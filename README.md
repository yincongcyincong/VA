# VA · 阿哈桌面角色

VA 在 macOS 桌面上显示透明悬浮的 3D 阿哈。可以拖动底部的「阿哈」把手移动窗口，拖动角色旋转视角，用滚轮缩放。底部控制条提供缩放和设置。macOS 菜单栏可以切换半身视角、隐藏角色、打开鼠标穿透、播放动作和复制角色照片。

[启动](#启动) · [命令行](#命令行) · [桌面互动](#配置与互动) · [智能体与模型](#智能体与模型) · [OpenClaw 和 AstrBot](#openclaw-和-astrbot) · [屏幕与音乐](#视觉-agent-与系统音乐) · [语音和口型](#语音和口型)

## 启动

本项目构建产物位于 `dist/VA-darwin-arm64/VA.app`（Apple Silicon），可以双击打开。在有 `va` 命令的终端中也可以运行：

```bash
va start
va status --json
```

从源码启动或打包需要 macOS 和 Node.js 22.12 及以上版本：

```bash
npm ci
npm start
npm run build:mac
```

项目默认直接读取 `~/Downloads/星穹铁道-阿哈_by_崩坏：星穹铁道_df69373aacbea0a160459be2ce0eb56e`，目录内应包含 `星穹铁道-阿哈2.pmx` 与贴图。若移动了素材，在命令行用 `AVATAR_DIR="/绝对路径" va start`。素材使用规则随下载包提供，其中禁止二次分发和商业使用。

如果在另一台 Mac 安装，先把 `./bin/va.js` 链接成 PATH 中的 `va`，或者在项目根目录直接用 `./bin/va.js`：

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/bin/va.js" ~/.local/bin/va
```

## 命令行

```bash
va actions --json
va act dance
va say '嗨，我是阿哈。'
va perform --action wave --expression smile --say '欢迎来到这里！'
va view portrait
va act pose --expression smile --no-wait
va photo --out /tmp/aha.png --clipboard --json
va stop
```

动作包括挥手、点头、鞠躬、大笑、摸摸、摆拍和下列舞步。菜单栏「VA → 跳舞」可以直接选舞步。台词使用设置中选定的 [朗读音色](#语音和口型)。

| 命令 | 舞步 |
| --- | --- |
| `va act dance` | 经典律动 |
| `va act dance-side` | 侧步摇摆 |
| `va act dance-spin` | 转身亮相 |
| `va act dance-bounce` | 弹跳挥手 |

可以直接输入「跳个舞吧」「跳三个舞」或「跳一段弹跳挥手」。VA 在本机识别明确的跳舞请求并开始表演。VA 聊天框、`va chat`、已绑定的豆包对话和已配置的机器人频道都支持这种用法。通话中的语音入口见下文。未指定舞步时，VA 轮换这四种舞步。完整动作适用于默认角色及兼容骨骼的 PMX 模型。

`va act`、`va say`、`va perform` 默认等演出完成后返回。用 `--no-wait` 可立即获取任务 ID，再用 `va status --json` 查询，或在动作进行时另行调用 `va photo`。已有表演时，新表演返回 `BUSY`。用 `va stop` 可打断，等待该任务的调用会收到 `CANCELED`。

照片是角色当前取景的透明 PNG。命令返回绝对路径，已有文件会保留。指定 `--clipboard` 时也会把图片放到系统剪贴板。更多命令见 `va --help`。

## 接入 Agent 和机器人

- **Codex 或其他支持 Agent Skills 的工具**可以发现 [va-desktop](skills/va-desktop/SKILL.md)，并通过 `va` 或已连接的 MCP 调用桌面角色。
- **MCP 客户端**可添加名为 `va-desktop` 的本机 stdio 服务，命令填 `va`，参数填 `["mcp"]`。若客户端有独立 PATH，用 `va` 的绝对路径，或用 Node.js 绝对路径作为命令并传入 `bin/va.js` 的绝对路径与 `mcp`。可调用 `va_start`、`va_status`、`va_actions`、`va_perform`、`va_stop` 和 `va_photo`，其中照片直接返回 PNG。
- **机器人**可以在同一台 Mac 用子进程调用 `va ... --json`。成功会输出 `{"ok":true,...}`，失败会输出 `{"ok":false,"error":{"code":"...","message":"..."}}` 并返回非零退出码。拿到照片的 `path` 后，用自己的渠道上传附件。远端机器人需要在运行 VA 的这台 Mac 上部署一个能调用 `va` 的桥接进程。

桌面控制通过当前用户独占的 Unix socket 完成。启动 VA 会打开桌面窗口和菜单栏入口。Agent 的受限环境若报告 Unix socket `EPERM`，执行环境需要允许本机 IPC。

## 配置与互动

项目根目录执行 `make run` 即可启动；`make install` 安装源码依赖，`make dev` 从源码运行，`make build` 生成本机 `.app`，`make stop` 退出。

点击角色下方的「设置」、从菜单栏「VA」选择「设置…」、按 **Control + Option + V**，或执行 `va settings`，都可以打开配置窗口。鼠标穿透只作用在角色窗口，底部控制条仍可点击。用控制条的「− / +」可每次调整 5%，设置里的滑块可实时调整 40–110%，也可以执行 `va scale 55`。默认大小为 68%，调整后会保存。关闭穿透时，单击角色触发摸摸反应。拖动模型仍可旋转视角。

「桌面角色 → 界面主题」可在经典、樱花漫画、星夜霓虹之间切换。主题会同时应用到设置窗口和桌面对话气泡。

「设置」中的「桌面模型」可以选择 PMX、VRM、GLB、glTF、FBX 或 OBJ。通过终端切换可用 `va model "/path/to/character.vrm"`，查询用 `va model --json`，恢复默认用 `va model default`。导入成功后会记住模型路径。带外部资源的模型请连同贴图、`.bin` 或 `.mtl` 一起解压，保留相对目录结构。

PMX 可使用现有动作所需的同名骨骼和表情。VRM 支持点头和摸摸时的头部动作，具有对应表情时也能眨眼和对口型。GLB、glTF 和 FBX 可以播放文件自带的动画，导入时优先选择待机片段。OBJ 适用于静态展示。导入模型仍可显示对白和拍照。

| 样本 | 下载来源 |
| --- | --- |
| Fox（GLB，含 3 段动画） | [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox) |
| BoxTextured（glTF，含独立贴图和 BIN） | [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoxTextured) |
| Seed-san（VRM 1.0） | [VRM Consortium](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san) |
| Blocky Characters（含 FBX、OBJ、GLB） | [Kenney 在 OpenGameArt 的下载页](https://opengameart.org/content/3d-rigged-characters) |

在「设置 → 桌面角色」修改「角色名称」。保存后，桌面控制条、菜单、默认台词和默认人设都会使用新名称。人物配置位于 `~/Library/Application Support/VA Desktop/character.json`，初次启动从 [默认人设](config/character.json) 创建。也可通过 `VA_CHARACTER_CONFIG` 指定文件。自定义 `prompt` 或 `dialogue` 时，用 `{{name}}` 引用当前名称。MCP 用 `va_character` 读取人设，命令行可用 `va character --json`。

MCP 的 `va_say` 和 `va_perform` 会在角色旁显示对白气泡。执行动作时可自带台词，也可让角色从配置中挑选。自拍用 `va selfie --out /tmp/aha.png --json` 或 MCP 的 `va_selfie`，会等待摆好姿势并返回 780 × 1040 的透明 PNG。角色隐藏时可以自拍，VA 退出后也可以后台启动自拍。当前聊天可直接展示图片，外部机器人可以用自己的附件发送能力。

## 智能体与模型

从菜单栏「VA → 智能体与模型…」或桌面设置的同名按钮打开，也可执行 `va chat`。接入方式同一时间只启用一种，切换时保留之前的配置，便于换回。

- **本地 Agent** 选择 Codex、Claude Code、DeepSeek Harness、OMP 或自定义 Agent。在「连接设置」可绑定会话、设置附加 Prompt 和工作目录。目录留空时使用启动 VA 时所在的目录。VA 使用已安装 Agent 自己的模型服务。
- **豆包客户端** 使用 Mac 上已登录的豆包及当前对话。VA 可以发送文字和显示新的回复，语音输入与朗读由豆包客户端负责。[客户端设置](#本机豆包客户端)
- **火山实时语音** 支持在 VA 直接开麦聊天。豆包语音流驱动阿哈口型，回复字幕会显示在桌面气泡中。[实时语音设置](#豆包实时语音)
- **模型 API** 列出本机可读取的 Codex CLI、Claude Code 和自定义配置。可直接选择可用的 CLI 配置，也可点「添加配置」填写名称、API 协议、Base URL、模型名、API Key 和附加 Prompt。支持 OpenAI Chat、OpenAI Responses 和 Anthropic Messages。视觉模型在同一弹窗单独配置。只有 CLI 登录而没有 API Key 时，可继续使用「本地 Agent」或复制为自定义配置并补全。CLI 配置按需读取，密钥不会显示在列表中。
- **AstrBot / OpenClaw** 在本窗口保存目标频道。Bot 调用自己的模型，VA 显示选定频道已经发出的回复。[安装与使用](#openclaw-和-astrbot)

配置保存在 `~/Library/Application Support/VA Desktop/agent.json`。CLI 可用 `va integration [off|local|doubao-client|doubao|api|astrbot|openclaw]` 查询或切换接入方式。手动编辑 JSON 的 `mode` 后重启 VA。

角色人设提供统一语气和动作的默认台词。本地 Agent 与模型 API 的附加 Prompt 会接在通用人设后面，供该连接的聊天使用。AstrBot 和 OpenClaw 由各自的 Agent 设定人设，VA 直接显示它们发出的文字。

在本地 Agent 模式，第一次发送会创建会话。VA 会记住每个 Agent 和工作目录的会话 ID，重启后继续使用。可在界面绑定已有的、当前空闲的会话 ID，或点「新会话」解除当前绑定。聊天窗口保留本次 VA 运行中最近 20 轮。回复也会在桌面角色旁显示气泡，最多 300 字。勾选「让角色朗读回复」可以同时听到语音。

```sh
va chat "我们刚才聊到哪里了？" --json
va chat "打个招呼" --speak
va chat-use omp
va chat-status --json
va chat-bind <会话ID>
va chat-new
va chat-cancel
```

配置与视觉、语言模型和频道一起放在 `agent.json` 的 `localAgent` 中。Codex 和 Claude Code 可用各自的 `command` 指定可执行文件。模型可在聊天窗口选择，留空时使用 Agent 自己的配置。Codex 在只读沙箱中运行，续聊时通过 `thread/inject_items` 传入最新指令。Claude Code 的内置工具在 VA 聊天中关闭。模型请求走所选 Agent 已配置的服务。

接入其他本机 Agent 时，在 `localAgent.custom.command` 填可执行文件的绝对路径，在 `args` 填它的参数。VA 直接运行该命令，以工作目录为 cwd，通过 stdin 发送一行 JSON `{"message":"你好","prompt":"角色和附加指令","sessionId":null}`。适配器通过 stdout 返回一个 JSON 对象 `{"reply":"你好","sessionId":"my-session-id"}` 后以 0 退出。续聊会收到相同的 `sessionId`。屏幕观察请求的 `sessionId` 为 `null`，图片在 `image.mime` 和 `image.data`，后者为 Base64。诊断写到 stderr。

### 本机豆包客户端

在 macOS「系统设置 → 隐私与安全性」按所用功能授权。

| 功能 | 权限位置 | 授权给 |
| --- | --- | --- |
| 从 VA 发文字、读取对话回复、调用豆包的朗读按钮 | 辅助功能 | VA |
| 在豆包里打电话或按住空格说话 | 麦克风 | 豆包 |
| 在 VA 显示豆包的语音字幕和口型 | 录屏与系统录音 → 仅系统录音 | VA |
| 让 VA 在豆包客户端通话中识别你说的跳舞请求 | 麦克风 | VA |

如果「辅助功能」列表没有 VA，点「添加」并选择 `dist/VA-darwin-arm64/VA.app`。打开开关时，macOS 可能要求用触控 ID 或登录密码确认。「系统录制权限…」可以从 VA 的字幕设置页打开录制授权。

1. 在「智能体与模型 → 豆包客户端」点「打开豆包」。用豆包内已登录的账号，打开一条已有对话。
2. 给 VA 开启「辅助功能」后，回到 VA 点「绑定当前对话」。关掉设置窗口后仍会在桌面显示新回复。切换接入方式、退出 VA 或点「解除绑定」会结束绑定。
3. 可以从 VA 发送文字，也可以在豆包客户端输入框按住空格说话。新回复会显示在 VA 的对话和桌面气泡里。「用豆包朗读最近回复」调用豆包客户端自己的朗读按钮。
4. 点「同步角色能力」或运行 `va chat-context`，把角色名称、桌面舞步和跳舞机制发到绑定的豆包文字对话。从 VA 发本次绑定后的第一条普通消息时，也会附上能力说明。有在本机安排的跳舞请求时，VA 会在下一条发给豆包的文字里补充动作反馈。

如果普通文字发送失败，先检查 VA 的「辅助功能」，再打开绑定的豆包对话并清理草稿。VA 会查找豆包的「发送」按钮，并确认豆包接受了输入；豆包输入框里已有其他草稿时会保留该草稿。

#### 打电话和字幕

1. 按上表给豆包开启麦克风，并给 VA 开启系统录音。字幕需要 macOS 26，首次启动时可能下载 Apple 的中文识别资源。[Apple 本机语音识别](https://developer.apple.com/documentation/speech/speechanalyzer)
2. 如果 VA 字幕已经开着，先点「停止字幕」。在豆包客户端选择「更多技能 → 打电话」，等电话接通。
3. 回到「VA → 智能体与模型 → 豆包客户端」，点「开始字幕」。豆包播放下一句回复后，字幕会显示在角色旁的气泡和 VA 设置页。通话字幕适用于当前豆包客户端的声音，只有从 VA 发文字或同步某条对话的文字回复才需要绑定该对话。
4. 想在通话里直接让角色跳舞时，开始字幕前勾选「识别麦克风里的跳舞请求」，并允许 VA 使用麦克风。VA 用本机转写判断你说的请求，识别完成后即可跳舞。麦克风识别随字幕停止。

「同步角色能力」会在绑定的文字对话中留下一条消息。豆包客户端的通话模式如何使用文字历史由豆包决定。

VA 通过 Core Audio 采集豆包及其音频助手的输出，中文转写在 Mac 本机完成。豆包的播放音量也会驱动角色口型、点头和说话手势。字幕只包含豆包播放的声音，麦克风仍由豆包客户端使用。关闭 VA 设置窗口后字幕可继续显示。点「停止字幕」、退出 VA 或切换接入方式会释放音频采集。

字幕状态会依次显示等待豆包出声、已收到音频和正在显示字幕。可以在豆包选一条回复点「朗读」测试。听到朗读后如果仍停在等待状态，可以用同页的「系统录制权限…」检查授权。打电话接不通时，可以先停止字幕、重启豆包，再按上述顺序重拨。

打开「让本机模型根据通话内容决定是否跳舞」时，VA 把识别完成的片段交给 Mac 上的模型判断。优先用 Apple Intelligence。Apple Intelligence 不可用时使用 macOS 的中文句向量模型，在语义与表演请求或舞蹈庆祝足够接近时触发。设置页会提示所用方式。这个判断由 VA 在本机依据豆包的语音回复完成。[Apple 设备端模型](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)

### 豆包实时语音

1. 在火山引擎开通豆包端到端实时语音（Seeduplex）。在 VA 打开「智能体与模型 → 火山实时语音」，填入拥有实时语音权限的火山 API Key，或在 VA 的启动环境设置 `VOLC_REALTIME_API_KEY`。音色可以留空使用默认的 Vivi，也可以填写实时语音的音色 ID。附加 Prompt 会与阿哈的人设一起发给豆包。[火山实时语音文档](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)
2. 点「保存豆包设置」，再点「开始语音对话」。首次使用时，在 macOS「系统设置 → 隐私与安全性 → 麦克风」允许 **VA** 访问。通话中，设置窗口显示双方的字幕，阿哈旁边的气泡同步显示豆包回复，嘴型跟随播放的语音。点「结束」或关闭设置窗口即可停止采集。
3. 说「跳个舞吧」时，VA 收到用户语音的转写就开始跳舞。默认还允许豆包根据聊天内容主动发起表演，例如听到「今天有好消息，庆祝一下吧」。主动表演开关在「火山实时语音」里。

VA 建立实时语音会话时会把桌面角色能跳的舞步发给模型。如果同一轮已经从用户语音识别并安排了舞蹈，跳舞工具会返回已安排的状态。

VA 在桌面采集麦克风和播放音频，豆包在火山引擎生成回复。这个接入使用实时语音 API Key，音色和「参考音色」中的火山 TTS 分别配置。

## OpenClaw 和 AstrBot

在仓库运行 `make integrations` 生成两个插件。在 VA 打开「智能体与模型」，选择一个机器人接入。两个机器人沿用各自的语言模型和人设。VA 把绑定频道中机器人发出的文字显示在阿哈身边，打开「朗读机器人回复」后同时播放语音和口型。

| 接入方式 | 安装与频道绑定 |
| --- | --- |
| OpenClaw | 执行 `openclaw plugins install --link /VA仓库绝对路径/integrations/openclaw`，也可安装 `dist/integrations/openclaw-va-desktop-0.2.0.tgz`。在插件设置中让 `command` 数组指向 VA 命令。在 Telegram 等目标频道用授权账号发送 `/va route`，把返回的 `channel`、`target`、`accountId`、`sessionKey` 填到 VA。 |
| AstrBot | 在管理面板导入 `dist/integrations/astrbot_plugin_va.zip`，设置 `command` 为 Bot 能执行的 VA 命令。用授权账号在目标频道发送 `/va route`，将返回的 UMO 填到 VA 的「目标频道」。 |

Bot 与 VA 同机运行时使用同一个 macOS 登录用户。远端 Bot 可通过 SSH 调用 VA，Docker 可使用仓库里的 [目录桥接](integrations/docker/bridge.py)。两个 Bot 共用一个 Telegram token 时，每次只开启一个 Bot 的 Telegram 适配器。[桥接参数和排查](integrations/README.md)

OpenClaw 按频道的配对或访问策略授权，AstrBot 允许管理员或插件 `allowed_user_ids` 中的账号控制角色。配对后，授权账号可直接在频道输入以下命令。

| 发送 | 结果 |
| --- | --- |
| `/va selfie` | 阿哈摆拍，机器人把 780 × 1040 的透明 PNG 发回当前频道。桌面角色隐藏时也能拍。 |
| `/va act dance` | 桌面角色跳经典律动并播放默认对白。动作名也可用 `dance-side`、`dance-spin` 或 `dance-bounce`。 |
| `/va act wave` | 桌面上的阿哈挥手并播放默认对白。 |
| `/va say 你好，我是阿哈` | 阿哈在桌面显示这句台词并朗读。 |

在 VA 配置的 OpenClaw 或 AstrBot 频道里，授权用户发「让阿哈跳舞」即可让 VA 表演。插件在机器人调用模型前处理这条请求。AstrBot 注册了 `va_desktop_selfie`，Agent 调用后会把照片发到当前频道。也可以用表中的命令直接自拍或选舞步。

## 视觉 Agent 与系统音乐

在 VA 的「设置 → 屏幕与音乐」分别开启屏幕观察和音乐跟随。两项功能默认关闭，角色隐藏时暂停。观察间隔可选 `10s`、`30s`、`1min`、`5min`、`10min`、`30min`、`1h`、`6h`、`24h`，默认 `10s`。截屏按间隔发起，分析较慢时只保留一张最新待处理截图。也可用 `va sense interval 30`、`va sense screen on` 和 `va sense music on`，状态可用 `va senses --json` 查询。首次使用时，在 macOS 的「隐私与安全性 → 屏幕与系统音频录制」授权 VA，然后退出并重新启动。源码模式下，macOS 可能将授权归给启动 VA 的终端。

截图由当前接入方式处理。本地 Agent 模式将图片放进单独的观察请求，选用远端模型的 Agent 可能会把画面发送给它的模型服务。模型 API 模式使用「视觉模型」中的配置，发送到远端需要 HTTPS，并勾选「允许发截图到远端视觉模型」。两种机器人模式下暂停主动观察和音乐跟随。开启观察时，MCP 客户端也可以用 `va_observe` 读取图片、用 `va_senses` 查看状态。

音乐识别使用 macOS 的本机音频分类，分析系统输出。检测到音乐会播放角色的预设舞步，音乐停止或关闭开关时会停下。鼠标穿透关闭时，点角色可以打断自动动作并听到摸摸回应。桌面打包会编译音频组件，源码开发可用 `make dev` 编译并启动。

## 语音和口型

「设置 → 参考音色」可选择 **macOS 系统音色**或 **火山 TTS**。「试听当前音色」用选定音色朗读一段台词。台词朗读用于点击摸摸、手动动作、CLI、MCP 和启用了朗读的 Agent 或机器人回复。

同一页的「说话风格」可选自然聊天、活泼雀跃、轻声思考或舞台演说。带口型的角色在静音文字回复中会按文字节奏开合嘴巴，朗读时跟随音频。语音可与挥手、跳舞等显式动作同时播放。

### 开启火山 TTS

1. 在火山引擎开通语音合成，准备 API Key 和该资源支持的 Speaker ID。标准语音合成选择 `seed-tts-2.0`。已有火山复刻音色时，选择 `seed-icl-2.0` 并填写该音色的 Speaker ID。[火山语音合成接口](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh)
2. 在「设置 → 参考音色」选择「火山 TTS」，填入 API Key 和 Speaker ID，选中资源，再点「保存并使用火山」。API Key 也可通过 VA 启动进程的 `VOLC_TTS_API_KEY` 提供。
3. 点击「试听当前音色」确认可播放。要听 Telegram 的机器人回复，在 VA 的频道配置中打开「朗读机器人回复」。

VA 通过 HTTPS 将朗读文本提交给火山引擎。语音设置保存在 `~/Library/Application Support/VA Desktop/voice.json`，也可通过 `VA_VOICE_CONFIG` 指定位置。火山服务请求失败时，日常对白回退到系统音色，试听会显示错误。

### 本地参考录音

本地 Qwen3-TTS 音色模仿已因合成耗时停用。先前导入的阿哈原声仍可通过「本地原声 → 播放参考原声」播放，也可导入新的 WAV、M4A 或 MP3。参考录音保存在本机，火山 TTS 读出的音色由填写的 Speaker ID 决定。

## 半身视角

「设置 → 角色视角」可选择全身或半身，重启会恢复上次视角。也可执行 `va view portrait` 或 `va view full`。
