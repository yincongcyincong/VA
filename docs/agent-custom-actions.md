# 给 VA 添加自定义动作和表情

用户描述的是想看到的动作。Agent 负责检查当前模型、编辑动作配置、重载和试演。仓库内可以用 `node bin/va.js` 代替下面的 `va`。

## 对话如何触发动作

```bash
va prompt
va prompt --voice
```

在「设置 → 桌面角色 → 角色 Prompt」编辑人设和 CLI 操作说明。用 `{{name}}` 引用当前角色名，用 `{{actionCommands}}` 插入当前模型支持的 `va act` 和 `va express` 命令。重载动作或切换模型后，命令清单会重新生成。`va prompt` 输出给本地 Agent 的完整内容，`va prompt --voice` 输出给豆包与机器人频道的版本。

用户可以直接说「挥挥手」「露出微笑」「跳一段侧步摇摆」，也可以直接说自定义动作的名字。Agent 可以根据对话决定是否表演。它应优先照顾明确请求，平常聊天时按需使用表情或保持待机。

本地 Agent 可以在回复最后单独附一行动作标记。给内置或自定义动作编一句符合当前对话的台词，写在标记前面。VA 会展示这句台词，并在启用「朗读回复」时同步发声。没有台词时会用动作配置里的默认台词。直接执行 CLI 时可用 `va act <动作> --say "本轮台词"`，调用 MCP 动作工具时填写 `speech`。`action` 和 `expression` 都只填可用编号，其中一个可以省略。

```text
嘿，见到你真开心！
[[va action=wave expression=smile]]
```

机器人频道和语音使用完整的第一人称短句，例如「太好了！我来侧步摇摆。」「我露出微笑。」VA 在收到回复或完整语音字幕后执行对应动作。豆包客户端可在已绑定对话里点「同步角色能力」。

用户明确要求发自拍时走频道的附件能力。摆拍只播放桌面动作。理解结果时要区分已安排表演和已经拍照、送达。

## 先读取模型和配置

```bash
va model --json
va actions --config-path --json
```

- 用 `model.checked` 确认当前模型通过加载和渲染检测。如果用户给的是尚未导入的文件，先运行 `va model-check "/绝对路径/角色.vrm" --json`，再按用户要求决定是否替换桌面角色。
- 用 `model.motions` 找可直接复用的内置动作，用 `model.bones`、`model.morphs`、`model.clips` 获取当前模型的骨骼、表情目标和动画片段。引用时沿用原名，包括大小写和空格。
- 读取 `va actions` 返回的 `configPath`。这是运行中的 VA 使用的配置文件，包含 `VA_PERFORMANCE_CONFIG` 指定的路径。用本机文件工具打开它。需要配置路径时，MCP 可以调用 `va_actions` 并传入 `{"includeConfigPath":true}`。

## 把用户意图翻译成配置

在已有 JSON 的 `actions` 和 `expressions` 对象中增加或更新条目，保留用户的其他动作和表情。动作和表情编号以小写英文字母开头，后续可用小写字母、数字或连字符，最长 40 个字符。

用 `va actions --json` 中的 `categories` 查看类别编号。自定义动作可通过 `category` 加入现有类别，省略时显示在「自定义」。`va actions --category 说话 --supported` 可筛选当前模型支持的说话动作。

| 用户想要的效果 | 配置方式 |
| --- | --- |
| 把挥手、飞吻或跳舞改成自己的表演 | 用 `motion` 复用内置动作，加上 `seconds`、默认 `expression` 和 `dialogue` |
| 做一个新的姿势，例如歪头打招呼 | 用 `bones` 为模型已有骨骼添加 X、Y、Z 轴的角度偏移。角度单位为度，取值 −180 到 180 |
| 播放模型里录好的完整动作 | 把 `clip` 设为 `model.clips` 中的原名，并填写播放时长 |
| 让角色做新的表情 | 在 `expressions` 中为模型的表情目标指定 0 至 1 的权重 |

例如，模型检测结果包含 `wave` 和 `head`，PMX 表情目标包含 `ウィンク`。可以合并下列配置来做「歪头眨眼问好」。同一个表情也给支持 `blinkLeft` 的 VRM 定义了对应权重。

```json
{
  "actions": {
    "hello-wink": {
      "label": "歪头眨眼问好",
      "category": "greeting",
      "motion": "wave",
      "seconds": 2.5,
      "bones": { "head": [0, 0, 12] },
      "expression": "wink",
      "dialogue": ["嗨，我在这儿呢！"]
    }
  },
  "expressions": {
    "wink": {
      "label": "单眼眨眼",
      "pmx": { "ウィンク": 0.8 },
      "vrm": { "blinkLeft": 0.8 }
    }
  }
}
```

`seconds` 的范围是 0.25 到 30。台词最多 12 条，每条最多 300 字。表情的目标分组用 `pmx`、`vrm` 或通用模型的 `morphs`。模型没有目标时，按实际支持情况选一个可用效果。模型带有 `Run` 片段时，动作也可以直接写成 `{"label":"小跑","seconds":3,"clip":"Run"}`。

## 重载、验证和试演

```bash
va actions --reload --json
va act hello-wink --json
va act '歪头眨眼问好' --json
```

1. 重载后确认返回的动作有 `supported: true`，并确认表情在 `supportedExpressions` 里。`va actions --supported` 可只看当前模型能播放的条目。MCP 可以用 `va_reload_actions` 重载，再用 `va_perform` 传入 `{"action":"hello-wink"}`。
2. 用户要求播放或验收时试演。用 `--expression` 覆盖本次表情，或单独运行 `va perform --expression wink`。配置阶段保留原模型，预检通过且用户要求切换时再导入。
3. 遇到 `PERFORMANCE_CONFIG` 时，根据错误修正 JSON 后重新加载。VA 会继续用上一份有效配置。遇到 `MODEL_ACTION` 时，重新核对当前模型的骨骼和片段。遇到 `BUSY` 时，等当前表演结束再试。

把动作编号和验证结果告诉用户。配置路径用于本机编辑，发往机器人频道的结果只需要动作编号和状态。
