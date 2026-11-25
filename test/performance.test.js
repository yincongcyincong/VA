import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actions } from '../desktop/actions.js';
import { chatPerformancePrompt, createRolePrompt, danceRequestProblem, replyPerformance, requestedPerformance, requestsSelfie } from '../desktop/character-performance.js';
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
  assert.match(prompt, /角色名是 "星神"。这条身份说明优先于会话里的旧角色设定。/u);
  assert.match(prompt, /默认用「你」称呼用户/u);
  assert.match(prompt, /请用 星神 自称/);
  assert.match(prompt, /dance-spin（转身亮相）/);
  assert.match(prompt, /自拍成功后只交付图片/);
});

test('dance requests are validated against the catalog and the dance queue before spending an agent round-trip', () => {
  const catalog = describePerformance(compilePerformance({}), model);
  const withoutDances = describePerformance(compilePerformance({}), { ...model, motions: ['wave'] });
  const clipped = describePerformance(compilePerformance({ actions: {
    'spin-dance': { label: '旋转舞', clip: 'SpinDance', seconds: 2, category: 'dance' },
  } }), model);
  assert.equal(danceRequestProblem({ action: undefined, count: 4 }, catalog, 0), undefined);
  assert.equal(danceRequestProblem({ action: 'dance-spin', count: 2 }, catalog, 2), undefined);
  assert.equal(danceRequestProblem({ action: undefined, count: 1 }, withoutDances, 0)?.code, 'MODEL_ACTION');
  assert.equal(danceRequestProblem({ action: 'dance-spin', count: 1 }, withoutDances, 0)?.code, 'MODEL_ACTION');
  assert.equal(danceRequestProblem({ action: 'spin-dance', count: 1 }, clipped, 0)?.code, 'MODEL_ACTION');
  assert.equal(danceRequestProblem({ action: 'dance-spin', count: 1 }, catalog, 4)?.code, 'BUSY');
  assert.equal(danceRequestProblem({ action: undefined, count: 1 }, catalog, 4)?.code, 'BUSY');
  assert.equal(danceRequestProblem(undefined, catalog, 0), undefined);
});

test('the role editor includes CLI examples and expands custom commands for the active model', () => {
  const rolePrompt = createRolePrompt('你是 {{name}}。', '喜欢讲故事。');
  assert.match(rolePrompt, /va act dance-side/);
  assert.match(rolePrompt, /va selfie --out/);
  const custom = compilePerformance({ actions: {
    'little-wave': { label: '轻轻挥手', motion: 'wave', seconds: 2 },
    'full-spin': { label: '转身动画', clip: 'FullSpin', seconds: 2 },
  } });
  const catalog = describePerformance(custom, model);
  const prompt = chatPerformancePrompt({ name: '雪雪', prompt: rolePrompt }, catalog);
  assert.match(prompt, /你是 雪雪。/);
  assert.match(prompt, /喜欢讲故事/);
  assert.match(prompt, /va act little-wave/);
  assert.match(prompt, /va express smile/);
  assert.doesNotMatch(prompt, /va act full-spin|\{\{actionCommands\}\}/);
  assert.equal(prompt.split('当前模型可用动作').length, 2);
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
