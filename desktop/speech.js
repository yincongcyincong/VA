import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { marked } from 'marked';
import { ControlError } from '../lib/control.js';
import { settingsWriter } from './config.js';
import { dialogueCut } from './dialogue-text.js';
import { windowsSpeech, windowsVoices } from './windows-speech.js';

const exec = promisify(execFile);
const windows = process.platform === 'win32';
export const defaultSystemVoice = windows ? '' : 'Tingting';

const imageExtension = /\.(?:png|jpe?g|gif|webp|avif|heic|bmp|svg)(?=$|[?#\s>])/iu;

function markdownText(tokens, separator = '') {
  return tokens.map(token => {
    switch (token.type) {
      case 'space':
      case 'hr':
      case 'def':
      case 'image': return '';
      case 'link':
        return /^data:image\//iu.test(token.href) || imageExtension.test(token.href)
          ? '' : markdownText(token.tokens);
      case 'br': return '\n';
      case 'html':
        return token.text.replace(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/giu, '');
      case 'list':
        return token.items.map(item => markdownText(item.tokens, '\n')).filter(Boolean).join('\n');
      case 'blockquote':
        return markdownText(token.tokens, '\n');
      case 'table':
        return [token.header, ...token.rows].map(row =>
          row.map(cell => markdownText(cell.tokens)).filter(Boolean).join('，')).filter(Boolean).join('\n');
      default:
        return token.tokens ? markdownText(token.tokens) : token.text ?? '';
    }
  }).filter(Boolean).join(separator);
}

export function spokenDialogue(text) {
  const dialogue = text
    .replace(/`?\[\[va[ \t]+[^\]\r\n]*\]\]`?/giu, '')
    .replace(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu, '')
    .replace(/!\[(?:\\.|[^\]\\\r\n])*\]\[[^\]\r\n]*\]/gu, '')
    .replace(/!?\[[^\]\r\n]*\]\(<?data:image\/[^\r\n)]*$/gimu, '');
  return markdownText(marked.lexer(dialogue), '\n')
    .replace(/data:image\/[\w.+-]+(?:;[\w=.+-]+)*,[^\s<>"'\x60)\]]+/giu, '')
    .replace(/(?:https?:\/\/|(?:sandbox|attachment|file):\/)[^\s<>"'\x60)\]，。！？；、]+/giu, url =>
      imageExtension.test(url) ? '' : url)
    .replace(/^[\t ]*(?:\/|[a-z]:[\\/])[^\r\n]*\.(?:png|jpe?g|gif|webp|avif|heic|bmp|svg)[\t ]*$/gimu, '')
    .trim();
}

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
  if (!windows && process.platform !== 'darwin') return [];
  try {
    if (windows) return await windowsVoices();
    const { stdout } = await exec('/usr/bin/say', ['-v', '?'], { timeout: 15_000 });
    return parseMacVoices(stdout);
  } catch (error) {
    throw new ControlError('VOICE_LIST_UNAVAILABLE', error.killed
      ? '读取本机音色超时，请点击「刷新」重试。'
      : `${windows ? 'Windows' : 'macOS'} 暂时无法读取本机音色，请点击「刷新」重试。`);
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
        throw new ControlError('VOICE_LIST_EMPTY', `${windows ? 'Windows' : 'macOS'} 未返回朗读音色，请在系统设置中添加音色后刷新。`);
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
    if (windows) await windowsSpeech(text, signal, { voice, rate, output });
    else await exec('/usr/bin/say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(175 * (1 + rate / 100))),
      '--file-format=WAVE', '--data-format=LEI16@22050', '-o', output, '--', text], { timeout: 15_000, signal });
    const audio = await readFile(output);
    if (!waveDuration(audio)) throw new Error('Empty audio');
    if (volume) scalePcm(audio, 1 + volume / 100);
    return audio;
  } catch {
    signal?.throwIfAborted();
    throw new ControlError('VOICE_SYSTEM', windows ? '本机音色暂不可用。请检查 Windows 语音包，或重新选择朗读音色。'
      : '本机音色暂不可用。请在 macOS「辅助功能」中安装音色，或重新选择朗读音色。');
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
