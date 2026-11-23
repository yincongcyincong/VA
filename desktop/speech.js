import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ControlError } from '../lib/control.js';
import { settingsWriter } from './config.js';
import { dialogueCut } from './dialogue-text.js';

const exec = promisify(execFile);

export function splitReplySpeech(text) {
  const lines = [];
  let rest = text.trim();
  while (rest.length > 300) {
    const limit = dialogueCut(rest, 300);
    const window = rest.slice(0, limit);
    const boundary = Math.max(...Array.from(window.matchAll(/[。！？.!?；;\n]/gu), match => match.index + 1));
    const end = boundary >= 100 ? boundary : limit;
    lines.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  lines.push(rest);
  return lines;
}

export function parseMacVoices(list) {
  return list.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(.+?)\s+([a-z]{2,3}_[a-z0-9_]+)\s+#/i);
    return match ? [{ name: match[1].trim(), language: match[2].replaceAll('_', '-') }] : [];
  });
}

export async function systemVoices() {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await exec('/usr/bin/say', ['-v', '?'], { timeout: 15_000 });
    return parseMacVoices(stdout);
  } catch (error) {
    throw new ControlError('VOICE_LIST_UNAVAILABLE', error.killed
      ? '读取本机音色超时，请点击「刷新」重试。'
      : 'macOS 暂时无法读取本机音色，请点击「刷新」重试。');
  }
}

export function createSystemVoiceCatalog(path, { scan = systemVoices, onSaveError = () => {} } = {}) {
  const save = settingsWriter(path);
  let latest;
  let pending;

  function cached() {
    latest ??= readFile(path, 'utf8').then(JSON.parse).then(voices => Array.isArray(voices)
      ? voices.filter(voice => typeof voice?.name === 'string' && voice.name && typeof voice.language === 'string')
      : []).catch(() => []);
    return latest;
  }

  function refresh() {
    pending ??= scan().then(async voices => {
      if (!voices.length) {
        throw new ControlError('VOICE_LIST_EMPTY', 'macOS 未返回朗读音色，请在系统设置中添加音色后刷新。');
      }
      latest = Promise.resolve(voices);
      await save(voices).catch(onSaveError);
      return voices;
    }).finally(() => { pending = undefined; });
    return pending;
  }

  return { cached, refresh };
}

function waveDuration(wave) {
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let bytesPerSecond;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const type = wave.toString('ascii', offset, offset + 4);
    const length = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wave.length) return 0;
    if (type === 'fmt ' && length >= 16) bytesPerSecond = wave.readUInt32LE(start + 8);
    if (type === 'data' && bytesPerSecond) return length / bytesPerSecond;
    offset = start + length + (length % 2);
  }
  return 0;
}

export async function systemSpeech(text, signal, { voice = '', rate = 0, volume = 0 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'va-speech-'));
  try {
    const output = join(folder, 'voice.wav');
    await exec('/usr/bin/say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(175 * (1 + rate / 100))),
      '--file-format=WAVE', '--data-format=LEI16@22050', '-o', output, '--', text], { timeout: 15_000, signal });
    const audio = await readFile(output);
    if (!waveDuration(audio)) throw new Error('Empty audio');
    if (volume) scalePcm(audio, 1 + volume / 100);
    return audio;
  } catch {
    signal?.throwIfAborted();
    throw new ControlError('VOICE_SYSTEM', '本机音色暂不可用。请在 macOS「辅助功能」中安装音色，或重新选择朗读音色。');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function scalePcm(wave, gain) {
  for (let offset = 12; offset + 8 <= wave.length;) {
    const length = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (wave.toString('ascii', offset, offset + 4) === 'data') {
      for (let i = start; i + 1 < start + length; i += 2) {
        wave.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(wave.readInt16LE(i) * gain))), i);
      }
      return;
    }
    offset = start + length + (length % 2);
  }
}
