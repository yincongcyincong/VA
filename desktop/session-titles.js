import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { findSessionFile, readDeepSeekFrames } from './session-replies.js';
import { deepSeekCachedTitle, deepSeekSessionId } from './deepseek-sessions.js';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function displayName(value) {
  if (typeof value !== 'string') return;
  const clean = value.replace(/\s+/gu, ' ').trim();
  const letters = Array.from(clean.slice(0, 280));
  return letters.length > 140 ? letters.slice(0, 139).join('') + '…' : clean || undefined;
}

export function sessionPreview(text) {
  const firstLine = typeof text === 'string' && text.trim().split(/\r?\n/u, 1)[0];
  return displayName(firstLine);
}

async function scan(path, match, visit) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!match(line)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row && typeof row === 'object') visit(row);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function codexNames(root, ids) {
  const names = new Map();
  await scan(join(root, 'session_index.jsonl'), line => line.includes('"thread_name"'), row => {
    if (ids.has(row.id)) names.set(row.id, displayName(row.thread_name));
  }).catch(() => {});
  const missing = [...ids].filter(id => !names.get(id));
  if (!missing.length) return names;

  const files = await readdir(root).catch(() => []);
  const latest = files.filter(file => /^state_\d+\.sqlite$/u.test(file))
    .sort((a, b) => Number(b.match(/\d+/u)[0]) - Number(a.match(/\d+/u)[0]))[0];
  if (!latest) return names;
  const query = async columns => {
    if (process.platform === 'win32') {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(root, latest), { readOnly: true, timeout: 500 });
      try {
        const placeholders = missing.map(() => '?').join(', ');
        return database.prepare(`SELECT id, ${columns} FROM threads WHERE id IN (${placeholders})`).all(...missing);
      } finally {
        database.close();
      }
    }
    const sql = `SELECT id, ${columns} FROM threads WHERE id IN (${missing.map(id => `'${id}'`).join(',')})`;
    const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', '-json', join(root, latest), sql], { timeout: 2000 });
    return JSON.parse(stdout || '[]');
  };
  const entries = await query('name, title').catch(() => query('title')).catch(() => []);
  for (const { id, name, title } of entries) names.set(id, displayName(name) ?? displayName(title));
  return names;
}

async function transcriptTitle(provider, path) {
  let name;
  let generated;
  let preview;
  const metadata = /"type"\s*:\s*"(?:custom-title|ai-title|summary|session_info|title|title_change)"/u;
  await scan(path, line => metadata.test(line) || (!preview && /"role"\s*:\s*"user"/u.test(line)), row => {
    if (provider === 'claude') {
      if (row.type === 'custom-title') name = displayName(row.customTitle) ?? name;
      else if (row.type === 'ai-title' || row.type === 'summary') {
        generated = displayName(row.aiTitle ?? row.summary) ?? generated;
      }
      if (row.type !== 'user' || row.isMeta || row.isSidechain) return;
    } else if (provider === 'omp') {
      if (['title', 'title_change'].includes(row.type)) name = displayName(row.title) ?? name;
      else if (row.type === 'session_info') generated = displayName(row.name) ?? generated;
      if (row.type !== 'message') return;
    }
    const message = provider === 'codex' ? row.payload : row.message;
    if (preview || message?.role !== 'user') return;
    const { content } = message;
    const text = Array.isArray(content) ? content.find(part => ['text', 'input_text'].includes(part?.type))?.text : content;
    if (typeof text === 'string' && !/^\s*<(?:environment_context|local-command|command-name|system-reminder)\b/iu.test(text)) {
      preview = sessionPreview(text);
    }
  });
  return name ?? generated ?? preview;
}

async function deepSeekTranscriptTitle(path) {
  if (typeof zlib.zstdDecompressSync !== 'function') return;
  const state = { frames: Buffer.alloc(0), decoder: new StringDecoder('utf8'), pending: '' };
  let title;
  for await (const bytes of createReadStream(path)) {
    const lines = (state.pending + readDeepSeekFrames(state, bytes).map(frame => state.decoder.write(frame)).join('')).split('\n');
    state.pending = lines.pop();
    for (const line of lines) {
      if (!line.includes('"session/title"')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type === 'session/title') title = displayName(event.data?.title) ?? title;
    }
  }
  return title;
}

export function createSessionTitles({ env = process.env } = {}) {
  const transcripts = new Map();

  async function fromTranscript({ id, provider }) {
    const key = `${provider}:${id}`;
    if (provider === 'deepseekharness') {
      if (!deepSeekSessionId(id)) return;
      const title = displayName(await deepSeekCachedTitle(id, env).catch(() => undefined));
      if (title) return title;
    } else if (!uuid.test(id) || !['codex', 'claude', 'omp'].includes(provider)) return;
    const saved = transcripts.get(key);
    const path = saved?.path ?? await findSessionFile(provider, id, env);
    if (!path) return;
    const { size, mtimeMs } = await stat(path).catch(() => ({}));
    if (size === undefined) { transcripts.delete(key); return; }
    if (saved?.size === size && saved.mtimeMs === mtimeMs) return saved.title;
    const title = await (provider === 'deepseekharness' ? deepSeekTranscriptTitle(path) : transcriptTitle(provider, path));
    transcripts.set(key, { path, size, mtimeMs, title });
    return title;
  }

  return async records => {
    const ids = new Set(records.filter(record => record.provider === 'codex' && uuid.test(record.id))
      .map(record => record.id.toLowerCase()));
    const codex = ids.size ? await codexNames(env.CODEX_HOME || join(homedir(), '.codex'), ids) : new Map();
    const titles = new Map();
    for (let i = 0; i < records.length; i += 6) {
      await Promise.all(records.slice(i, i + 6).map(async record => {
        const name = record.provider === 'codex' ? codex.get(record.id.toLowerCase()) : undefined;
        const title = name || await fromTranscript(record).catch(() => undefined) || displayName(record.titlePreview);
        if (title) titles.set(record.ref, title);
      }));
    }
    return titles;
  };
}
