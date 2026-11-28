import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { runBotBridge } from '../lib/bot-bridge.js';
import { ControlError } from '../lib/control.js';

const input = text => Readable.from([Buffer.from(text)]);
const run = (command, dependencies) => runBotBridge({ input: input(JSON.stringify(command)), ...dependencies });

test('bridge rejects malformed requests before touching the desktop', async () => {
  const request = () => assert.fail('invalid request reached the desktop');
  for (const raw of ['null', '[]', '{', ' '.repeat(8193)]) {
    await assert.rejects(runBotBridge({ input: input(raw), request }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const command of [
    { op: 'view', mode: 'invalid' }, { op: 'other' }, { op: 'say', speech: ' ' },
    { op: 'say', speech: '字'.repeat(301) }, { op: 'say', speech: '好', expression: '../smile' },
    { op: 'perform', action: 'idle' }, { op: 'events', platform: 'unknown' },
    { op: 'events', platform: 'astrbot', cursor: 123 }, { op: 'chat', platform: 'astrbot', text: '你好' },
  ]) {
    await assert.rejects(run(command, { request }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('passive bot events never launch a closed desktop and retain routing errors', async () => {
  const request = async () => { throw new ControlError('NOT_RUNNING', '关闭'); };
  const startDesktop = () => assert.fail('passive event launched the desktop');
  const dependencies = { request, startDesktop };
  const platform = 'astrbot';
  for (const op of ['input', 'present', 'prompt']) {
    assert.deepEqual(await run({ op, platform }, dependencies), { accepted: false });
  }
  assert.deepEqual(await run({ op: 'route', platform }, dependencies), { route: null });
  assert.deepEqual(await run({ op: 'events', platform }, dependencies), { route: null, events: [] });
  const status = await run({ op: 'status' }, dependencies);
  assert.deepEqual([status.state, status.visible, status.action], ['off', false, null]);
  const denied = async () => { throw new ControlError('FORBIDDEN', '频道不匹配'); };
  for (const op of ['input', 'present', 'prompt', 'route', 'events', 'status']) {
    await assert.rejects(run({ op, platform }, { request: denied, startDesktop }), { code: 'FORBIDDEN' });
  }
  await assert.rejects(run({ op: 'say', speech: '你好' }, { request: denied, startDesktop }), { code: 'FORBIDDEN' });
});

test('explicit bot commands preserve arguments, retry once after launch, and return PNG metadata', async () => {
  const calls = [];
  const platform = 'openclaw';
  const dependencies = {
    request: async command => {
      calls.push(command);
      if (calls.length === 1) throw new ControlError('NOT_READY', '加载中');
      return { speech: '你好' };
    },
    startDesktop: async () => calls.push('start'),
    takeSelfie: async options => {
      assert.deepEqual(options, { expression: 'smile', bot: true, platform });
      return { png: 'Zml4dHVyZQ==', saved: true };
    },
    listActions: async () => ({ actions: ['wave'] }),
  };
  const perform = { type: 'bot-perform', platform, action: 'wave', expression: 'smile', wait: true };
  assert.deepEqual(await run({ op: 'perform', ...perform, speech: '旧客户端附带的台词' }, dependencies), { speech: '你好' });
  assert.deepEqual(calls, [perform, 'start', perform]);
  await run({ op: 'say', platform, speech: '台词' }, dependencies);
  await run({ op: 'view', platform, mode: 'portrait' }, dependencies);
  await run({ op: 'chat', platform, conversation: '频道', text: '你好' }, dependencies);
  assert.deepEqual(calls.slice(3), [
    { type: 'bot-perform', platform, speech: '台词', expression: undefined, wait: true },
    { type: 'view', platform, mode: 'portrait' },
    { type: 'bot-chat', platform, conversation: '频道', text: '你好' },
  ]);
  assert.deepEqual(await run({ op: 'actions' }, dependencies), { actions: ['wave'] });
  assert.deepEqual(await run({ op: 'selfie', platform, expression: 'smile' }, dependencies), {
    saved: true, image: { mimeType: 'image/png', data: 'Zml4dHVyZQ==' },
  });
});
