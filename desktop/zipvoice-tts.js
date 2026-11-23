import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import { ControlError } from '../lib/control.js';

const maxAudio = 16 * 1024 * 1024;
const setupErrors = {
  missing_model: 'ZipVoice 模型文件不完整。请运行 make zipvoice-tts 或选择完整的模型目录。',
  missing_engine: '该 Python 环境缺少 sherpa-onnx。请运行 make zipvoice-tts 或检查 Python 路径。',
  load_failed: 'ZipVoice 模型加载失败。请检查模型、词表和声码器文件。',
};
const referenceErrors = {
  invalid_reference: '无法读取参考录音。请选择可播放的 WAV、M4A 或 MP3 文件。',
  long_reference: '参考录音最长支持 30 秒。建议使用约 3 秒的清晰人声。',
};
const failure = message => new ControlError('VOICE_ZIPVOICE', message);

export async function zipVoiceReference({ referenceAudio, referenceText }) {
  if (!referenceAudio || !referenceText) throw failure('请选择参考录音并填写录音的原文。');
  if (!['.wav', '.m4a', '.mp3'].includes(extname(referenceAudio).toLowerCase())) {
    throw failure(referenceErrors.invalid_reference);
  }
  const info = await stat(referenceAudio).catch(() => undefined);
  if (!info?.isFile() || !info.size) throw failure(referenceErrors.invalid_reference);
  if (info.size > 16 * 1024 * 1024) throw failure(referenceErrors.long_reference);
  return { path: referenceAudio, text: referenceText, revision: [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') };
}

export function createZipVoice(script) {
  let worker;
  let nextId = 0;

  function start(python, modelDirectory) {
    const child = spawn(python, ['-I', '-u', script, modelDirectory], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map();
    const running = { python, modelDirectory, child, close, pending };
    function close(error = failure('ZipVoice 语音服务已停止。')) {
      if (worker !== running) return;
      worker = undefined;
      lines.close();
      child.stdin.destroy();
      child.kill();
      for (const request of pending.values()) request.reject(error);
    }
    child.once('error', () => close(failure('无法启动 ZipVoice 所用的 Python。请检查路径或运行 make zipvoice-tts。')));
    child.stdin.on('error', () => close());
    child.once('close', () => close(failure('ZipVoice 语音服务意外退出。请检查 Python 和模型目录。')));
    lines.on('line', line => {
      try {
        const response = JSON.parse(line);
        if (response.id === 0 && Object.hasOwn(setupErrors, response.error)) {
          close(failure(setupErrors[response.error]));
          return;
        }
        const request = pending.get(response.id);
        if (!request) return;
        if (!response.ok) {
          const message = Object.hasOwn(referenceErrors, response.error) ? referenceErrors[response.error] : 'ZipVoice 未能合成这段文字。';
          request.reject(failure(message));
        }
        else if (request.probe) request.resolve();
        else {
          const audio = Buffer.from(response.audio, 'base64');
          if (audio.length <= 44 || audio.length > maxAudio || audio.toString('ascii', 0, 4) !== 'RIFF') {
            throw new Error('Invalid WAV');
          }
          request.resolve(audio);
        }
      } catch {
        close(failure('ZipVoice 返回的音频无效。'));
      }
    });
    return running;
  }

  function send({ python, modelDirectory }, payload, signal) {
    signal?.throwIfAborted();
    if (!worker || worker.python !== python || worker.modelDirectory !== modelDirectory) {
      worker?.close();
      worker = start(python, modelDirectory);
    }
    const { child, close, pending } = worker;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const settle = callback => value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(id);
        callback(value);
      };
      const abort = () => pending.get(id)?.reject(signal.reason);
      const timer = setTimeout(() => close(failure('ZipVoice 语音合成超时。')), 15_000);
      pending.set(id, { probe: payload.text === undefined, resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  return {
    warm: (config, reference) => send(config, { reference }),
    speak: (text, config, reference, signal, { rate, volume }) =>
      send(config, { text, reference, rate, volume }, signal),
    stop: () => worker?.close(),
  };
}
