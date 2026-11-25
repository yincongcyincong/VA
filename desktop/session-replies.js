import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as zlib from 'node:zlib';
import { deepSeekArchives, deepSeekHome, deepSeekSessionId } from './deepseek-sessions.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const readSize = 128 * 1024;
const maxLine = 1024 * 1024;
const maxFrame = 8 * 1024 * 1024;
const frameMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function sessionIdSupported(provider, id) {
  if (provider === 'deepseekharness') return deepSeekSessionId(id);
  return ['codex', 'claude', 'omp'].includes(provider) && uuid.test(id ?? '');
}

export const replySessionKey = (provider, id) => `${provider}:${provider === 'custom' ? id : id.toLowerCase()}`;

export function supportsSessionReplies(provider, id) {
  return sessionIdSupported(provider, id) &&
    (provider !== 'deepseekharness' || typeof zlib.zstdDecompressSync === 'function');
}

export async function findSessionFile(provider, id, env = process.env) {
  if (!sessionIdSupported(provider, id)) return;
  id = id.toLowerCase();
  const { CODEX_HOME, CLAUDE_CONFIG_DIR, OMP_CODING_AGENT_DIR, PI_CODING_AGENT_DIR } = env;
  const roots = {
    codex: join(CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
    claude: join(CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    omp: join(OMP_CODING_AGENT_DIR || PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent'), 'sessions'),
    deepseekharness: join(deepSeekHome(env), 'sessions'),
  };
  const deepseek = provider === 'deepseekharness';
  if (deepseek) {
    const projects = await readdir(roots[provider], { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectPath = join(roots[provider], project.name);
      const folders = await readdir(projectPath, { withFileTypes: true });
      const session = folders.find(folder => folder.isDirectory() && folder.name.toLowerCase() === id);
      if (!session) continue;
      const folder = join(projectPath, session.name);
      const files = await readdir(folder, { withFileTypes: true });
      const file = files.find(entry => entry.isFile() && entry.name === 'session.v4.jsonl.zstd');
      if (file) return join(folder, file.name);
    }
    return;
  }
  const matches = name => provider === 'claude'
    ? name.toLowerCase() === `${id}.jsonl` : name.toLowerCase().endsWith(`_${id}.jsonl`) ||
      name.toLowerCase().endsWith(`-${id}.jsonl`) || name.toLowerCase() === `${id}.jsonl`;

  async function search(folder, depth) {
    const entries = await readdir(folder, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    const file = entries.find(entry => entry.isFile() && matches(entry.name));
    if (file) return join(folder, file.name);
    if (depth > 0) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await search(join(folder, entry.name), depth - 1);
        if (found) return found;
      }
    }
  }

  return search(roots[provider], provider === 'codex' ? 3 : 1);
}

function deepSeekReply(state, event) {
  const { turn, message, reason } = event.data ?? {};
  if (!Number.isSafeInteger(turn)) return;
  if (event.type === 'assistant/message' && message?.role === 'assistant' &&
      Array.isArray(message.content)) {
    const text = message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n');
    state.turnReply = { id: turn, text: message.content.some(part => part?.type === 'tool-call') ? '' : text };
  }
  if (event.type === 'turn/end' && state.turnReply?.id === turn) {
    const reply = state.turnReply;
    state.turnReply = undefined;
    if (reason?.kind === 'completed') return reply;
  }
}

export function readDeepSeekFrames(state, bytes) {
  const buffer = state.frames.length ? Buffer.concat([state.frames, bytes]) : bytes;
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = buffer.indexOf(frameMagic, offset);
    if (start === -1) {
      offset = Math.max(offset, buffer.length - frameMagic.length + 1);
      break;
    }
    try {
      const { buffer: frame, engine } = zlib.zstdDecompressSync(buffer.subarray(start), {
        info: true, maxOutputLength: maxFrame,
      });
      if (!engine.bytesWritten) break;
      frames.push(frame);
      offset = start + engine.bytesWritten;
    } catch (error) {
      if (error.code === 'Z_BUF_ERROR' && buffer.length - start <= maxFrame) {
        offset = start;
        break;
      }
      offset = start + frameMagic.length;
      state.turnReply = undefined;
      state.pending = '';
      state.decoder = new StringDecoder('utf8');
    }
  }
  state.frames = buffer.subarray(offset);
  return frames;
}

function finishedReply(state, event) {
  const { provider } = state;
  if (provider === 'deepseekharness') return deepSeekReply(state, event);
  if (provider === 'codex') {
    const { type, turn_id, last_agent_message, error } = event.payload ?? {};
    if (event.type === 'event_msg' && type === 'task_complete' && turn_id && !error) {
      return { id: turn_id, text: last_agent_message };
    }
    return;
  }
  const message = event.message;
  const claude = provider === 'claude';
  const final = claude
    ? event.type === 'assistant' && message?.stop_reason === 'end_turn' && !event.isSidechain && !event.isApiErrorMessage
    : event.type === 'message' && message?.role === 'assistant' && message.stopReason === 'stop';
  if (!final) return;
  const id = claude ? message.id : event.id;
  const text = Array.isArray(message.content) && message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  if (id && text) return { id, text };
}

export function createSessionReplies({ present, paused = () => false, onError = () => {}, env = process.env, interval = 750 }) {
  const sessions = new Map();
  const tracking = state => sessions.get(state.scope) === state;

  function next(state, delay = interval) {
    if (!tracking(state)) return;
    state.timer = setTimeout(() => void poll(state), delay);
    state.timer.unref();
  }

  function deliver(state) {
    while (tracking(state) && state.deliveries.length && !paused(state) && present(state.deliveries[0], state)) {
      state.deliveries.shift();
    }
  }

  async function poll(state, baseline = false) {
    let file;
    try {
      if (!tracking(state) || (!baseline && paused(state))) return;
      if (state.provider === 'deepseekharness' && (await deepSeekArchives(env)).has(state.id)) {
        state.deliveries.length = 0;
        state.turnReply = undefined;
        return;
      }
      deliver(state);
      if (state.deliveries.length) return;
      state.path ??= await findSessionFile(state.provider, state.id, env);
      if (!state.path) return;
      file = await open(state.path, 'r');
      const { size, dev, ino } = await file.stat();
      if (!tracking(state) || (!baseline && paused(state))) return;
      const identity = `${dev}:${ino}`;
      if (baseline || (state.fileId && (state.fileId !== identity || size < state.offset))) {
        state.offset = size;
        state.pending = '';
        state.dropping = false;
        state.decoder = new StringDecoder('utf8');
        state.frames = Buffer.alloc(0);
        state.turnReply = undefined;
      }
      state.fileId = identity;
      let batches = 4;
      const replies = new Map();
      while (state.offset < size && batches-- > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(readSize, size - state.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, state.offset);
        if (!bytesRead || !tracking(state)) break;
        state.offset += bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        const chunks = state.provider === 'deepseekharness' ? readDeepSeekFrames(state, bytes) : [bytes];
        const lines = (state.pending + chunks.map(chunk => state.decoder.write(chunk)).join('')).split('\n');
        state.pending = lines.pop();
        if (state.dropping && lines.length > 0) {
          lines.shift();
          state.dropping = false;
        }
        if (state.pending.length > maxLine) {
          state.pending = '';
          state.dropping = true;
        }
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          const reply = event && finishedReply(state, event);
          if (typeof reply?.text !== 'string' || !reply.text.trim() || state.seen.has(reply.id)) continue;
          const prior = replies.get(reply.id);
          if (!prior) replies.set(reply.id, reply.text.trim());
          else if (prior !== reply.text.trim()) replies.set(reply.id, prior + '\n' + reply.text.trim());
        }
      }
      for (const [id, text] of replies) {
        if (!tracking(state)) break;
        state.seen.add(id);
        if (state.seen.size > 100) state.seen.delete(state.seen.values().next().value);
        state.deliveries.push(text);
      }
      deliver(state);
    } catch (error) {
      if (error.code === 'ENOENT') state.path = undefined;
      else if (tracking(state) && state.problem !== error.code) onError(error);
      state.problem = error.code;
    } finally {
      await file?.close().catch(onError);
      next(state, state.path ? interval : Math.max(interval, 2500));
    }
  }

  return {
    async select(targets = []) {
      const selected = new Map(targets.filter(({ provider, id }) => supportsSessionReplies(provider, id))
        .map(target => [replySessionKey(target.provider, target.id), target]));
      for (const [scope, state] of sessions) {
        if (!selected.has(scope)) {
          clearTimeout(state.timer);
          sessions.delete(scope);
        }
      }
      const baselines = [];
      for (const [scope, target] of selected) {
        const existing = sessions.get(scope);
        if (existing) {
          existing.speakReplies = target.speakReplies;
          continue;
        }
        const state = { ...target, scope, id: target.id.toLowerCase(), seen: new Set(), deliveries: [],
          offset: 0, pending: '', frames: Buffer.alloc(0), decoder: new StringDecoder('utf8') };
        sessions.set(scope, state);
        baselines.push(poll(state, true));
      }
      await Promise.all(baselines);
    },
  };
}
