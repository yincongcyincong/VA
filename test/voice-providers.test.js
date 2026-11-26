import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { volcKey, volcSpeech } from '../desktop/volc-tts.js';
import { createZipVoice, zipVoiceReference } from '../desktop/zipvoice-tts.js';

// Run the mock interpreter with Node explicitly; Windows cannot execute shebang files.
const mockInterpreter = { launch: (file, args, options) => spawn(process.execPath, [file, ...args], options) };

function chunks(...parts) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }));
}

test('Volcengine TTS assembles split UTF-8 and concatenated PCM packets into WAV', async t => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  const packet = JSON.stringify({ code: 0, data: 'AQA=', message: '{"字":"测试"}' });
  const data = Buffer.from(packet + JSON.stringify({ code: 0, data: 'AgA=' }) + '{"code":20000000}');
  const offset = data.indexOf(Buffer.from('字')) + 1;
  const mock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['X-Api-Key'], 'test-key');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body).req_params, {
      text: '你好', speaker: 'custom', model: 'seed-tts-2.0-standard',
      audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: 10, loudness_rate: -5 },
    });
    return chunks(data.subarray(0, offset), data.subarray(offset));
  });
  const wave = await volcSpeech('你好', { apiKey: ' test-key ', speaker: 'custom', resourceId: 'seed-icl-2.0' },
    new AbortController().signal, { rate: 10, volume: -5 });
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.readUInt32LE(24), 24000);
  assert.equal(wave.readUInt32LE(40), pcm.length);
  assert.deepEqual(wave.subarray(44), pcm);
});

test('Volcengine TTS reports invalid, truncated and canceled responses', async t => {
  const oldKey = process.env.VOLC_TTS_API_KEY;
  const oldNamed = process.env.VA_TEST_TTS_KEY;
  delete process.env.VOLC_TTS_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.VOLC_TTS_API_KEY;
    else process.env.VOLC_TTS_API_KEY = oldKey;
    if (oldNamed === undefined) delete process.env.VA_TEST_TTS_KEY;
    else process.env.VA_TEST_TTS_KEY = oldNamed;
  });
  await assert.rejects(volcSpeech('字', {}, new AbortController().signal), { code: 'VOICE_CONFIG' });
  process.env.VA_TEST_TTS_KEY = ' named-test-key ';
  assert.equal(volcKey({ apiKeyEnv: 'VA_TEST_TTS_KEY' }), 'named-test-key');
  let reply;
  const request = t.mock.method(globalThis, 'fetch', async () => reply);
  for (const [response, pattern] of [
    [new Response(null, { status: 403 }), /HTTP 403/],
    [new Response('{"code":12345}'), /12345/],
    [new Response('{"code":0,"data":"AA=="}'), /不完整/],
    [new Response('{"code":0'), /不完整/],
    [new Response('[0]'), /不完整/],
  ]) {
    reply = response;
    await assert.rejects(volcSpeech('字', { apiKeyEnv: 'VA_TEST_TTS_KEY' }, new AbortController().signal),
      error => error.code === 'VOICE_SERVER' && pattern.test(error.message));
  }
  const error = new Error('切换音色');
  request.mock.mockImplementation(async () => { throw error; });
  await assert.rejects(volcSpeech('字', { apiKey: 'test' }, AbortSignal.abort(error)), error);
});

test('ZipVoice validates reference audio and preserves its exact transcript', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'va-reference-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const referenceAudio = join(dir, 'voice.WAV');
  const referenceText = '一段参考录音';
  await assert.rejects(zipVoiceReference({ referenceAudio }), { code: 'VOICE_ZIPVOICE' });
  await assert.rejects(zipVoiceReference({ referenceAudio: join(dir, 'voice.txt'), referenceText }), { code: 'VOICE_ZIPVOICE' });
  await assert.rejects(zipVoiceReference({ referenceAudio, referenceText }), { code: 'VOICE_ZIPVOICE' });
  await writeFile(referenceAudio, 'reference');
  const { path, text, revision } = await zipVoiceReference({ referenceAudio, referenceText });
  assert.deepEqual([path, text], [referenceAudio, referenceText]);
  await writeFile(referenceAudio, 'changed reference');
  assert.notEqual((await zipVoiceReference({ referenceAudio, referenceText })).revision, revision);
  await truncate(referenceAudio, 16 * 1024 * 1024 + 1);
  await assert.rejects(zipVoiceReference({ referenceAudio, referenceText }), /30 秒/);
});

