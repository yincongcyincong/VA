# Windows 版本适配与本机测试

## 可选的 SenseVoice 中文字幕

「语音 → 语音识别」提供统一的识别引擎选择，供本地智能体麦克风输入和豆包通话字幕共用：Windows 系统识别（默认、免下载）或 SenseVoice Small INT8（本机 CPU，支持普通话和中英混说）。SenseVoice 使用 Silero VAD 分句，通常在停顿后显示最终字幕；模型初始化和分句会增加延迟，具体准确度取决于音源。两种引擎都需明确勾选采集默认扬声器混合声音，不保存录音。SenseVoice 暂不支持麦克风动作监听；可选的字幕动作仍可使用。

先准备 Python 3.10–3.12 环境，再在仓库根目录运行安装脚本（也可以复用 ZipVoice 的 Python 环境）：

```powershell
powershell -File scripts/setup-windows-sensevoice.ps1 -Python "C:\path\to\python.exe"
```

脚本安装 `sherpa-onnx`、`numpy`，下载官方 SenseVoice INT8 模型及 Silero VAD，并在不采音的情况下验证加载。下载目录默认为 `build/sensevoice`，可用 `-Destination` 指定。随后在「语音 → 语音识别」选 SenseVoice，填写同一个 Python 可执行文件及模型目录并保存。旧版豆包字幕中的引擎和路径会自动沿用到统一设置。智能体输入仍需手动开启麦克风；豆包字幕仍需勾选扬声器采音。保存识别设置会停止正在运行的识别，再次开启后使用新引擎。模型目录需包含 `model.int8.onnx`、`tokens.txt`、`silero_vad.onnx`。模型仅在选择 SenseVoice 时加载，加载失败会明确报错，可手动切回系统识别。

