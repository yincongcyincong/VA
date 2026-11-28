import { screenIntervals } from './preferences.js';
import { speakingStyles } from './speech-motion.js';
import { choices, choiceValue, markChoice, onChoice } from './settings-tabs.js';

const scale = document.getElementById('scale');
const value = document.getElementById('value');
const view = document.getElementById('view');
const theme = document.getElementById('theme');
const speakingStyle = document.getElementById('speaking-style');
const clickThrough = document.getElementById('click-through');
const screenWatch = document.getElementById('screen-watch');
const screenDestination = document.getElementById('screen-destination');
const screenInterval = document.getElementById('screen-interval');
const screenTiming = document.getElementById('screen-timing');
const musicDance = document.getElementById('music-dance');
const screenState = document.getElementById('screen-state');
const musicState = document.getElementById('music-state');
const status = document.getElementById('status');
const voiceProvider = document.getElementById('voice-provider');
const activeVoiceProvider = document.getElementById('active-voice-provider');
const systemVoicePicker = document.getElementById('system-voice-picker');
const systemVoiceMenu = document.getElementById('system-voice-menu');
const systemVoiceCurrent = document.getElementById('system-voice-current');
const systemVoiceChoices = document.getElementById('system-voice-choices');
const systemVoiceQuery = document.getElementById('system-voice-query');
const systemVoiceRefresh = document.getElementById('system-voice-refresh');
const systemVoiceResults = document.getElementById('system-voice-results');
const zipVoiceForm = document.getElementById('zipvoice-form');
const zipVoiceStatus = document.getElementById('zipvoice-status');
const volcForm = document.getElementById('volc-form');
const volcResource = document.getElementById('volc-resource');
const voiceStatus = document.getElementById('voice-status');
const listen = document.getElementById('voice-preview');
const modelSummary = document.getElementById('model-summary');
const modelStatus = document.getElementById('model-status');
const modelFile = document.getElementById('model-file');
const modelCheck = document.getElementById('model-check');
const modelCapabilities = document.getElementById('model-capabilities');
const performanceCategories = document.getElementById('performance-categories');
const performanceActions = document.getElementById('performance-actions');
const performancePreview = document.getElementById('performance-preview');
const performanceStatus = document.getElementById('performance-status');
const nameForm = document.getElementById('character-name-form');
const nameInput = document.getElementById('character-name');
const nameStatus = document.getElementById('character-name-status');
const rolePromptForm = document.getElementById('role-prompt-form');
const rolePromptInput = document.getElementById('role-prompt');
const rolePromptSave = rolePromptForm.querySelector('button[type=submit]');
const rolePromptStatus = document.getElementById('role-prompt-status');
let lastName;
let lastRolePrompt;
let modelPending = false;
let inspectedModel;
let actionCatalog;
let actionReady = false;
let catalogKey;
let previewCategory = 'dance';
let previewAction = 'idle';
let installedVoices;
let voiceListError = '';
let voiceOptionsKey;
let voiceConfig;
let voiceSelection;
let voiceRequest = 0;
const languageNames = new Intl.DisplayNames(['zh-Hans'], { type: 'language' });

function renderModelReport(model) {
  const checked = model?.checked;
  modelCapabilities.hidden = !checked;
  if (!checked) return;
  const format = (label, values) => label + '　' + (values?.length ? values.join('、') : '无');
  document.getElementById('model-clips').textContent = format('动画片段', model.clips);
  document.getElementById('model-morphs').textContent = format('表情目标', model.morphs);
  document.getElementById('model-bones').textContent = format('骨骼', model.bones);
}

function renderActionChoices() {
  const entries = Object.entries(actionCatalog.actions)
    .filter(([, item]) => item.category === previewCategory && !item.alternate);
  if (!entries.some(([id, item]) => id === previewAction && item.supported)) {
    previewAction = entries.find(([, item]) => item.supported)?.[0] ?? entries[0]?.[0];
  }
  performanceActions.replaceChildren();
  choices(performanceActions, entries.map(([id, item]) => [id, item.label]));
  for (const button of performanceActions.children) {
    const entry = actionCatalog.actions[button.dataset.choice];
    button.disabled = !actionReady || !entry.supported;
    if (!entry.supported) button.title = '当前模型缺少此动作需要的骨骼或动画';
  }
  markChoice(performanceCategories, previewCategory);
  markChoice(performanceActions, previewAction);
  performancePreview.disabled = !actionReady || !actionCatalog.actions[previewAction]?.supported;
}

