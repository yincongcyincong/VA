import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBotRoute, configureIntegration, integrationMode, modes, screenMode } from '../desktop/integration.js';
import { createLocalAgent } from '../desktop/local-agent.js';

test('only the selected integration accepts bot traffic or routes screenshot recognition', () => {
  const routes = {
    astrbot: { enabled: true, target: 'room-a' },
    openclaw: { enabled: true, target: 'room-b', channel: 'telegram', accountId: 'default' },
  };
  const config = { channels: routes, localAgent: { provider: 'codex' } };
  assert.equal(integrationMode({}), 'off');
  assert.equal(integrationMode(config), 'off');
  assert.equal(integrationMode({ mode: 'api', localAgent: { provider: 'codex' } }), 'off');
  assert.equal(integrationMode({ mode: 'doubao' }), 'doubao-client');
  for (const mode of modes) {
    const next = configureIntegration(config, { mode });
    assert.equal(integrationMode(next), mode);
    assert.equal(Boolean(checkBotRoute(next, 'astrbot', { target: 'room-a' })), mode === 'astrbot');
    assert.equal(Boolean(checkBotRoute(next, 'openclaw', routes.openclaw)), mode === 'openclaw');
    assert.equal(screenMode(mode), mode === 'local' ? mode : null);
  }
  assert.equal(checkBotRoute(configureIntegration(config, { mode: 'openclaw' }), 'openclaw',
    { ...routes.openclaw, accountId: 'other' }), null);
});

test('local agent uses the selected executable, injects the prompt and resumes its session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'va-agent-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'agent.cjs');
  await writeFile(script, [
    "const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
    'const { sessionId, prompt, image } = input;',
    'console.log(JSON.stringify({ sessionId: sessionId ?? "session-1", reply: JSON.stringify({ sessionId, prompt, image }) }));',
  ].join('\n'));
  let config = { provider: 'custom', custom: { command: process.execPath, args: [script] } };
  const agent = createLocalAgent({
    getConfig: async () => config,
    getPrompt: async () => '角色\n附加内容',
    parseReply: speech => ({ speech }),
    presentReply: () => true,
    sessionPath: join(directory, 'sessions.json'),
    launchDirectory: directory,
  });
  const first = await agent.send('你好');
  assert.equal(first.provider, 'custom');
  assert.equal(JSON.parse(first.reply).sessionId, null);
  assert.match(JSON.parse(first.reply).prompt, /^角色\n附加内容\n\n.*末行动作标记/);
  assert.equal(JSON.parse((await agent.send('再说')).reply).sessionId, 'session-1');
  const observer = await agent.prepareObservation();
  const image = { mime: 'image/jpeg', data: 'fixture' };
  assert.deepEqual(JSON.parse(await observer({ frame: image, message: '看看', prompt: '识别', signal: new AbortController().signal })),
    { sessionId: null, prompt: '识别', image });
  config = { provider: 'deepseekharness' };
  await assert.rejects(agent.prepareObservation(), { code: 'AGENT_IMAGE_UNSUPPORTED' });
});

