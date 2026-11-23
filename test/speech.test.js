import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSpeechCache } from '../desktop/speech-cache.js';
import { createSystemVoiceCatalog, parseMacVoices, splitReplySpeech } from '../desktop/speech.js';
import { createSpeechMotion, speakingPreset, textSpeechDuration } from '../desktop/speech-motion.js';
import { dialoguePages } from '../desktop/dialogue-text.js';

test('subtitle pages keep combined emoji intact and leave room for explicit line breaks', () => {
  const emoji = '🧑🏽‍🚀';
  const face = '(๑•̀ᴗ•́)و';
  const firstLine = '星'.repeat(52);
  assert.deepEqual(dialoguePages(firstLine + emoji + face), [firstLine, emoji + face]);
  const multiline = Array.from({ length: 9 }, () => emoji).join('\n');
  const pages = dialoguePages(multiline);
  assert.ok(pages.every(page => page.split('\n').length <= 4));
  assert.equal(pages.join('\n'), multiline);
  assert.deepEqual(dialoguePages(emoji), [emoji]);
});

test('splitting a long spoken reply does not separate emoji across performances', () => {
  const emoji = '🧑🏽‍🚀';
  const text = '星'.repeat(298);
  assert.deepEqual(splitReplySpeech(text + emoji + '你好'), [text, emoji + '你好']);
});

test('macOS voice listing keeps the exact names accepted by say', () => {
  assert.deepEqual(parseMacVoices([
    'Tingting             zh_CN    # 你好',
    'Flo (中文（中国大陆）)     zh_CN    # 你好',
    'Samantha    en_US    # Hello',
    'invalid line',
  ].join('\n')), [
    { name: 'Tingting', language: 'zh-CN' },
    { name: 'Flo (中文（中国大陆）)', language: 'zh-CN' },
    { name: 'Samantha', language: 'en-US' },
  ]);
});

test('system voices remain available during refresh and survive failures and restarts', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'va-voice-catalog-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'system-voices.json');
  const first = [{ name: 'Tingting', language: 'zh-CN' }];
  const next = [...first, { name: 'Samantha', language: 'en-US' }];
  const seeded = createSystemVoiceCatalog(path, { scan: async () => first });
  assert.deepEqual(await seeded.cached(), []);
  await seeded.refresh();

  const scan = Promise.withResolvers();
  const catalog = createSystemVoiceCatalog(path, { scan: () => scan.promise });
  const pending = catalog.refresh();
  assert.equal(catalog.refresh(), pending);
  assert.deepEqual(await catalog.cached(), first);
  scan.resolve(next);
  assert.deepEqual(await pending, next);

  const failed = createSystemVoiceCatalog(path, { scan: async () => { throw new Error('timeout'); } });
  await assert.rejects(failed.refresh(), /timeout/);
  assert.deepEqual(await failed.cached(), next);
  const empty = createSystemVoiceCatalog(path, { scan: async () => [] });
  await assert.rejects(empty.refresh(), { code: 'VOICE_LIST_EMPTY' });
  assert.deepEqual(await createSystemVoiceCatalog(path).cached(), next);
});

test('identical synthesis is reused while switching voice or prosody synthesizes again', async () => {
  const cache = createSpeechCache({ maxEntries: 2, maxBytes: 8 });
  const { signal } = new AbortController();
  let synthesized = 0;
  const request = (voice, style) => cache.get('你好', ['system', voice, style], signal, async () => {
    return Buffer.alloc(4, ++synthesized);
  });
  assert.equal((await request('Tingting', 'natural')).cached, false);
  assert.deepEqual(await request('Tingting', 'natural'), { audio: Buffer.alloc(4, 1), cached: true });
  assert.equal((await request('Sandy', 'natural')).cached, false);
  assert.equal((await request('Tingting', 'natural')).cached, true);
  assert.equal((await request('Tingting', 'thoughtful')).cached, false);
  assert.equal((await request('Sandy', 'natural')).cached, false);
  assert.equal(synthesized, 4);
});

test('canceled or failed synthesis does not replace fresh audio', async () => {
  const cache = createSpeechCache();
  const settings = ['system', 'Tingting', 'natural'];
  const controller = new AbortController();
  const fresh = Buffer.from('audio');
  await assert.rejects(cache.get('你好', settings, controller.signal, async () => {
    controller.abort();
    return fresh;
  }), { name: 'AbortError' });
  const { signal } = new AbortController();
  await assert.rejects(cache.get('你好', settings, signal, async () => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(await cache.get('你好', settings, signal, async () => fresh), { audio: fresh, cached: false });
});

test('speaking styles change both visible movement and prosody', () => {
  const line = '这是一句方便比较不同说话风格和朗读速度的测试台词。';
  assert.ok(textSpeechDuration(line, 'lively') < textSpeechDuration(line, 'natural'));
  assert.ok(textSpeechDuration(line, 'thoughtful') > textSpeechDuration(line, 'natural'));
  assert.ok(speakingPreset('thoughtful').volume < speakingPreset('dramatic').volume);
  const thoughtful = createSpeechMotion(line, 'thoughtful', 4)(1.1);
  const dramatic = createSpeechMotion(line, 'dramatic', 4)(1.1);
  assert.ok(dramatic.oppositeHand > thoughtful.oppositeHand);
  assert.ok(thoughtful.tilt > .12);
});