function renderPerformance(next, ready) {
  actionCatalog = next;
  actionReady = ready;
  const key = JSON.stringify({ next, ready });
  if (catalogKey === key) return;
  catalogKey = key;
  const categories = new Set(Object.values(next.actions).filter(item => !item.alternate).map(item => item.category));
  const groups = Object.entries(next.categories).filter(([id]) => categories.has(id));
  if (!categories.has(previewCategory)) previewCategory = groups[0]?.[0];
  performanceCategories.replaceChildren();
  choices(performanceCategories, groups);
  renderActionChoices();
  if (next.warning) performanceStatus.textContent = next.warning;
}

onChoice(performanceCategories, id => {
  if (previewCategory === id) return;
  previewCategory = id;
  renderActionChoices();
});
onChoice(performanceActions, id => {
  previewAction = id;
  markChoice(performanceActions, previewAction);
});
for (const operation of ['open', 'reload', 'preview']) {
  document.getElementById('performance-' + operation).addEventListener('click', async event => {
    const button = event.currentTarget;
    const action = previewAction;
    button.disabled = true;
    try {
      const result = await window.va.performance(operation, operation === 'preview' ? { action } : undefined);
      if (operation === 'reload') render(result);
      performanceStatus.textContent = operation === 'open' ? result || '' :
        operation === 'reload' ? '配置已加载。' : '正在预览「' + (actionCatalog.actions[action]?.label ?? action) + '」。';
    } catch (error) {
      performanceStatus.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    } finally {
      button.disabled = operation === 'preview' && (!actionReady || !actionCatalog?.actions[previewAction]?.supported);
    }
  });
}

const tabs = document.getElementById('settings-tabs');
document.getElementById('quit-va').addEventListener('click', () => window.va.quit());
function showSection(section) {
  const selected = tabs.querySelectorAll('[data-choice]');
  if (![...selected].some(button => button.dataset.choice === section)) return;
  markChoice(tabs, section);
  for (const button of selected) document.getElementById(button.getAttribute('aria-controls')).hidden = button.dataset.choice !== section;
  window.scrollTo(0, 0);
  if (section !== 'voice') closeSystemVoices();
}
onChoice(tabs, showSection);
window.va.onSettingsSection(showSection);
void window.va.initialSettingsSection().then(showSection);
choices(screenInterval, screenIntervals);
choices(speakingStyle, Object.entries(speakingStyles).map(([value, { label }]) => [value, label]));

function render(settings) {
  if (lastName !== settings.characterName) {
    lastName = settings.characterName;
    nameInput.value = lastName;
  }
  if (lastRolePrompt === undefined || rolePromptInput.value === lastRolePrompt) {
    rolePromptInput.value = settings.rolePrompt;
  }
  lastRolePrompt = settings.rolePrompt;
  rolePromptSave.disabled = rolePromptInput.readOnly;
  document.documentElement.dataset.theme = settings.theme;
  markChoice(theme, settings.theme);
  markChoice(speakingStyle, settings.speakingStyle);
  scale.value = settings.scale;
  value.value = settings.scale + '%';
  markChoice(view, settings.view);
  for (const option of view.children) option.disabled = false;
  clickThrough.checked = settings.clickThrough;
  screenWatch.checked = settings.screenWatch;
  markChoice(screenInterval, settings.screenInterval);
  musicDance.checked = settings.musicDance;
  document.getElementById('privacy').hidden = !settings.nativeSenses;
  if (settings.platform === 'win32') {
    document.getElementById('settings-shortcut').textContent = 'Ctrl+Alt+V';
    document.getElementById('music-description').textContent = 'Windows 暂不支持系统音乐识别。可以在「动作」页手动播放舞步。';
    document.getElementById('zipvoice-setup').textContent = '在 Windows 上请准备 Python、sherpa-onnx 和模型。可直接使用 24 kHz 单声道 16 位 PCM WAV，其他参考音频通过 PATH 中的 FFmpeg 转换。';
  }
  scale.disabled = clickThrough.disabled = false;
  musicDance.disabled = !settings.nativeSenses || settings.integrationMode === 'off';
  screenWatch.disabled = !settings.screenTarget && !settings.screenWatch;
  screenDestination.textContent = settings.screenTarget === 'local'
    ? '由当前选中的本地 Agent 识别截图。使用远端模型时，截图可能发给其模型服务。角色隐藏时暂停。'
    : '选用支持图片的本地 Agent 后可开启。';
  renderSenses(settings.senses);
  if (settings.model) {
    const model = settings.model;
    const modes = { pmx: 'MMD 骨骼', vrm: 'VRM 人形', clips: '自带动画', static: '静态模型' };
    const mode = modes[model.mode] ?? '';
    modelSummary.textContent = [model.name, model.format.toUpperCase(), mode,
      model.animationCount ? model.animationCount + ' 段动画' : ''].filter(Boolean).join(' · ');
    modelFile.disabled = modelCheck.disabled = modelPending;
    renderModelReport(inspectedModel ?? model);
    if (!modelPending) {
      const report = inspectedModel ?? model;
      modelStatus.textContent = (inspectedModel ? '检测通过 · ' + report.name : report.checked ? '已通过显示检测' : '') +
        (report.textureWarning ? ' · 部分贴图或材质缺失' : '') + (model.warning ? ' · ' + model.warning : '');
    }
    renderPerformance(settings.performance, model.checked);
  }
}

nameForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = nameForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    render(await window.va.nameCharacter(nameInput.value));
    nameInput.value = lastName;
    nameStatus.textContent = '名称已保存。';
  } catch (error) {
    nameStatus.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  } finally {
    button.disabled = false;
  }
});

function renderSenses(state) {
  if (!state) return;
  const screenLabels = { off: '已关闭', paused: '角色隐藏，已暂停', analyzing: '视觉 Agent 正在看屏幕…',
    waiting: '等待下一次观察', error: '屏幕观察暂不可用' };
  const musicLabels = { off: '已关闭', paused: '角色隐藏，已暂停', starting: '正在连接系统音频…',
    listening: '正在听系统音频', music: '检测到音乐', error: '系统音频暂不可用' };
  screenState.textContent = state.screen.detail || state.screen.lastActivity || screenLabels[state.screen.state];
  const { lastCapturedAt, nextCaptureAt } = state.screen;
  const time = value => {
    const date = new Date(value);
    return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString()
      : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  screenTiming.textContent = [lastCapturedAt && '上次截屏 ' + time(lastCapturedAt),
    nextCaptureAt && '下次截屏 ' + time(nextCaptureAt)].filter(Boolean).join(' · ');
  musicState.textContent = state.music.detail || musicLabels[state.music.state];
}

async function update(change) {
  try {
    render(await window.va.settings(change));
    status.textContent = '';
  } catch (error) {
    if (Object.hasOwn(change, 'screenWatch')) await window.va.settings().then(render).catch(() => {});
    status.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
}

window.va.onSettings(render);
rolePromptForm.addEventListener('submit', async event => {
  event.preventDefault();
  rolePromptInput.readOnly = rolePromptSave.disabled = true;
  try {
    const settings = await window.va.saveRolePrompt(rolePromptInput.value);
    render(settings);
    rolePromptInput.value = settings.rolePrompt;
    rolePromptStatus.textContent = 'Prompt 已保存。';
  } catch (error) {
    rolePromptStatus.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  } finally {
    rolePromptInput.readOnly = rolePromptSave.disabled = false;
  }
});
window.va.onVoiceChanged(renderVoice);
window.va.onSenses(renderSenses);
scale.addEventListener('input', () => {
  value.value = scale.value + '%';
  window.va.previewScale(Number(scale.value));
});
scale.addEventListener('change', () => update({ scale: Number(scale.value) }));
onChoice(view, value => void update({ view: value }));
onChoice(theme, value => void update({ theme: value }));
onChoice(speakingStyle, value => void update({ speakingStyle: value }));
clickThrough.addEventListener('change', () => update({ clickThrough: clickThrough.checked }));
screenWatch.addEventListener('change', () => update({ screenWatch: screenWatch.checked }));
onChoice(screenInterval, value => void update({ screenInterval: Number(value) }));
musicDance.addEventListener('change', () => update({ musicDance: musicDance.checked }));
for (const [id, open] of [
  ['character', window.va.openCharacter], ['privacy', window.va.openCapturePrivacy],
]) {
  document.getElementById(id).addEventListener('click', async () => {
    const error = await open().catch(error => error.message);
    status.textContent = error || '';
  });
}

function renderVoicePanel() {
  markChoice(voiceProvider, voiceSelection);
  systemVoicePicker.hidden = voiceSelection !== 'system';
  if (systemVoicePicker.hidden) closeSystemVoices();
  zipVoiceForm.hidden = voiceSelection !== 'zipvoice';
  volcForm.hidden = voiceSelection !== 'volc';
  const active = voiceConfig?.provider;
  activeVoiceProvider.hidden = !active || active === voiceSelection;
  activeVoiceProvider.textContent = activeVoiceProvider.hidden ? '' :
    '当前使用 ' + voiceProvider.querySelector(`[data-choice="${active}"]`).textContent;
}

function renderVoice(config) {
  const previous = voiceConfig;
  voiceConfig = config;
  if (config.recognition?.engine === 'sensevoice' && JSON.stringify(config.recognition) !== JSON.stringify(previous?.recognition)) {
    void checkRecognitionSetup();
  } else if (config.recognition?.engine === 'system') {
    document.getElementById('speech-recognition-status').textContent = '使用 Windows 系统识别，无需下载 SenseVoice 模型。';
  }
  const recognitionForm = document.getElementById('speech-recognition-form');
  recognitionForm.hidden = !config.recognition;
  if (config.recognition) {
    for (const [key, value] of Object.entries(config.recognition)) {
      const field = recognitionForm.elements[key];
      if (!previous?.recognition || field.value === previous.recognition[key]) field.value = value;
    }
    document.getElementById('speech-recognition-paths').hidden = recognitionForm.elements.engine.value !== 'sensevoice';
  }
  if (Object.hasOwn(config, 'playbackWarning')) {
    if (config.playbackWarning) voiceStatus.textContent = config.playbackWarning;
    else if (previous?.playbackWarning) voiceStatus.textContent = '';
  }
  voiceSelection ??= config.provider;
  renderVoicePanel();
  const preparation = config.zipvoicePreparation;
  zipVoiceStatus.textContent = preparation?.phase === 'loading' ? '正在后台加载 ZipVoice…'
    : preparation?.phase === 'error' ? preparation.message : '';
  for (const [key, value] of Object.entries(config.zipvoice)) {
    const field = zipVoiceForm.elements[key];
    if (!previous || field.value === previous.zipvoice[key]) field.value = value;
  }
  renderSystemVoices();
  if (!previous || volcForm.elements.speaker.value === previous.volc.speaker) {
    volcForm.elements.speaker.value = config.volc.speaker;
  }
  volcForm.elements.apiKey.placeholder = config.volc.hasKey ? '已配置，留空保留' : '输入控制台 API Key';
  if (!previous || choiceValue(volcResource) === previous.volc.resourceId) markChoice(volcResource, config.volc.resourceId);
}

const localVoiceNames = { Tingting: '婷婷', Meijia: '美佳', Sinji: '善怡' };
const systemDefault = '跟随系统朗读音色';

function systemVoiceLabel(name) {
  return (Object.hasOwn(localVoiceNames, name) ? localVoiceNames[name] + ' · ' + name : name) || systemDefault;
}

function systemVoiceLanguage(language) {
  try { return languageNames.of(language) ?? language; }
  catch { return language; }
}

function renderSystemVoices() {
  const selected = voiceConfig?.systemVoice ?? '';
  systemVoiceCurrent.textContent = systemVoiceLabel(selected);
  systemVoiceCurrent.title = systemVoiceCurrent.textContent;
  if (systemVoiceMenu.hidden) return;
  const query = systemVoiceQuery.value.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (...terms) => query.every(word => terms.some(term => term?.toLowerCase().includes(word)));
  const filtered = (installedVoices ?? []).filter(({ name, language }) =>
    matches(systemVoiceLabel(name), language, systemVoiceLanguage(language)));
  const priority = voice => voice.name === selected ? 0 : voice.language.startsWith('zh-') ? 1 : 2;
  filtered.sort((a, b) => priority(a) - priority(b));
  const options = filtered.map(({ name, language }) =>
    [name, name.includes(' (') ? name : systemVoiceLabel(name) + ' · ' + systemVoiceLanguage(language)]);
  if (matches(systemDefault)) options.splice(options[0]?.[0] === selected ? 1 : 0, 0, ['', systemDefault]);
  const optionsKey = JSON.stringify(options);
  if (voiceOptionsKey !== optionsKey) {
    const focused = systemVoiceChoices.contains(document.activeElement) ? document.activeElement.dataset.choice : undefined;
    systemVoiceChoices.replaceChildren();
    choices(systemVoiceChoices, options);
    voiceOptionsKey = optionsKey;
    if (focused !== undefined) {
      const option = [...systemVoiceChoices.children].find(button => button.dataset.choice === focused);
      (option ?? systemVoiceQuery).focus();
    }
  }
  markChoice(systemVoiceChoices, selected);
  const hasVoices = Boolean(installedVoices?.length);
  if (systemVoiceRefresh.disabled) {
    systemVoiceResults.textContent = hasVoices ? '正在后台更新音色…' : '正在读取本机音色…';
  } else if (voiceListError) {
    systemVoiceResults.textContent = voiceListError + (hasVoices ? ' 已保留上次读取的音色。' : '');
  } else {
    systemVoiceResults.textContent = options.length ? '' : '没有找到匹配的音色。';
  }
}

async function refreshSystemVoices() {
  systemVoiceRefresh.disabled = true;
  renderSystemVoices();
  try {
    if (!installedVoices) {
      installedVoices = await window.va.cachedSystemVoices().catch(() => []);
      renderSystemVoices();
    }
    installedVoices = await window.va.systemVoices();
    voiceListError = '';
  } catch (error) {
    voiceListError = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  } finally {
    systemVoiceRefresh.disabled = false;
    renderSystemVoices();
  }
}

function openSystemVoices() {
  if (!systemVoiceMenu.hidden) return;
  systemVoiceMenu.hidden = false;
  if (!installedVoices && !systemVoiceRefresh.disabled) void refreshSystemVoices();
  else renderSystemVoices();
}
systemVoiceQuery.addEventListener('focus', openSystemVoices);
systemVoiceQuery.addEventListener('click', openSystemVoices);
systemVoiceQuery.addEventListener('input', () => {
  if (systemVoiceMenu.hidden) openSystemVoices();
  else renderSystemVoices();
});
systemVoiceRefresh.addEventListener('click', () => {
  systemVoiceMenu.hidden = false;
  void refreshSystemVoices();
});
function closeSystemVoices() {
  systemVoiceMenu.hidden = true;
  systemVoiceQuery.value = '';
}
document.addEventListener('pointerdown', event => {
  if (!systemVoiceMenu.hidden && !systemVoicePicker.contains(event.target)) closeSystemVoices();
});
systemVoicePicker.addEventListener('focusout', event => {
  if (event.relatedTarget && !systemVoicePicker.contains(event.relatedTarget)) closeSystemVoices();
});
systemVoicePicker.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.target === systemVoiceQuery && event.key === 'ArrowDown') openSystemVoices();
  if (systemVoiceMenu.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    systemVoiceQuery.focus();
    closeSystemVoices();
    return;
  }
  const options = [...systemVoiceChoices.querySelectorAll('button')];
  if (event.target === systemVoiceQuery && event.key === 'Enter' && options.length === 1) {
    event.preventDefault();
    options[0].click();
    return;
  }
  const index = options.indexOf(event.target);
  if (event.key === 'ArrowDown' && (index >= 0 || event.target === systemVoiceQuery)) {
    event.preventDefault();
    options[Math.min(index + 1, options.length - 1)]?.focus();
  } else if (event.key === 'ArrowUp' && index >= 0) {
    event.preventDefault();
    (options[index - 1] ?? systemVoiceQuery).focus();
  }
});
systemVoiceChoices.addEventListener('click', event => {
  const option = event.target.closest('button[data-choice]');
  if (!option) return;
  const value = option.dataset.choice;
  systemVoiceQuery.focus();
  closeSystemVoices();
  if (value !== voiceConfig?.systemVoice) void updateVoice({ provider: 'system', systemVoice: value });
});

