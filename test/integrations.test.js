import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(JSON.parse(first.reply), { sessionId: null, prompt: '角色\n附加内容' });
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
  const launch = () => createLocalAgent({
    getConfig: async () => config,
    updateConfig: async edit => { config = await edit(config); },
    getPrompt: async () => '共用 Prompt',
    sessionPath,
    launchDirectory: directory,
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
  assert.equal((await restarted.status()).sessionId, claudeId);
  assert.equal((await restarted.restoreSession(records[1].ref)).sessionId, codexId);
  assert.equal(config.provider, 'codex');
  assert.equal(config.cwd, codexCwd);
  await assert.rejects(restarted.openSession('missing-record'), { code: 'AGENT_SESSION' });
});
