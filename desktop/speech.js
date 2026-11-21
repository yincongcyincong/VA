import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { ControlError } from '../lib/control.js';

const exec = promisify(execFile);
const windows = process.platform === 'win32';
export const sampleLimit = 20 * 1024 * 1024;
const windowsSpeech = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $speech.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'zh' } | Select-Object -First 1
    if (!$voice) { throw 'Chinese system voice not found' }
    $speech.SelectVoice($voice.VoiceInfo.Name)
    $speech.SetOutputToWaveFile((Join-Path $env:VA_SPEECH_DIR 'voice.wav'))
    $speech.Speak([IO.File]::ReadAllText((Join-Path $env:VA_SPEECH_DIR 'input.txt')))
} finally { $speech.Dispose() }
`, 'utf16le').toString('base64');

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

export async function importReference(source, directory) {
  const info = await stat(source);
  if (!info.isFile() || info.size > sampleLimit) {
    throw new ControlError('VOICE_SAMPLE', '参考录音必须为 20 MB 以内的音频文件。');
  }
  const temp = windows ? undefined : await mkdtemp(join(tmpdir(), 'va-reference-'));
  try {
    let wav = source;
    if (temp) {
      wav = join(temp, 'reference.wav');
      try {
        await exec('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@32000', '-c', '1', source, wav],
          { timeout: 12_000 });
      } catch {
        throw new ControlError('VOICE_SAMPLE', '无法转换这段录音，请选择 WAV、M4A 或 MP3 文件。');
      }
      if ((await stat(wav)).size > 700_000) {
        throw new ControlError('VOICE_DURATION', '请截取 3–10 秒的参考录音。');
      }
    }
    const audio = await readFile(wav);
    const duration = waveDuration(audio);
    if (windows && !duration) throw new ControlError('VOICE_SAMPLE', '请选择有效的 WAV 参考录音。');
    if (duration < 3 || duration > 10) {
      throw new ControlError('VOICE_DURATION', '请截取 3–10 秒的参考录音。');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // GPT-SoVITS uses the path as a cache key, so different samples need different paths.
    const hash = createHash('sha256').update(audio).digest('hex');
    const referenceAudio = join(directory, hash + '.wav');
    await writeFile(referenceAudio, audio, { mode: 0o600, flag: 'wx' })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
    return { referenceAudio, referenceName: basename(source) };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

export async function systemSpeech(text, signal) {
  const folder = await mkdtemp(join(tmpdir(), 'va-speech-'));
  try {
    const output = join(folder, 'voice.wav');
    if (windows) {
      await writeFile(join(folder, 'input.txt'), text, 'utf8');
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', windowsSpeech],
        { timeout: 15_000, signal, windowsHide: true, env: { ...process.env, VA_SPEECH_DIR: folder } });
    } else {
      await exec('/usr/bin/say', ['-v', 'Tingting', '--file-format=WAVE', '--data-format=LEI16@22050',
        '-o', output, '--', text], { timeout: 15_000, signal });
    }
    const audio = await readFile(output);
    if (!waveDuration(audio)) throw new Error('Empty audio');
    return audio;
  } catch {
    signal?.throwIfAborted();
    throw new ControlError('VOICE_SYSTEM', windows
      ? '普通话语音暂不可用。请安装 Windows 中文语音，或选择火山 TTS。'
      : '普通话语音暂不可用。请检查 macOS 的 Tingting 语音。');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
