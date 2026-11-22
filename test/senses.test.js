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

test('music detection is independent of the screen route', {
  skip: process.platform === 'win32', timeout: 3000,
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
