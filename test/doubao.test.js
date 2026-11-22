import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createDoubaoClient } from '../desktop/doubao-client.js';
import { ControlError } from '../lib/control.js';

const existing = { title: '测试对话', route: 'fixture-route', reply: '旧回复' };

test('client binding returns native errors and cannot finish after switching modes', async t => {
  const window = Promise.withResolvers();
  const client = createDoubaoClient({
    request: () => window.promise, onChange: () => {}, onReply: () => {}, onInput: () => {},
  });
  t.after(() => client.unbind());
  let active = true;
  const binding = client.bind(() => active);
  active = false;
  window.resolve(existing);
  await assert.rejects(binding, { code: 'CANCELED' });
  assert.equal(client.state().client.title, undefined);
  const unavailable = createDoubaoClient({
    request: async () => { throw new ControlError('CLIENT_ROUTE', '未找到会话'); },
  });
  await assert.rejects(unavailable.bind(() => true), { code: 'CLIENT_ROUTE' });
});

test('client sends role context once and shows replies from the bound conversation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const replies = [];
  let visible = existing;
  const client = createDoubaoClient({
    request: async command => {
      requests.push(command);
      if (command.op === 'inspect') return visible;
      assert.equal(command.route, existing.route);
    },
    onChange: () => {}, onReply: reply => replies.push(reply), onInput: () => {},
  });
  t.after(() => client.unbind());
  await client.bind(() => true);
  assert.equal(client.state().client.title, '测试对话');
  const first = client.send('你好', { context: '角色可以挥手' });
  await setImmediate();
  assert.match(requests.at(-1).text, /【VA 角色能力】角色可以挥手/);
  visible = { ...existing, reply: '你好呀' };
  t.mock.timers.tick(1000);
  assert.deepEqual(await first, { reply: '你好呀' });
  await setImmediate();
  const second = client.send('继续', { context: '角色可以挥手' });
  await setImmediate();
  assert.equal(requests.at(-1).text, '继续');
  visible = { ...existing, reply: '继续聊' };
  t.mock.timers.tick(1000);
  assert.deepEqual(await second, { reply: '继续聊' });
  assert.deepEqual(replies, ['你好呀', '继续聊']);
  assert.equal(client.state().client.contextSent, true);
});

test('client polling exposes only the current binding problem and recovers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let missing = false;
  const client = createDoubaoClient({
    request: async () => {
      if (missing) throw new ControlError('CLIENT_ROUTE', '请切回测试对话');
      return existing;
    },
    onChange: () => {}, onReply: () => {}, onInput: () => {},
  });
  t.after(() => client.unbind());
  await client.bind(() => true);
  missing = true;
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(client.state().client.problemCode, 'CLIENT_ROUTE');
  missing = false;
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(client.state().client.problemCode, undefined);
  assert.equal(client.state().client.problem, '');
});
