import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { callWindowsDoubaoHelper, createWindowsDoubaoRequest, parseWindowsDoubaoSnapshot } from '../desktop/windows-doubao-client.js';

function snapshot() {
  const node = (id, parent, kind, name = '', more = {}) => ({ id, parent, kind, name, enabled: true, offscreen: false, key: `node-${id}`, ...more });
  return { pid: 10, windowId: '20', title: '豆包', url: 'chrome://doubao-chat/chat/123', route: '10:20:chrome://doubao-chat/chat/123', nodes: [
    node(0, -1, 'Window'), node(1, 0, 'Document'),
    node(2, 1, 'Group'), node(3, 2, 'Text', '旧回复'), node(4, 2, 'Group'), node(5, 4, 'Button', '朗读'),
    node(6, 1, 'Group'), node(7, 6, 'Text', '用户的新问题'), node(8, 6, 'Button'), node(9, 6, 'Button'),
    node(10, 1, 'Group'), node(11, 10, 'Text', '最新回复第一段'), node(12, 10, 'Text', '第二段'),
    node(13, 10, 'Group'), node(14, 13, 'Button', '复制'), node(15, 13, 'Button', '朗读'),
    node(16, 1, 'Edit', '', { value: '', editable: true }), node(17, 1, 'Button', '发送'),
  ] };
}

test('Windows Doubao snapshot selects the newest completed reply and keeps the stable route', () => {
  const result = parseWindowsDoubaoSnapshot(snapshot());
  assert.equal(result.reply, '最新回复第一段\n第二段');
  assert.equal(result.title, '豆包 · 123');
  assert.equal(result.replyCount, 2);
  assert.equal(result.reader.key, 'node-15');
  assert.equal(result.composer.key, 'node-16');
  assert.deepEqual(result.userTurn, { text: '用户的新问题', id: 'node-6' });
  const generating = snapshot();
  generating.nodes.push({ id: 18, parent: 1, kind: 'Button', name: '停止生成', enabled: true });
  assert.equal(parseWindowsDoubaoSnapshot(generating).reply, '');
  const contentEditable = snapshot();
  contentEditable.nodes[16] = { ...contentEditable.nodes[16], kind: 'Group', focusable: true, textPattern: true, editable: false };
  assert.equal(parseWindowsDoubaoSnapshot(contentEditable).composer.key, 'node-16');
  contentEditable.nodes.push({ id: 19, parent: 1, kind: 'Hyperlink', name: '绑定的测试对话', value: contentEditable.url });
  assert.equal(parseWindowsDoubaoSnapshot(contentEditable).title, '绑定的测试对话');
  contentEditable.nodes.push({ id: 20, parent: 1, kind: 'Edit', enabled: true, key: 'unrelated-search' });
  assert.equal(parseWindowsDoubaoSnapshot(contentEditable).composer, undefined);
  contentEditable.nodes.push({ id: 21, parent: 1, kind: 'Group', automationId: 'input-engine-container' });
  contentEditable.nodes[16].parent = 21;
  assert.equal(parseWindowsDoubaoSnapshot(contentEditable).composer.key, 'node-16');
});

test('Windows Doubao refuses login and new-chat pages instead of binding an unstable conversation', () => {
  const login = snapshot();
  login.url = '';
  login.nodes.push({ kind: 'Button', name: '登录' });
  assert.throws(() => parseWindowsDoubaoSnapshot(login), { code: 'CLIENT_LOGIN' });
  login.nodes.pop();
  assert.throws(() => parseWindowsDoubaoSnapshot(login), { code: 'CLIENT_ROUTE' });
  assert.throws(() => parseWindowsDoubaoSnapshot({}), { code: 'CLIENT_HELPER' });
});

