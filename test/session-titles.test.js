import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createSessionTitles, sessionPreview } from '../desktop/session-titles.js';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const line = item => JSON.stringify(item) + '\n';

async function fixtures(t) {
  const root = await mkdtemp(join(tmpdir(), 'va-session-titles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lookup = createSessionTitles({ env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root } });
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
});

test('Codex sessions without an index title use the local SQLite title', async t => {
  if (!await access('/usr/bin/sqlite3').then(() => true, () => false)) return t.skip('macOS sqlite3 is unavailable');
  const { root, lookup, record } = await fixtures(t);
  execFileSync('/usr/bin/sqlite3', [join(root, 'state_5.sqlite'),
    `CREATE TABLE threads (id TEXT, title TEXT); INSERT INTO threads VALUES ('${id}', '数据库的会话名');`]);
  const codex = record('codex');
  assert.equal((await lookup([codex])).get(codex.ref), '数据库的会话名');
});
