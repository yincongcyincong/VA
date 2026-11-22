import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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

function matchesRoute(route, origin) {
  return route && route.channel === origin.channel && route.target === origin.target
    && (!route.accountId || route.accountId === origin.accountId);
}

function channelTarget(channel, id) {
  if (!channel || !id) return;
  const target = String(id);
  return target.startsWith(channel + ':') ? target : channel + ':' + target;
}

const promptStart = '<!-- VA DESKTOP PROMPT START -->';
const promptEnd = '<!-- VA DESKTOP PROMPT END -->';

export async function syncWorkspacePrompt(workspace, prompt) {
  const path = join(workspace, 'SOUL.md');
  const prior = await readFile(path, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const start = prior.indexOf(promptStart);
  const end = prior.indexOf(promptEnd);
  const section = `${promptStart}\n${prompt.trim()}\n${promptEnd}`;
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('SOUL.md 中的 VA Prompt 标记不完整。');
  const next = start < 0 ? `${prior.trimEnd()}${prior.trim() ? '\n\n' : ''}${section}\n`
    : prior.slice(0, start) + section + prior.slice(end + promptEnd.length);
  if (next === prior) return;
  const temporary = join(workspace, '.va-prompt-' + randomUUID());
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

const presetId = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' };
const speech = { type: 'string', maxLength: 300 };
const definition = [
  ['say', 'Speak on VA', '让 VA 朗读指定台词。', { speech, expression: presetId }, ['speech']],
  ['act', 'Animate VA', '使用 va_desktop_actions 返回的编号做动作。', { action: presetId, expression: presetId, speech }, ['action']],
  ['selfie', 'VA selfie', '用户请求自拍时让 VA 拍照并返回 PNG。', { speech, expression: presetId }, []],
  ['actions', 'VA actions', '列出 VA 的动作和表情，包括用户添加的配置。', {}, []],
  ['status', 'VA status', '读取 VA 桌面角色状态。', {}, []],
];

export default {
  id: 'va-desktop',
  name: 'VA 桌面角色',
  description: '把 OpenClaw 频道回复显示在 VA 桌面角色旁。',
  register(api) {
    const config = api.pluginConfig ?? {};
    const bridge = makeBridge(config);
    const workspace = api.config?.agents?.defaults?.workspace;
    const canSyncPrompt = config.workspacePrompt === true && typeof workspace === 'string' && isAbsolute(workspace);

    async function stageSelfie(speech) {
      const result = await bridge({ op: 'selfie', speech });
      const state = api.runtime?.state?.resolveStateDir?.(process.env) ?? process.env.OPENCLAW_STATE_DIR
        ?? join(homedir(), '.openclaw');
      const folder = join(state, 'media', 'outbound');
      const path = join(folder, 'va-' + randomUUID() + '.png');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(result.image.data, 'base64'), { mode: 0o600, flag: 'wx' });
      setTimeout(() => { void rm(path, { force: true }).catch(() => {}); }, 15 * 60_000).unref();
      return { mediaUrl: path, folder };
    }

    api.on('before_dispatch', async (event, ctx) => {
      const text = typeof event.content === 'string' ? event.content.trim() : '';
      if (!ctx.conversationId || !text || text.length > 2200 || text.startsWith('/')) return;
      const channel = ctx.channelId ?? event.channel;
      const target = channelTarget(channel, ctx.conversationId);
      const origin = { channel, target, accountId: ctx.accountId, sessionKey: ctx.sessionKey };
      let result;
      try {
        result = await bridge({ op: 'input', text, origin }, undefined, 5000);
      } catch (error) {
        api.logger.warn('VA 入站消息：' + error.message);
        return;
      }
      if (result.handled === 'selfie') {
        const loadAdapter = api.runtime?.channel?.outbound?.loadAdapter;
        const outbound = await loadAdapter?.(channel).catch(() => undefined);
        if (!outbound?.sendMedia) return { handled: true, text: 'Telegram 附件通道暂时不可用。可以试试 /va selfie。' };
        let photo;
        try {
          photo = await stageSelfie();
        } catch (error) {
          return { handled: true, text: 'VA 自拍失败。' + error.message };
        }
        try {
          // before_dispatch replies carry text only. Send the PNG using the channel's outbound adapter.
          await outbound.sendMedia({ cfg: api.config, to: target, accountId: ctx.accountId,
            text: '', mediaUrl: photo.mediaUrl, mediaLocalRoots: [photo.folder],
            signal: AbortSignal.timeout(30_000) });
          return { handled: true };
        } catch {
          api.logger.warn('VA 自拍：Telegram 附件发送失败。');
          return { handled: true, text: 'VA 已拍照，Telegram 附件发送失败。请稍后再试。' };
        } finally {
          await rm(photo.mediaUrl, { force: true }).catch(() => {});
        }
      }

      if (result.accepted) return { handled: true, text: result.reply };
      if (canSyncPrompt) {
        try {
          const { accepted, prompt } = await bridge({ op: 'prompt', origin }, undefined, 5000);
          if (accepted && prompt) await syncWorkspacePrompt(workspace, prompt);
        } catch (error) {
          api.logger.warn('VA 角色 Prompt：' + error.message);
        }
      }
    });
    api.on('message_sent', async (event, ctx) => {
      const content = typeof event.content === 'string' ? event.content.trim() : '';
      if (event.success !== true || !content) return;
      try {
        const { route } = await bridge({ op: 'route' }, undefined, 5000);
        const channel = ctx?.channelId ?? event.channelId;
        const origin = { channel, accountId: ctx?.accountId ?? event.accountId,
          target: channelTarget(channel, event.to), sessionKey: ctx?.sessionKey };
        if (!matchesRoute(route, origin) || (route.sessionKey && origin.sessionKey && origin.sessionKey !== route.sessionKey)) return;
        await bridge({ op: 'present', origin, text: content.slice(0, 2000) }, undefined, 5000);
      } catch (error) {
        api.logger.warn('VA 回复镜像：' + error.message);
      }
    });

    api.registerCommand({
      name: 'va',
      description: '与 VA 桌面角色对话、做动作或自拍。',
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
            const { mediaUrl } = await stageSelfie(argument || undefined);
            return { text: '', mediaUrl };
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
            const content = image ? [{ type: 'image', mimeType: image.mimeType, data: image.data }]
              : [{ type: 'text', text: details.speech || JSON.stringify(details) }];
            return { content, details };
          } catch (error) {
            return { content: [{ type: 'text', text: error.message }], details: { ok: false } };
          }
        },
      }), { name, optional: true, workspaceAccess: false });
    }
  },
};
