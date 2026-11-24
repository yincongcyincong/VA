import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createSenses } from '../desktop/senses.js';
import { ControlError } from '../lib/control.js';

test('screen observation only uses selected route and discards a canceled result', { timeout: 3000 }, async t => {
  const local = Promise.withResolvers();
  const started = Promise.withResolvers();
  const speech = Promise.withResolvers();
  const used = [];
  const spoken = [];
  let target = 'local';
  let frames = 0;
  const sensor = createSenses({
    getCharacter: async () => ({ prompt: '测试角色' }),
    captureScreen: async () => ({ data: 'fake-image', capturedAt: String(++frames) }),
    prepareObservation: async () => {
      const source = target;
      return ({ frame, signal }) => {
        assert.equal(frame.data, 'fake-image');
        used.push(source);
        if (source === 'local') {
          started.resolve(signal);
          return local.promise;
        }
        return '{"activity":"阅读","speech":"你在读书"}';
      };
    },
    onScreen: line => { spoken.push(line); speech.resolve(); },
    onMusic: () => {},
    onStatus: () => {},
  });
  const configure = (route, screenWatch = true) => {
    target = route;
    sensor.update({ target: route, screenWatch, musicDance: false, shown: true, interval: 30 });
  };
  t.after(() => configure(null, false));
  configure('local');
  const signal = await started.promise;
  configure('api');
  assert.equal(signal.aborted, true);
  local.resolve('{"activity":"过期","speech":"不要播出"}');
  await speech.promise;
  assert.deepEqual(spoken, ['你在读书']);
  assert.deepEqual(used, ['local', 'api']);
  assert.deepEqual(await sensor.observe(), { activity: '阅读', speech: '你在读书', capturedAt: '3' });
  configure(null);
  assert.equal(sensor.status().screen.state, 'paused');
  await assert.rejects(sensor.observe(), { code: 'SCREEN_DISABLED' });
});

test('an unavailable vision provider reports its error before capturing', async t => {
  const sensor = createSenses({
    captureScreen: async () => assert.fail('Must check the provider before capturing'),
    prepareObservation: async () => { throw new ControlError('MODEL_UNCONFIGURED', 'missing fixture model'); },
    onStatus: () => {},
    onMusic: () => {},
  });
  t.after(() => sensor.update({ screenWatch: false, musicDance: false, shown: false }));
  sensor.update({ screenWatch: true, musicDance: false, shown: true, target: 'api', interval: 60 });
  await setImmediate();
  assert.equal(sensor.status().screen.state, 'error');
  assert.equal(sensor.status().screen.code, 'MODEL_UNCONFIGURED');
});

test('screen permission denial is reported before Claude sees an image and recovers on re-enable', async t => {
  const denied = new ControlError('SCREEN_PERMISSION', '系统录屏权限关闭');
  const observation = Promise.withResolvers();
  let granted = false;
  let requests = 0;
  const sensor = createSenses({
    getCharacter: async () => ({ prompt: '测试角色' }),
    captureScreen: async () => {
      if (!granted) throw denied;
      return { data: 'mock-frame', capturedAt: 'fixture' };
    },
    prepareObservation: async () => ({ frame, prompt }) => {
      requests++;
      assert.equal(frame.data, 'mock-frame');
      assert.match(prompt, /只返回 JSON 对象/);
      return '\x60\x60\x60json\n{"activity":"阅读文档","speech":"正在读文档吧？"}\n\x60\x60\x60';
    },
    onScreen: observation.resolve,
    onStatus: () => {},
    onMusic: () => {},
  });
  const configure = screenWatch => sensor.update({ screenWatch, musicDance: false, shown: true, interval: 60, target: 'local' });
  t.after(() => configure(false));
  configure(true);
  await setImmediate();
  assert.equal(sensor.status().screen.state, 'error');
  assert.equal(sensor.status().screen.code, 'SCREEN_PERMISSION');
  assert.equal(requests, 0);
  configure(false);
  granted = true;
  configure(true);
  assert.equal(await observation.promise, '正在读文档吧？');
  assert.equal(sensor.status().screen.lastActivity, '阅读文档');
  assert.equal(sensor.status().screen.code, undefined);
  assert.equal(requests, 1);
});

test('music detection is independent of the screen route', {
  timeout: 10000,
}, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'va-audio-test-'));
  const audioHelper = join(folder, 'fixture-audio');
  await writeFile(audioHelper, [
    '#!/bin/sh',
    "printf '%s\\n' '{\"type\":\"ready\"}' '{\"type\":\"score\",\"music\":0.8}' '{\"type\":\"score\",\"music\":0.9}'",
    'exec sleep 30',
  ].join('\n') + '\n', { mode: 0o700 });
  const detected = Promise.withResolvers();
  const sensor = createSenses({
    audioHelper, onStatus: () => {},
    onMusic: active => { if (active) detected.resolve(); },
  });
  t.after(async () => {
    sensor.update({ screenWatch: false, musicDance: false, shown: false });
    await rm(folder, { recursive: true, force: true });
  });
  sensor.update({ screenWatch: false, musicDance: true, shown: true, target: null });
  await detected.promise;
  assert.equal(sensor.status().music.state, 'music');
  assert.equal(sensor.status().screen.state, 'off');
  sensor.update({ screenWatch: false, musicDance: true, shown: false });
  assert.equal(sensor.status().music.state, 'paused');
});
