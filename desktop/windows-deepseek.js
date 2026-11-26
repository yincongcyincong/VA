import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ControlError } from '../lib/control.js';

export const deepSeekPresetUnsupported = error =>
  /runs under agent preset "[^"]+", which the one-shot runner does not compose/u.test(error?.message ?? '');

export function windowsDeepSeekEndpoint(env = process.env) {
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'VA Desktop', 'deepseek-bridge.endpoint.json');
}

export async function installWindowsDeepSeekBridge({
  home = process.env.DSH_HOME || join(homedir(), '.dsh'), endpoint = windowsDeepSeekEndpoint(),
} = {}) {
  const profile = join(home, 'profiles', 'desktop');
  const patch = join(profile, 'cordis.patch.yml');
  const plugin = join(profile, 'va-harness', 'windows-bridge.mjs');
  const previous = await readFile(patch, 'utf8').catch(() => {
    throw new ControlError('DEEPSEEK_PROFILE', '请先打开 DeepSeek Harness 桌面端完成初始化。');
  });
  const row = '    - id: va-windows-bridge';
  const registration = `- insert:\n${row}\n      name: ${JSON.stringify(plugin)}\n      config:\n        endpoint: ${JSON.stringify(endpoint)}\n`;
  if (previous.includes(row) && !previous.includes(registration)) {
    throw new ControlError('DEEPSEEK_PROFILE', 'DeepSeek 的 VA 桥接配置已被修改，请检查 desktop/cordis.patch.yml。');
  }
  const source = await readFile(new URL('./windows-deepseek-plugin.js', import.meta.url));
  const old = await readFile(plugin).catch(() => undefined);
  const configured = previous.includes(registration);
  await mkdir(join(profile, 'va-harness'), { recursive: true });
  async function replace(path, data) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  if (!old?.equals(source)) await replace(plugin, source);
  if (!configured) {
    if (await readFile(patch, 'utf8') !== previous) throw new ControlError('DEEPSEEK_PROFILE', 'DeepSeek 配置刚刚变更，请重试。');
    await replace(patch, previous + (previous.endsWith('\n') ? '' : '\n') + registration);
  }
  return { restart: !configured || !old?.equals(source) };
}

export async function runWindowsDeepSeek(agent, input, signal, { endpoint = windowsDeepSeekEndpoint() } = {}) {
  signal.throwIfAborted();
  const info = await readFile(endpoint, 'utf8').then(JSON.parse).catch(() => undefined);
  if (!/^\\\\\.\\pipe\\va-deepseek-[a-f0-9-]{36}$/i.test(info?.pipe ?? '') || !/^[a-f0-9]{64}$/.test(info?.token ?? '')) {
    await installWindowsDeepSeekBridge({ endpoint });
    throw new ControlError('DEEPSEEK_RESTART', '已安装 Windows 会话桥接，请退出并重新打开 DeepSeek Harness，再开启监听。');
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: info.pipe, signal });
    let output = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(80_000, () => finish(new ControlError('AGENT_TIMEOUT', '等待 DeepSeek 回复超时。')));
    socket.once('connect', () => socket.write(JSON.stringify({ token: info.token, requestId: randomUUID(), input }) + '\n'));
    socket.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 1024 * 1024) return finish(new ControlError('AGENT_OUTPUT', 'DeepSeek 回复过长。'));
      if (!output.includes('\n')) return;
      try {
        const reply = JSON.parse(output.slice(0, output.indexOf('\n')));
        if (!reply.ok) return finish(new ControlError(reply.error?.code || 'AGENT_FAILED', reply.error?.message || 'DeepSeek 会话发送失败。'));
        if (reply.sessionId !== input.sessionId || typeof reply.reply !== 'string' || !reply.reply.trim()) {
          return finish(new ControlError('AGENT_OUTPUT', 'DeepSeek 返回了无效或不一致的会话回复。'));
        }
        finish(null, { reply: reply.reply, sessionId: reply.sessionId });
      } catch { finish(new ControlError('AGENT_OUTPUT', 'DeepSeek 桥接响应无效。')); }
    });
    socket.once('error', () => finish(signal.aborted ? signal.reason : new ControlError('DEEPSEEK_RESTART',
      '无法连接 DeepSeek 桌面会话桥接，请重新打开 DeepSeek Harness。')));
    socket.once('close', () => finish(signal.aborted ? signal.reason : new ControlError('AGENT_FAILED', 'DeepSeek 桥接在回复前断开。')));
  });
}
