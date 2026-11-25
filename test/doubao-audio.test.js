import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createDoubaoCaptions } from '../desktop/doubao-captions.js';
import { createDoubaoPlayback } from '../desktop/doubao-playback.js';

test('Doubao captions coordinate audio levels, microphone input and fresh action decisions', t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = child.signalCode = null;
  child.kill = t.mock.fn(() => {
    child.exitCode = 0;
    child.emit('exit', 0);
  });
  const requests = [];
  child.stdin.setEncoding('utf8').on('data', data => requests.push(JSON.parse(data)));
  const levels = [];
  const acted = [];
  const spoken = [];
  const inputs = [];
  const candidates = { actions: ['wave'], expressions: [] };
  const captions = createDoubaoCaptions({
    binary: '/fixture/captions',
    launch: (binary, flags) => {
      assert.equal(binary, '/fixture/captions');
      assert.deepEqual(flags, ['--actions', '--listen']);
      return child;
    },
    onState: () => {},
    onCaption: (text, final) => { spoken.push([text, final]); return text === '已经挥手'; },
    onLevel: value => levels.push(value),
    onInput: text => inputs.push(text),
    getCandidates: () => candidates,
    onAction: reply => acted.push(reply.action),
  });
  const send = event => child.stdout.write(JSON.stringify(event) + '\n');
  t.after(() => { child.stdout.end(); child.stdin.end(); });
  assert.equal(captions.start({ autoActions: true, listen: true }).phase, 'starting');
  assert.ok(captions.running());
  assert.equal(captions.start({}).phase, 'starting');
  child.stdout.write('invalid line\n');
  send({ type: 'loading', message: '装载中' });
  assert.equal(captions.state().message, '装载中');
  send({ type: 'ready', actions: true, message: '已启动' });
  send({ type: 'audio' });
  assert.equal(captions.state().heardAudio, true);
  send({ type: 'level', value: 1.5 });
  send({ type: 'level', value: -0.5 });
  send({ type: 'mic-status', message: '麦克风已连接' });
  assert.equal(captions.state().micStatus, '麦克风已连接');
  send({ type: 'user-input', text: '跳一段舞' });
  send({ type: 'caption', text: '正在识别', final: false });
  send({ type: 'caption', text: '要挥手吗', final: true });
  send({ type: 'caption', text: '已经挥手', final: true });
  assert.deepEqual(requests, [{ id: 1, text: '要挥手吗', ...candidates }]);
  send({ type: 'action-choice', id: 1, action: 'wave' });
  assert.deepEqual(acted, []);
  send({ type: 'caption', text: '打个招呼', final: true });
  send({ type: 'action-choice', id: 2, action: 'wave' });
  assert.deepEqual(acted, ['wave']);
  send({ type: 'error', message: '系统录音断开' });
  assert.equal(captions.state().phase, 'idle');
  assert.equal(captions.state().message, '系统录音断开');
  assert.deepEqual(levels, [0.95, 0, null]);
  assert.deepEqual(inputs, ['跳一段舞']);
  assert.deepEqual(spoken.at(-1), ['', true]);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('Doubao playback reuses speech motion across level updates and clears it with the dance', () => {
  const calls = [];
  let avatar;
  const playback = createDoubaoPlayback({ getAvatar: () => avatar });
  assert.equal(playback.dance({ action: 'dance', seconds: 2 }), false);
  avatar = {
    speak: (_text, style, _duration, volume) => calls.push(['speech', style, volume]),
    play: plan => calls.push(['play', plan]),
    stopSpeaking: () => calls.push(['stop-speech']),
  };
  playback.output({ type: 'client-speech', level: 0.01 });
  playback.output({ type: 'client-speech', level: 0.2, speakingStyle: 'lively' });
  playback.output({ type: 'client-speech', level: 0.7, speakingStyle: 'lively' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['speech', 'lively']);
  assert.equal(calls[0][2](), 0.7);
  const dance = { action: 'dance', seconds: 2 };
  assert.equal(playback.dance(dance), true);
  assert.equal(playback.dance(dance), false);
  playback.output({ type: 'client-speech-end' });
  playback.output({ type: 'clear' });
  assert.deepEqual(calls.slice(1), [['play', dance], ['stop-speech'], ['play', undefined]]);
  assert.equal(calls[0][2](), 0);
});
