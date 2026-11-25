import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyPresenter } from '../desktop/reply-presenter.js';
import { ControlError } from '../lib/control.js';

const line = '好'.repeat(150) + '。';
const longSpeech = line.repeat(3);

function presenter(overrides = {}) {
  const calls = { dances: [], speeches: [], lines: [] };
  const show = createReplyPresenter({
    parseReply: text => ({ speech: text }),
    queueDance: (intent, introduction) => { calls.dances.push([intent, introduction]); return true; },
    queueSpeech: (speech, source, readAloud, effect) => { calls.speeches.push([speech, source, readAloud, effect]); return true; },
    queueLines: (lines, source, readAloud) => { calls.lines.push([lines, source, readAloud]); },
    speechCapacity: () => true,
    ...overrides,
  });
  return { show, calls };
}

test('a dance reply queues one dance with its opening line and speaks the remainder afterwards', () => {
  const { show, calls } = presenter();
  assert.equal(show(longSpeech, 'local-agent', true, { dance: { count: 2 }, speech: longSpeech, expression: 'smile' }), true);
  assert.deepEqual(calls.dances, [[{ count: 2 },
    { speech: line, expression: 'smile', readAloud: true, source: 'local-agent' }]]);
  assert.deepEqual(calls.lines, [[[line, line], 'local-agent', true]]);
  assert.deepEqual(calls.speeches, []);
});

test('a dance that cannot be queued falls back to speaking the reply instead of failing the exchange', () => {
  for (const code of ['MODEL_ACTION', 'BUSY']) {
    const failing = presenter({ queueDance: () => { throw new ControlError(code, '舞步排不进去。'); } });
    assert.equal(failing.show('好呀，跳给你看！', 'bot-chat', false, { dance: { count: 1 }, speech: '好呀，跳给你看！' }), true);
    assert.deepEqual(failing.calls.speeches, [['好呀，跳给你看！', 'bot-chat', false, { speech: '好呀，跳给你看！', dance: undefined }]]);
    assert.deepEqual(failing.calls.lines, []);
  }
  const busy = presenter({
    queueDance: () => { throw new ControlError('BUSY', '舞步排不进去。'); },
    queueSpeech: () => false,
  });
  assert.equal(busy.show('跳一段吧', 'bot-chat', true, { dance: { count: 1 }, speech: '跳一段吧' }), false);
});

test('unexpected dance queue failures still surface and a full speech queue drops multi-line dance replies', () => {
  const crashing = presenter({ queueDance: () => { throw new ControlError('AGENT_FAILED', 'Agent 异常。'); } });
  assert.throws(() => crashing.show('跳一段吧', 'local-agent', true, { dance: { count: 1 }, speech: '跳一段吧' }),
    { code: 'AGENT_FAILED' });
  const full = presenter({ speechCapacity: () => false });
  assert.equal(full.show(longSpeech, 'bot-chat', true, { dance: { count: 1 }, speech: longSpeech }), false);
  assert.deepEqual(full.calls.dances, []);
});

test('replies without a dance go through the speech queue and parse when no effect is given', () => {
  const { show, calls } = presenter({ parseReply: text => ({ speech: text + '！', action: 'wave' }) });
  assert.equal(show('你好', 'doubao-client', false), true);
  assert.deepEqual(calls.speeches, [[
    '你好！', 'doubao-client', false, { speech: '你好！', action: 'wave' }]]);
  assert.equal(show('嗨', 'local-agent', true, { speech: '嗨', expression: 'smile' }), true);
  assert.deepEqual(calls.speeches[1], ['嗨', 'local-agent', true, { speech: '嗨', expression: 'smile' }]);
  assert.deepEqual(calls.dances, []);
});
