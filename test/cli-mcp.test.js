import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../bin/va.js', import.meta.url));

function execute(args, input, env = process.env) {
  const result = spawnSync(process.execPath, [cli, '--json', ...args], { input, env, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(result.status, payload.ok ? 0 : 1);
  return payload;
}

test('the VA CLI exposes the configuration catalog and validates requests without launching VA', async t => {
  const fixtures = await mkdtemp(join(tmpdir(), 'va-cli-test-'));
  t.after(() => rm(fixtures, { recursive: true, force: true }));
  const catalog = execute(['config', 'list']);
  assert.ok(catalog.sections.character);
  assert.ok(catalog.operations['chat-clear-sessions']);
  assert.ok(catalog.sections.desktop.input.properties.windowPosition);
  assert.ok(catalog.operations['model-preview']);
  assert.ok(catalog.operations['agent-voice-start']);
  if (process.platform === 'win32') {
    assert.ok(catalog.operations['voice-recognition-status']);
    assert.ok(catalog.sections.voice.input.properties.recognition.properties.modelDirectory);
  }
  assert.ok(catalog.operations['chat-bind-current']);
  assert.equal(execute(['chat-bind-current'], undefined, { ...process.env, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' })
    .error.code, 'CODEX_THREAD_UNAVAILABLE');
  const configFile = join(fixtures, 'config.json');
  await writeFile(configFile, '{"scale":999}');
  assert.equal(execute(['config', 'set', 'desktop', '--file', configFile]).error.code, 'CONFIG_VALUE');
  assert.equal(execute(['config', 'set', 'desktop', '--stdin'], '{"scale":0}').error.code, 'CONFIG_VALUE');
  assert.equal(execute(['config', 'run', 'permissions-open', '{"kind":"location"}']).error.code, 'CONFIG_VALUE');
  assert.equal(execute(['bridge'], '["invalid"]').error.code, 'INVALID_ARGUMENTS');
  for (const args of [
    ['config', 'get', 'desktop', '{}'], ['config', 'set', 'desktop', '{bad json'],
    ['mcp'], ['actions', 'extra'], ['model-check'], ['start', 'extra'], ['chat', '--speak'], ['chat-bind'],
    ['chat-use'], ['integration', 'off', 'local'], ['photo', '--out', 'photo.jpg'], ['scale', 'unknown'],
    ['model', 'one', 'two'], ['sense', 'screen', 'unknown'], ['click-through', 'unknown'], ['status', 'extra'],
    ['perform'], ['say', '   '],
    ['camera', '--ask', ' '], ['camera', '--agent', 'codex'], ['camera', '--model', 'fast'],
    ['camera', '--ask', '看看', '--agent', 'deepseekharness'], ['camera', '--out', 'photo.png'],
  ]) {
    assert.equal(execute(args).error.code, 'INVALID_ARGUMENTS', args.join(' '));
  }
});

test('VA MCP initializes over stdio and returns schema errors as tool results', { timeout: 10000 }, async t => {
  const client = new Client({ name: 'va-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, 'mcp'], env: { ...process.env }, stderr: 'ignore',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'va_actions' && tool.annotations?.readOnlyHint));
  assert.ok(tools.some(tool => tool.name === 'va_observe'));
  assert.ok(tools.some(tool => tool.name === 'va_camera' && tool.inputSchema.properties.question));
  if (process.platform === 'win32') assert.ok(tools.some(tool => tool.name === 'va_voice_recognition_status' && tool.annotations.readOnlyHint));
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const config = await call('va_config_list', {});
  const catalog = JSON.parse(config.content[0].text);
  assert.equal(catalog.operations['chat-sessions'].description.includes('Agent'), true);
  for (const operation of ['chat-bind-current', 'agent-voice-status', 'agent-voice-start', 'agent-voice-stop', 'deepseek-install-role',
    'model-preview', 'doubao-client-open', 'doubao-client-read', 'permissions-status', 'permissions-open']) {
    assert.ok(Object.hasOwn(catalog.operations, operation));
  }
  const badSection = await call('va_config_get', { section: 'absent' });
  assert.equal(badSection.isError, true);
  assert.equal(JSON.parse(badSection.content[0].text).code, 'CONFIG_COMMAND');
  for (const [name, args] of [
    ['va_config_set', { section: 'desktop', patch: { scale: 1 } }],
    ['va_config_run', { operation: 'chat-open-session', parameters: { ref: '' } }],
    ['va_config_run', { operation: 'model-preview', parameters: { id: 'va-cover', path: '/tmp/avatar.vrm' } }],
    ['va_config_run', { operation: 'chat-bind-current', parameters: { id: 'another-project' } }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'CONFIG_VALUE');
  }
  const badPerformance = await call('va_perform', { speech: '  ' });
  assert.equal(badPerformance.isError, true);
  assert.match(JSON.parse(badPerformance.content[0].text).message, /请提供动作/);
});
