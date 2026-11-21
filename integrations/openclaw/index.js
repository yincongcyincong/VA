import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const platform = 'openclaw';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function run(argv, { input, signal, timeout = 85_000 } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const aborted = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { signal: aborted, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 34 * 1024 * 1024) {
        child.kill();
        reject(new Error('VA 响应过大。'));
      } else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.once('error', error => reject(new Error(error.name === 'AbortError'
      ? '等待 VA 或频道服务超时。' : '无法执行命令，请检查 VA、SSH 或 OpenClaw 的路径。')));
    child.once('close', code => resolve({ code, output: Buffer.concat(chunks).toString('utf8') }));
    child.stdin.end(input);
  });
}

function makeBridge(config) {
  const command = [...(config.command ?? ['va']), 'bridge'];
  const host = config.sshHost?.trim();
  return async (input, signal, timeout) => {
    if (host && !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(host)) throw new Error('请填写有效的 SSH 主机别名。');
    const argv = host
      ? ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', host, command.map(quote).join(' ')]
      : command;
    const { output } = await run(argv, { input: JSON.stringify({ platform, ...input }), signal, timeout });
    let reply;
    try {
      reply = JSON.parse(output);
    } catch {
      throw new Error('VA 连接失败，请检查命令和 SSH 设置。');
    }
    if (!reply?.ok) throw new Error(reply?.error?.message || 'VA 执行失败。');
    return reply;
  };
}

const action = { type: 'string', enum: [
  'wave', 'nod', 'bow', 'laugh', 'dance', 'dance-side', 'dance-spin', 'dance-bounce', 'pose', 'pet',
] };
const speech = { type: 'string', maxLength: 300 };
const definition = [
  ['say', 'Speak on VA', '让 VA 朗读指定台词。', { speech }, ['speech']],
  ['act', 'Animate VA', '让 VA 做动作，可提供一句台词。', { action, speech }, ['action']],
  ['selfie', 'VA selfie', '用户请求自拍时让 VA 拍照并返回 PNG。', { speech }, []],
  ['status', 'VA status', '读取 VA 桌面角色状态。', {}, []],
];

export default {
  id: 'va-desktop',
  name: 'VA 桌面角色',
  description: '把 OpenClaw 频道回复显示在 VA 桌面角色旁。',
  register(api) {
    const config = api.pluginConfig ?? {};
    const bridge = makeBridge(config);
    api.on('before_dispatch', async (event, ctx) => {
      const text = typeof event.content === 'string' ? event.content.trim() : '';
      if (!/跳|舞|\bdance\b/iu.test(text) || !ctx.conversationId) return;
      const channel = ctx.channelId ?? event.channel;
      const conversation = String(ctx.conversationId);
      const target = conversation.startsWith(channel + ':') ? conversation : channel + ':' + conversation;
      try {
        const result = await bridge({ op: 'input', text: text.slice(0, 2200),
          origin: { channel, target, accountId: ctx.accountId, sessionKey: ctx.sessionKey } }, undefined, 5000);
        if (result.accepted) return { handled: true, text: result.reply };
      } catch (error) {
        api.logger.warn('VA 入站消息：' + error.message);
      }
    });
    api.on('message_sent', async (event, ctx) => {
      const content = typeof event.content === 'string' ? event.content.trim() : '';
      if (event.success !== true || !content) return;
      try {
        const { route } = await bridge({ op: 'route' }, undefined, 5000);
        const origin = { channel: ctx?.channelId ?? event.channelId, accountId: ctx?.accountId ?? event.accountId,
          target: event.to, sessionKey: ctx?.sessionKey };
        if (!route || origin.channel !== route.channel || (route.accountId && origin.accountId !== route.accountId)) return;
        if (route.sessionKey && origin.sessionKey ? origin.sessionKey !== route.sessionKey : origin.target !== route.target) return;
        await bridge({ op: 'present', origin, text: content.slice(0, 2000) }, undefined, 5000);
      } catch (error) {
        api.logger.warn('VA 回复镜像：' + error.message);
      }
    });

    api.registerCommand({
      name: 'va',
      description: '与桌面角色阿哈对话、做动作或自拍。',
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim() ?? '';
        const [, verb = '', argument = ''] = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args) ?? [];
        try {
          if (verb === 'route') {
            return { text: JSON.stringify({
              channel: ctx.channelId ?? ctx.channel, target: ctx.from,
              accountId: ctx.accountId, sessionKey: ctx.sessionKey,
            }, null, 2) };
          }
          if (verb === 'selfie') {
            const result = await bridge({ op: 'selfie', speech: argument || undefined });
            const state = api.runtime?.state?.resolveStateDir?.(process.env) ?? process.env.OPENCLAW_STATE_DIR
              ?? join(homedir(), '.openclaw');
            const folder = join(state, 'media', 'outbound');
            const path = join(folder, 'va-' + randomUUID() + '.png');
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await writeFile(path, Buffer.from(result.image.data, 'base64'), { mode: 0o600, flag: 'wx' });
            setTimeout(() => { void rm(path, { force: true }).catch(() => {}); }, 15 * 60_000).unref();
            return { text: result.speech, mediaUrl: path };
          }
          if (verb === 'say' || verb === 'act') {
            const result = await bridge(verb === 'say' ? { op: 'say', speech: argument }
              : { op: 'perform', action: argument });
            return { text: result.speech };
          }
          if (verb === 'chat') return { text: '请直接和 OpenClaw 对话，VA 会显示已选频道的回复。' };
          return { text: '用法：/va say 台词，/va act 动作，/va selfie，/va route。' };
        } catch (error) {
          return { text: error.message };
        }
      },
    });

    for (const [op, label, description, properties, required] of definition) {
      const name = 'va_desktop_' + op;
      api.registerTool(() => ({
        name, label, description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        async execute(_id, params, signal) {
          try {
            const result = await bridge({ ...params, op: op === 'act' ? 'perform' : op }, signal);
            const { image, ...details } = result;
            const content = [{ type: 'text', text: details.speech || JSON.stringify(details) }];
            if (image) content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
            return { content, details };
          } catch (error) {
            return { content: [{ type: 'text', text: error.message }], details: { ok: false } };
          }
        },
      }), { name, optional: true, workspaceAccess: false });
    }
  },
};
