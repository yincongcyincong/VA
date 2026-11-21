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
const screenInterval = document.getElementById('screen-interval');
const screenDestination = document.getElementById('screen-destination');
const screenTiming = document.getElementById('screen-timing');
const musicDance = document.getElementById('music-dance');
const screenState = document.getElementById('screen-state');
const musicState = document.getElementById('music-state');
const status = document.getElementById('status');
const voiceName = document.getElementById('voice-name');
const voiceProvider = document.getElementById('voice-provider');
const volcForm = document.getElementById('volc-form');
const volcResource = document.getElementById('volc-resource');
const voiceStatus = document.getElementById('voice-status');
const voiceFile = document.getElementById('voice-file');
const listen = document.getElementById('voice-preview');
const original = document.getElementById('voice-original');
const modelSummary = document.getElementById('model-summary');
const modelStatus = document.getElementById('model-status');
const modelFile = document.getElementById('model-file');
const nameForm = document.getElementById('character-name-form');
const nameInput = document.getElementById('character-name');
const nameStatus = document.getElementById('character-name-status');
let lastName;
let modelPending = false;

const tabs = document.getElementById('settings-tabs');
function showSection(section) {
  const selected = tabs.querySelectorAll('[data-choice]');
  if (![...selected].some(button => button.dataset.choice === section)) return;
  markChoice(tabs, section);
  for (const button of selected) document.getElementById(button.getAttribute('aria-controls')).hidden = button.dataset.choice !== section;
  window.scrollTo(0, 0);
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
  scale.disabled = clickThrough.disabled = screenWatch.disabled = musicDance.disabled = false;
  const canObserve = ['local', 'api'].includes(settings.integrationMode);
  screenWatch.disabled = musicDance.disabled = !canObserve;
  for (const option of screenInterval.children) option.disabled = !canObserve;
  screenDestination.textContent = settings.integrationMode === 'local'
    ? '截图发送给选定的本地 Agent 及其模型服务。角色隐藏时暂停。'
    : settings.integrationMode === 'api'
      ? '截图发送给已配置的视觉模型。角色隐藏时暂停。'
      : '此接入方式下，VA 暂停主动看屏幕和跟随音乐。';
  renderSenses(settings.senses);
  if (settings.model) {
    const model = settings.model;
    const modes = { pmx: 'MMD 骨骼', vrm: 'VRM 人形', clips: '自带动画', static: '静态模型' };
    const mode = modes[model.mode] ?? '';
    modelSummary.textContent = [model.name, model.format.toUpperCase(), mode,
      model.animationCount ? model.animationCount + ' 段动画' : ''].filter(Boolean).join(' · ');
    modelFile.disabled = modelPending;
    if (!modelPending) modelStatus.textContent = model.warning || '';
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
    status.textContent = error.message;
  }
}

window.va.onSettings(render);
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

function renderVoice(config) {
  voiceName.textContent = config.referenceName || '未选择录音';
  markChoice(voiceProvider, config.provider);
  volcForm.hidden = config.provider !== 'volc';
  volcForm.elements.speaker.value = config.volc.speaker;
  volcForm.elements.apiKey.value = '';
  volcForm.elements.apiKey.placeholder = config.volc.hasKey ? '已配置，留空保留' : '输入控制台 API Key';
  markChoice(volcResource, config.volc.resourceId);
  original.disabled = !config.referenceName;
}

async function updateVoice(change) {
  try {
    renderVoice(await window.va.voiceConfig(change));
    voiceStatus.textContent = change?.provider === 'volc' ? '已启用火山 TTS。' : '';
  } catch (error) {
    voiceStatus.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }
}

onChoice(voiceProvider, value => {
  if (value === 'system') void updateVoice({ provider: 'system' });
  else {
    volcForm.hidden = false;
    volcForm.elements.apiKey.focus();
  }
});
onChoice(volcResource, value => markChoice(volcResource, value));
volcForm.addEventListener('submit', async event => {
  event.preventDefault();
  const { speaker, apiKey } = volcForm.elements;
  const save = volcForm.querySelector('button[type=submit]');
  save.disabled = true;
  try {
    await updateVoice({ provider: 'volc', volc: { speaker: speaker.value.trim(),
      resourceId: choiceValue(volcResource), apiKey: apiKey.value } });
  } finally { save.disabled = false; }
});

voiceFile.addEventListener('click', async () => {
  voiceFile.disabled = true;
  try {
    renderVoice(await window.va.chooseVoiceFile());
    voiceStatus.textContent = '';
  } catch (error) {
    voiceStatus.textContent = error.message;
  } finally {
    voiceFile.disabled = false;
  }
});
listen.addEventListener('click', async () => {
  listen.disabled = true;
  voiceStatus.textContent = '正在生成试听…';
  try {
    const preview = await window.va.previewVoice();
    voiceStatus.textContent = preview.voiceWarning || '试听完成。';
  } catch (error) {
    voiceStatus.textContent = error.message;
  } finally {
    listen.disabled = false;
  }
});
original.addEventListener('click', async () => {
  original.disabled = true;
  let url;
  let audio;
  try {
    url = URL.createObjectURL(new Blob([await window.va.previewReference()], { type: 'audio/wav' }));
    audio = new Audio(url);
    await new Promise((resolve, reject) => {
      audio.addEventListener('ended', resolve, { once: true });
      audio.addEventListener('error', () => reject(new Error('无法播放参考录音。')), { once: true });
      audio.play().catch(reject);
    });
    voiceStatus.textContent = '已播放参考原声。';
  } catch (error) {
    voiceStatus.textContent = error.message;
  } finally {
    if (url) URL.revokeObjectURL(url);
    original.disabled = false;
  }
});
document.getElementById('voice-config').addEventListener('click', async () => {
  const error = await window.va.openVoiceFile().catch(error => error.message);
  voiceStatus.textContent = error || '';
});

await update();
await updateVoice();

modelFile.addEventListener('click', async () => {
  modelPending = modelFile.disabled = true;
  modelStatus.textContent = '正在加载模型…';
  let errorMessage;
  try {
    await window.va.chooseModel();
  } catch (error) {
    errorMessage = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  } finally {
    modelPending = false;
    await update();
    if (errorMessage) modelStatus.textContent = errorMessage;
  }
});