async function updateVoice(change) {
  const request = ++voiceRequest;
  try {
    const config = await window.va.voiceConfig(change);
    if (request === voiceRequest) {
      renderVoice(config);
      voiceStatus.textContent = { volc: '已启用火山 TTS。', zipvoice: '已保存本地音色复刻。' }[change?.provider] ?? '';
    }
    return true;
  } catch (error) {
    if (request === voiceRequest) voiceStatus.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    return false;
  }
}

onChoice(voiceProvider, value => {
  voiceSelection = value;
  renderVoicePanel();
  voiceStatus.textContent = '';
  if (value === 'system') void updateVoice({ provider: 'system' });
});
document.getElementById('choose-voice-reference').addEventListener('click', async () => {
  try {
    const path = await window.va.chooseVoiceReference();
    if (path) {
      zipVoiceForm.elements.referenceAudio.value = path;
      zipVoiceForm.elements.referenceText.focus();
    }
  } catch (error) {
    voiceStatus.textContent = error.message;
  }
});
zipVoiceForm.addEventListener('submit', async event => {
  event.preventDefault();
  const zipvoice = Object.fromEntries([...new FormData(zipVoiceForm)].map(([key, text]) => [key, text.trim()]));
  const save = zipVoiceForm.querySelector('button[type=submit]');
  save.disabled = true;
  voiceStatus.textContent = '正在检查参考录音…';
  try {
    await updateVoice({ provider: 'zipvoice', zipvoice });
  } finally { save.disabled = false; }
});
onChoice(volcResource, value => markChoice(volcResource, value));
volcForm.addEventListener('submit', async event => {
  event.preventDefault();
  const { speaker, apiKey } = volcForm.elements;
  const save = volcForm.querySelector('button[type=submit]');
  save.disabled = true;
  try {
    const key = apiKey.value;
    if (await updateVoice({ provider: 'volc', volc: { speaker: speaker.value.trim(),
      resourceId: choiceValue(volcResource), apiKey: key } }) && apiKey.value === key) apiKey.value = '';
  } finally { save.disabled = false; }
});

