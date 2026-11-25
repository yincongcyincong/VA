import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import plugin, { syncWorkspacePrompt } from '../integrations/openclaw/index.js';

const route = { channel: 'telegram', target: 'telegram:fixture', accountId: 'bot', sessionKey: 'session' };
const context = { channelId: route.channel, conversationId: 'fixture', accountId: route.accountId, sessionKey: route.sessionKey };
const png = Buffer.from('fixture PNG payload');

async function install(t, { sendMedia, config } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'va-openclaw-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'requests.jsonl');
  const client = join(dir, 'mock-va.cjs');
  await writeFile(client, `
    const fs = require('node:fs');
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync(process.argv[2], JSON.stringify(request) + '\\n');
    const reply = {
      route: { route: ${JSON.stringify(route)} },
      input: request.text === '拍张自拍' ? { handled: 'selfie' } :
        request.text === '挥手' ? { accepted: true, reply: '嗨！' } : {},
      prompt: { accepted: true, prompt: '角色就绪。' },
      perform: { speech: '已挥手' },
      selfie: { image: { mimeType: 'image/png', data: '${png.toString('base64')}' } },
    }[request.op];
    console.log(JSON.stringify(reply ? { ok: true, ...reply } : { ok: false, error: { message: '测试失败' } }));
  `);
  const hooks = new Map();
  const tools = new Map();
  const warnings = [];
  let command;
  plugin.register({
    pluginConfig: { command: [process.execPath, client, transcript], workspacePrompt: true, ...config },
    config: { agents: { defaults: { workspace: dir } } },
    logger: { warn: message => warnings.push(message) },
    runtime: {
      state: { resolveStateDir: () => dir },
      channel: { outbound: { loadAdapter: async () => sendMedia ? { sendMedia } : null } },
    },
    on: (event, fn) => hooks.set(event, fn),
    registerCommand: entry => { command = entry; },
    registerTool: (factory, { name }) => tools.set(name, factory()),
  });
  const requests = async () => (await readFile(transcript, 'utf8')).trim().split('\n').map(JSON.parse);
  return { dir, hooks, tools, warnings, command, requests };
}

test('OpenClaw presents only completed replies from the bound channel, account, and session', async t => {
  const { hooks, requests } = await install(t);
  const send = hooks.get('message_sent');
  const event = { success: true, content: '  测试回复  ', to: 'fixture' };
  await send({ ...event, success: false }, context);
  await send({ ...event, content: '  ' }, context);
  await send(event, { ...context, accountId: 'other' });
  await send(event, { ...context, sessionKey: 'other' });
  await send(event, context);
  assert.deepEqual(await requests(), [
    { platform: 'openclaw', op: 'route' },
    { platform: 'openclaw', op: 'route' },
    { platform: 'openclaw', op: 'route' },
    { platform: 'openclaw', op: 'present', text: '测试回复', origin: route },
  ]);
});

test('OpenClaw handles gestures and sends a selfie as the only reply', async t => {
  let sent;
  const { dir, hooks, command, tools } = await install(t, {
    sendMedia: async message => {
      assert.deepEqual(await readFile(message.mediaUrl), png);
      assert.equal(message.text, '');
      assert.equal(message.to, route.target);
      assert.deepEqual(message.mediaLocalRoots, [join(dir, 'media', 'outbound')]);
      sent = message.mediaUrl;
    },
  });
  const dispatch = hooks.get('before_dispatch');
  assert.equal(await dispatch({ content: '/va route' }, context), undefined);
  assert.deepEqual(await dispatch({ content: '挥手' }, context), { handled: true, text: '嗨！' });
  assert.deepEqual(await dispatch({ content: '拍张自拍' }, context), { handled: true });
  await assert.rejects(access(sent), { code: 'ENOENT' });
  assert.equal(await dispatch({ content: '聊天' }, context), undefined);
  assert.match(await readFile(join(dir, 'SOUL.md'), 'utf8'), /角色就绪。/);
  assert.equal(command.requireAuth, true);
  assert.deepEqual(JSON.parse((await command.handler({ ...context, args: 'route', from: route.target })).text), route);
  assert.deepEqual(await command.handler({ args: 'act wave' }), { text: '已挥手' });
  const photo = await tools.get('va_desktop_selfie').execute('photo', {});
  assert.deepEqual(photo.content, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
  const failure = await tools.get('va_desktop_status').execute('status', {});
  assert.deepEqual(failure, { content: [{ type: 'text', text: '测试失败' }], details: { ok: false } });
});

test('OpenClaw prompt updates preserve neighboring content and reject incomplete markers', async t => {
  const { dir, hooks, warnings } = await install(t, { config: { sshHost: 'invalid host' } });
  const path = join(dir, 'SOUL.md');
  await writeFile(path, '# 角色约定\n');
  await syncWorkspacePrompt(dir, '旧人设');
  await writeFile(path, (await readFile(path, 'utf8')) + '\n后续约定\n');
  await syncWorkspacePrompt(dir, '新人设');
  const text = '# 角色约定\n\n<!-- VA DESKTOP PROMPT START -->\n新人设\n<!-- VA DESKTOP PROMPT END -->\n\n后续约定\n';
  assert.equal(await readFile(path, 'utf8'), text);
  await syncWorkspacePrompt(dir, '新人设');
  const incomplete = '<!-- VA DESKTOP PROMPT START -->\n';
  await writeFile(path, incomplete);
  await assert.rejects(syncWorkspacePrompt(dir, '新人设'), /标记不完整/);
  assert.equal(await readFile(path, 'utf8'), incomplete);
  assert.equal(await hooks.get('before_dispatch')({ content: 'hello' }, context), undefined);
  assert.match(warnings[0], /SSH 主机别名/);
});