来源：[SenseVoice](https://github.com/FunAudioLLM/SenseVoice) · [sherpa-onnx 模型及 Python 接口](https://k2-fsa.github.io/sherpa/onnx/sense-voice/python-api.html)。macOS 保持原有识别路径。

Agent、CLI 和 MCP 共用 `voice.recognition`。可用 `va config get voice --json` 读取、`va config set voice '{"recognition":{"engine":"sensevoice","python":"C:/speech/python.exe","modelDirectory":"C:/speech/sensevoice"}}' --json` 修改。开启识别前用 `va config run voice-recognition-status --json` 检查环境；MCP 可直接调用只读工具 `va_voice_recognition_status`，也可通过 `va_config_run` 执行同名配置操作。未下载模型时会返回 `ready: false`、缺失项 `missing`、安装命令 `setup.command` 和下载地址，Agent 应先提醒用户下载安装。此检查不打开麦克风或扬声器采集；实际启动时也会检查并拒绝缺失环境。

## 豆包 Windows 语音联动（2026-11-26）

字幕气泡会按顺序显示长句的每一页，新识别到的句子排在后面，避免只显示最后一页。设置页的字幕区域保留本次识别记录（最近约 6000 字，停止后清空，不写入文件）。在字幕面板勾选「根据语音中明确的动作词执行动作」后，可让豆包完整说出「我来给你跳一段舞」「我来侧步摇摆」「我来转身亮相」等短句；识别到最终句子后会选择当前模型支持的舞步。提及、引用、否定动作不触发。若没有触发，可先查看字幕是否准确识别出该短句、自动动作选项是否开启、角色是否正忙。

新增独立的 `native/WindowsDoubaoCaptions.cs` 与 `desktop/windows-doubao-captions.js`。WASAPI 采集默认扬声器，混音转为 16 kHz 单声道 PCM，再交给 Windows System.Speech 在本机转写。字幕、口型和明确动作词接入现有角色流程，支持可选的麦克风本机动作请求；通话期间保留豆包原声，避免 VA 重复朗读。停止字幕、切换模式、退出或父进程断开时结束采音，不保存音频。

本机为 Windows 10 19045，微软按进程隔离采音接口要求 20348 及以上；此兼容实现会包含默认扬声器上其他应用的声音，使用前必须明确勾选同意，默认不启动。建议暂停其他应用音频、使用耳机；切换播放设备后需停止并重新开始。需安装本机语音识别语言组件。麦克风识别仅触发本机动作，不向豆包发送转写；扬声器出声后短暂抑制麦克风结果以减少回声。[微软 loopback 说明](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)

已编译原生助手，检测到 `zh-CN`。离线验证浮点双声道转单声道、48 kHz 转 16 kHz、跨数据包采样相位和静音输入通过；合成中文 PCM 经相同流接口送入真实识别器，返回中文转写。117 项自动化测试通过。

用户授权后，在实际打包 VA 中验证了混合声音采集的同意保护、启动、豆包现有回复朗读、实时字幕及停止；未发送新消息，未保存录音。该回复包含 `va act` 等中英文指令，中文识别器的转写准确度很差。再用纯中文经真实扬声器播放验证同一链路，得到「你好这是一条语音字母测试消息」，其中「字幕」被误识别为「字母」。因此此功能为实验性，不能保证字幕准确度。记录在本机 `build/windows-doubao-voice-smoke.json` 和 `build/windows-doubao-speaker-smoke.json`；验收后已停止采音。口型音量事件的路由由自动化测试验证，没有做逐帧视觉验收。真实双向通话及实际麦克风动作仍待验收。

## 豆包 Windows 文字客户端接入（2026-11-26）

新增独立的 `native/WindowsDoubaoClient.cs` 和 `desktop/windows-doubao-client.js`。Windows 通过 [UI Automation 可访问性接口](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-msaa) 识别豆包聊天窗口、读取会话地址与回复、输入文字和调用朗读按钮，不读取豆包账号数据库或 Cookie。构建会使用 Windows 自带 .NET Framework 编译并携带客户端助手；macOS 仍使用原来的 Swift 助手。

使用步骤：在豆包完成登录，从左侧历史打开一条已有对话，在 VA 选择「豆包客户端」并点「绑定当前对话」。会话绑定使用进程、窗口和会话地址共同核对；切换会话、已有其他草稿、输入框失焦或内容变化时会拒绝发送，剪贴板输入后恢复原内容。新回复通过 VA 当前音色朗读；「用豆包朗读最近回复」调用客户端本身的朗读按钮。语音通话字幕见上方独立的语音联动说明。

已完成原生助手编译和真实登录会话绑定。经用户授权，向其指定测试会话提交一次验收消息，豆包实际回复「VA Windows 联动测试通过。」。验收修正了 Windows 特有的可编辑分组输入框、未命名发送箭头和扁平化聊天树；回复提取按消息操作栏边界隔离，避免把旧回复或用户提示词混入。使用真实发送前快照作为绑定基线、轮询当前会话取得这条实际回复，再由 VA 当前 ZipVoice 音色朗读成功，记录在本机 `build/windows-doubao-read-speech-smoke.json`。没有为复核重复发送验收消息。

文字适配阶段 115 项自动化测试全部通过，覆盖回复提取、登录及新聊天页拒绝、会话切换保护、草稿保护、输入框选择歧义、扁平化历史边界和原生操作派发。后续语音验收及客户端朗读验证见上方语音联动说明。

## DeepSeek standard 会话语音续聊（2026-11-26）

Windows 发送遇到 `one-shot runner does not compose` 时，使用独立的桌面会话桥接。插件只追加到 DeepSeek `desktop` profile，在已运行的桌面 Host 内调用原会话的 `sessionController`，保持 standard 预设及会话 ID，不另起 Host 抢占写句柄。macOS 原有发送实现保持原样。

首次安装后需要退出并重新打开 DeepSeek Harness。桥接只通过随机命名的本机管道提供服务，每次启动生成独立认证令牌，端点记录保存在用户 VA 数据目录；不会开放网络监听。绑定变化、取消、忙碌状态及超时均有处理，已经接受的消息不自动重发。授权请求仍由 DeepSeek 原界面处理。Windows 语音面板将最近转写明确标注为「最近识别」，错误另加标签；需要重启桥接时停止监听，避免背景声音反复触发失败。

本机在原 `session-ee697ce0-e676-4f97-aaf1-ffdfef7d6521` standard 会话验收成功，回复「续聊测试通过。」；记录在忽略提交的 `build/deepseek-standard-smoke.json`。完整测试 109 项通过，覆盖真实 CMD 入口拒绝 one-shot 后转入桌面桥接、身份验证、同会话发送、旧回复过滤、取消及安装幂等性。未进行 macOS 实机回归。

Windows 修复包位于 `build/deepseek-release/VA-win32-x64/VA.exe`，已正常启动。再经打包后 VA 的聊天入口向原绑定会话发送验收消息，返回「语音续聊测试通过。」且 `spoken: true`；日志确认 ZipVoice 合成和播放完成。麦克风验收后保持停止，用户可再次点击「开始监听」。

## 全部 AI 娘的本机可用性（2026-11-26）

远程同步后的 10 款 VRM（DeepSeek、Claude、GPT、Gemini、GLM、Grok、Qwen、Kimi、MiniMax、豆包）均已在当前 VA 渲染器逐个加载检测通过，没有纹理警告，均报告骨骼、口型及 22 种动作信息。此为实际模型加载与能力检测，没有逐个执行全部动作。检测前后当前角色保持不变，详细结果在本机 `build/windows-ai-girls-check.json`。

发现旧 Windows 打包白名单遗漏 `assets/models/ai-girls`，导致源码有模型、运行包的模型库却没有这些角色。已仅在 Windows 构建分支包含全部 VRM 和模型许可文件，并在打包后检查文件完整性；macOS 构建逻辑保持原样。新版已启动，模型库列出这 10 款及 VA 封面角色；再逐个从实际包内加载检测，10/10 通过，当前角色保持不变。包内检测结果在 `build/windows-ai-girls-packaged-check.json`。完整测试 107 项通过。

## ZipVoice 长回复回退系统音色（2026-11-26）

本机星铃参考音色已保存，但较长回复的 CPU 合成需要约 23.7 秒，旧的 15 秒限制会触发超时并回退系统声音。已复现旧限制在约 15 秒报错，再用同一配置验证延长等待后生成有效 WAV。Windows 的实际合成上限调整到 60 秒，macOS 仍为原来的 15 秒；模型启动、参考音频准备的限制保持原样。Windows 上的回退原因会显示在语音设置页并记录为 `speech.fallback`。诊断结果及测试音频在本机 `build/windows-zipvoice-diagnose.json`、`build/windows-zipvoice-diagnose.wav`。完整测试 100 项通过。

Windows 绑定 DSH 会话本身不向其软件窗口注入 VA 人设或聊天历史；从 VA 发给 DSH 的消息会带上 VA 角色提示词和动作规则。Windows 暂不支持原有 DSH 桌面角色插件的自动安装，Codex 聊天记录也不会因为绑定而自动同步给 DSH。

## Agent 保存按钮布局（2026-11-26）

Windows 的 Agent 配置表单将两个选项与右侧「保存设置」按钮放在同一行，并使用主题强调色；窄窗口时按钮另起一行靠右。修复原来按钮落在两列网格左半列、看起来悬在中间的问题。样式仅由 Windows 分支添加的类启用，macOS 保持原样。宽、窄两种窗口的对齐和溢出检查通过，预览在本机 `build/windows-agent-layout-907.png` 和 `build/windows-agent-layout-520.png`。

## Agent 麦克风语音输入（2026-11-26）

Windows 现使用独立的 `desktop/windows-agent-voice.js`，通过隐藏的 Windows PowerShell 调用 System.Speech 识别默认麦克风；不调用 Swift 助手。macOS 仍使用原有 Apple Speech 通路，版本和权限检查保持原样。

使用方法：在「设置 → 智能体接入 → 本地 Agent」绑定发送会话，再点「向 Agent 说话 → 开始监听」。需安装 Windows 语音识别语言组件，并允许桌面应用访问麦克风。优先使用简体中文引擎，其次使用界面语言或其他已安装引擎，状态栏显示实际语言。识别完成后自动发送，发送和朗读期间暂停，停止或切换绑定后丢弃旧识别结果。

本机已验证中文引擎 `zh-CN` 和真实默认麦克风初始化。另用本机合成的中文 WAV 验证原生识别器能输出中文转写，并在父进程输入管道关闭后退出；没有将测试语音发到真实 Agent。合成语音的转写存在错字，识别效果仍需用实际说话验证。本机冒烟记录在忽略提交的 `build/windows-agent-voice-smoke.json`。语音相关测试覆盖重复结果、会话切换、播放暂停和恢复、停止监听及组件错误。

完整测试 100 项通过。Windows x64 打包通过，新版试用入口为 `build/voice-release/VA-win32-x64/VA.exe`；退出正在运行的旧版后再启动此入口，保留整个应用目录。macOS 原生助手及语音控制模块未改动，未在本机进行 macOS 实机回归。

## Windows Agent 创建会话修复（2026-11-26）

本机 `dsh` 解析为 `C:\Users\b\AppData\Roaming\npm\dsh.cmd`。旧的 Windows 终端启动器只接受 EXE/COM，导致点击创建会话、准备运行 `dsh web` 时直接报错。Windows 启动器现支持在工作目录和 PATH 查找 EXE、COM、CMD、BAT，并使用 cross-spawn 处理命令包装脚本和参数，在独立控制台启动。macOS 路径没有改动。

Claude、Codex、OMP、DSH 共用该 Windows 启动器，均支持 CMD/BAT 入口。OMP 不再拒绝新建会话，而是为本次启动生成 `autoResume: false` 的临时配置，避免自动恢复旧会话。Claude 和 OMP 的角色提示词通过临时文件传入，避免 CMD 截断多行内容；进程结束后清理临时配置和提示词。

DSH 优先打开当前用户或系统开始菜单中的 DeepSeek Harness 软件快捷方式，也可识别常见安装目录的 EXE。软件入口不存在或打开失败时，才回退到 `dsh web`。本机通过 Electron 的系统打开接口验证软件启动成功，结果保存在 `build/windows-deepseek-desktop-smoke.json`。

验证：本机 `dsh --help` 成功，Claude Code 2.1.332、OMP 19.1.1、Codex CLI 0.172.0 的版本命令均成功。新增测试执行四种 Agent 的 CMD/BAT 包装脚本，覆盖中文路径、空格、引号、`&` 参数、完整多行提示词、OMP 新会话配置及 DSH 软件启动优先级。完整测试 100 项通过。未发送真实模型对话，打开软件不代表自动创建并绑定会话。

测试日期：2026-11-25（北京时间）。本机验证平台为 Windows x64，测试运行时为 Node.js 24.22.3，打包使用 Electron 45.4.1。ARM64 构建入口已提供，但未在 ARM64 机器上验证。

## 代码同步

- 先将上次的 Windows 改动保存为本地提交 `d3b6ac8`。
- 拉取 `origin/main`，合入远程的 3 个提交，包含 Agent 语音输入和扩展测试。
- 解决 7 个文件冲突，生成合并提交 `98642ce`。保留远程更新及 Windows 分支。
- 本机 GPG 签名失败，这两次提交使用单次关闭签名的方式完成，没有修改全局 Git 配置，没有推送远程。

## 构建与启动

开发环境需要 Node.js 22.12 或更新版本。

```powershell
npm ci
npm run build:win -- --arch=x64
.\dist\VA-win32-x64\VA.exe
```

便携包入口是 `dist/VA-win32-x64/VA.exe`。需要保留整个目录，不能只复制 EXE。目前产物是便携应用目录，并非安装程序。

已有 Electron ZIP 缓存时，可向构建命令传入 `--electron-zip-dir=<ZIP所在目录>`。Windows 构建不调用 Swift 编译，也不要求安装 macOS 原生助手。

命令行示例（在仓库目录运行，确保使用符合版本要求的 Node）：

```powershell
node bin/va.js status --json
node bin/va.js act wave
node bin/va.js say "你好，这是 Windows 版 VA。"
node bin/va.js photo --out .\photo.png
node bin/va.js settings
```

设置快捷键为 `Ctrl+Alt+V`。角色加载完成后，状态应为 `ready`，`model.checked` 为 `true`。

## 实测结果

| 功能 | 结果与验证范围 |
| --- | --- |
| 打包、启动、默认模型 | 通过；运行的是打包后的 EXE，默认封面 VRM 显示正常，无纹理警告 |
| 本机控制接口 | 通过；Windows 命名管道收发命令正常 |
| 动作 | 挥手、点头、跳舞均完成，收到完成回执 |
| 系统音色 | 通过；枚举出 Microsoft Huihui Desktop（中文）及 Microsoft Zira Desktop（英文） |
| 语音合成与播放流程 | 通过；生成有效 RIFF/WAV，中英文台词在应用内执行完成且无语音警告；未以麦克风录音核验实际扬声器输出 |
| 拍照、自拍 | 通过；返回有效 PNG，分别约 390 KB、704 KB |
| 隐藏与显示 | 通过；状态随命令正确变化 |
| 全身与半身 | 通过；切换后恢复原视角 |
| 鼠标穿透 | 通过；开启后状态正确，并恢复原设置 |
| 设置界面 | 通过；已检查窗口画面和可访问性内容，默认模型显示检测通过 |
| 自动化测试 | 87 项通过，0 失败、0 跳过 |
| 本机冒烟检查 | 13 项通过，包含正常操作及不支持功能的错误返回 |

本机详细证据位于忽略提交的 `build/` 目录：`windows-test-output.txt`、`windows-smoke-results.json`、`windows-photo.png`、`windows-selfie.png`。运行日志在启动目录的 `logs/va.log`。

## Windows 兼容改动

- 使用明确的 `win32` 分支及独立的 `windows-speech.js`、`windows-agent.js`，macOS 继续使用原有语音、终端和原生助手路径。
- 系统朗读使用 Windows PowerShell / System.Speech，支持音色枚举、中文默认音色选择及 WAV 合成，后台辅助进程隐藏窗口。
- Windows 使用命名管道替代 Unix socket，在当前用户应用数据目录发布随机管道端点。
- Agent 后台进程使用 Windows 兼容的启动与进程树清理方式；交互式终端支持 EXE、COM、CMD、BAT，失败时提供包含命令名的操作提示。
- Codex 会话标题在 Windows 使用 Node SQLite 读取，保留远程新增的大小写兼容修复；macOS 仍使用原来的 sqlite3 路径。
- Windows 的 ZipVoice 默认 Python 路径是虚拟环境的 `Scripts/python.exe`。参考录音可使用 24 kHz 单声道 16 位 PCM WAV。其他 WAV、M4A 和 MP3 需要将 `ffmpeg.exe` 加入 PATH。
- macOS 专用功能在 Windows 禁用或返回 `UNSUPPORTED_PLATFORM`，避免继续调用缺失的原生组件。设置页使用 Windows 快捷键文案。

## 暂不支持的功能

| 功能 | Windows 当前行为 |
| --- | --- |
| 豆包语音通话的系统音频字幕 | 独立 Windows WASAPI + System.Speech 助手；需明确勾选采集默认扬声器混合声音，包含其他应用 |
| 系统音乐检测后自动跳舞 | 不支持；仍可手动执行舞步。启用请求已实测返回明确错误 |
| DeepSeek Harness 桌面导航及角色插件安装 | 不支持自动操作桌面端；需在其原生界面打开会话后回到 VA 绑定，文字 CLI 能力需另行配置验证 |

## 尚未完成端到端验证

- 本地 Agent 的进程调用、绑定、续聊、回复处理由测试夹具验证通过；本机已检测并验证 Claude、Codex、OMP、DSH 命令入口，没有向真实模型发送对话，账号、模型服务及完整交互仍需另行验证。
- 屏幕观察的采集代码已按平台分支处理，路由逻辑有自动化测试；本轮未将真实桌面截图交给视觉模型，因此不将整个屏幕识别链路列为实测通过。
- 火山 TTS 的响应解析及错误处理测试通过，未调用真实服务；需配置密钥及音色。
- ZipVoice 的预热、合成、取消、异常恢复及超时已通过模拟测试。Windows 需要自行准备 Python、sherpa-onnx、模型和参考音频，真实克隆语音合成仍需验证。
- 托盘对象和全局快捷键已成功注册；未逐项点击托盘菜单或实际按键验证。
- macOS 没有在本机重新构建或运行，保留平台分支不等于完成 macOS 回归实测。

## 拖动名称后控制条变长的修复

2026-11-25 补充：本机复现了 Windows 无边框、不可调整大小的小窗口在移动时尺寸累积增长的问题。旧逻辑连续移动 12 次后，控制条从约 73×41 增长到 86×55，角色窗口高度也发生漂移。

修复仅在 Windows 分支生效：使用相等的最小/最大尺寸限制窗口大小，避免不可调整大小窗口的尺寸缓存反复取整；控制条跟随角色移动时显式维持宽高，并屏蔽程序定位造成的拖动反馈。角色缩放时同步更新 Windows 尺寸限制。macOS 保留原有窗口选项及移动逻辑。

通过本地 Electron 调试接口重复移动 12 次，角色保持 386×517、控制条保持 73×38（本机显示缩放下的窗口边界）；配置按钮内容保持 30×28。另检查 80%/110% 缩放后恢复及重复移动。完整尺寸记录见本机 `build/windows-drag-measurements.json`。桌面截图工具在本轮重试时返回 `unknown or expired node_repl continuation`，因此回归依据是实际窗口和 DOM 尺寸测量，未声称完成鼠标拖拽的逐帧画面验证。
