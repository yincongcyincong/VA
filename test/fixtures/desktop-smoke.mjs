import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, systemPreferences } from 'electron';

const [, , root, profile] = process.argv;
const data = join(profile, 'VA Desktop');
const sessionsPath = join(data, 'local-agent-sessions.json');
const history = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bound = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
app.commandLine.appendSwitch('use-fake-device-for-media-stream');

async function waitFor(check, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function prepare() {
  await mkdir(data);
  app.setPath('appData', profile);
  app.setPath('documents', profile);
  app.setPath('downloads', profile);
  await writeFile(join(data, 'settings.json'), JSON.stringify({
    modelPath: join(profile, 'old-VA.app', 'Contents', 'Resources', 'app.asar', 'assets', 'models', 'Gemini 娘.glb'),
  }));
  await writeFile(join(data, 'agent.json'), JSON.stringify({
    mode: 'local', localAgent: { provider: 'claude', claude: { command: join(profile, 'missing-claude') } },
  }));

  // Reuse the actual main process and renderer while isolating the machine-wide control socket.
  const entry = pathToFileURL(join(root, 'desktop', 'main.js')).href;
  const control = pathToFileURL(join(root, 'lib', 'control.js')).href;
  const controlStub = 'data:text/javascript,' + encodeURIComponent(`
    export { ControlError } from ${JSON.stringify(control + '?original')};
    export let handle;
    export async function startControl(callback) { handle = callback; return { close() {} }; }
    export async function request(command) { return handle(command); }
  `);
  const hook = registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    return result.url === control ? { url: controlStub, shortCircuit: true } : result;
  } });
  const channel = await import(controlStub);

  // Simulate the speech helper at the OS boundary without opening the microphone.
  const microphone = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  let stops = 0;
  microphone.kill = () => { stops++; };
  systemPreferences.askForMediaAccess = async () => true;
  const mediaStatus = systemPreferences.getMediaAccessStatus.bind(systemPreferences);
  let cameraGranted = true;
  systemPreferences.getMediaAccessStatus = kind => kind === 'camera'
    ? (cameraGranted ? 'granted' : 'denied') : mediaStatus(kind);
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (args?.[0] !== '--agent-microphone') return spawn(command, args, options);
    return microphone;
  };
  syncBuiltinESMExports();
  await import(entry);
  return async function verify() {
    const command = await waitFor(() => channel.handle, 'control readiness');
    const status = await waitFor(async () => {
      const status = await command({ type: 'status' });
      assert.notEqual(status.state, 'error', status.detail);
      return status.state === 'ready' && status;
    }, 'the rendered cover');
    assert.equal(status.model.path, join(root, 'assets', 'models', 'VA Cover.vrm'));
    assert.equal(status.model.checked, true);
    assert.equal(status.model.textureWarning, false);
    assert.ok(status.model.bones.includes('head'));
    assert.equal((await command({ type: 'configuration', operation: 'get', target: 'model' })).useDefault, true);

    await command({ type: 'chat' });
    const settings = await waitFor(() => BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL() === 'va-app://desktop/settings.html'), 'settings');
    const chat = (operation, value) => settings.webContents.executeJavaScript(
      `window.va.localChat(${JSON.stringify(operation)}, ${JSON.stringify(value)})`);
    await chat('bind', history);
    assert.equal((await chat('bind', bound)).sessionId, bound);
    const saved = await readFile(sessionsPath, 'utf8');
    assert.equal((await chat('agent-voice-start')).enabled, true);
    microphone.stdout.write(JSON.stringify({ type: 'ready', message: 'Listening fixture' }) + '\n');

    const evaluate = code => settings.webContents.executeJavaScript(code);
    await waitFor(() => evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#session-history li'));
      const row = rows.find(item => item.querySelector('code')?.textContent === ${JSON.stringify(history)});
      const button = Array.from(row?.querySelectorAll('button') ?? [])
        .find(item => item.textContent === '打开并绑定');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`), 'the recorded session button');
    await waitFor(() => evaluate(
      "document.getElementById('chat-status')?.textContent.includes('找不到可执行的 Claude Code')"),
      'the launch error in settings');

    const after = await chat('status');
    assert.equal(after.sessionId, bound);
    assert.equal(after.voiceInput.enabled, true);
    assert.equal(after.voiceInput.message, 'Listening fixture');
    assert.equal(stops, 0);
    assert.equal(microphone.stdin.destroyed, false);
    assert.equal(await readFile(sessionsPath, 'utf8'), saved);
    await chat('agent-voice-stop');
    assert.equal(stops, 1);

    cameraGranted = false;
    await assert.rejects(command({ type: 'camera' }), { code: 'CAMERA_PERMISSION' });
    cameraGranted = true;
    const photo = await command({ type: 'camera' });
    assert.equal(photo.mime, 'image/jpeg');
    assert.equal(Buffer.from(photo.data, 'base64').readUInt16BE(), 0xffd8);
    assert.ok(photo.width > 1 && photo.height > 1 && Math.max(photo.width, photo.height) <= 1280);
    assert.equal(BrowserWindow.getAllWindows().some(window =>
      window.webContents.getURL() === 'va-app://desktop/camera.html'), false);

    const cameraAgent = join(profile, 'camera-agent.cjs');
    await writeFile(cameraAgent, `
      const assert = require('node:assert/strict');
      const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
      assert.equal(input.sessionId, null);
      assert.equal(input.image.mime, 'image/jpeg');
      assert.equal(Buffer.from(input.image.data, 'base64').readUInt16BE(), 0xffd8);
      console.log(JSON.stringify({ reply: '收到：' + input.message }));
    `);
    await command({ type: 'configuration', operation: 'set', target: 'agent', value: {
      localAgent: { custom: { command: '/usr/bin/env', args: ['node', cameraAgent] } },
    } });
    const answer = await command({ type: 'camera', agent: 'custom', question: '照片是什么？' });
    assert.equal(answer.reply, '收到：照片是什么？');
    assert.equal(answer.data, undefined);
    assert.equal((await command({ type: 'configuration', operation: 'get', target: 'agent' })).localAgent.provider, 'claude');
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    hook.deregister();
    microphone.stdout.end();
  };
}

function fail(error) {
  console.error(error);
  app.exit(1);
}

try {
  const verify = await prepare();
  // Electron emits ready only after the entry module has finished evaluating.
  void verify().then(() => app.exit(0), fail);
} catch (error) {
  fail(error);
}
