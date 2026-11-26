import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createWindowsAgentVoice, launchWindowsAgentVoice } from '../desktop/windows-agent-voice.js';

function fixture(t, send = async () => {}) {
  const children = [];
  const states = [];
  const voice = createWindowsAgentVoice({
    send, onState: state => states.push(state), resumeDelay: 1,
    launch(file, args, options) {
      assert.match(file, /WindowsPowerShell.*powershell\.exe$/);
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
      assert.equal(args[args.length - 2], '-EncodedCommand');
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /SpeechRecognitionEngine/);
      assert.doesNotMatch(script, /va-doubao-captions/);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = t.mock.fn();
      child.emitLine = value => child.stdout.write(JSON.stringify(value) + '\n');
      children.push(child);
      return child;
    },
  });
  t.after(() => {
    voice.stop();
    for (const child of children) child.stdout.end();
  });
  return { voice, children, states };
}

test('Windows final transcripts reach the selected session once, with playback pause and resume', async t => {
  const sent = [];
  const pending = Promise.withResolvers();
  const { voice, children } = fixture(t, (text, target) => {
    sent.push({ text, target });
    return pending.promise;
  });
  const target = { key: 'codex', sessionId: 'bound-session' };
  voice.start(target);
  const [first] = children;
  first.emitLine({ type: 'ready', message: '正在监听 Windows 麦克风（zh-CN）' });
  assert.match(voice.state().message, /Windows.*zh-CN/);
  first.stdout.write('malformed output\n');
  first.emitLine({ type: 'user-input', text: '   ' });
  first.emitLine({ type: 'user-input', text: '  中文语音  ' });
  first.emitLine({ type: 'user-input', text: '重复结果' });
  assert.deepEqual(sent, [{ text: '中文语音', target }]);
  assert.equal(first.kill.mock.callCount(), 1);
  assert.equal(first.stdin.destroyed, true);
  voice.setPlayback(true);
  pending.resolve();
  await setTimeout(15);
  assert.equal(children.length, 1);
  voice.setPlayback(false);
  await setTimeout(15);
  assert.equal(children.length, 2);
  voice.stop();
  children[1].emitLine({ type: 'user-input', text: '停止之后' });
  await setTimeout(15);
  assert.equal(children.length, 2);
  assert.equal(sent.length, 1);
});

test('Windows helper failures report their cause and do not restart automatically', async t => {
  const { voice, children } = fixture(t, () => assert.fail('error must not send'));
  const target = { key: 'codex', sessionId: 'bound-session' };
  voice.start(target);
  children[0].emitLine({ type: 'error', message: '请安装语音识别组件' });
  assert.equal(voice.state().enabled, false);
  assert.equal(voice.state().problem, '请安装语音识别组件');
  children[0].emit('close', 1);
  await setTimeout(15);
  assert.equal(children.length, 1);
  assert.equal(voice.state().problem, '请安装语音识别组件');
  voice.start(target);
  children[1].emit('error', new Error('PowerShell missing'));
  assert.equal(voice.state().enabled, false);
  assert.match(voice.state().problem, /无法启动/);
});

test('Windows changed bindings discard pending recognition and old send failures', async t => {
  const pending = Promise.withResolvers();
  const oldTarget = { key: 'codex', sessionId: 'old' };
  const nextTarget = { key: 'codex', sessionId: 'next' };
  const sent = [];
  const { voice, children } = fixture(t, (text, target) => {
    sent.push([text, target]);
    return target === oldTarget ? pending.promise : Promise.resolve();
  });
  voice.start(oldTarget);
  children[0].emitLine({ type: 'user-input', text: '第一句' });
  voice.stop();
  voice.start(nextTarget);
  pending.reject(new Error('旧会话失败'));
  await setTimeout(15);
  assert.equal(voice.state().problem, '');
  children[0].emitLine({ type: 'user-input', text: '过期识别' });
  children[1].emitLine({ type: 'user-input', text: '第二句' });
  assert.deepEqual(sent, [['第一句', oldTarget], ['第二句', nextTarget]]);
});

test('Windows microphone stops after a DeepSeek bridge restart requirement instead of repeatedly sending', async t => {
  const { voice, children } = fixture(t, async () => {
    throw Object.assign(new Error('请重新打开 DeepSeek Harness'), { code: 'DEEPSEEK_RESTART' });
  });
  voice.start({ key: 'deepseekharness', sessionId: 'bound-session' });
  children[0].emitLine({ type: 'user-input', text: '测试' });
  await setTimeout(15);
  assert.equal(voice.state().enabled, false);
  assert.equal(voice.state().problem, '请重新打开 DeepSeek Harness');
  assert.equal(children.length, 1);
});

test('Windows native helper can probe recognizers without opening the microphone',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
    const child = launchWindowsAgentVoice({ probe: true });
    t.after(() => child.kill());
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, output);
    const result = JSON.parse(output);
    assert.equal(result.type, 'probe');
    assert.ok(Array.isArray(result.languages));
  });

test('Windows native helper explains missing recognizers before opening a microphone',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
    const child = launchWindowsAgentVoice({ launch(file, args, options) {
      const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      args[args.length - 1] = Buffer.from(source.replace(
        '$installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())',
        '$installed = @()'), 'utf16le').toString('base64');
      return spawn(file, args, options);
    } });
    t.after(() => child.kill());
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1);
    const events = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).message, /安装语音识别组件/);
    assert.ok(!events.some(event => event.type === 'ready'));
  });
