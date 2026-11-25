import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { createSessionTitles, sessionPreview } from '../desktop/session-titles.js';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const line = item => JSON.stringify(item) + '\n';

async function fixtures(t) {
  const root = await mkdtemp(join(tmpdir(), 'va-session-titles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lookup = createSessionTitles({ env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, OMP_CODING_AGENT_DIR: root, DSH_HOME: root } });
  const record = provider => ({ provider, id, ref: `${provider}:${id}` });
  return { root, lookup, record };
}

test('session names prefer saved titles and reflect native renames', async t => {
  const { root, lookup, record } = await fixtures(t);
  await writeFile(join(root, 'session_index.jsonl'), line({ id, thread_name: '旧名字' }) +
    line({ id, thread_name: 'Codex 改名后' }));
  const claudePath = join(root, 'projects', '-project', `${id}.jsonl`);
  await mkdir(dirname(claudePath), { recursive: true });
  await writeFile(claudePath, line({ type: 'user', isMeta: true, message: { role: 'user', content: '内部提示' } }) +
    line({ type: 'user', message: { role: 'user', content: 'Claude 的第一条消息\n第二行' } }));
  const ompPath = join(root, 'sessions', '-project', `2026-11-23_${id}.jsonl`);
  await mkdir(dirname(ompPath), { recursive: true });
  await writeFile(ompPath, line({ type: 'title', title: 'OMP 当前名字' }) +
    line({ type: 'session_info', name: 'OMP 早期名字' }));
  const [codex, claude, omp, custom] = ['codex', 'claude', 'omp', 'custom'].map(record);
  custom.titlePreview = sessionPreview('自定义 Agent 的首条消息\n第二行');
  const result = await lookup([codex, claude, omp, custom]);
  assert.deepEqual([codex, claude, omp, custom].map(record => result.get(record.ref)),
    ['Codex 改名后', 'Claude 的第一条消息', 'OMP 当前名字', '自定义 Agent 的首条消息']);

  await appendFile(claudePath, line({ type: 'custom-title', customTitle: 'Claude 改名后' }) +
    line({ type: 'ai-title', aiTitle: '自动标题' }));
  assert.equal((await lookup([claude])).get(claude.ref), 'Claude 改名后');
  await appendFile(ompPath, line({ type: 'title_change', title: 'OMP 改名后' }));
  assert.equal((await lookup([omp])).get(omp.ref), 'OMP 改名后');
});

test('DeepSeek Harness titles come from the native title projection or the final title event', async t => {
  const { root, lookup, record } = await fixtures(t);
  const entry = { ...record('deepseekharness'), id: 'session-' + id, titlePreview: 'VA 首条消息' };
  if (typeof zlib.zstdCompressSync === 'function') {
    const file = join(root, 'sessions', 'project', entry.id, 'session.v4.jsonl.zstd');
    await mkdir(dirname(file), { recursive: true });
    const event = title => ({ type: 'session/title', data: { title } });
    const packed = (...rows) => zlib.zstdCompressSync(Buffer.from(rows.map(line).join('')));
    await writeFile(file, Buffer.concat([packed(event('早期标题')), packed(event('Harness 当前标题'))]));
    assert.equal((await lookup([entry])).get(entry.ref), 'Harness 当前标题');
  }
  const cache = join(root, 'storages', 'session_projcache', 'sessions', entry.id + '.json');
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify({ record: { rows: { title: { val: 'Harness 重命名' } } } }));
  assert.equal((await lookup([entry])).get(entry.ref), 'Harness 重命名');
});

test('Codex sessions without an index title use the local SQLite title', async t => {
  const windows = process.platform === 'win32';
  if (!windows && !await access('/usr/bin/sqlite3').then(() => true, () => false)) return t.skip('macOS sqlite3 is unavailable');
  const { root, lookup, record } = await fixtures(t);
  const path = join(root, 'state_5.sqlite');
  const statement = `CREATE TABLE threads (id TEXT, title TEXT); INSERT INTO threads VALUES ('${id.toUpperCase()}', '数据库的会话名');`;
  if (windows) {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path);
    try { database.exec(statement); } finally { database.close(); }
  } else {
    execFileSync('/usr/bin/sqlite3', [path, statement]);
  }
  const codex = record('codex');
  assert.equal((await lookup([codex])).get(codex.ref), '数据库的会话名');
});

test('Codex titles match session ids stored with uppercase letters', async t => {
  const { root, lookup } = await fixtures(t);
  const upper = id.toUpperCase();
  await writeFile(join(root, 'session_index.jsonl'), line({ id: upper, thread_name: '大写会话的名字' }));
  const codex = { provider: 'codex', id: upper, ref: `codex:${upper}` };
  assert.equal((await lookup([codex])).get(codex.ref), '大写会话的名字');
});
