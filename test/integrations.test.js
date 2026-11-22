import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { editApiProfiles, readCliProfiles, resolveApiConfig } from '../desktop/api-profiles.js';
import { checkBotRoute, configureIntegration, integrationMode, modes, screenMode } from '../desktop/integration.js';
import { createLocalAgent } from '../desktop/local-agent.js';
import { prepareVisionObservation } from '../desktop/vision-agent.js';

test('only the selected integration accepts bot traffic or routes screenshot recognition', () => {
  const routes = {
    astrbot: { enabled: true, target: 'room-a' },
    openclaw: { enabled: true, target: 'room-b', channel: 'telegram', accountId: 'default' },
  };
  const config = { channels: routes, localAgent: { provider: 'codex' } };
  assert.equal(integrationMode({}), 'off');
  assert.equal(integrationMode(config), 'off');
  for (const mode of modes) {
    const next = configureIntegration(config, { mode });
    assert.equal(integrationMode(next), mode);
    assert.equal(Boolean(checkBotRoute(next, 'astrbot', { target: 'room-a' })), mode === 'astrbot');
    assert.equal(Boolean(checkBotRoute(next, 'openclaw', routes.openclaw)), mode === 'openclaw');
    assert.equal(screenMode(mode), ['local', 'api'].includes(mode) ? mode : null);
  }
  assert.equal(checkBotRoute(configureIntegration(config, { mode: 'openclaw' }), 'openclaw',
    { ...routes.openclaw, accountId: 'other' }), null);
});

test('Codex and Claude CLI profiles read isolated config and resolve the configured model', async t => {
  const home = await mkdtemp(join(tmpdir(), 'va-cli-config-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex'));
  await mkdir(join(home, '.claude'));
  await writeFile(join(home, '.codex', 'config.toml'), [
    'model = "codex-fixture"', 'model_provider = "mock"',
    '[model_providers.mock]', 'base_url = "http://127.0.0.1:4200/v1"', 'env_key = "FIXTURE_KEY"',
  ].join('\n'));
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'sonnet', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fixture', ANTHROPIC_AUTH_TOKEN: 'fixture-key' },
  }));
  const [codex, claude] = await readCliProfiles(home, { FIXTURE_KEY: 'fixture-key' });
  assert.equal(codex.language.model, 'codex-fixture');
  assert.equal(codex.language.baseUrl, 'http://127.0.0.1:4200/v1');
  assert.equal(codex.reason, '');
  assert.equal(claude.language.model, 'claude-fixture');
  assert.equal(claude.language.bearerAuth, true);
});

test('selected API profile uses its vision model and requires permission for a remote host', async t => {
  const language = { model: 'text-fixture', baseUrl: 'http://127.0.0.1:4200/v1', apiKey: '', protocol: 'chat' };
  const vision = { ...language, model: 'vision-fixture' };
  const config = await editApiProfiles({ mode: 'api' }, { op: 'save', name: 'Test', language, vision });
  const selected = await resolveApiConfig(config, 'vision');
  assert.throws(() => prepareVisionObservation({ vision: { ...vision, baseUrl: 'https://example.invalid/v1' } }),
    { code: 'REMOTE_DISABLED' });
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.equal(url, 'http://127.0.0.1:4200/v1/chat/completions');
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'vision-fixture');
    assert.equal(payload.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,fixture');
    return Response.json({ choices: [{ message: { content: 'fixture reply' } }] });
  });
  assert.equal(await prepareVisionObservation(selected)({
    frame: { mime: 'image/jpeg', data: 'fixture' }, message: '识别', prompt: '测试',
  }), 'fixture reply');
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
  let config = { provider: 'custom', prompt: '附加内容', custom: { command: process.execPath, args: [script] } };
  const agent = createLocalAgent({
    getConfig: async () => config,
    getPrompt: async prompt => '角色\n' + prompt,
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