test('binding history migrates old records and reopens the correct native session after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'va-agent-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'sessions.json');
  const codexCwd = await realpath(directory);
  const claudeCwd = join(codexCwd, "Claude's project");
  await mkdir(claudeCwd);
  const codexId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const claudeId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const legacyKey = createHash('sha256').update(JSON.stringify(['codex', codexCwd, 'codex', []])).digest('hex');
  await writeFile(sessionPath, JSON.stringify({ [legacyKey]: codexId }));
  let config = { provider: 'codex' };
  const opened = [];
  const launch = (openCodex = async () => false) => createLocalAgent({
    getConfig: async () => config,
    updateConfig: async edit => { config = await edit(config); },
    getPrompt: async () => '共用 Prompt',
    sessionPath,
    launchDirectory: directory,
    openCodex,
    openTerminal: async (agent, args) => { opened.push([agent.command, agent.cwd, args]); },
  });
  const agent = launch();
  assert.equal((await agent.status()).sessionHistory[0].id, codexId);
  await agent.configure({ provider: 'claude', cwd: claudeCwd });
  await assert.rejects(agent.send('没有绑定'), { code: 'AGENT_SESSION' });
  await agent.bind(claudeId.toUpperCase());
  await agent.bind(null);
  await agent.bind(claudeId);

  const restarted = launch();
  const records = (await restarted.status()).sessionHistory;
  assert.deepEqual(records.map(record => [record.provider, record.id, record.cwd, record.active]), [
    ['claude', claudeId, claudeCwd, true], ['codex', codexId, codexCwd, false],
  ]);
  await restarted.openSession(records[1].ref);
  await restarted.openSession(records[0].ref);
  assert.deepEqual(opened, [
    ['codex', codexCwd, ['resume', '--config', 'developer_instructions="共用 Prompt"', codexId]],
    ['claude', claudeCwd, ['--resume', claudeId, '--append-system-prompt', '共用 Prompt']],
  ]);
  assert.equal(await launch(async id => id === codexId).openSession(records[1].ref), 'codex');
  assert.equal(opened.length, 2);
  assert.equal((await restarted.status()).sessionId, claudeId);
  assert.ok(records[1].bound);
  await restarted.unbindSession(records[1].ref);
  const unbound = await launch().status();
  assert.equal(unbound.sessionId, claudeId);
  assert.equal(unbound.sessionHistory.find(record => record.ref === records[1].ref).bound, false);
  const openedAndBound = launch(async id => {
    assert.equal(id, codexId);
    assert.equal(config.provider, 'codex');
    assert.equal(config.cwd, codexCwd);
    return true;
  });
  assert.equal(await openedAndBound.openSession(records[1].ref, { bind: true }), 'codex');
  assert.equal((await openedAndBound.status()).sessionId, codexId);
  assert.equal(config.provider, 'codex');
  assert.equal(config.cwd, codexCwd);
  await assert.rejects(restarted.openSession('missing-record'), { code: 'AGENT_SESSION' });
});

test('Claude creates a new conversation, keeps generated dialogue with the requested action, and resumes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'va-claude-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'claude');
  const previous = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const created = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await writeFile(script, `#!${process.execPath}\n` + [
    "const message = require('node:fs').readFileSync(0, 'utf8');",
    "const resume = process.argv.indexOf('--resume');",
    `const id = resume < 0 ? '${created}' : process.argv[resume + 1];`,
    "const result = message === '挥手' ? '今天也来击个掌吧！' : '';",
    "console.log(JSON.stringify({ result, session_id: id, is_error: message === '失败' }));",
  ].join('\n'), { mode: 0o700 });
  const performed = [];
  const agent = createLocalAgent({
    getConfig: async () => ({ provider: 'claude', claude: { command: script }, speakReplies: true }),
    getPrompt: async () => '角色说明',
    parseReply: speech => ({ speech }),
    presentReply: (...args) => performed.push(args) > 0,
    sessionPath: join(directory, 'sessions.json'),
    launchDirectory: directory,
  });
  await agent.bind(previous);
  await assert.rejects(agent.send('失败', { newSession: true }), { code: 'AGENT_FAILED' });
  assert.equal((await agent.status()).sessionId, previous);
  const first = await agent.send('挥手', { newSession: true, requestedEffect: { action: 'wave' } });
  assert.equal(first.sessionId, created);
  assert.equal((await agent.status()).sessionHistory.length, 2);
  assert.deepEqual(performed[0], ['今天也来击个掌吧！', true, { speech: '今天也来击个掌吧！', action: 'wave' }]);
  const second = await agent.send('点头', { requestedEffect: { action: 'nod' } });
  assert.equal(second.sessionId, created);
  assert.deepEqual(performed[1], ['', true, { speech: '', action: 'nod' }]);
});

