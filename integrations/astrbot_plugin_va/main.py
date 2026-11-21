import asyncio
import json
import re
import shlex

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import Image, Plain
from astrbot.api.star import Context, Star, register


class VAError(Exception):
    pass


@register("astrbot_plugin_va", "VA", "把 AstrBot 频道回复显示在 VA 桌面角色旁", "0.2.0")
class VAPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

    def allowed(self, event):
        return event.is_admin() or str(event.get_sender_id()) in {
            str(user) for user in self.config.get("allowed_user_ids", [])
        }

    def invocation(self):
        command = shlex.split(self.config.get("command", "va"))
        if not command:
            raise VAError("请配置 VA 命令。")
        command.append("bridge")
        host = self.config.get("ssh_host", "").strip()
        if not host:
            return command
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", host):
            raise VAError("请填写有效的 SSH 主机别名。")
        return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", host, shlex.join(command)]

    async def call(self, op, **kwargs):
        payload = json.dumps({"op": op, "platform": "astrbot", **kwargs}, ensure_ascii=False).encode()
        try:
            process = await asyncio.create_subprocess_exec(
                *self.invocation(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, ValueError) as error:
            raise VAError("无法运行 VA 命令，请检查路径和 SSH 设置。") from error
        try:
            output, _ = await asyncio.wait_for(process.communicate(payload), 5 if op == "input" else 85)
        except (asyncio.TimeoutError, asyncio.CancelledError) as error:
            if process.returncode is None:
                process.kill()
            await process.wait()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise VAError("等待 VA 回复超时。") from error
        try:
            result = json.loads(output)
        except (UnicodeError, ValueError) as error:
            raise VAError("VA 连接失败，请检查命令路径、权限或 SSH 连接。") from error
        if not isinstance(result, dict) or not result.get("ok"):
            message = result.get("error", {}).get("message") if isinstance(result, dict) else None
            raise VAError(message or "VA 执行失败。")
        return result

    @filter.event_message_type(filter.EventMessageType.ALL, priority=10)
    async def handle_va_input(self, event: AstrMessageEvent):
        text = event.message_str.strip()
        if not self.allowed(event) or not re.search(r"跳|舞|\bdance\b", text, re.IGNORECASE):
            return
        try:
            result = await self.call("input", origin={"target": event.unified_msg_origin}, text=text[:2200])
            if result.get("accepted"):
                yield event.plain_result(result["reply"]).stop_event()
        except VAError as error:
            logger.warning("VA 入站消息：%s", error)

    @filter.after_message_sent()
    async def mirror_reply(self, event: AstrMessageEvent):
        if re.match(r"^/?va(?:\s|$)", event.message_str.strip(), re.IGNORECASE):
            return
        result = event.get_result()
        text = "".join(part.text for part in (getattr(result, "chain", None) or [])
                       if isinstance(part, Plain)).strip()
        if not text:
            return
        origin = event.unified_msg_origin
        try:
            route = (await self.call("route")).get("route")
            if route and route["target"] == origin:
                await self.call("present", origin={"target": origin}, text=text[:1000])
        except VAError as error:
            logger.warning("VA 回复镜像：%s", error)

    @staticmethod
    def message_tail(event):
        parts = event.message_str.strip().split(maxsplit=2)
        return parts[2] if len(parts) == 3 else ""

    @filter.command_group("va")
    def va():
        pass

    @va.command("chat")
    async def chat_command(self, event: AstrMessageEvent):
        yield event.plain_result("请直接和 AstrBot 对话，VA 会显示已选频道的回复。").stop_event()

    @va.command("route")
    async def route_command(self, event: AstrMessageEvent):
        if self.allowed(event):
            yield event.plain_result(event.unified_msg_origin).stop_event()

    @va.command("say")
    async def say_command(self, event: AstrMessageEvent):
        if not self.allowed(event):
            return
        try:
            result = await self.call("say", speech=self.message_tail(event))
            yield event.plain_result(result["speech"]).stop_event()
        except VAError as error:
            yield event.plain_result(str(error)).stop_event()

    @va.command("act")
    async def act_command(self, event: AstrMessageEvent, action: str):
        if not self.allowed(event):
            return
        try:
            result = await self.call("perform", action=action)
            yield event.plain_result(result["speech"]).stop_event()
        except VAError as error:
            yield event.plain_result(str(error)).stop_event()

    @va.command("selfie")
    async def selfie_command(self, event: AstrMessageEvent):
        if not self.allowed(event):
            return
        try:
            result = await self.call("selfie")
            yield event.chain_result([Image.fromBase64(result["image"]["data"])]).stop_event()
        except VAError as error:
            yield event.plain_result(str(error)).stop_event()

    @filter.llm_tool(name="va_desktop_selfie")
    async def selfie_tool(self, event: AstrMessageEvent):
        """用户明确请求自拍时，把 VA 的照片发到当前对话。"""
        if not self.allowed(event):
            return "这个账号没有 VA 控制权限。"
        try:
            result = await self.call("selfie")
            await event.send(MessageChain([Image.fromBase64(result["image"]["data"])]))
            return "VA 自拍已发送到当前对话。"
        except VAError as error:
            return str(error)
