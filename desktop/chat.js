import { choices, choiceValue, markChoice, onChoice } from './settings-tabs.js';
import { renderDoubao } from './doubao-chat.js';

const byId = id => document.getElementById(id);
const configuration = byId('configuration');
const routeConfiguration = byId('route-configuration');
const modes = byId('mode');
const providers = byId('providers');
const binding = byId('binding');
const composer = byId('composer');
const history = byId('history');
const connection = byId('connection');
const status = byId('chat-status');
const send = byId('send');
const stop = byId('stop');
const newChat = byId('new');
const message = composer.elements.message;
const call = window.va.localChat;

const profileList = byId('profiles');
const profileDialog = byId('profile-dialog');
const profileForm = byId('profile-form');
const profileTabs = byId('profile-tabs');
const profileStatus = byId('profile-status');
const captionPanel = byId('doubao-captions-panel');
const captionStart = byId('doubao-caption-start');
const captionStop = byId('doubao-caption-stop');
const captionDance = byId('doubao-caption-dance');
const listenDance = byId('doubao-listen-dance');
const captionStatus = byId('doubao-caption-status');
const micStatus = byId('doubao-mic-status');
const captionText = byId('doubao-caption-text');
const protocols = [['chat', 'OpenAI Chat'], ['responses', 'OpenAI Responses'], ['anthropic', 'Anthropic']];
const modelKinds = ['language', 'vision'];
let editingProfile;
let current;
let responding = false;
let working = false;

