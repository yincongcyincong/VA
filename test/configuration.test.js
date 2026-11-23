import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configCatalog, mergeConfigEntries, parseConfigCommand } from '../lib/configuration.js';
import { agentConfigSnapshot, legacyAgentPrompt, normalizeAgentConfig, patchAgentConfig,
  removeLegacyAgentPrompts } from '../desktop/agent-settings.js';
import { compilePerformance } from '../desktop/performance-config.js';

test('CLI and MCP catalog examples validate with the shared configuration schema', () => {
  const { sections, operations } = configCatalog();
  for (const [target, { example }] of Object.entries(sections)) {
    assert.equal(parseConfigCommand({ operation: 'get', target }).target, target);
    assert.doesNotThrow(() => parseConfigCommand({ operation: 'set', target, value: example }));
  }
  for (const [target, { example }] of Object.entries(operations)) {
    assert.doesNotThrow(() => parseConfigCommand({ operation: 'run', target, value: example }));
  }
  assert.equal(Object.hasOwn(operations, 'voice-reference'), false);
  assert.equal(Object.hasOwn(operations, 'api-profile'), false);
  assert.equal(Object.hasOwn(operations, 'doubao-realtime-open'), false);
  assert.throws(() => parseConfigCommand({ operation: 'set', target: 'agent', value: { mode: 'api' } }),
    { code: 'CONFIG_VALUE' });
  assert.throws(() => parseConfigCommand({ operation: 'run', target: 'voice-reference' }), { code: 'CONFIG_COMMAND' });
  assert.throws(() => parseConfigCommand({ operation: 'set', target: 'desktop', value: { scale: 39 } }), { code: 'CONFIG_VALUE' });
  assert.throws(() => parseConfigCommand({ operation: 'set', target: 'desktop', value: { modelPath: 'x' } }), { code: 'CONFIG_VALUE' });
  assert.throws(() => parseConfigCommand({ operation: 'set', target: 'constructor', value: {} }), { code: 'CONFIG_COMMAND' });
});

test('actions patches preserve existing options and remove specified overrides', () => {
  const before = { wave: { seconds: 3 }, 'quick-bow': { label: '快速鞠躬', motion: 'bow', seconds: 2 } };
  const actions = mergeConfigEntries(before, { wave: { label: '挥挥手' }, 'quick-bow': null });
  const result = compilePerformance({ actions });
  assert.equal(result.actions.wave.seconds, 3);
  assert.equal(result.actions.wave.label, '挥挥手');
  assert.equal(Object.hasOwn(result.actions, 'quick-bow'), false);
  assert.equal(before['quick-bow'].seconds, 2);
});

test('CLI and MCP accept ZipVoice reference audio, transcript and runtime paths', () => {
  const zipvoice = { python: 'tts/.venv/bin/python', modelDirectory: 'tts/model',
    referenceAudio: 'tts/voice.wav', referenceText: '你好，我在这里。' };
  const value = { provider: 'zipvoice', zipvoice };
  const request = { operation: 'set', target: 'voice', value };
  assert.deepEqual(parseConfigCommand(request), request);
  assert.throws(() => parseConfigCommand({ ...request, value: { zipvoice: { referenceAudio: 'bad\0path' } } }),
    { code: 'CONFIG_VALUE' });
  assert.throws(() => parseConfigCommand({ ...request, value: { provider: 'matcha' } }), { code: 'CONFIG_VALUE' });
});

test('agent updates preserve inactive channels and store the role prompt apart from agent configuration', async () => {
  const before = {
    mode: 'local',
    localAgent: { provider: 'codex', prompt: '原来的指令', codex: { command: 'codex', model: 'old' } },
    channels: { astrbot: { target: 'test' } },
    language: { baseUrl: 'https://old.example.invalid/v1', apiKey: 'fixture-secret', model: 'text' },
  };
  const value = {
    localAgent: { codex: { model: 'new' } },
    channels: { openclaw: { target: 'other', channel: 'telegram' } },
    doubaoClient: { autoActions: false },
  };
  const next = await patchAgentConfig(before, value, process.cwd());
  assert.equal(next.mode, 'local');
  assert.equal(next.localAgent.codex.command, 'codex');
  assert.equal(next.localAgent.codex.model, 'new');
  assert.equal(next.channels.astrbot.target, 'test');
  assert.equal(next.channels.openclaw.channel, 'telegram');
  assert.equal(legacyAgentPrompt(before), '原来的指令');
  assert.equal(next.prompt, undefined);
  assert.equal(next.localAgent.prompt, undefined);
  assert.equal(next.language, undefined);
  assert.equal(agentConfigSnapshot(before, 'local', '桌面角色 Prompt').prompt, '桌面角色 Prompt');
  assert.equal(legacyAgentPrompt({ mode: 'doubao', doubao: { prompt: '保留旧语音指令' } }), '保留旧语音指令');
  const oldApi = {
    mode: 'api', apiProfileId: 'selected',
    apiProfiles: [{ id: 'selected', language: { prompt: '原来的 API 指令', baseUrl: 'https://example.invalid' } }],
  };
  assert.equal(legacyAgentPrompt(oldApi), '原来的 API 指令');
  assert.equal(normalizeAgentConfig(oldApi).mode, 'off');
  const cleaned = removeLegacyAgentPrompts(oldApi);
  assert.deepEqual(cleaned.apiProfiles[0].language, { baseUrl: 'https://example.invalid' });
  assert.equal(removeLegacyAgentPrompts(cleaned), cleaned);
});
