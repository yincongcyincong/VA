import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createLocalAgent } from '../desktop/local-agent.js';
import { createSessionReplies } from '../desktop/session-replies.js';
import { splitReplySpeech } from '../desktop/speech.js';

const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const block = text => [{ type: 'text', text }];
const codex = (id, text) => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: text } });
const claude = (id, text, reason = 'end_turn') => ({ type: 'assistant', message: { id, stop_reason: reason, content: block(text) } });
const omp = (id, text, stopReason = 'stop') => ({ type: 'message', id, message: { role: 'assistant', stopReason, content: block(text) } });
const line = data => JSON.stringify(data) + '\n';

test('bound native sessions deliver new final replies and ignore their prior history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'va-native-replies-'));
  const delivered = [];
  let paused = false;
  const monitor = createSessionReplies({
    interval: 15,
    env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root },
    paused: () => paused,
    present: (text, session) => delivered.push([session.provider, text, session.speakReplies]),
  });
  t.after(async () => { await monitor.select(); await rm(root, { recursive: true, force: true }); });

  const codexFile = join(root, 'sessions', '2026', '11', '23', `rollout-2026-11-23-${sessionId}.jsonl`);
  const claudeFile = join(root, 'projects', '-project', `${sessionId}.jsonl`);
  const ompFile = join(root, 'sessions', '-project', `2026-11-23_${sessionId}.jsonl`);
  const fixtures = [
    ['codex', codexFile, codex, { type: 'response_item', payload: { role: 'assistant', phase: 'commentary' } }],
    ['claude', claudeFile, claude, claude('tool', '中间工具输出', 'tool_use')],
    ['omp', ompFile, omp, omp('tool', '中间工具输出', 'toolUse')],
  ];
  for (const [provider, path, final, intermediate] of fixtures) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, line(final('old', '会话之前的内容')));
    await monitor.select({ provider, key: provider, id: sessionId, speakReplies: true });
    const oldCount = delivered.length;
    paused = true;
    await appendFile(path, line(intermediate));
    const finalLine = Buffer.from(line(final('new', '这是新的普通回复')));
    const offset = finalLine.indexOf(Buffer.from('这')) + 1;
    await appendFile(path, finalLine.subarray(0, offset));
    paused = false;
    await setTimeout(40);
    assert.equal(delivered.length, oldCount);
    await appendFile(path, finalLine.subarray(offset));
    await appendFile(path, finalLine);
    const deadline = Date.now() + 2000;
    while (delivered.length === oldCount && Date.now() < deadline) await setTimeout(15);
    assert.deepEqual(delivered.slice(oldCount), [[provider, '这是新的普通回复', true]]);
  }
  await monitor.select();
  await appendFile(ompFile, line(omp('after-unbind', '解除绑定后')));
  await setTimeout(40);
  assert.equal(delivered.length, 3);
});

test('long agent replies split into speakable phrases without losing their ending', () => {
  const text = '第一句。'.repeat(60) + '🙂'.repeat(180) + '最后一句。';
  const parts = splitReplySpeech(text);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(part => part.length <= 300 && part.isWellFormed()));
  assert.equal(parts.join(''), text);
});

test('an OMP turn forwarded through VA is spoken once even when OMP persists it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'va-reply-dedup-'));
  const file = join(root, 'sessions', '-work', `2026-11-23_${sessionId}.jsonl`);
  const command = join(root, 'omp');
  const delivered = [];
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '');
  const final = omp('routed', 'VA 转发的回复');
  await writeFile(command, `#!${process.execPath}\n` + [
    "const fs = require('node:fs');",
    'fs.readFileSync(0);',
    `fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line(final))});`,
    `console.log(JSON.stringify({ type: 'session', id: '${sessionId}' }));`,
    `console.log(JSON.stringify({ type: 'agent_end', messages: [${JSON.stringify(final.message)}] }));`,
  ].join('\n'), { mode: 0o700 });
  const agent = createLocalAgent({
    getConfig: async () => ({ provider: 'omp', omp: { command }, speakReplies: true }),
    getPrompt: async () => '角色说明',
    parseReply: speech => ({ speech }),
    presentReply: speech => delivered.push(speech) > 0,
    sessionPath: join(root, 'bindings.json'),
    launchDirectory: root,
  });
  t.after(async () => {
    await agent.monitorReplies(false);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await agent.bind(sessionId);
  await agent.monitorReplies(true);
  await agent.send('一句话');
  await appendFile(file, line(omp('native', '直接在 OMP 聊天的回复')));
  const deadline = Date.now() + 3000;
  while (!delivered.includes('直接在 OMP 聊天的回复') && Date.now() < deadline) await setTimeout(50);
  assert.deepEqual(delivered, ['VA 转发的回复', '直接在 OMP 聊天的回复']);
});
