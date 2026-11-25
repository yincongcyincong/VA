# AstrBot 和 OpenClaw 接入 VA

[VA 使用手册](../README.md#openclaw-和-astrbot)汇总了频道、自拍、动作和语音的用法。

在 VA 打开「设置 → 智能体接入」，选择 **AstrBot** 或 **OpenClaw**。机器人按正常流程调用自己配置的模型并发送频道回复。VA 插件监听已发送的文字，只把选定频道的回复显示在桌面角色旁。是否朗读可在 VA 的频道设置里选择。机器人模型密钥在各自的配置里管理。选用机器人接入时，屏幕观察暂停。macOS 上可在「屏幕与音乐」开启本机音乐检测。

## 安装与配对

仓库包含两个插件的源码，安装包由本机生成。在仓库根目录运行 `bash scripts/package.sh integrations`，需要 Node.js、npm、Make 和 `zip`。输出在 `dist/integrations/`。

- **AstrBot** 在管理面板的「插件 → 安装插件 → 从文件安装」上传 `dist/integrations/astrbot_plugin_va.zip`。设置 `command` 为 Bot 运行环境可执行的 VA 命令，例如 `va`，远端可设置 `ssh_host`。在目标频道用授权账号运行 `/va route`，把返回的 UMO 填入 VA 的「目标频道」。插件监听 AstrBot 的 `after_message_sent`。部分 AstrBot 版本对流式发送不触发该钩子，这类频道需要更新 AstrBot 或关闭流式发送。[AstrBot 插件安装](https://docs.astrbot.app/use/plugin.html)
- **OpenClaw** 在 Gateway 所在环境进入 VA 仓库，运行 `openclaw plugins install --link "$PWD/integrations/openclaw"`。也可以用 `openclaw plugins install` 安装生成的 `dist/integrations/openclaw-va-desktop-<版本>.tgz`。把插件的 `command` 配置成命令数组，可按部署选择 `sshHost`。在目标频道运行 `/va route`，将返回的 `channel`、`target`、`accountId` 和 `sessionKey` 填入 VA。插件监听 Gateway 的 `message_sent`，成功送出的消息才镜像。[OpenClaw 插件安装](https://docs.openclaw.ai/cli/plugins/install)

同一台 Mac 上，Bot 和 VA 需以同一登录用户运行。远端机器可通过已验证主机密钥的 SSH 主机别名运行同一个 VA 命令。例如插件命令可以指定 `/opt/homebrew/bin/node /Users/你的用户名/VA/bin/va.js`。连接测试可在 Bot 的运行环境执行：

```sh
printf '%s\n' '{"op":"status"}' | va bridge
printf '%s\n' '{"op":"route","platform":"astrbot"}' | va bridge
```

Docker Desktop 可通过 [目录桥接脚本](docker/bridge.py) 访问 VA。宿主机运行 `python3 integrations/docker/bridge.py host <私有目录> --command <VA绝对路径>`，并把该目录下对应的 `astrbot` 或 `openclaw` 子目录单独挂载到容器的 `/va-bridge`。容器需只读挂载脚本到 `/opt/va-bridge.py`，插件命令填 `python3 /opt/va-bridge.py client /va-bridge`。两个 Bot 使用同一个 Telegram token 时，同一时间只开启一个 Telegram 适配器。

更新插件后重启对应的机器人。Docker 方式还需重启宿主机的桥接进程。授权用户在 VA 配置的频道发「跳个舞吧」时，插件把请求交给 VA 本机处理，普通对话仍由机器人回复。OpenClaw 使用 `before_dispatch`，AstrBot 使用入站消息监听。

配对后就在 Bot 频道照常对话。授权账号可用 `/va selfie` 将角色 PNG 发回频道，也可用 `/va act dance` 让桌面角色跳舞。OpenClaw 工具策略可允许 `va_desktop_say`、`va_desktop_act`、`va_desktop_selfie` 和 `va_desktop_status`，AstrBot 也注册了 `va_desktop_selfie`。VA 关闭时跳过镜像，已错过的回复不补发。

参考 [AstrBot 发送后事件](https://docs.astrbot.app/dev/star/guides/listen-message-event.html) 和 [OpenClaw 消息与送达事件](https://docs.openclaw.ai/plugins/hooks/messages)。