test('Windows flattened chat trees exclude earlier answers and user prompts while a new turn is pending', () => {
  const current = snapshot();
  const node = (id, kind, name = '', more = {}) => ({ id, parent: 1, kind, name, enabled: true, key: `flat-${id}`, ...more });
  current.nodes = [current.nodes[0], current.nodes[1],
    node(2, 'Text', '更早的回复'), node(3, 'Button'), node(4, 'Button', '朗读'), node(5, 'Button'),
    node(6, 'Text', '用户的人设和上下文'), node(7, 'Group', '', {invoke:true}),
    node(8, 'Text', '绑定时的旧回复'), node(9, 'Button'), node(10, 'Button', '朗读'), node(11, 'Button')];
  assert.equal(parseWindowsDoubaoSnapshot(current).reply, '绑定时的旧回复');
  current.nodes.push(node(12, 'Text', '【VA 角色能力】不能把此提示词当作助手回复'), node(13, 'Button'), node(14, 'Button'));
  assert.equal(parseWindowsDoubaoSnapshot(current).reply, '绑定时的旧回复');
  current.nodes.push(node(15, 'Text', 'VA Windows 联动测试通过。'), node(16, 'Button'), node(17, 'Button', '朗读'));
  assert.equal(parseWindowsDoubaoSnapshot(current).reply, 'VA Windows 联动测试通过。');
});

test('Windows Doubao only sends into the bound conversation and preserves unrelated drafts', async () => {
  let current = snapshot();
  const calls = [];
  const request = createWindowsDoubaoRequest('fixture', { request: async command => {
    calls.push(command);
    return command.op === 'snapshot' ? current : {};
  } });
  const initial = await request({ op: 'inspect' });
  assert.equal(initial.composer, undefined);
  await request({ op: 'send', route: initial.route, text: '中文\n完整消息' });
  assert.deepEqual(calls.at(-1), { op: 'send', route: initial.route, key: 'node-16', text: '中文\n完整消息' });
  current.nodes[16].value = '用户尚未发送的草稿';
  const count = calls.filter(command => command.op === 'send').length;
  await assert.rejects(request({ op: 'send', route: initial.route, text: '另外一条消息' }), { code: 'CLIENT_DRAFT' });
  assert.equal(calls.filter(command => command.op === 'send').length, count);
  current = { ...snapshot(), route: '10:20:chrome://doubao-chat/chat/456', url: 'chrome://doubao-chat/chat/456' };
  await assert.rejects(request({ op: 'send', route: initial.route, text: '禁止发到别的会话' }), { code: 'CLIENT_ROUTE' });
  assert.equal(calls.filter(command => command.op === 'send').length, count);
});

test('Windows Doubao invokes the current read button and rejects invalid input before native actions', async () => {
  const current = snapshot();
  const calls = [];
  const request = createWindowsDoubaoRequest('fixture', { request: async command => {
    calls.push(command); return command.op === 'snapshot' ? current : {};
  } });
  await request({ op: 'read', route: current.route });
  assert.deepEqual(calls.at(-1), { op: 'invoke', route: current.route, key: 'node-15' });
  await assert.rejects(request({ op: 'send', route: current.route, text: 'a\0b' }), { code: 'CLIENT_INPUT' });
  await assert.rejects(request({ op: 'send', text: '无绑定' }), { code: 'CLIENT_ROUTE' });
  await assert.rejects(request({ op: 'unknown' }), { code: 'CLIENT_INPUT' });
});

test('Windows Doubao helper uses hidden native IPC and reports native failures without exposing stderr', async () => {
  let sent;
  const data = await callWindowsDoubaoHelper('helper.exe', { op: 'snapshot' }, { run(file, args, options, callback) {
    assert.equal(file, 'helper.exe'); assert.deepEqual(args, []);
    assert.equal(options.windowsHide, true);
    const stdin = new PassThrough();
    stdin.on('data', bytes => { sent = bytes.toString(); });
    queueMicrotask(() => callback(null, JSON.stringify({ ok: true, data: { route: 'safe' } })));
    return { stdin };
  } });
  assert.deepEqual(data, { route: 'safe' });
  assert.deepEqual(JSON.parse(sent), { op: 'snapshot' });
  await assert.rejects(callWindowsDoubaoHelper('missing.exe', {}, { run(_file, _args, _options, callback) {
    queueMicrotask(() => callback(Object.assign(Error('private native path'), { killed: true })));
    return { stdin: new PassThrough() };
  } }), { code: 'CLIENT_TIMEOUT' });
});
