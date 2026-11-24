import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createAgentVoice } from '../desktop/agent-voice.js';
import { ControlError } from '../lib/control.js';

function fixture(t, send) {
  const children = [];
  const voice = createAgentVoice({
    binary: '/test/voice',
    launch: (binary, args) => {
      assert.equal(binary, '/test/voice');
      assert.deepEqual(args, ['--agent-microphone']);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = t.mock.fn();
      child.emitLine = event => child.stdout.write(JSON.stringify(event) + '\n');
      children.push(child);
      return child;
    },
    onState: () => {},
    send,
    resumeDelay: 1,
  });
  t.after(() => {
    voice.stop();
    for (const child of children) child.stdout.end();
  });
  return { voice, children };
}

test('VA forwards a final microphone transcript only once and pauses until playback ends', async t => {
  const sent = [];
  const pending = Promise.withResolvers();
  const { voice, children } = fixture(t, async (text, target) => {
    sent.push({ text, target });
    return pending.promise;
  });
  const target = { key: 'selected-agent', sessionId: 'selected-session' };
  assert.equal(voice.state().enabled, false);
  voice.start(target);
  const [first] = children;
  first.emitLine({ type: 'ready', message: '正在监听' });
  assert.equal(voice.state().message, '正在监听');
  first.emitLine({ type: 'user-input', text: '  ' });
  assert.deepEqual(sent, []);
  first.emitLine({ type: 'user-input', text: '  你好  ' });
  first.emitLine({ type: 'user-input', text: '同一轮的重复事件' });
  assert.deepEqual(sent, [{ text: '你好', target }]);
  assert.equal(first.kill.mock.callCount(), 1);
  assert.equal(first.stdin.destroyed, true);
  voice.setPlayback(true);
  pending.resolve();
  await setTimeout(10);
  assert.equal(children.length, 1);
  voice.setPlayback(false);
  await setTimeout(10);
  assert.equal(children.length, 2);
  voice.setPlayback(true);
  children[1].emitLine({ type: 'user-input', text: 'VA 播放的声音' });
  assert.equal(children[1].kill.mock.callCount(), 1);
  voice.setPlayback(false);
  await setTimeout(10);
  assert.equal(children.length, 3);
  voice.stop();
  children[2].emitLine({ type: 'user-input', text: '停止之后的结果' });
  await setTimeout(10);
  assert.equal(children.length, 3);
  assert.equal(voice.state().enabled, false);
  assert.equal(sent.length, 1);
});

test('VA stops listening when the bound Agent changes and reports native microphone errors', async t => {
  const { voice, children } = fixture(t, async () => {
    throw new ControlError('AGENT_SESSION_CHANGED', '会话已变更');
  });
  const target = { key: 'selected-agent', sessionId: 'selected-session' };
  voice.start(target);
  children[0].emitLine({ type: 'user-input', text: '你好' });
  await setTimeout(10);
  assert.equal(voice.state().enabled, false);
  assert.equal(voice.state().problem, '会话已变更');
  assert.equal(children.length, 1);
  voice.start(target);
  children[1].emitLine({ type: 'error', message: '没有麦克风权限' });
  assert.equal(voice.state().problem, '没有麦克风权限');
  assert.equal(voice.state().enabled, false);
});

test('stopping during a send discards the old result before listening to a new binding', async t => {
  const previous = { key: 'claude', sessionId: 'old-session' };
  const next = { key: 'codex', sessionId: 'new-session' };
  const firstSend = Promise.withResolvers();
  const sent = [];
  const { voice, children } = fixture(t, (text, target) => {
    sent.push([text, target]);
    return target === previous ? firstSend.promise : Promise.resolve();
  });
  voice.start(previous);
  children[0].emitLine({ type: 'user-input', text: '旧会话中的消息' });
  voice.stop();
  assert.equal(voice.state().text, '');
  voice.start(next);
  assert.equal(children.length, 1);

  firstSend.reject(new ControlError('AGENT_BUSY', '旧会话的错误'));
  await setTimeout(10);
  assert.equal(children.length, 2);
  assert.equal(voice.state().problem, '');
  children[0].emitLine({ type: 'user-input', text: '过期的转写结果' });
  children[1].emitLine({ type: 'user-input', text: '新会话中的消息' });
  assert.deepEqual(sent, [
    ['旧会话中的消息', previous],
    ['新会话中的消息', next],
  ]);
});

test('a busy Agent reports the failure and accepts the next utterance without retrying the old one', async t => {
  const sent = [];
  const target = { key: 'claude', sessionId: 'current-session' };
  const { voice, children } = fixture(t, async text => {
    sent.push(text);
    if (sent.length === 1) throw new ControlError('AGENT_BUSY', 'Agent 正在回复');
  });
  voice.start(target);
  children[0].emitLine({ type: 'user-input', text: '第一句话' });
  await setTimeout(10);
  assert.equal(voice.state().enabled, true);
  assert.equal(voice.state().problem, 'Agent 正在回复');
  assert.equal(children.length, 2);
  assert.deepEqual(sent, ['第一句话']);
  children[1].emitLine({ type: 'user-input', text: '第二句话' });
  assert.equal(voice.state().problem, '');
  assert.deepEqual(sent, ['第一句话', '第二句话']);
});

test('unexpected microphone process errors and exits end listening until manually restarted', async t => {
  const { voice, children } = fixture(t, () => assert.fail('process error sent a message'));
  const target = { key: 'claude', sessionId: 'current-session' };
  voice.start(target);
  voice.start(target);
  const [first] = children;
  assert.equal(children.length, 1);
  first.emit('error', new Error('fixture spawn error'));
  assert.equal(voice.state().enabled, false);
  assert.match(voice.state().problem, /无法启动/);
  assert.equal(first.stdin.destroyed, true);
  assert.equal(first.kill.mock.callCount(), 1);
  first.emit('close', 1);
  assert.match(voice.state().problem, /无法启动/);
  await setTimeout(10);
  assert.equal(children.length, 1);
  voice.start(target);
  children[1].emit('close', 0);
  assert.equal(voice.state().enabled, false);
  assert.match(voice.state().problem, /已结束/);
});

test('VA ignores malformed helper output and sends a bounded, well-formed transcript', async t => {
  const sent = [];
  const { voice, children } = fixture(t, async text => { sent.push(text); });
  const target = { key: 'claude', sessionId: 'current-session' };
  voice.setPlayback(true);
  voice.start(target);
  assert.equal(children.length, 0);
  voice.setPlayback(false);
  await setTimeout(10);
  const [helper] = children;
  helper.stdout.write('not JSON\n');
  helper.emitLine(null);
  helper.emitLine({ type: 'user-input', text: 123 });
  helper.emitLine({ type: 'loading', message: '正在下载语音识别资源' });
  assert.equal(voice.state().message, '正在下载语音识别资源');
  assert.deepEqual(sent, []);
  helper.emitLine({ type: 'user-input', text: '字'.repeat(1999) + '😀后续文字' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 2000);
  assert.equal(sent[0].isWellFormed(), true);
});
