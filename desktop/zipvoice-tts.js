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
  converter_missing: '请把 FFmpeg 加入 Windows 的 PATH，或使用 24 kHz、单声道、16 位 PCM WAV 作为参考录音。',
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

export function createZipVoice(script, { launch = spawn } = {}) {
  let worker;
  let nextId = 0;

  function start(python, modelDirectory) {
    const child = launch(python, ['-I', '-u', '-X', 'utf8', script, modelDirectory], {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(process.platform === 'win32' && { windowsHide: true }),
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map();
    let ready = false;
    let active;
    let requestTimer;
    const running = { python, modelDirectory, enqueue, close };
    const startupTimer = setTimeout(() => close(failure('ZipVoice 语音服务启动超时。')), 120_000);

    function close(error = failure('ZipVoice 语音服务已停止。')) {
      if (worker !== running) return;
      worker = undefined;
      clearTimeout(startupTimer);
      clearTimeout(requestTimer);
      lines.close();
      child.stdin.destroy();
      child.kill();
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      active = undefined;
    }

    function sendNext() {
      if (!ready || active || !pending.size) return;
      active = pending.values().next().value;
      const timeoutMessage = active.probe ? 'ZipVoice 参考录音准备超时。' : 'ZipVoice 语音合成超时。';
      requestTimer = setTimeout(() => close(failure(timeoutMessage)), 15_000);
      child.stdin.write(JSON.stringify({ id: active.id, ...active.payload }) + '\n');
    }

    function enqueue(payload, signal) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const settle = callback => value => {
          signal?.removeEventListener('abort', abort);
          callback(value);
        };
        const request = { id, payload, probe: payload.text === undefined, resolve: settle(resolve), reject: settle(reject) };
        const abort = () => {
          if (active !== request) pending.delete(id);
          request.reject(signal.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(id, request);
        sendNext();
      });
    }
    child.once('error', () => close(failure('无法启动 ZipVoice 所用的 Python。请检查路径或运行 make zipvoice-tts。')));
    child.stdin.on('error', () => close());
    child.once('close', () => close(failure('ZipVoice 语音服务意外退出。请检查 Python 和模型目录。')));
    lines.on('line', line => {
      try {
        const response = JSON.parse(line);
        if (response.id === 0) {
          if (response.ok !== true) {
            const message = Object.hasOwn(setupErrors, response.error) ? setupErrors[response.error] : setupErrors.load_failed;
            close(failure(message));
            return;
          }
          ready = true;
          clearTimeout(startupTimer);
          sendNext();
          return;
        }
        if (!active || response.id !== active.id) return;
        const request = active;
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
        clearTimeout(requestTimer);
        pending.delete(request.id);
        active = undefined;
        sendNext();
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
    return worker.enqueue(payload, signal);
  }

  return {
    warm: (config, reference) => send(config, { reference }),
    speak: (text, config, reference, signal, { rate, volume }) =>
      send(config, { text, reference, rate, volume }, signal),
    stop: () => worker?.close(),
  };
}
