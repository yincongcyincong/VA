import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actions } from '../desktop/actions.js';
import { chatPerformancePrompt, replyPerformance, requestedPerformance, requestsSelfie } from '../desktop/character-performance.js';
import { danceMotion } from '../desktop/dance-motion.js';
import { compilePerformance, describePerformance } from '../desktop/performance-config.js';
import { createSpeechMotion, smoothMouthWeight, textSpeechDuration } from '../desktop/speech-motion.js';

const model = { mode: 'vrm', clips: [], bones: ['head'], motions: Object.keys(actions), morphs: ['happy'] };

test('built-in catalog has three visible dance and speaking actions', () => {
  const catalog = describePerformance(compilePerformance({}), model);
  for (const category of ['dance', 'speech', 'greeting', 'interaction', 'emotion', 'pose', 'idle']) {
    assert.equal(Object.values(catalog.actions).filter(action => action.category === category && !action.alternate).length, 3);
  }
  assert.equal(catalog.actions.dance.alternate, true);
  assert.ok(catalog.supportedExpressions.includes('smile'));
});

test('custom actions retain dialogue and require model clips and bones', () => {
  const compiled = compilePerformance({
    actions: { stretch: { label: '伸展', seconds: 2, clip: 'Stretch', bones: { head: [5, 0, 0] }, dialogue: ['{{name}}伸个懒腰'] } },
  });
  assert.deepEqual(compiled.actions.stretch.dialogue, ['{{name}}伸个懒腰']);
  assert.equal(describePerformance(compiled, model).actions.stretch.supported, false);
  assert.equal(describePerformance(compiled, { ...model, clips: ['Stretch'], bones: [] }).actions.stretch.supported, false);
  assert.equal(describePerformance(compiled, { ...model, clips: ['Stretch'] }).actions.stretch.supported, true);
  assert.throws(() => compilePerformance({ actions: { wave: { category: 'unknown' } } }), /category/);
  assert.throws(() => compilePerformance({ actions: { wave: { bones: { head: [181, 0, 0] } } } }), /bones/);
  assert.throws(() => compilePerformance({ expressions: { smile: { vrm: { happy: 2 } } } }), /权重/);
});

test('the current character and supported catalog drive input and reply actions', () => {
  const catalog = describePerformance(compilePerformance({}), model);
  assert.deepEqual(requestedPerformance('请星神，跳三段舞吧', '星神', catalog), { dance: { action: undefined, count: 3 } });
  assert.equal(requestedPerformance('别跳舞', '星神', catalog), undefined);
  assert.deepEqual(requestedPerformance('挥手', '星神', catalog), { action: 'wave' });
  assert.deepEqual(replyPerformance('嗨！\n[[va action=wave expression=smile]]', catalog),
    { speech: '嗨！', action: 'wave', expression: 'smile' });
  assert.deepEqual(replyPerformance('我来挥手。', catalog), { speech: '我来挥手。', action: 'wave' });
  assert.deepEqual(replyPerformance('“我来挥手”。', catalog), { speech: '“我来挥手”。' });
  assert.equal(requestsSelfie('请星神，发一张自拍吧', '星神'), true);
  assert.equal(requestsSelfie('“发一张自拍”是什么意思？', '星神'), false);
  const prompt = chatPerformancePrompt({ name: '星神', prompt: '喜欢打招呼' }, catalog, '请用 {{name}} 自称');
  assert.match(prompt, /请用 星神 自称/);
  assert.match(prompt, /dance-spin（转身亮相）/);
  assert.match(prompt, /自拍成功后只交付图片/);
});

test('mouth follows audio when available and text timing otherwise', () => {
  let level = 0;
  const audio = createSpeechMotion('你好', 'lively', 2, () => level);
  assert.equal(audio(.5).open, 0);
  level = .7;
  assert.ok(audio(.5).open > 0);
  assert.equal(audio(2).open, 0);
  const natural = createSpeechMotion('你好', 'natural', 2);
  const lively = createSpeechMotion('你好', 'lively', 2);
  assert.ok(natural(.5).open > 0);
  assert.ok(lively(.5).hand > natural(.5).hand);
  assert.equal(textSpeechDuration('短句'), 2100);
  assert.equal(textSpeechDuration('长'.repeat(200)), 12_000);
});

test('sound peaks change the mouth while body gestures keep their own rhythm', () => {
  let level = 0;
  const sample = createSpeechMotion('我在这里，听你说。', 'lively', 3, () => level);
  const { open: closed, round: _closedRound, ...quietPose } = sample(1);
  level = .95;
  const { open, round, ...loudPose } = sample(1);
  assert.equal(closed, 0);
  assert.ok(open > .45 && open < .7);
  assert.ok(round > 0);
  assert.deepEqual(quietPose, loudPose);
  const oneFrame = smoothMouthWeight(0, open, 1 / 60);
  const afterPause = smoothMouthWeight(oneFrame, 0, 1 / 60);
  assert.ok(oneFrame > 0 && oneFrame < open / 3);
  assert.ok(afterPause > 0 && afterPause < oneFrame);
});

test('dance steps have bounded lift and movement while the spin still completes a full turn', () => {
  const dt = .01;
  for (const action of ['dance', 'dance-side', 'dance-spin', 'dance-bounce']) {
    for (let time = dt; time < actions[action].seconds; time += dt) {
      const pose = danceMotion(action, time, 1);
      const previous = danceMotion(action, time - dt, 1);
      assert.ok(Math.abs(pose.x - previous.x) / dt < 3, action);
      assert.ok(Math.abs(pose.y - previous.y) / dt < 1.6, action);
      assert.ok(Math.abs(pose.yaw - previous.yaw) / dt < 2.2, action);
    }
  }
  assert.ok(danceMotion('dance-bounce', .25, 1).y > .22);
  assert.equal(danceMotion('dance-spin', actions['dance-spin'].seconds, 1).yaw, Math.PI * 2);
});
