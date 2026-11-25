# Windows 版本适配与本机测试

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
- Agent 后台进程使用 Windows 兼容的启动与进程树清理方式；交互式终端要求原生 EXE/COM，失败时提供操作提示。
- Codex 会话标题在 Windows 使用 Node SQLite 读取，保留远程新增的大小写兼容修复；macOS 仍使用原来的 sqlite3 路径。
- Windows 的 ZipVoice 默认 Python 路径改为虚拟环境的 `Scripts/python.exe`；测试中的模拟解释器改为显式由 Node 启动，避免 Windows 不执行 shebang 文件。
- macOS 专用功能在 Windows 禁用或返回 `UNSUPPORTED_PLATFORM`，避免继续调用缺失的原生组件。设置页使用 Windows 快捷键文案。

## 暂不支持的功能

| 功能 | Windows 当前行为 |
| --- | --- |
| 豆包客户端绑定、桌面联动、通话字幕 | 依赖 macOS 原生助手，Windows 禁用入口并返回明确错误 |
| 系统音乐检测后自动跳舞 | 不支持；仍可手动执行舞步。启用请求已实测返回明确错误 |
| Agent 麦克风语音输入 | 远程新增实现依赖 macOS 26 原生助手；Windows 禁用按钮并提示使用文字输入 |
| DeepSeek Harness 桌面导航及角色插件安装 | 不支持自动操作桌面端；需在其原生界面打开会话后回到 VA 绑定，文字 CLI 能力需另行配置验证 |
| OMP 自动新建终端会话 | Windows 需先手动创建会话，再回到 VA 绑定 |

## 尚未完成端到端验证

- 本地 Agent 的进程调用、绑定、续聊、回复处理由测试夹具验证通过；没有向真实模型发送对话。本机检测到 Codex，但未验证其账号、模型服务及完整交互。Claude、OMP、DeepSeek Harness 需要先安装相应程序。
- 屏幕观察的采集代码已按平台分支处理，路由逻辑有自动化测试；本轮未将真实桌面截图交给视觉模型，因此不将整个屏幕识别链路列为实测通过。
- 火山 TTS 的响应解析及错误处理测试通过，未调用真实服务；需配置密钥及音色。
- ZipVoice 的预热、合成、取消、异常恢复及超时测试通过；本机未安装模型并完成真实克隆语音合成。Windows 需自行准备 Python、sherpa-onnx、模型和参考音频，原有 `make zipvoice-tts` 安装流程未验证。
- 托盘对象和全局快捷键已成功注册；未逐项点击托盘菜单或实际按键验证。
- macOS 没有在本机重新构建或运行，保留平台分支不等于完成 macOS 回归实测。
