import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWindowsCaptionDisplay } from '../desktop/windows-caption-display.js';

test('Windows captions show every long-utterance page in order and queue the following sentence', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const display = createWindowsCaptionDisplay(page => seen.push(page));
  t.after(display.clear);
  const text = '一'.repeat(52) + '二'.repeat(52) + '最后几个字';
  display.push(text, true);
  assert.equal(display.page(), '一'.repeat(52));
  display.push('下一句', true);
  assert.equal(display.page(), '一'.repeat(52));
  t.mock.timers.tick(6500);
  assert.equal(display.page(), '二'.repeat(52));
  t.mock.timers.tick(6500);
  assert.equal(display.page(), '最后几个字');
  t.mock.timers.tick(6500);
  assert.equal(display.page(), '下一句');
  assert.equal(seen.join(''), text + '下一句');
  t.mock.timers.tick(6500);
  assert.equal(display.page(), '');
});

test('Windows partial captions replace hypotheses and clearing cancels unread pages', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const display = createWindowsCaptionDisplay(page => seen.push(page));
  display.push('临时', false);
  display.push('临时识别', false);
  display.push('最终识别', true);
  assert.equal(display.page(), '最终识别');
  display.push('后续', true);
  display.clear();
  t.mock.timers.tick(10000);
  assert.equal(display.page(), '');
  assert.equal(seen.includes('后续'), false);
});
