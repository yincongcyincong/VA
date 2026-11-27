# VA Agent 使用指南

VA 是 macOS 上的 3D 桌面角色。Agent 可以通过本机 CLI 或 MCP 查询状态、控制角色、拍照和修改配置。通过 AstrBot 或 OpenClaw 接入时，机器人负责频道对话，VA 根据绑定目标展示回复和执行动作。

## 启动和检查

在仓库根目录执行以下命令。已把 `va` 加入 PATH 时，可用 `va` 代替 `./bin/va.js`。

```bash
./bin/va.js status --json
./bin/va.js start --json
./bin/va.js model --json
./bin/va.js actions --supported --json
./bin/va.js prompt
```

`start` 使用已有的打包应用。从源码开发时，先运行 `npm ci`，再运行 `make dev`。收到 `NOT_RUNNING` 时先启动 VA。若沙箱阻止访问本机 Unix socket，使用具备本机 IPC 权限的运行环境。

## 控制角色

先查询当前模型支持的动作和表情。用户明确指定台词时使用原话。需要配动作时，写一句符合当前对话的台词，合并成一次表演。省略台词会播放动作默认对白。

```bash
./bin/va.js perform --action wave --expression smile --say "你好呀，见到你真好！" --json
./bin/va.js say "我在桌面上。" --json
./bin/va.js selfie --out /tmp/va-selfie.png --json
./bin/va.js model-check "/绝对路径/角色.vrm" --json
```

自拍使用新的输出路径，完成后使用返回的 PNG。用户只要照片时直接交付图片。向机器人频道发自拍时，使用已绑定频道的插件入口并核对目标。读取屏幕前先确认用户确实要求观察，再用 `va senses --json` 查询当前接入和权限状态。[自定义动作和回复协议](docs/agent-custom-actions.md)

## 连接 MCP 和 Skill

把 VA 启动为 stdio MCP 服务。将下例中的路径换成仓库的绝对路径，并按客户端要求放入其 MCP 配置。

```json
{
  "mcpServers": {
    "va-desktop": {
      "command": "node",
      "args": ["/绝对路径/VA/bin/va.js", "mcp"]
    }
  }
}
```

常用工具有 `va_status`、`va_actions`、`va_prompt`、`va_perform`、`va_selfie` 和 `va_config_list`。支持 Skill 的 Agent 可读取仓库里的 [va-desktop Skill](skills/va-desktop/SKILL.md)。

## 配置与会话

用户说「绑定VA」或要求绑定当前 Codex 会话时，直接运行 `./bin/va.js chat-bind-current --json`。默认替换原绑定，开启 `agent.localAgent.allowMultipleSessions` 时才保留其他绑定。确认结果返回 Codex 会话 ID 后，回报 `listeningCount` 显示的监听总数。

```bash
./bin/va.js config list --json
./bin/va.js config get character --json
./bin/va.js config run chat-sessions --json
```

修改前读取当前配置，并只提交用户要求更新的字段。MCP 对应 `va_config_get`、`va_config_set` 和 `va_config_run`。统一角色 Prompt 在「桌面角色」的输入框里，可用 `config set character` 的 `prompt` 字段更新。

Windows 的智能体麦克风与豆包字幕共用 `voice.recognition`，包含 `engine`（`system` 或 `sensevoice`）、`python` 和 `modelDirectory`。先读取 `config get voice --json`，修改后用 `config run voice-recognition-status --json` 检查，或调用只读 MCP 工具 `va_voice_recognition_status`。检查不会采音。若返回 `ready: false`，先向用户说明缺少哪些模型或依赖，并提供 `setup.command` 安装命令、下载地址；下载安装后再次检查，不能直接声称可用或反复开启录音。设置保存在「语音 → 语音识别」，启用录音仍需用户明确要求。详细流程见 [VA Skill](skills/va-desktop/SKILL.md) 和 [Windows 说明](WIN.md#可选的-sensevoice-中文字幕)。

`chat-sessions` 返回绑定记录及其 `ref`。可用 `chat-open-session` 打开记录、用 `chat-unbind-session` 解除绑定，或用 `chat-clear-sessions` 按 `ref` 或 `provider` 清理 VA 的记录。绑定和清理前核对会话所属的 Agent。AstrBot 和 OpenClaw 的部署、频道配对和 Docker 桥接见 [机器人接入指南](integrations/README.md)。

## 开发与打包

- 所有 Windows 修复必须只走 Windows 的独立逻辑：使用明确的 `process.platform === 'win32'` 分支，或独立的 Windows 模块。不得为修复 Windows 问题修改 macOS 原有实现或行为；共用文件中的改动也必须限定在 Windows 分支内。验证时单独检查 Windows 路径，并确认 macOS 仍走原有逻辑。
- `desktop/` 维护应用窗口、角色渲染、本地 Agent、会话绑定、语音和动作。CLI 在 `bin/va.js`，MCP 和配置校验在 `lib/`。
- `integrations/` 存放机器人插件和 Docker 桥接。先运行 `npm test` 检查改动，再使用实际需要的打包目标。
- `bash scripts/package.sh` 生成 DMG 和校验文件。`bash scripts/package.sh app` 只生成 macOS 应用。`bash scripts/package.sh integrations` 生成两种插件包。产物在本机 `dist/`。
- 运行配置位于 macOS 应用数据目录的 `VA Desktop` 下。`config/` 是初始配置模板。诊断时可查看启动目录下的 `logs/va.log`。提交代码时保留用户的本地配置、凭据、日志和生成产物在本机。

[代码结构与配置路径](docs/architecture.md) · [用户手册](README.md)