function errorText(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function renderCaptions(state) {
  const running = state.phase !== 'idle';
  captionStart.disabled = captionDance.disabled = listenDance.disabled = running;
  captionStop.disabled = !running;
  captionStatus.textContent = state.message;
  micStatus.textContent = state.micStatus ?? '';
  micStatus.hidden = !state.micStatus;
  captionText.textContent = state.text;
}

function controls() {
  const busy = working || current?.busy;
  const local = current?.integration.mode === 'local';
  const api = current?.integration.mode === 'api';
  const client = current?.integration.mode === 'doubao-client';
  for (const button of modes.children) button.disabled = button.hidden || working || !current;
  for (const button of providers.children) button.disabled = Boolean(busy);
  for (const form of [configuration, routeConfiguration]) {
    for (const control of form.elements) control.disabled = Boolean(busy);
  }
  const unavailable = Boolean(busy) || !(client ? current.client?.title && !current.client.problem
    : api ? current.activeApi : local && current.provider);
  for (const control of binding.elements) control.disabled = unavailable || !local;
  newChat.disabled = unavailable;
  send.disabled = (working && !responding) || !current;
  byId('doubao-client-bind').disabled = Boolean(busy);
  byId('doubao-client-unbind').disabled = !current?.client?.title || working;
  byId('doubao-client-context').disabled = unavailable || !client;
  byId('doubao-client-read').disabled = unavailable || !client;
  stop.disabled = !responding && !current?.busy;
  for (const button of byId('api-panel').querySelectorAll('button')) {
    button.disabled = Boolean(busy);
  }
}

function line(who, text, user = false) {
  const item = document.createElement('li');
  item.className = user ? 'user' : 'agent';
  const author = document.createElement('small');
  const paragraph = document.createElement('p');
  author.textContent = who;
  paragraph.textContent = text;
  item.append(author, paragraph);
  history.append(item);
  history.scrollTop = history.scrollHeight;
}

function button(label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function renderProfiles({ profiles = [], selected }) {
  profileList.replaceChildren();
  byId('profile-empty').hidden = profiles.length > 0;
  for (const profile of profiles) {
    const item = document.createElement('li');
    item.className = 'profile';
    const summary = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = profile.name;
    const parts = [profile.language.model, profile.language.baseUrl].filter(Boolean);
    summary.append(title);
    if (parts.length) {
      const metadata = document.createElement('p');
      metadata.textContent = parts.join(' · ');
      summary.append(metadata);
    }
    if (profile.reason) {
      const warning = document.createElement('p');
      warning.textContent = profile.reason;
      summary.append(warning);
    }
    const actions = document.createElement('div');
    actions.className = 'row';
    if (selected === profile.id && !profile.reason) {
      const active = document.createElement('span');
      active.className = 'profile-state';
      active.textContent = '使用中';
      actions.append(active);
    } else if (!profile.reason) {
      actions.append(button('使用', () => void edit('api-profile', { op: 'select', id: profile.id })));
    }
    if (profile.source === 'cli') actions.append(button('复制为自定义…', () => openProfile(profile, true)));
    else actions.append(button('编辑…', () => openProfile(profile)));
    item.append(summary, actions);
    profileList.append(item);
  }
}

function render(state, syncFields) {
  current = state;
  const { mode, selected, profiles, route } = current.integration;
  const local = mode === 'local';
  const api = mode === 'api';
  const doubao = mode === 'doubao';
  const client = mode === 'doubao-client';
  modes.querySelector('[data-choice="doubao-client"]').hidden = state.integration.nativeDoubao === false;
  const profile = profiles?.find(entry => entry.id === selected);
  current.activeApi = Boolean(profile && !profile.reason);
  current.agentLabel = local ? state.label : api ? (profile?.name ?? '模型 API')
    : [...modes.children].find(button => button.dataset.choice === mode)?.textContent;
  markChoice(modes, mode);
  byId('local-panel').hidden = !local;
  byId('doubao-client-panel').hidden = !client;
  captionPanel.hidden = !client;
  if (client) {
    if (syncFields) {
      captionDance.checked = state.autoDance;
      listenDance.checked = state.listenForDance;
    }
    renderCaptions(state.captions);
  }
  byId('doubao-client-hint').textContent = state.client?.problem ||
    (state.client?.contextSent ? '已将角色能力发到这条豆包对话。' : '');
  renderDoubao(doubao ? current.integration.doubao : null, current.doubao, syncFields);
  byId('api-panel').hidden = !api;
  routeConfiguration.hidden = !route;
  byId('conversation').hidden = mode === 'off' || doubao;
  composer.hidden = !local && !api && !client;
  newChat.hidden = !local && !api;
  byId('openclaw-fields').hidden = mode !== 'openclaw';
  connection.textContent = local ? (state.provider ? state.label + (state.sessionId ? ' · ' + state.sessionId : ' · 新会话') : '请选择 Agent')
    : route ? (route.target ? '接收频道回复 · ' + route.target : '请配置目标频道')
      : api ? (current.activeApi ? profile.name : '请选择 API 配置')
        : doubao ? '豆包实时语音' : client ? (state.client.title || '未绑定本机对话') : '';
  if (syncFields && local) {
    const { cwd, model, prompt, speak } = configuration.elements;
    markChoice(providers, state.provider);
    byId('model-field').hidden = !['codex', 'claude', 'omp'].includes(state.provider);
    model.value = state.models[state.provider] ?? '';
    cwd.value = state.workingDirectory;
    cwd.placeholder = state.launchDirectory;
    prompt.value = state.prompt;
    speak.checked = state.speakReplies;
  }
  if (api) renderProfiles(current.integration);
  if (syncFields && route) {
    for (const field of ['target', 'channel', 'accountId', 'sessionKey']) routeConfiguration.elements[field].value = route[field];
    routeConfiguration.elements.speak.checked = route.speakReplies;
  }
  history.replaceChildren();
  for (const turn of state.history) {
    if (turn.message) line('你', turn.message, true);
    line(current.agentLabel, turn.reply);
  }
  controls();
}

async function refresh(syncFields = false) {
  try {
    const state = await call('status');
    render(state, syncFields || state.integration.mode !== current?.integration.mode || state.provider !== current?.provider);
  } catch (error) { status.textContent = errorText(error); }
}

async function edit(operation, value, success = '') {
  working = true;
  status.textContent = '';
  controls();
  try {
    render(await call(operation, value), true);
    status.textContent = success;
    return true;
  } catch (error) {
    (profileDialog.open ? profileStatus : status).textContent = errorText(error);
    return false;
  } finally {
    working = false;
    controls();
  }
}

onChoice(modes, mode => { if (mode !== current?.integration.mode) void edit('integration', { mode }); });
for (const action of ['open', 'bind', 'unbind', 'read']) {
  const operation = 'doubao-client-' + action;
  byId(operation).addEventListener('click', () => void edit(operation));
}
byId('doubao-client-context').addEventListener('click', () => void edit('doubao-client-context', undefined, '豆包已回复角色能力同步消息。'));
captionStart.addEventListener('click', async () => {
  captionStart.disabled = captionDance.disabled = listenDance.disabled = true;
  try {
    renderCaptions(await call('doubao-caption-start', { dance: captionDance.checked, listen: listenDance.checked }));
  } catch (error) {
    renderCaptions({ phase: 'idle', message: errorText(error), text: '' });
  }
});
captionStop.addEventListener('click', async () => {
  try {
    renderCaptions(await call('doubao-caption-stop'));
  } catch (error) {
    captionStatus.textContent = errorText(error);
  }
});
window.va.onDoubaoCaptions(renderCaptions);
byId('doubao-caption-privacy').addEventListener('click', async () => {
  try { await window.va.openCapturePrivacy(); }
  catch (error) { captionStatus.textContent = errorText(error); }
});
onChoice(providers, provider => { if (provider !== current?.provider) void edit('configure', { provider }); });
routeConfiguration.addEventListener('submit', event => {
  event.preventDefault();
  const { target, channel, accountId, sessionKey, speak } = routeConfiguration.elements;
  void edit('integration', { mode: current.integration.mode, route: { target: target.value, channel: channel.value,
    accountId: accountId.value, sessionKey: sessionKey.value, speakReplies: speak.checked } }, '已保存频道。');
});
configuration.addEventListener('submit', event => {
  event.preventDefault();
  const { cwd, prompt, model, speak } = configuration.elements;
  void edit('configure', { cwd: cwd.value, prompt: prompt.value, model: model.value, speakReplies: speak.checked }, '已保存 Agent。');
});
binding.addEventListener('submit', event => {
  event.preventDefault();
  void edit('bind', binding.elements.session.value, '已绑定会话。');
});
newChat.addEventListener('click', () => void edit('bind', null, '已准备好新会话。'));
byId('config-file').addEventListener('click', async () => {
  try { status.textContent = await call('open-config') || ''; }
  catch (error) { status.textContent = errorText(error); }
});

function showProfileTab(tab) {
  markChoice(profileTabs, tab);
  for (const name of modelKinds) byId('profile-' + name).hidden = name !== tab;
}
onChoice(profileTabs, showProfileTab);
for (const kind of modelKinds) {
  const group = byId(kind + '-protocol');
  choices(group, protocols);
  onChoice(group, protocol => markChoice(group, protocol));
}

function openProfile(profile, copy = false) {
  editingProfile = copy ? undefined : profile?.id;
  byId('profile-title').textContent = editingProfile ? '编辑模型 API 配置' : '添加模型 API 配置';
  byId('remove-profile').hidden = !editingProfile;
  byId('remove-profile').textContent = '删除配置';
  profileForm.reset();
  const fields = profileForm.elements;
  fields.name.value = copy ? profile.name + '（自定义）' : profile?.name ?? '';
  fields.speak.checked = profile?.speakReplies === true;
  fields.prompt.value = profile?.prompt ?? '';
  fields.remote.checked = profile?.vision.allowRemoteScreenshots === true;
  for (const kind of modelKinds) {
    const model = profile?.[kind];
    fields[kind + '-url'].value = model?.baseUrl ?? '';
    fields[kind + '-model'].value = model?.model ?? '';
    fields[kind + '-key'].placeholder = editingProfile && model?.hasKey ? '留空保留已保存的密钥' : '可选';
    fields[kind + '-clear'].parentElement.hidden = !editingProfile || !model?.hasKey;
    markChoice(byId(kind + '-protocol'), model?.protocol ?? 'chat');
  }
  profileStatus.textContent = '';
  showProfileTab('language');
  profileDialog.showModal();
}

byId('add-profile').addEventListener('click', () => openProfile());
byId('refresh-profiles').addEventListener('click', () => void refresh());
byId('close-profile').addEventListener('click', () => profileDialog.close());
profileDialog.addEventListener('close', () => profileForm.reset());
byId('remove-profile').addEventListener('click', async event => {
  if (event.target.textContent === '删除配置') {
    event.target.textContent = '确认删除';
    return;
  }
  if (await edit('api-profile', { op: 'remove', id: editingProfile }, '已删除配置。')) profileDialog.close();
});
profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = profileForm.elements;
  const model = kind => ({ protocol: choiceValue(byId(kind + '-protocol')), baseUrl: fields[kind + '-url'].value,
    model: fields[kind + '-model'].value, apiKey: fields[kind + '-key'].value, clearKey: fields[kind + '-clear'].checked });
  const language = model('language');
  if (!language.baseUrl.trim() || !language.model.trim()) {
    showProfileTab('language');
    profileStatus.textContent = '请填写语言模型的 Base URL 和模型名。';
    return;
  }
  const submit = byId('save-profile');
  submit.disabled = true;
  try {
    if (await edit('api-profile', { op: 'save', id: editingProfile, name: fields.name.value,
      language, vision: { ...model('vision'), allowRemoteScreenshots: fields.remote.checked }, prompt: fields.prompt.value,
      speakReplies: fields.speak.checked }, '已保存配置。')) profileDialog.close();
  } finally { submit.disabled = false; }
});

stop.addEventListener('click', async () => {
  try {
    await call('cancel');
    if (!responding) await refresh();
  } catch (error) { status.textContent = errorText(error); }
});
message.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    if (!send.disabled) composer.requestSubmit();
  }
});
composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = message.value.trim();
  if (send.disabled || !text) return;
  if (responding) {
    try {
      const result = await call('dance-input', text);
      if (result.handled) {
        if (message.value.trim() === text) message.value = '';
        status.textContent = result.reply;
      }
    } catch (error) { status.textContent = errorText(error); }
    return;
  }
  responding = working = true;
  message.value = '';
  line('你', text, true);
  status.textContent = '正在等待 ' + current.agentLabel + '…';
  controls();
  try {
    const result = await call('send', text);
    status.textContent = result.handled === 'dance' ? result.reply : '';
  } catch (error) {
    if (!message.value) message.value = text;
    status.textContent = errorText(error);
  } finally {
    responding = working = false;
    await refresh();
    controls();
    message.focus();
  }
});

window.va.onChatRefresh(() => { if (!working) void refresh(); });
await refresh(true);
