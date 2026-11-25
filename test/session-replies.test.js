import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { createLocalAgent } from '../desktop/local-agent.js';
import { createSessionReplies } from '../desktop/session-replies.js';
import { replyPerformance } from '../desktop/character-performance.js';
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
    await monitor.select([{ provider, id: sessionId, speakReplies: true }]);
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

test('multiple Codex sessions keep separate cursors and deliver only the still-bound replies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'va-multiple-replies-'));
  const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const sessions = join(root, 'sessions');
  const path = id => join(sessions, id + '.jsonl');
  const delivered = [];
  let pausedId;
  const monitor = createSessionReplies({
    env: { CODEX_HOME: root }, interval: 15,
    paused: state => state.id === pausedId,
    present: (text, state) => delivered.push([state.id, text]) > 0,
  });
  t.after(async () => { await monitor.select(); await rm(root, { recursive: true, force: true }); });
  await mkdir(sessions);
  await Promise.all([sessionId, otherId].map(id => writeFile(path(id), line(codex('old', '旧回复')))));
  const first = { provider: 'codex', id: sessionId };
  const second = { provider: 'codex', id: otherId };
  await monitor.select([first]);
  pausedId = sessionId;
  await appendFile(path(sessionId), line(codex('first', '第一条会话的回复')));
  await monitor.select([first, second]);
  await appendFile(path(otherId), line(codex('second', '第二条会话的回复')));
  const waitFor = async count => {
    const deadline = Date.now() + 2000;
    while (delivered.length < count && Date.now() < deadline) await setTimeout(15);
  };
  await waitFor(1);
  assert.deepEqual(delivered, [[otherId, '第二条会话的回复']]);
  pausedId = undefined;
  await waitFor(2);
  assert.deepEqual(delivered, [[otherId, '第二条会话的回复'], [sessionId, '第一条会话的回复']]);
  await monitor.select([second]);
  await Promise.all([
    appendFile(path(sessionId), line(codex('unbound', '已解除绑定的回复'))),
    appendFile(path(otherId), line(codex('next', '第二条会话的新回复'))),
  ]);
  await waitFor(3);
  assert.deepEqual(delivered.slice(2), [[otherId, '第二条会话的新回复']]);
});

test('long agent replies split into speakable phrases without losing their ending', () => {
  const text = '第一句。'.repeat(60) + '🙂'.repeat(180) + '最后一句。';
  const parts = splitReplySpeech(text);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(part => part.length <= 300 && part.isWellFormed()));
  assert.equal(parts.join(''), text);
});

test('DeepSeek Harness delivers the action and speech from the completed turn of the bound session',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'va-deepseek-replies-'));
    const file = join(root, 'sessions', '-workspace', `session-${sessionId}`, 'session.v4.jsonl.zstd');
    const other = join(root, 'sessions', '-workspace', 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'session.v4.jsonl.zstd');
    const assistant = (turn, content) => ({
      type: 'assistant/message', data: { turn, message: { role: 'assistant', content } },
    });
    const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });
    const frame = (...events) => zlib.zstdCompressSync(Buffer.from(events.map(line).join('')));
    const delivered = [];
    const catalog = { actions: { wave: { supported: true } }, supportedExpressions: ['smile'] };
    const monitor = createSessionReplies({
      interval: 15,
      env: { DSH_HOME: root },
      present: (text, session) => delivered.push([replyPerformance(text, catalog), session.speakReplies]),
    });
    t.after(async () => { await monitor.select(); await rm(root, { recursive: true, force: true }); });
    await mkdir(dirname(file), { recursive: true });
    await mkdir(dirname(other), { recursive: true });
    await writeFile(file, frame(assistant(1, block('旧字幕')), end(1)));
    await writeFile(other, '');
    await monitor.select([{ provider: 'deepseekharness', id: `session-${sessionId}`, speakReplies: true }]);
    await appendFile(other, frame(assistant(1, block('其他会话')), end(1)));
    await appendFile(file, frame(assistant(2, block('已取消的回复')), end(2, 'canceled')));
    await appendFile(file, frame(assistant(3, [...block('过程消息'), { type: 'tool-call' }])));
    const final = frame(assistant(3, [{ type: 'reasoning', text: '内部推理' }, ...block('嗨，见到你真好！\n[[va action=wave expression=smile]]')]));
    await appendFile(file, final.subarray(0, 9));
    await setTimeout(40);
    assert.deepEqual(delivered, []);
    await appendFile(file, final.subarray(9));
    await setTimeout(40);
    assert.deepEqual(delivered, []);
    await appendFile(file, frame(end(3)));
    const deadline = Date.now() + 2000;
    while (!delivered.length && Date.now() < deadline) await setTimeout(15);
    assert.deepEqual(delivered, [[{ speech: '嗨，见到你真好！', action: 'wave', expression: 'smile' }, true]]);
    const archives = join(root, 'storages', 'workspace.json');
    await mkdir(dirname(archives), { recursive: true });
    await writeFile(archives, JSON.stringify({ global: { archivedSessionIds: [`session-${sessionId}`] } }));
    await appendFile(file, frame(assistant(4, block('归档后的回复')), end(4)));
    await setTimeout(40);
    assert.equal(delivered.length, 1);
    await monitor.select();
    await appendFile(file, frame(assistant(5, block('解除绑定后的回复')), end(5)));
    await setTimeout(40);
    assert.equal(delivered.length, 1);
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
