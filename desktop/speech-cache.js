import { createHash } from 'node:crypto';

export function createSpeechCache({ maxBytes = 24 * 1024 * 1024, maxEntries = 100 } = {}) {
  const entries = new Map();
  let bytes = 0;

  async function get(text, settings, signal, synthesize) {
    signal.throwIfAborted();
    // The key includes the voice, style and account, and retains neither text nor credentials.
    const key = createHash('sha256').update(JSON.stringify([text, settings])).digest('hex');
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      return { audio: cached, cached: true };
    }

    const audio = await synthesize();
    signal.throwIfAborted();
    if (audio.byteLength <= maxBytes && maxEntries > 0) {
      bytes += audio.byteLength - (entries.get(key)?.byteLength ?? 0);
      entries.delete(key);
      entries.set(key, audio);
      while (bytes > maxBytes || entries.size > maxEntries) {
        const [oldest, value] = entries.entries().next().value;
        bytes -= value.byteLength;
        entries.delete(oldest);
      }
    }
    return { audio, cached: false };
  }

  return { get };
}
