import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createWindowsDoubaoCaptions, windowsCaptionAction } from '../desktop/windows-doubao-captions.js';
import { parseConfigCommand } from '../lib/configuration.js';

test('Windows captions require explicit mixed-output consent and release capture on stop/error', t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = child.signalCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const states = [], captions = [], levels = [], actions = [], inputs = [];
  let launched = 0;
  const controller = createWindowsDoubaoCaptions({ binary: 'captions.exe',
    launch: (binary, flags, options) => {
      launched++;
      assert.equal(binary, 'captions.exe');
      assert.deepEqual(flags, ['--system-output', '--actions', '--listen']);
      assert.equal(options.windowsHide, true);
      return child;
    },
    onState: state => states.push(state),
    onCaption: (text, final) => { captions.push([text, final]); return false; },
    onLevel: level => levels.push(level), onAction: action => actions.push(action), onInput: text => inputs.push(text),
    getCandidates: () => ({ actions: [{ id: 'wave' }], expressions: [] }),
  });
  t.after(() => { child.stdin.end(); child.stdout.end(); });
  assert.throws(() => controller.start({}), { code: 'AUDIO_CAPTURE_CONSENT' });
  const command = { operation: 'run', target: 'doubao-caption-start', value: { systemOutput: true, listen: false } };
  if (process.platform === 'win32') assert.equal(parseConfigCommand(command).value.systemOutput, true);
  else assert.throws(() => parseConfigCommand(command));
  assert.equal(launched, 0);
  controller.start({ systemOutput: true, autoActions: true, listen: true });
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  emit({ type: 'ready', actions: false, message: '默认扬声器' });
  emit({ type: 'level', value: .4 });
  emit({ type: 'caption', text: '我向你挥挥手', final: false });
  assert.equal(actions.length, 0);
  emit({ type: 'caption', text: '我向你挥挥手', final: true });
  emit({ type: 'user-input', text: '请点头' });
  assert.equal(actions[0].action, 'wave');
  assert.deepEqual(inputs, ['请点头']);
  assert.equal(states.at(-1).captureScope, 'default-output-mix');
  assert.match(states.at(-1).message, /包含其他应用/);
  emit({ type: 'error', message: '输出设备断开' });
  assert.equal(controller.running(), false);
  assert.equal(controller.state().message, '输出设备断开');
  assert.deepEqual(captions.at(-1), ['', true]);
  assert.deepEqual(levels, [.4, null]);
});

test('Windows spoken action matching respects negation and the selected model catalog', () => {
  const candidates = { actions: [{ id: 'wave' }, { id: 'dance' }], expressions: [{ id: 'smile' }] };
  assert.equal(windowsCaptionAction('不要说我来跳舞', candidates), undefined);
  assert.equal(windowsCaptionAction('我向你鞠躬', candidates), undefined);
  assert.equal(windowsCaptionAction('他说我不会挥手', candidates), undefined);
  assert.equal(windowsCaptionAction('今天我们谈一谈跳舞的历史', candidates), undefined);
  assert.equal(windowsCaptionAction('我来给你跳一段舞', candidates)?.action, 'dance');
  assert.equal(windowsCaptionAction('我微笑着看着你', candidates)?.expression, 'smile');
});
