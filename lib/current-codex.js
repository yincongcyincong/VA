import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { findSessionFile } from '../desktop/session-replies.js';
import { ControlError, request } from './control.js';
import { startDesktop } from './start.js';

export async function readCodexSession(id, env = process.env) {
  if (typeof id !== 'string' || !id) {
    throw new ControlError('CODEX_THREAD_UNAVAILABLE', '当前环境没有 Codex 会话 ID。请从这条 Codex 会话执行绑定。');
  }
  const path = await findSessionFile('codex', id, env);
  if (!path) throw new ControlError('CODEX_THREAD_UNAVAILABLE', '本机找不到这条 Codex 会话的记录。');

  const input = createReadStream(path, { end: 1024 * 1024 - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      const meta = event.type === 'session_meta' ? event.payload : undefined;
      if (meta?.id?.toLowerCase() !== id.toLowerCase() || typeof meta.cwd !== 'string' || !isAbsolute(meta.cwd)) break;
      const cwd = await realpath(meta.cwd);
      if ((await stat(cwd)).isDirectory()) return { id: id.toLowerCase(), cwd };
      break;
    }
  } catch {
    // A moved project or an unreadable header cannot identify a bindable session.
  } finally {
    lines.close();
    input.destroy();
  }
  throw new ControlError('CODEX_THREAD_UNAVAILABLE', '无法从 Codex 会话记录确认工作目录，请检查原项目是否仍在本机。');
}

export async function bindCurrentCodex(parameters) {
  const id = parameters?.id ?? (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID);
  const session = await readCodexSession(id);
  const status = await request({ type: 'status' }).catch(error => {
    if (error.code !== 'NOT_RUNNING') throw error;
    return startDesktop();
  });
  if (status.sessionBindingPolicy !== true) {
    throw new ControlError('VA_UPDATE_REQUIRED', '请退出当前 VA 并启动支持会话绑定设置的新版后重试。');
  }
  return request({ type: 'configuration', operation: 'run', target: 'chat-bind-current', value: { id: session.id } });
}
