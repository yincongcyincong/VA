import { markChoice, onChoice } from './settings-tabs.js';

const byId = id => document.getElementById(id);
const call = window.va.localChat;
const modes = byId('mode');
const providers = byId('providers');
const configuration = byId('configuration');
const binding = byId('binding');
const createSession = byId('create-session');
const sessions = byId('session-history');
const routeConfiguration = byId('route-configuration');
const status = byId('chat-status');
const clientStatus = byId('doubao-bind-status');
const captionStart = byId('doubao-caption-start');
const captionStop = byId('doubao-caption-stop');
const captionActions = byId('doubao-caption-actions');
const listenActions = byId('doubao-listen-actions');
const captionStatus = byId('doubao-caption-status');

let current;
let working = false;
let sessionListKey;
let revision = 0;

function errorText(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function renderCaptions(state) {
  const running = state.phase !== 'idle';
  captionStart.disabled = captionActions.disabled = listenActions.disabled = running;
  captionStop.disabled = !running;
  captionStatus.textContent = state.message;
  byId('doubao-caption-text').textContent = state.text;
  const micStatus = byId('doubao-mic-status');
  micStatus.textContent = state.micStatus ?? '';
  micStatus.hidden = !state.micStatus;
}

function controls() {
  const busy = working || !current || current.busy;
  for (const group of [modes, providers, configuration, routeConfiguration]) {
    for (const control of group.querySelectorAll('button, input')) control.disabled = Boolean(busy);
  }
  for (const control of binding.elements) control.disabled = Boolean(busy || !current?.provider);
  createSession.disabled = Boolean(busy || !current?.provider);
  for (const control of sessions.querySelectorAll('button')) control.disabled = Boolean(busy || control.dataset.unavailable);
  const bound = Boolean(current?.client?.title);
  byId('doubao-client-bind').disabled = Boolean(busy);
  byId('doubao-client-unbind').disabled = Boolean(busy || !bound);
  for (const id of ['doubao-client-context', 'doubao-client-read']) {
    byId(id).disabled = Boolean(busy || !bound || current.client.problem);
  }
}

function sessionButton(text, handle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', handle);
  return button;
}

function renderSessions(provider, history) {
  const records = history.filter(record => record.provider === provider);
  const key = JSON.stringify([provider, records]);
  if (key === sessionListKey) return;
  sessionListKey = key;
  const empty = byId('session-empty');
  empty.hidden = records.length > 0;
  empty.textContent = provider ? '这个 Agent 还没有绑定记录。' : '选择一个 Agent 查看绑定记录。';
  sessions.replaceChildren(...records.map(record => {
    const item = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('strong');
    const id = document.createElement('code');
    const cwd = document.createElement('p');
    title.textContent = record.title || '未命名会话';
    id.textContent = record.id;
    cwd.textContent = record.cwd;
    info.append(title, id, cwd);
    if (record.boundAt) {
      const time = document.createElement('time');
      time.dateTime = record.boundAt;
      time.textContent = new Date(record.boundAt).toLocaleString();
      info.append(time);
    }
    const actions = document.createElement('div');
    actions.className = 'row';
    const restore = sessionButton(record.active ? '当前绑定' : '重新绑定',
      () => void edit('restore-session', record.ref, '已恢复会话绑定。'));
    if (record.active) restore.dataset.unavailable = 'true';
    actions.append(restore);
    if (record.canOpen) actions.append(sessionButton('打开并绑定',
      () => void edit('open-session', record.ref, '已打开会话并接收它的新回复。')));
    const unbind = sessionButton('解除绑定', () => void edit('unbind-session', record.ref, '已解除绑定，会话仍保存在记录中。'));
    if (!record.bound) unbind.dataset.unavailable = 'true';
    actions.append(unbind);
    item.append(info, actions);
    return item;
  }));
}

function render(state, syncFields = false) {
  const { mode, route } = state.integration;
  const local = mode === 'local';
  const client = mode === 'doubao-client';
  syncFields ||= mode !== current?.integration.mode || state.provider !== current?.provider;
  current = state;

  markChoice(modes, mode);
  byId('local-panel').hidden = byId('session-panel').hidden = !local;
  byId('doubao-client-panel').hidden = byId('doubao-captions-panel').hidden = !client;
  routeConfiguration.hidden = !route;
  byId('openclaw-fields').hidden = mode !== 'openclaw';
  const activeTitle = state.sessionHistory?.find(record => record.active)?.title;
  byId('connection').textContent = local ? (state.provider
    ? state.label + (state.sessionId ? ' · ' + (activeTitle || state.sessionId) : ' · 未绑定会话') : '请选择 Agent')
    : route ? (route.target ? '接收频道回复 · ' + route.target : '请配置目标频道')
      : client ? (state.client?.title || '未绑定本机对话') : '智能体接入已关闭';

  if (local) {
    markChoice(providers, state.provider);
    renderSessions(state.provider, state.sessionHistory ?? []);
    if (syncFields) {
      configuration.elements.cwd.value = state.workingDirectory;
      configuration.elements.cwd.placeholder = state.launchDirectory;
      configuration.elements.speak.checked = state.speakReplies;
    }
  }
  if (client) {
    if (syncFields) {
      captionActions.checked = state.autoActions;
      listenActions.checked = state.listenForActions;
    }
    renderCaptions(state.captions);
  } else clientStatus.textContent = '';
  byId('doubao-client-hint').textContent = state.client?.problem ||
    (state.client?.contextSent ? '已将角色能力发到这条豆包对话。' : '');
  if (route && syncFields) {
    for (const field of ['target', 'channel', 'accountId', 'sessionKey']) routeConfiguration.elements[field].value = route[field];
    routeConfiguration.elements.speak.checked = route.speakReplies;
  }
  controls();
}

async function refresh() {
  const requested = ++revision;
  try {
    const result = await call('status');
    if (requested === revision && !working) render(result);
  } catch (error) {
    if (requested === revision) status.textContent = errorText(error);
  }
}

async function edit(operation, value, success = '', pending = '') {
  if (working) return false;
  revision++;
  const feedback = operation.startsWith('doubao-client-') ? clientStatus : status;
  working = true;
  feedback.textContent = pending;
  controls();
  try {
    const result = await call(operation, value);
    render(result, true);
    feedback.textContent = typeof success === 'function' ? success(result) : success;
    return true;
  } catch (error) {
    feedback.textContent = errorText(error);
    return false;
  } finally {
    working = false;
    controls();
    if (operation === 'open-session') void refresh();
  }
}

onChoice(modes, mode => {
  if (mode !== current?.integration.mode) void edit('integration', { mode });
});
onChoice(providers, provider => {
  if (provider !== current?.provider) void edit('configure', { provider });
});
configuration.addEventListener('submit', event => {
  event.preventDefault();
  const { cwd, speak } = configuration.elements;
  void edit('configure', { cwd: cwd.value, speakReplies: speak.checked }, '已保存 Agent。');
});
binding.addEventListener('submit', async event => {
  event.preventDefault();
  if (await edit('bind', binding.elements.session.value, '已绑定会话。')) binding.reset();
});
createSession.addEventListener('click', () => {
  void edit('create-session', undefined, ({ label, openedSession }) => openedSession.sessionId
    ? `已打开并绑定 ${label} 的新会话。`
    : `已打开 ${label}。开始聊天后，可用新会话的 ID 绑定 VA。`, '正在打开 Agent…');
});
routeConfiguration.addEventListener('submit', event => {
  event.preventDefault();
  const { target, channel, accountId, sessionKey, speak } = routeConfiguration.elements;
  void edit('integration', { mode: current.integration.mode, route: { target: target.value, channel: channel.value,
    accountId: accountId.value, sessionKey: sessionKey.value, speakReplies: speak.checked } }, '已保存频道。');
});
byId('config-file').addEventListener('click', async () => {
  try { status.textContent = await call('open-config') || ''; }
  catch (error) { status.textContent = errorText(error); }
});
for (const [action, success, pending] of [
  ['open', '', ''],
  ['read', '', ''],
  ['bind', '已绑定豆包当前对话。', '正在识别豆包当前对话…'],
  ['unbind', '已解除绑定。', ''],
  ['context', '已同步角色 Prompt 和动作能力。', '正在同步角色 Prompt 和动作能力…'],
]) {
  const operation = 'doubao-client-' + action;
  byId(operation).addEventListener('click', () => void edit(operation, undefined, success, pending));
}
captionStart.addEventListener('click', async () => {
  captionStart.disabled = captionActions.disabled = listenActions.disabled = true;
  try {
    renderCaptions(await call('doubao-caption-start', { autoActions: captionActions.checked, listen: listenActions.checked }));
  } catch (error) {
    renderCaptions({ phase: 'idle', message: errorText(error), text: '' });
  }
});
captionStop.addEventListener('click', async () => {
  try { renderCaptions(await call('doubao-caption-stop')); }
  catch (error) { captionStatus.textContent = errorText(error); }
});
window.va.onDoubaoCaptions(renderCaptions);
byId('doubao-caption-privacy').addEventListener('click', async () => {
  try { await window.va.openCapturePrivacy(); }
  catch (error) { captionStatus.textContent = errorText(error); }
});
window.va.onChatRefresh(() => { if (!working) void refresh(); });
controls();
await refresh();