test('a fresh session opens the selected native Agent without sending a first message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'va-agent-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = await realpath(directory);
  const calls = [];
  let config = { provider: 'codex' };
  let codexDesktop = true;
  let deepSeekDesktop = true;
  let terminalAvailable = true;
  const agent = createLocalAgent({
    getConfig: async () => config,
    getPrompt: async () => '角色 Prompt',
    sessionPath: join(directory, 'sessions.json'),
    launchDirectory: directory,
    openCodex: async (id, path) => { calls.push({ id, path }); return codexDesktop; },
    openDeepSeek: async command => { calls.push({ command }); return deepSeekDesktop; },
    openTerminal: async (target, args, options) => {
      if (!terminalAvailable) throw new Error('Terminal unavailable');
      calls.push({ provider: target.provider, cwd: target.cwd, args, options });
    },
  });
  const previous = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await agent.bind(previous);
  assert.deepEqual(await agent.openNewSession(), { opened: true, application: 'codex', provider: 'codex' });
  assert.deepEqual(calls.shift(), { id: null, path: cwd });
  assert.equal((await agent.status()).sessionId, previous);

  codexDesktop = false;
  assert.equal((await agent.openNewSession()).application, 'terminal');
  assert.deepEqual(calls.shift(), { id: null, path: cwd });
  assert.deepEqual(calls.shift().args, ['--config', 'developer_instructions="角色 Prompt"']);

  config = { provider: 'claude', claude: { model: 'sonnet' } };
  await agent.bind(previous);
  terminalAvailable = false;
  await assert.rejects(agent.openNewSession(), /Terminal unavailable/);
  assert.equal((await agent.status()).sessionId, previous);
  terminalAvailable = true;
  const created = await agent.openNewSession();
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(calls.shift().args,
    ['--session-id', created.sessionId, '--append-system-prompt', '角色 Prompt', '--model', 'sonnet']);
  assert.equal((await agent.status()).sessionId, created.sessionId);

  config = { provider: 'omp' };
  assert.equal((await agent.openNewSession()).application, 'terminal');
  assert.deepEqual(calls.shift(), { provider: 'omp', cwd, args: ['--allow-home', '--append-system-prompt', '角色 Prompt'],
    options: { freshOmp: true } });

  config = { provider: 'deepseekharness' };
  assert.equal((await agent.openNewSession()).application, 'deepseek');
  assert.deepEqual(calls.shift(), { command: 'dsh' });
  deepSeekDesktop = false;
  await agent.openNewSession();
  assert.deepEqual(calls.shift(), { command: 'dsh' });
  assert.deepEqual(calls.shift().args, ['web']);
});

test('Codex writer lock is reported without modifying the session binding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'va-codex-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const script = join(directory, 'codex');
  await writeFile(script, `#!${process.execPath}\n` + [
    "const lines = require('node:readline').createInterface({ input: process.stdin });",
    "lines.on('line', line => {",
    '  const request = JSON.parse(line);',
    "  if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }));",
    "  if (request.method === 'thread/resume') console.log(JSON.stringify({ id: request.id,",
    "    error: { message: 'thread ' + request.params.threadId + ' already has an active writer' } }));",
    '});',
  ].join('\n'), { mode: 0o700 });
  const agent = createLocalAgent({
    getConfig: async () => ({ provider: 'codex', codex: { command: script } }),
    getPrompt: async () => '角色说明',
    sessionPath: join(directory, 'sessions.json'),
    launchDirectory: directory,
  });
  await agent.bind(id);
  await assert.rejects(agent.send('继续聊'), { code: 'CODEX_SESSION_IN_USE' });
  const [record] = (await agent.status()).sessionHistory;
  await assert.rejects(agent.syncSessionRole(record.ref), { code: 'CODEX_SESSION_IN_USE' });
  assert.equal((await agent.status()).sessionId, id);
});

test('syncing an existing Codex session adds a developer instruction without sending a chat turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'va-codex-role-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const script = join(directory, 'codex');
  const seen = join(directory, 'injected.json');
  await writeFile(script, `#!${process.execPath}\n` + [
    "const lines = require('node:readline').createInterface({ input: process.stdin });",
    "const fs = require('node:fs');",
    "lines.on('line', line => {",
    '  const request = JSON.parse(line);',
    '  const reply = result => console.log(JSON.stringify({ id: request.id, result }));',
    "  if (request.method === 'initialize') reply({});",
    "  else if (request.method === 'thread/resume') reply({ thread: { id: request.params.threadId } });",
    "  else if (request.method === 'thread/inject_items') {",
    `    fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(request.params)); reply({});`,
    "  } else if (request.method === 'turn/start') process.exit(2);",
    '});',
  ].join('\n'), { mode: 0o700 });
  const agent = createLocalAgent({
    getConfig: async () => ({ provider: 'codex', codex: { command: script } }),
    getPrompt: async () => '当前角色名是星神。默认称用户为你。',
    sessionPath: join(directory, 'sessions.json'),
    launchDirectory: directory,
  });
  await agent.bind(id);
  const [record] = (await agent.status()).sessionHistory;
  assert.deepEqual(await agent.syncSessionRole(record.ref), { synced: true, sessionId: id });
  const { threadId, items: [item] } = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(threadId, id);
  assert.equal(item.role, 'developer');
  assert.match(item.content[0].text, /当前角色名是星神。默认称用户为你。/u);
  assert.equal((await agent.status()).sessionId, id);
});
