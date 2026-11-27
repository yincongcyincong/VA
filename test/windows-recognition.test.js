import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { windowsRecognitionStatus, requireWindowsRecognition } from '../desktop/windows-recognition.js';

test('missing recognition downloads are reported before any runtime or capture is launched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'va-asr-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { engine: 'sensevoice', python: join(root, 'python.exe'), modelDirectory: join(root, 'model') };
  const options = { script: join(root, 'worker.py'), binary: join(root, 'capture.exe'), run: () => assert.fail('must not launch') };
  const status = await windowsRecognitionStatus(config, options);
  assert.equal(status.ready, false);
  assert.equal(status.missing.length, 6);
  assert.ok(status.missing.some(item => item.component === 'model.int8.onnx'));
  assert.match(status.message, /下载/);
  assert.match(status.setup.command, /setup-windows-sensevoice/);
  await assert.rejects(requireWindowsRecognition(config, options), error => error.code === 'ASR_SETUP' && error.message.includes(status.setup.command));
  const system = await windowsRecognitionStatus({ engine: 'system' }, options);
  assert.equal(system.ready, true);
});

test('recognition readiness validates installed dependencies and reports load failures without capture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'va-asr-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { engine: 'sensevoice', python: join(root, 'python.exe'), modelDirectory: join(root, 'models') };
  const options = { script: join(root, 'worker.py'), binary: join(root, 'capture.exe') };
  await mkdir(config.modelDirectory);
  for (const path of [config.python, options.script, options.binary, ...['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'].map(n => join(config.modelDirectory, n))]) await writeFile(path, 'fixture');
  let fail = false;
  options.run = (program, args, launchOptions, callback) => {
    assert.equal(program, config.python);
    assert.equal(args.at(-1), '--check');
    assert.equal(args.includes('--capture'), false);
    assert.equal(launchOptions.windowsHide, true);
    callback(fail ? new Error('missing dependency') : null, '{"type":"check","ok":true}\n');
  };
  assert.equal((await requireWindowsRecognition(config, options)).ready, true);
  fail = true;
  const failed = await windowsRecognitionStatus(config, options);
  assert.equal(failed.ready, false);
  assert.equal(failed.missing[0].component, 'runtime-or-model');
  assert.match(failed.message, /numpy/);
});
