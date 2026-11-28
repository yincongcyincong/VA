import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installDeepSeekRole } from '../desktop/deepseek-profile.js';
import { deepSeekNavigation, navigateDeepSeek } from '../desktop/deepseek-navigation.js';
import { continueDesktopTurn, requestDeepSeekDesktopTurn, startDeepSeekDesktopBridge } from '../desktop/deepseek-desktop-bridge.mjs';
import { createLocalAgent } from '../desktop/local-agent.js';

test('DeepSeek profile installation migrates the old registration and is idempotent', async t => {
  const home = await mkdtemp(join(tmpdir(), 'va-deepseek-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(installDeepSeekRole(home), { code: 'DEEPSEEK_PROFILE' });
  const profile = join(home, 'profiles', 'desktop');
  await mkdir(profile, { recursive: true });
  const patch = join(profile, 'cordis.patch.yml');
  await writeFile(patch, 'options:\n  preserve: true\n');
  await assert.rejects(installDeepSeekRole(home), { code: 'DEEPSEEK_PROFILE' });
  assert.equal(await readFile(patch, 'utf8'), 'options:\n  preserve: true\n');
  const prefix = '# existing plugin\n- insert:\n    - id: keep\n      name: keep\n';
  await writeFile(patch, prefix + '- insert:\n    - id: va-desktop-role\n      name: ' +
    JSON.stringify(join(profile, 'va-desktop-role.mjs')) + '\n');
  assert.deepEqual(await installDeepSeekRole(home), { restart: true });
  const result = await readFile(patch, 'utf8');
  assert.equal(result, prefix + '- insert:\n    - id: va-desktop-role\n      name: ' +
    JSON.stringify(join(profile, 'va-harness', 'deepseek-role.mjs')) + '\n');
  const manifest = JSON.parse(await readFile(join(profile, 'va-harness', 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.match(await readFile(join(profile, 'va-harness/deepseek-desktop-bridge.mjs'), 'utf8'), /startDeepSeekDesktopBridge/);
  assert.deepEqual(await installDeepSeekRole(home), { restart: false });
  await writeFile(join(profile, 'va-harness', 'client.js'), 'outdated');
  assert.deepEqual(await installDeepSeekRole(home), { restart: true });
  assert.equal(await readFile(patch, 'utf8'), result);
  await rm(patch);
  assert.deepEqual(await installDeepSeekRole(home), { restart: true });
});

function desktopController(t) {
  let requestId;
  let subscribed = false;
  const frame = (type, data) => ({ type: 'event', event: { type, data } });
  const assistant = (turn, text) => frame('assistant/message',
    { turn, message: { content: [{ type: 'text', text }] } });
  const end = turn => frame('turn/end', { turn, reason: { kind: 'completed' } });
  return {
    state: async () => ({ running: false }),
    async *observeEvent() {
      subscribed = true;
      yield { type: 'ready' };
      yield frame('turn/start', { turn: 1 });
      yield frame('user/message', { source: { rpcId: 'another-request' } });
      yield assistant(1, '另一个请求的回复');
      yield end(1);
      yield frame('turn/start', { turn: 2 });
      yield frame('user/message', { source: { rpcId: requestId } });
      yield assistant(2, '在原会话里回复');
      yield end(2);
    },
    prompt: t.mock.fn(async request => {
      assert.ok(subscribed);
      requestId = request.requestId;
      return { accepted: true };
    }),
  };
}

test('the DeepSeek desktop continuation correlates the reply with its own submitted turn', async t => {
  const sessionId = 'session-' + randomUUID();
  const input = { sessionId, requestId: randomUUID(), message: '你好' };
  const api = desktopController(t);
  assert.deepEqual(await continueDesktopTurn(api, input, new AbortController().signal), {
    sessionId, reply: '在原会话里回复',
  });
  assert.deepEqual(api.prompt.mock.calls[0].arguments[0], {
    sessionId, requestId: input.requestId, mode: 'queue', content: [{ type: 'text', text: '你好' }],
  });
  api.state = async () => ({ pendingInput: ['approval'] });
  await assert.rejects(continueDesktopTurn(api, input, new AbortController().signal), { code: 'AGENT_BUSY' });
  assert.equal(api.prompt.mock.callCount(), 1);
});

test('the DeepSeek bridge uses a private Unix socket and reports stale endpoints',
  { skip: process.platform !== 'darwin' }, async t => {
    const directory = await mkdtemp('/tmp/va-dsh-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sessionId = 'session-' + randomUUID();
    const input = { sessionId, message: '你好' };
    const { signal } = new AbortController();
    await assert.rejects(requestDeepSeekDesktopTurn(input, signal, directory), { code: 'DEEPSEEK_RESTART' });
    const controller = desktopController(t);
    let close;
    try { close = await startDeepSeekDesktopBridge(controller, directory); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code) && error.syscall === 'listen') return t.skip('Unix socket listen is restricted');
      throw error;
    }
    try {
      assert.deepEqual(await requestDeepSeekDesktopTurn(input, signal, directory), { sessionId, reply: '在原会话里回复' });
      await chmod(directory, 0o755);
      await assert.rejects(requestDeepSeekDesktopTurn(input, signal, directory), { code: 'DEEPSEEK_RESTART' });
      assert.equal(controller.prompt.mock.callCount(), 1);
    } finally {
      await chmod(directory, 0o700);
      await close();
    }
    await assert.rejects(requestDeepSeekDesktopTurn(input, signal, directory), { code: 'DEEPSEEK_RESTART' });
  });

test('macOS sends DeepSeek voice input to the bound desktop session after a one-shot preset rejection',
  { skip: process.platform !== 'darwin' }, async t => {
    const folder = await mkdtemp(join(tmpdir(), 'va-dsh-dispatch-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const sessionId = 'session-' + randomUUID();
    const command = join(folder, 'dsh');
    await writeFile(command, '#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" \'dsh: session "fixture" runs under agent preset "standard", which the one-shot runner does not compose\' >&2\nexit 1\n', { mode: 0o700 });
    const runDeepSeekDesktop = t.mock.fn(async () => ({ sessionId, reply: '在原会话里回复' }));
    const agent = createLocalAgent({
      getConfig: async () => ({ provider: 'deepseekharness', cwd: folder, deepseekharness: { command } }),
      getPrompt: async () => '当前角色设定',
      parseReply: speech => ({ speech }),
      presentReply: () => true,
      sessionPath: join(folder, 'bindings.json'),
      launchDirectory: folder,
      runDeepSeekDesktop,
    });
    await agent.bind(sessionId);
    const target = await agent.voiceTarget();
    const result = await agent.send('语音转写', { voiceTarget: target });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.reply, '在原会话里回复');
    assert.equal(runDeepSeekDesktop.mock.callCount(), 1);
    assert.deepEqual(runDeepSeekDesktop.mock.calls[0].arguments[0], { sessionId, message: '语音转写' });
  });

test('DeepSeek navigation waits for the matching acknowledgement and cleans up failed requests', async () => {
  const { signal } = new AbortController();
  await navigateDeepSeek('session-target', async () => {
    const { navigation } = deepSeekNavigation();
    assert.equal(navigation.id, 'session-target');
    assert.deepEqual(deepSeekNavigation('wrong token'), {});
    assert.deepEqual(deepSeekNavigation(), { navigation });
    assert.deepEqual(deepSeekNavigation(navigation.token), {});
    assert.deepEqual(deepSeekNavigation(), {});
    return true;
  }, signal);
  await assert.rejects(navigateDeepSeek('session-unavailable', async () => false, signal), { code: 'AGENT_LAUNCH' });
  assert.deepEqual(deepSeekNavigation(), {});
  const canceled = AbortSignal.abort(new Error('接入已切换'));
  await assert.rejects(navigateDeepSeek('session-canceled', async () => true, canceled), /接入已切换/);
  assert.deepEqual(deepSeekNavigation(), {});
});
