import { randomUUID } from 'node:crypto';
import { ControlError } from '../lib/control.js';

const endpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const sampleRate = 24_000;
const maxBytes = 16 * 1024 * 1024;
export const volcDefaults = { speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0' };

export function volcKey(config) {
  const key = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
  return key || process.env.VOLC_TTS_API_KEY?.trim() || '';
}

// An HTTP read can split a JSON object or contain several objects.
async function* packets(body) {
  const decoder = new TextDecoder();
  let pending = '';
  let offset = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    if (pending.length > maxBytes * 2) throw new Error('Response too large');
    while (offset < pending.length) {
      const char = pending[offset++];
      if (depth === 0 && char !== '{') {
        if (/\s/u.test(char)) continue;
        throw new Error('Expected a JSON object');
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        yield JSON.parse(pending.slice(0, offset));
        pending = pending.slice(offset);
        offset = 0;
      }
    }
  }
  if ((pending + decoder.decode()).trim()) throw new Error('Interrupted response');
}

function toWav(chunks, length) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(length, 40);
  return Buffer.concat([header, ...chunks], header.length + length);
}

export async function volcSpeech(text, config, signal) {
  const key = volcKey(config);
  if (!key) throw new ControlError('VOICE_CONFIG', '请先填写火山 TTS 的 API Key。');
  const { speaker, resourceId } = { ...volcDefaults, ...config };
  const reqParams = { text, speaker, audio_params: { format: 'pcm', sample_rate: sampleRate } };
  if (resourceId === 'seed-icl-2.0') reqParams.model = 'seed-tts-2.0-standard';
  const timeout = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key,
        'X-Api-Resource-Id': resourceId, 'X-Api-Request-Id': randomUUID() },
      body: JSON.stringify({ req_params: reqParams }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ControlError('VOICE_SERVER', `火山 TTS 返回 HTTP ${response.status}，请检查密钥和音色权限。`);
    }
    const audio = [];
    let length = 0;
    for await (const packet of packets(response.body)) {
      const { code, data } = packet;
      if (code !== 0 && code !== 20000000) {
        throw new ControlError('VOICE_SERVER', `火山 TTS 合成失败（${Number.isInteger(code) ? code : '响应异常'}）。`);
      }
      if (typeof data === 'string' && data) {
        const chunk = Buffer.from(data, 'base64');
        length += chunk.length;
        if (length > maxBytes) throw new Error('Audio too large');
        audio.push(chunk);
      }
      if (code === 20000000) break;
    }
    if (!length || length % 2 !== 0) throw new Error('Incomplete PCM');
    return toWav(audio, length);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ControlError) throw error;
    throw new ControlError('VOICE_SERVER', timeout.aborted ? '火山 TTS 合成超时。' : '火山 TTS 连接失败或返回了不完整的音频。');
  }
}