test('ZipVoice handles warmup, synthesis, cancellation, and worker recovery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'va-zipvoice-test-'));
  const python = join(dir, 'mock-python.cjs');
  const worker = createZipVoice('fixture-worker', mockInterpreter);
  t.after(async () => {
    worker.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const wave = Buffer.alloc(46);
  wave.write('RIFF');
  await writeFile(python, `#!${process.execPath}
    const readline = require('node:readline');
    if (process.argv.at(-1) === 'missing') console.log(JSON.stringify({ id: 0, error: 'missing_model' }));
    else console.log(JSON.stringify({ id: 0, ok: true }));
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, text } = JSON.parse(line);
      const reply = text === '坏音频' ? { ok: true, audio: 'AAAA' } :
        text === '坏录音' ? { ok: false, error: 'invalid_reference' } :
        text === '无解码器' ? { ok: false, error: 'converter_missing' } : { ok: true, audio: '${wave.toString('base64')}' };
      console.log(JSON.stringify({ id, ...reply }));
    });
  `, { mode: 0o700 });
  const config = { python, modelDirectory: 'available' };
  const reference = { path: 'voice.wav', text: '原文' };
  const speak = (text, signal) => worker.speak(text, config, reference, signal, { rate: 0, volume: 0 });
  await worker.warm(config, reference);
  assert.deepEqual(await speak('合成'), wave);
  await assert.rejects(speak('坏录音'), /参考录音/);
  await assert.rejects(speak('无解码器'), /FFmpeg.*24 kHz/);
  const controller = new AbortController();
  const pending = speak('等待', controller.signal);
  controller.abort(new Error('用户取消'));
  await assert.rejects(pending, /用户取消/);
  await assert.rejects(speak('坏音频'), /音频无效/);
  assert.deepEqual(await speak('重新启动'), wave);
  await assert.rejects(worker.warm({ ...config, modelDirectory: 'missing' }, reference), /模型文件不完整/);
});

test('ZipVoice waits for model readiness before timing the queued synthesis', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'va-zipvoice-timeout-'));
  const python = join(dir, 'silent-python.cjs');
  const worker = createZipVoice('fixture-worker', mockInterpreter);
  t.after(async () => {
    worker.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const loadComplete = join(dir, 'model-loaded');
  await writeFile(python, `#!${process.execPath}
    const { existsSync } = require('node:fs');
    const { createInterface } = require('node:readline');
    const model = process.argv.at(-1);
    const loading = setInterval(() => {
      if (model === 'never-ready' || !existsSync(model)) return;
      clearInterval(loading);
      console.log(JSON.stringify({ id: 0, ok: true }));
      createInterface({ input: process.stdin }).on('line', line => {
        const { id, text } = JSON.parse(line);
        if (!text) console.log(JSON.stringify({ id, ok: true }));
      });
    }, 5);
  `, { mode: 0o700 });
  const config = { python, modelDirectory: loadComplete };
  const reference = { path: 'voice.wav', text: '原文' };
  const settle = promise => promise.then(() => 'fulfilled', error => `rejected:${error.message}`);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const warm = worker.warm(config, reference);
  let speakState = 'pending';
  const speaking = settle(worker.speak('一段文字', config, reference, undefined, { rate: 0, volume: 0 }));
  void speaking.then(state => { speakState = state; });
  t.mock.timers.tick(25_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(speakState, 'pending');
  await writeFile(loadComplete, '');
  await warm;
  t.mock.timers.tick(14_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(speakState, 'pending');
  t.mock.timers.tick(1);
  if (process.platform === 'win32') {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(speakState, 'pending');
    t.mock.timers.tick(45_000);
  }
  assert.equal(await speaking, 'rejected:ZipVoice 语音合成超时。');

  const unavailable = settle(worker.warm({ ...config, modelDirectory: 'never-ready' }, reference));
  t.mock.timers.tick(120_000);
  assert.equal(await unavailable, 'rejected:ZipVoice 语音服务启动超时。');
});