listen.addEventListener('click', async () => {
  listen.disabled = true;
  voiceStatus.textContent = '正在试听…';
  try {
    const preview = await window.va.previewVoice();
    voiceStatus.textContent = preview.voiceWarning || '试听完成。';
  } catch (error) {
    voiceStatus.textContent = error.message;
  } finally {
    listen.disabled = false;
  }
});
document.getElementById('voice-config').addEventListener('click', async () => {
  const error = await window.va.openVoiceConfig().catch(error => error.message);
  voiceStatus.textContent = error || '';
});

await update();
await updateVoice();

async function pickModel(checkOnly) {
  modelPending = modelFile.disabled = modelCheck.disabled = true;
  modelStatus.textContent = '正在检测模型…';
  let errorMessage;
  try {
    const report = await window.va.chooseModel(checkOnly);
    if (report) inspectedModel = checkOnly ? report : undefined;
  } catch (error) {
    errorMessage = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  } finally {
    modelPending = false;
    await update();
    if (errorMessage) modelStatus.textContent = errorMessage;
  }
}
modelFile.addEventListener('click', () => void pickModel(false));
modelCheck.addEventListener('click', () => void pickModel(true));

const recognitionForm = document.getElementById('speech-recognition-form');
let recognitionCheck = 0;
async function checkRecognitionSetup() {
  const revision = ++recognitionCheck;
  const feedback = document.getElementById('speech-recognition-status');
  try {
    const result = await window.va.recognitionStatus();
    if (revision !== recognitionCheck || voiceConfig?.recognition?.engine !== 'sensevoice') return;
    feedback.textContent = result.ready ? 'SenseVoice 环境和模型已就绪。' : result.message + '\n安装命令（在 VA 仓库根目录运行）：' + result.setup.command;
  } catch (error) { if (revision === recognitionCheck) feedback.textContent = error.message; }
}
recognitionForm.elements.engine.addEventListener('change', () => {
  document.getElementById('speech-recognition-paths').hidden = recognitionForm.elements.engine.value !== 'sensevoice';
});
recognitionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = recognitionForm.querySelector('button');
  const feedback = document.getElementById('speech-recognition-status');
  button.disabled = true;
  try {
    const recognition = Object.fromEntries(['engine', 'python', 'modelDirectory'].map(key => [key, recognitionForm.elements[key].value]));
    renderVoice(await window.va.voiceConfig({ recognition }));
    feedback.textContent = '已保存，智能体语音输入和豆包字幕共用此引擎。';
  } catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});
