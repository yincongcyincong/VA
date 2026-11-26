import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { bridgeTurn, startWindowsDeepSeekBridge } from '../desktop/windows-deepseek-plugin.js';
import { deepSeekPresetUnsupported, installWindowsDeepSeekBridge, runWindowsDeepSeek } from '../desktop/windows-deepseek.js';

const sessionId = 'session-' + randomUUID();
const input = { sessionId, prompt: '角色提示', message: '你好' };
const record = (seq, text) => ({ event: { seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } });
function controller(t, overrides = {}) {
  return {
    state: t.mock.fn(async () => ({ cursor: 10, running: false, queue: [], pendingInput: [] })),
    prompt: t.mock.fn(async () => ({ accepted: true })),
    wait: t.mock.fn(async () => ({ reason: 'idle', output: { records: [record(9, '旧消息'), record(14, '新回复'), record(12, '中间回复')] } })),
    cancel: t.mock.fn(), ...overrides,
  };
}

test('DeepSeek bridge sends exactly once to the same standard session and filters old replies', async t => {
  const api = controller(t);
  const id = randomUUID();
  assert.deepEqual(await bridgeTurn(api, input, id, new AbortController().signal), { reply: '新回复', sessionId });
  assert.equal(api.prompt.mock.callCount(), 1);
  assert.deepEqual(api.prompt.mock.calls[0].arguments[0], { requestId: id, sessionId, mode: 'queue', content: [{ type: 'text', text: '角色提示\n\n用户消息：\n你好' }] });
  assert.equal(api.wait.mock.calls[0].arguments[0].afterSeq, 10);
  assert.equal(api.cancel.mock.callCount(), 0);
});

test('DeepSeek busy sessions reject before admitting a prompt', async t => {
  const api = controller(t, { state: async () => ({ cursor: 10, running: true }) });
  await assert.rejects(bridgeTurn(api, input, randomUUID(), new AbortController().signal), { code: 'AGENT_BUSY' });
  assert.equal(api.prompt.mock.callCount(), 0);
  assert.equal(api.cancel.mock.callCount(), 0);
});

test('DeepSeek waits through timeouts and does not replay an accepted turn after failure', async t => {
  const api = controller(t);
  api.wait.mock.mockImplementationOnce(async () => ({ reason: 'timeout' }));
  assert.equal((await bridgeTurn(api, input, randomUUID(), new AbortController().signal)).reply, '新回复');
  assert.equal(api.prompt.mock.callCount(), 1);
  const broken = controller(t, { wait: async () => { throw new Error('等待中断'); } });
  await assert.rejects(bridgeTurn(broken, input, randomUUID(), new AbortController().signal), /等待中断/);
  assert.equal(broken.prompt.mock.callCount(), 1);
  assert.deepEqual(broken.cancel.mock.calls[0].arguments, [{ sessionId }]);
});

test('DeepSeek cancellation after admission cancels only the admitted session', async t => {
  const cancel = new AbortController();
  const api = controller(t, { wait: async (_, signal) => { await setTimeout(5000, undefined, { signal }); } });
  const pending = bridgeTurn(api, input, randomUUID(), cancel.signal);
  await setTimeout(10);
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(api.cancel.mock.calls[0].arguments, [{ sessionId }]);
});

test('DeepSeek bridge installer preserves user configuration and is idempotent', async t => {
  const home = await mkdtemp(join(tmpdir(), 'va-dsh-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, 'profiles/desktop');
  await mkdir(profile, { recursive: true });
  const path = join(profile, 'cordis.patch.yml');
  const original = '# user settings\n- id: ui-chat\n  config:\n    transcriptView: standard\n';
  await writeFile(path, original);
  const endpoint = join(home, 'endpoint.json');
  assert.deepEqual(await installWindowsDeepSeekBridge({ home, endpoint }), { restart: true });
  const installed = await readFile(path, 'utf8');
  assert.ok(installed.startsWith(original));
  assert.match(installed, /va-windows-bridge/);
  assert.deepEqual(await installWindowsDeepSeekBridge({ home, endpoint }), { restart: false });
  assert.equal(await readFile(path, 'utf8'), installed);
});

test('Windows bridge uses an authenticated pipe and rejects invalid tokens before admission',
  { skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'va-dsh-pipe-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const endpoint = join(directory, 'endpoint.json');
    const api = controller(t);
    const close = await startWindowsDeepSeekBridge(api, endpoint);
    t.after(close);
    assert.deepEqual(await runWindowsDeepSeek({}, input, new AbortController().signal, { endpoint }), { reply: '新回复', sessionId });
    const info = JSON.parse(await readFile(endpoint, 'utf8'));
    const rejected = await new Promise((resolve, reject) => {
      const socket = createConnection(info.pipe);
      socket.setEncoding('utf8');
      socket.on('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({ token: 'invalid', input, requestId: randomUUID() }) + '\n'));
      let response = '';
      socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(JSON.parse(response)));
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /认证失败/);
    assert.equal(api.prompt.mock.callCount(), 1);
  });

test('only the explicit one-shot preset rejection can activate the Windows fallback', () => {
  assert.equal(deepSeekPresetUnsupported(new Error('dsh: session "session-123" runs under agent preset "standard", which the one-shot runner does not compose')), true);
  for (const message of ['API request failed', 'Permission denied', 'already owned by an active write handle']) {
    assert.equal(deepSeekPresetUnsupported(new Error(message)), false);
  }
});
