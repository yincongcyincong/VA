import { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage,
  protocol, screen, session, shell, systemPreferences } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { danceActions } from './actions.js';
import { actionSupported, compilePerformance, describePerformance, performanceDefaults } from './performance-config.js';
import { danceIntent } from './dance-intent.js';
import { characterPerformancePrompt, chatPerformancePrompt, replyPerformance, requestedPerformance, requestsSelfie } from './character-performance.js';
import { ControlError, startControl } from '../lib/control.js';
import { defaultScale, isScale, minScale, maxScale,
  readCharacter, readConfig, readSettings, settingsWriter } from './config.js';
import { defaultSpeakingStyle, isSpeakingStyle } from './speech-motion.js';
import { defaultScreenInterval, isScreenInterval, screenIntervalLabel, themes } from './preferences.js';
import { apiProfileSnapshot, editApiProfiles, resolveApiConfig, selectedApiId } from './api-profiles.js';
import { createSenses } from './senses.js';
import { botRoute, checkBotRoute, configureIntegration, createApiChat, externalModes, integrationMode, integrationSnapshot } from './integration.js';
import { createLocalAgent } from './local-agent.js';
import { importReference, sampleLimit, systemSpeech } from './speech.js';
import { volcDefaults, volcKey, volcSpeech } from './volc-tts.js';
import { configureDoubao, createDoubaoConversation, doubaoConfig, doubaoSnapshot } from './doubao.js';
import { callDoubaoClient, createDoubaoClient } from './doubao-client.js';
import { createDoubaoCaptions } from './doubao-captions.js';
import { bindModel, modelFormats, modelMime, modelResource } from './model-files.js';
import { createModelLibrary, localAhaName, modelPage, modelSources } from './model-library.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const mac = process.platform === 'darwin';
const appIconPath = join(root, 'assets', 'app-icon.png');
const launchDirectory = resolve(process.env.VA_START_CWD || process.cwd());
const pageURL = 'va-app://desktop/index.html';
const bubbleURL = 'va-app://desktop/bubble.html';
const settingsURL = 'va-app://desktop/settings.html';
const controlsURL = 'va-app://desktop/controls.html';
const bundledModelPath = join(root, 'assets', 'models', 'Gemini 娘.glb');
const ahaPack = '星穹铁道-阿哈_by_崩坏：星穹铁道_df69373aacbea0a160459be2ce0eb56e';
const ahaFile = '星穹铁道-阿哈2.pmx';
let defaultModelPath = bundledModelPath;
const mime = {
  ...modelMime,
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
};
const pages = new Set(['index.html', 'style.css', 'renderer.js', 'voice.js', 'avatar.js', 'actions.js',
  'speech-motion.js', 'dance-motion.js', 'bubble.html', 'bubble.css', 'bubble.js', 'chat.js', 'settings-tabs.js', 'preferences.js',
  'model-loaders.js', 'settings.html', 'settings.css', 'settings.js', 'controls.html', 'controls.css', 'controls.js',
  'doubao-chat.js', 'doubao-mic.js', 'doubao-playback.js', 'model-gallery.js']);

protocol.registerSchemesAsPrivileged([{
  scheme: 'va-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);
app.setName('VA');
app.setPath('userData', join(app.getPath('appData'), 'VA Desktop'));
const settingsPath = join(app.getPath('userData'), 'settings.json');
const characterPath = resolve(process.env.VA_CHARACTER_CONFIG || join(app.getPath('userData'), 'character.json'));
const performancePath = resolve(process.env.VA_PERFORMANCE_CONFIG || join(app.getPath('userData'), 'performance.json'));
const agentPath = resolve(process.env.VA_AGENT_CONFIG || join(app.getPath('userData'), 'agent.json'));
const voicePath = resolve(process.env.VA_VOICE_CONFIG || join(app.getPath('userData'), 'voice.json'));
const saveSettings = settingsWriter(settingsPath);
const saveAgent = settingsWriter(agentPath);
const saveVoice = settingsWriter(voicePath);
const saveCharacter = settingsWriter(characterPath);
const launchHidden = process.argv.includes('--va-hidden');

let window;
let settingsWindow;
let modelLibrary;
let settingsSection = 'avatar';
let screenRevision = 0;
let controlsWindow;
let controlsReady = false;
let controlsPosition;
let tray;
let server;
let defaultCharacter;
let performanceCatalog = compilePerformance({});
let performanceWarning;
let characterName = 'Gemini 娘';
let nameEdits = Promise.resolve();
let defaultVoice;
let voiceEdits = Promise.resolve();
let localAgent;
let apiChat;
let doubao;
let doubaoClient;
let doubaoCaptions;
let doubaoStartRevision = 0;
let captionStartRevision = 0;
let captionAutoActions = false;
let getAgentConfig;
let editAgentConfig;
let currentMode = 'local';
let externalHistory = [];
const channelSpeech = [];
const inputDances = [];
let voiceDanceTimer;
let actionVoiceJob;
let lastInputDanceAt = 0;
let lastInputPerformanceAt = 0;
let lastVoicePerformance;
let senses;
let screenWatch = false;
let screenInterval = defaultScreenInterval;
let musicDance = false;
let queuedSpeech;
let petting = false;
let state = { state: 'loading' };
let clickThrough = false;
let scale = defaultScale;
let speechText = '';
let captionText = '';
let captionTimer;
let lastCaptionAt = 0;
let bubbleWindow;
let bubbleReady = false;
let bubblePage = '';
let bubbleRevision = 0;
let theme = 'default';
let speakingStyle = defaultSpeakingStyle;
let shortcutRegistered = false;
const bubbleWidth = 236;
const bubbleHeight = 164;
const controlsWidth = 172;
const controlsHeight = 28;
let view = 'full';
let modelPath;
let selectedModel;
let galleryPreview;
let galleryRevision = 0;
let modelWarning;
let changingModel = false;
const assets = new Map();
let active;
let danceIndex = 0;
let nextId = 0;
const calls = new Map();

async function getCharacter() {
  const character = await readCharacter(characterPath, defaultCharacter);
  if (characterName !== character.name) {
    characterName = character.name;
    if (window && !window.isDestroyed()) window.setTitle(characterName + ' · VA');
    if (tray) {
      tray.setToolTip('VA · ' + characterName);
      updateTray();
    }
    if (selectedModel) {
      const settings = settingsSnapshot();
      settingsWindow?.webContents.send('va:settings-changed', settings);
      controlsWindow?.webContents.send('va:settings-changed', settings);
    }
  }
  return character;
}

async function asset(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'desktop' || request.method !== 'GET') return new Response(null, { status: 404 });
  const path = decodeURIComponent(url.pathname.slice(1));
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) {
    return new Response(null, { status: 404 });
  }
  let local;
  const extension = extname(path).toLowerCase();
  if (pages.has(path)) local = join(root, 'desktop', path);
  if (path === 'app-icon.png') local = appIconPath;
  if (path === 'three/three.module.js') local = join(root, 'node_modules/three/build/three.module.js');
  if (path === 'vendor/three-vrm.js') local = join(root, 'node_modules/@pixiv/three-vrm/lib/three-vrm.module.js');
  if (path.startsWith('three/addons/') && (extension === '.js'
      || (extension === '.wasm' && /^three\/addons\/libs\/(draco\/gltf|basis)\//.test(path)))) {
    local = join(root, 'node_modules/three/examples/jsm', ...parts.slice(2));
  }
  if (parts[0] === 'assets') {
    local = await modelResource(assets.get(parts[1]), parts.slice(2)).catch(() => undefined);
  }
  if (!local) return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(local);
    return new Response(bytes, { headers: { 'Content-Type': mime[extension] } });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
    return new Response(null, { status: 404 });
  }
}

async function getVoiceConfig() {
  const stored = await readConfig(voicePath, defaultVoice, 'VOICE_CONFIG', 'voice.json');
  const { provider, actionSound, volc, reference, gptSoVits } = stored ?? {};
  return {
    provider: provider === 'volc' ? 'volc' : 'system',
    actionSound: actionSound === true,
    volc: { ...volcDefaults, ...volc },
    reference: reference ?? {
      referenceAudio: gptSoVits?.referenceAudio ?? '',
      referenceName: gptSoVits?.referenceName ?? '',
    },
  };
}

function voiceSnapshot(config) {
  const { provider, actionSound, volc, reference } = config;
  return {
    provider,
    actionSound,
    referenceName: reference.referenceName || (reference.referenceAudio ? basename(reference.referenceAudio) : ''),
    volc: { speaker: volc.speaker, resourceId: volc.resourceId, hasKey: Boolean(volcKey(volc)) },
  };
}

function editVoice(edit) {
  voiceEdits = voiceEdits.catch(() => {}).then(async () => {
    const config = await getVoiceConfig();
    edit(config);
    await saveVoice(config);
    return voiceSnapshot(config);
  });
  return voiceEdits;
}

function transferAudio(audio, warning) {
  return { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), warning };
}

async function synthesize(text, job) {
  const controller = new AbortController();
  const { signal } = controller;
  job.synthesis = controller;
  const preview = job.source === 'voice-preview';
  try {
    let warning;
    try {
      const config = await getVoiceConfig();
      signal.throwIfAborted();
      if (config.provider === 'volc') {
        return transferAudio(await volcSpeech(text, config.volc, signal));
      }
    } catch (error) {
      signal.throwIfAborted();
      if (preview) throw error;
      warning = error.message + ' 本次改用系统声音。';
    }
    return transferAudio(await systemSpeech(text, signal), warning);
  } finally {
    job.synthesis = undefined;
  }
}

function authorized(event) {
  return event.sender === window?.webContents && event.senderFrame?.url === pageURL;
}

function settingsAuthorized(event) {
  return event.sender === settingsWindow?.webContents && event.senderFrame?.url === settingsURL;
}

function controlsAuthorized(event) {
  return event.sender === controlsWindow?.webContents && event.senderFrame?.url === controlsURL;
}

ipcMain.on('va:ready', (event, value) => {
  if (!authorized(event)) return;
  const firstLoad = state.state === 'loading';
  state = value;
  if (firstLoad && state.state === 'error' && !launchHidden) openSettings();
  updateTray();
  drainAutomatic();
});
ipcMain.handle('va:initial-view', event => {
  if (!authorized(event)) throw new Error('无效的视角请求。');
  return view;
});
ipcMain.handle('va:initial-model', event => {
  if (!authorized(event)) throw new Error('无效的模型请求。');
  return publicModel(selectedModel);
});
ipcMain.on('va:open-settings', event => {
  if (controlsAuthorized(event)) openSettings();
});
ipcMain.on('va:open-chat', event => {
  if (settingsAuthorized(event) || controlsAuthorized(event)) openChat();
});
ipcMain.handle('va:settings-section', event => {
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  return settingsSection;
});
ipcMain.handle('va:local-chat', async (event, operation, value) => {
  if (!settingsAuthorized(event)) {
    throw new Error('无效的本地聊天请求。');
  }
  switch (operation) {
    case 'status': return chatStatus();
    case 'send': return sendChat(value);
    case 'action-input': return queueInputPerformance(value) ?? { handled: false };
    case 'bind': return bindChat(value);
    case 'configure': return localConfig(value);
    case 'integration': return changeIntegration(value);
    case 'api-profile': return changeApiProfile(value);
    case 'doubao-client-open': {
      requireMode('doubao-client');
      const paths = ['/Applications/Doubao.app', join(homedir(), 'Applications/Doubao.app')];
      for (const path of paths) {
        if (!(await stat(path).catch(() => null))?.isDirectory()) continue;
        const error = await shell.openPath(path);
        if (!error) return chatStatus();
      }
      throw new ControlError('CLIENT_CLOSED', '请先安装豆包 macOS 客户端。');
    }
    case 'doubao-client-bind':
      requireMode('doubao-client');
      await doubaoClient.bind(() => currentMode === 'doubao-client' && event.sender === settingsWindow?.webContents);
      return chatStatus();
    case 'doubao-client-unbind':
      doubaoClient.unbind();
      return chatStatus();
    case 'doubao-client-read':
      requireMode('doubao-client');
      await doubaoClient.read();
      return chatStatus();
    case 'doubao-client-context':
      await syncDoubaoContext();
      return chatStatus();
    case 'doubao-caption-start': {
      requireMode('doubao-client');
      const { autoActions, listen } = value ?? {};
      if (typeof autoActions !== 'boolean' || typeof listen !== 'boolean') {
        throw new ControlError('INVALID_REQUEST', '请选择通话字幕选项。');
      }
      const revision = ++captionStartRevision;
      const microphoneAllowed = !listen || await systemPreferences.askForMediaAccess('microphone');
      if (revision !== captionStartRevision) throw new ControlError('CANCELED', '已取消启动字幕。');
      requireMode('doubao-client');
      await editAgentConfig(config => ({ ...config, doubaoClient: {
        ...config.doubaoClient, autoActions, listenForActions: listen && microphoneAllowed,
      } }));
      if (revision !== captionStartRevision) throw new ControlError('CANCELED', '已取消启动字幕。');
      requireMode('doubao-client');
      captionAutoActions = autoActions;
      return doubaoCaptions.start({ autoActions, listen: listen && microphoneAllowed,
        micStatus: microphoneAllowed ? '' : '请在 macOS 系统设置允许 VA 使用麦克风。' });
    }
    case 'doubao-caption-stop':
      captionStartRevision++;
      cancelActionVoice();
      doubaoCaptions.stop();
      return doubaoCaptions.state();
    case 'doubao-config':
      requireMode('doubao');
      if (doubao.running()) throw new ControlError('BUSY', '请先结束语音对话。');
      await editAgentConfig(config => configureDoubao(config, value));
      return chatStatus();
    case 'doubao-start': {
      requireMode('doubao');
      if (changingModel || active || petting || state.state !== 'ready') {
        throw new ControlError('BUSY', '请等角色准备好后再开始语音对话。');
      }
      const revision = doubaoStartRevision;
      const [config, character] = await Promise.all([getAgentConfig(), getCharacter()]);
      requireMode('doubao');
      if (revision !== doubaoStartRevision || event.sender !== settingsWindow?.webContents) {
        throw new ControlError('CANCELED', '已取消语音连接。');
      }
      if (changingModel || active || petting) {
        throw new ControlError('BUSY', '角色还在忙，请稍后再试。');
      }
      const voice = doubaoConfig(config);
      return await doubao.start(voice, characterPerformancePrompt(character, performanceSnapshot(), { style: 'voice', dance: voice.allowDance }), character.name);
    }
    case 'doubao-stop':
      doubaoStartRevision++;
      return doubao.stop();
    case 'cancel':
      if (currentMode === 'doubao-client') return doubaoClient.cancel();
      return currentMode === 'api' ? apiChat.cancel() : localAgent.cancel();
    case 'open-config': return shell.openPath(agentPath);
    default: throw new Error('无效的 Agent 操作。');
  }
});
ipcMain.on('va:doubao-audio', (event, id, pcm) => {
  if (currentMode === 'doubao' && settingsAuthorized(event)) doubao.audio(id, pcm);
});
ipcMain.on('va:adjust-scale', (event, amount) => {
  if (!controlsAuthorized(event) || ![-5, 5].includes(amount)) return;
  const next = Math.max(minScale, Math.min(maxScale, scale + amount));
  applySettings({ scale: next }).catch(error => console.error(error.message));
});
ipcMain.on('va:preview-scale', (event, value) => {
  if (!settingsAuthorized(event) || !isScale(value) || value === scale) return;
  scale = value;
  syncBounds();
  controlsWindow?.webContents.send('va:settings-changed', settingsSnapshot());
});
ipcMain.on('va:pet', event => {
  if (!authorized(event) || !['local', 'api', 'doubao'].includes(currentMode) ||
      doubao?.running() || clickThrough || petting || active?.action === 'pet') return;
  petting = true;
  (async () => {
    if (active) await stopPerformance();
    await perform({ action: 'pet', expression: 'amused' });
  })().catch(error => console.error(error.message)).finally(() => {
    petting = false;
    drainAutomatic();
  });
});
ipcMain.on('va:bubble', (event, text, page) => {
  if (!authorized(event) || typeof text !== 'string' || typeof page !== 'string') return;
  speechText = text;
  bubblePage = page;
  syncBubble();
});
ipcMain.on('va:bubble-painted', (event, revision) => {
  if (event.sender === bubbleWindow?.webContents && event.senderFrame?.url === bubbleURL &&
      revision === bubbleRevision && (captionText || bubblePage) && window.isVisible() && !bubbleWindow.isVisible()) {
    bubbleWindow.showInactive();
  }
});
ipcMain.handle('va:settings', (event, change) => {
  if (controlsAuthorized(event) && change === undefined) return settingsSnapshot();
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  return applySettings(change);
});
async function pickModelFile(title) {
  const { canceled, filePaths: [file] } = await dialog.showOpenDialog(settingsWindow, {
    title,
    defaultPath: app.getPath('downloads'),
    properties: ['openFile'],
    filters: [{ name: '支持的 3D 模型', extensions: modelFormats }],
  });
  return canceled ? null : file;
}

ipcMain.handle('va:choose-model', async (event, checkOnly = false) => {
  if (!settingsAuthorized(event)) throw new Error('无效的模型请求。');
  const file = await pickModelFile(checkOnly === true ? '检测 3D 模型' : '选择 3D 模型');
  if (!file) return null;
  return changeModel(file, checkOnly === true);
});

function dropGalleryPreview() {
  galleryRevision++;
  if (galleryPreview) assets.delete(galleryPreview.id);
  galleryPreview = undefined;
}

ipcMain.handle('va:model-library', async (event, operation, value) => {
  if (!settingsAuthorized(event)) throw new Error('无效的模型库请求。');
  switch (operation) {
    case 'list': return modelLibrary.list();
    case 'provider': {
      if (!Object.hasOwn(modelSources, value)) throw new ControlError('MODEL_LINK', '请选择模型来源。');
      return shell.openExternal(modelSources[value]);
    }
    case 'link': return shell.openExternal(modelPage(value));
    case 'import-pack': {
      const { canceled, filePaths: [folder] } = await dialog.showOpenDialog(settingsWindow, {
        title: '选择解压后的 AI 娘全家桶目录',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory'],
      });
      if (canceled || !settingsAuthorized(event)) return null;
      return modelLibrary.importPack(folder, path => changeModel(path, true));
    }
    case 'release': return dropGalleryPreview();
    case 'use': {
      if (!galleryPreview || value !== galleryPreview.url) {
        throw new ControlError('MODEL_LIBRARY', '请重新预览要使用的模型。');
      }
      return changeModel(galleryPreview.path === defaultModelPath ? null : galleryPreview.path);
    }
    case 'preview-file':
    case 'preview-pack': {
      const revision = ++galleryRevision;
      const entry = operation === 'preview-pack' ? await modelLibrary.preview(value) : undefined;
      const path = entry?.path ?? await pickModelFile('预览本机 3D 模型');
      if (!path) return null;
      const next = await bindModel(path, entry?.builtIn === true);
      if (entry) next.name = entry.label;
      if (!settingsAuthorized(event) || revision !== galleryRevision) return null;
      dropGalleryPreview();
      galleryPreview = next;
      assets.set(next.id, next);
      return publicModel(next);
    }
    default: throw new Error('无效的模型库操作。');
  }
});
ipcMain.handle('va:performance', async (event, operation, value) => {
  if (!settingsAuthorized(event)) throw new Error('无效的动作配置请求。');
  switch (operation) {
    case 'open':
      await readConfig(performancePath, performanceDefaults, 'PERFORMANCE_CONFIG', 'performance.json').catch(() => {});
      return shell.openPath(performancePath);
    case 'reload':
      await reloadPerformance();
      return settingsSnapshot();
    case 'preview':
      return perform({ action: value?.action, expression: value?.expression, wait: false });
    default: throw new Error('无效的动作配置操作。');
  }
});
ipcMain.handle('va:open-character', async event => {
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  // A malformed configuration still needs to be editable.
  await readCharacter(characterPath, defaultCharacter).catch(() => {});
  return shell.openPath(characterPath);
});
ipcMain.handle('va:character-name', async (event, value) => {
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 40 || /[\r\n\p{Cc}]/u.test(name)) {
    throw new ControlError('CHARACTER_CONFIG', '请输入 1–40 个字符的角色名。');
  }
  nameEdits = nameEdits.catch(() => {}).then(async () => {
    const data = await readConfig(characterPath, defaultCharacter, 'CHARACTER_CONFIG', 'character.json');
    await saveCharacter({ ...data, name });
    await getCharacter();
    return settingsSnapshot();
  });
  return nameEdits;
});
ipcMain.handle('va:open-capture-privacy', event => {
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  if (mac) return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});
ipcMain.handle('va:voice-config', async (event, change) => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  if (!change) return voiceSnapshot(await getVoiceConfig());
  return editVoice(config => {
    if (Object.hasOwn(change, 'actionSound')) {
      if (typeof change.actionSound !== 'boolean') throw new ControlError('VOICE_CONFIG', '无效的动作发声设置。');
      config.actionSound = change.actionSound;
      if (!config.actionSound) cancelActionVoice();
    }
    if (change.volc) {
      const { speaker, resourceId, apiKey, clearKey } = change.volc;
      if (typeof speaker !== 'string' || !/^[-_a-z0-9.]{1,160}$/i.test(speaker) ||
          !['seed-tts-2.0', 'seed-icl-2.0'].includes(resourceId) ||
          typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) {
        throw new ControlError('VOICE_CONFIG', '请检查火山 TTS 的音色 ID、模型资源和 API Key。');
      }
      Object.assign(config.volc, { speaker, resourceId });
      if (clearKey) delete config.volc.apiKey;
      else if (apiKey.trim()) config.volc.apiKey = apiKey.trim();
    }
    if (Object.hasOwn(change, 'provider')) {
      if (!['system', 'volc'].includes(change.provider)) throw new ControlError('VOICE_CONFIG', '无效的声音来源。');
      if (change.provider === 'volc' && !volcKey(config.volc)) {
        throw new ControlError('VOICE_CONFIG', '请填写火山 TTS 的 API Key。');
      }
      config.provider = change.provider;
    }
  });
});
ipcMain.handle('va:voice-file', async event => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  const { canceled, filePaths: [selected] } = await dialog.showOpenDialog(settingsWindow, {
    title: '选择一段参考录音',
    properties: ['openFile'],
    filters: [{ name: '参考录音', extensions: mac ? ['wav', 'm4a', 'mp3'] : ['wav'] }],
  });
  if (canceled || !selected) return voiceSnapshot(await getVoiceConfig());
  const reference = await importReference(selected, join(dirname(voicePath), 'voice-samples'));
  return editVoice(config => { config.reference = reference; });
});
ipcMain.handle('va:open-voice-file', event => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  return shell.openPath(voicePath);
});
ipcMain.handle('va:voice-preview', async event => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  if (active && ['music', 'screen'].includes(active.source)) await stopPerformance();
  return await perform({ speech: `嗨，我是${characterName}。听听我现在的声音！`, expression: 'smile' },
    { source: 'voice-preview' });
});
ipcMain.handle('va:voice-reference-preview', async event => {
  if (!settingsAuthorized(event)) throw new Error('无效的音色请求。');
  const path = (await getVoiceConfig()).reference.referenceAudio;
  if (typeof path !== 'string' || !path) throw new ControlError('VOICE_REFERENCE', '请先选择参考录音。');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > (mac ? 700_000 : sampleLimit)) {
    throw new ControlError('VOICE_REFERENCE', '参考录音不可用，请重新导入。');
  }
  const audio = await readFile(path).catch(() => null);
  if (!audio || audio.length > 700_000 || audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ControlError('VOICE_REFERENCE', '参考录音不可用，请重新导入。');
  }
  return transferAudio(audio).audio;
});
ipcMain.handle('va:speech', (event, text) => {
  if (!authorized(event) || typeof text !== 'string' || !text.trim() || text.length > 300) {
    throw new Error('无效的语音请求。');
  }
  if (!active || active.canceled) throw new Error('台词已停止。');
  return synthesize(text, active);
});
ipcMain.on('va:response', (event, id, result) => {
  if (!authorized(event)) return;
  const pending = calls.get(id);
  if (!pending) return;
  calls.delete(id);
  clearTimeout(pending.timer);
  if (result.ok) pending.resolve(result.data);
  else pending.reject(new ControlError('RENDERER_ERROR', result.message));
});

function failPending(detail) {
  state = { state: 'error', detail };
  for (const pending of calls.values()) {
    clearTimeout(pending.timer);
    pending.reject(new ControlError('RENDERER_ERROR', detail));
  }
  calls.clear();
}

function renderer(command, timeout = 6000) {
  if (state.state !== 'ready' && !(command.type.startsWith('model-') && state.state === 'error')) {
    throw new ControlError('NOT_READY', state.detail || '角色正在加载。');
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(new ControlError('TIMEOUT', '桌面角色未及时响应。'));
    }, timeout);
    calls.set(id, { resolve, reject, timer });
    window.webContents.send('va:request', id, command);
  });
}

function status() {
  return {
    version: 2,
    ...state,
    visible: window.isVisible(),
    clickThrough,
    scale,
    avatarHeight: window.getBounds().height,
    controlsVisible: controlsWindow?.isVisible() ?? false,
    screenWatch,
    musicDance,
    senses: senses?.status(),
    speech: captionText || speechText || null,
    doubaoCaptions: currentMode === 'doubao-client' ? doubaoCaptions?.state() : undefined,
    settingsShortcut: shortcutRegistered ? (mac ? 'Control+Option+V' : 'Ctrl+Alt+V') : null,
    view,
    model: modelSnapshot(),
    character: characterName,
    performance: active ? {
      id: active.id, action: active.action, hasSpeech: Boolean(active.speech), source: active.source,
    } : null,
  };
}

function menu() {
  const run = command => handle(command).catch(error => console.error(error.message));
  return Menu.buildFromTemplate([
    { label: '智能体与模型…', click: () => openChat() },
    { label: '动作与表情…', click: () => openSettings('performance') },
    { label: '模型库…', click: () => openSettings('models') },
    { label: '设置…', click: () => openSettings() },
    { label: (window.isVisible() ? '隐藏' : '显示') + characterName,
      click: () => run({ type: window.isVisible() ? 'hide' : 'show' }) },
    { label: '鼠标穿透', type: 'checkbox', checked: clickThrough,
      click: item => run({ type: 'click-through', enabled: item.checked }) },
    { label: `看屏幕 · ${screenIntervalLabel(screenInterval)}`, type: 'checkbox', checked: screenWatch,
      click: item => run({ type: 'sense', channel: 'screen', enabled: item.checked }) },
    ...(mac ? [{ label: '检测音乐并自动跳舞', type: 'checkbox', checked: musicDance,
      click: item => run({ type: 'sense', channel: 'music', enabled: item.checked }) }] : []),
    { label: view === 'full' ? '半身视角' : '全身视角',
      click: () => run({ type: 'view', mode: view === 'full' ? 'portrait' : 'full' }) },
    { type: 'separator' },
    { label: '打招呼', enabled: state.state === 'ready', click: () => run({
      type: 'perform', action: 'wave', expression: 'smile',
    }) },
    { label: '跳舞', enabled: supportedDances().length > 0, submenu: danceActions.map(action => ({
      label: performanceCatalog.actions[action].label, enabled: actionSupported(performanceCatalog.actions[action], state.media),
      click: () => run({ type: 'perform', action }),
    })) },
    { label: '复制角色照片', enabled: state.state === 'ready',
      click: () => run({ type: 'photo', clipboard: true }) },
    { label: '自拍并复制', enabled: state.state === 'ready' && !active,
      click: () => run({ type: 'selfie', clipboard: true }) },
    { label: '停止表演', enabled: Boolean(active), click: () => run({ type: 'stop' }) },
    { type: 'separator' },
    { label: '退出 VA', role: 'quit' },
  ]);
}

function updateTray() {
  tray?.setContextMenu(menu());
}

async function chooseLine(action, speech, configured) {
  const line = speech.trim();
  if (line || action === 'idle') return line;
  const character = await getCharacter().catch(error => {
    console.error(error.message);
    return { dialogue: Object.fromEntries(Object.entries(defaultCharacter.dialogue).map(([key, value]) =>
      [key, value.map(line => line.replaceAll('{{name}}', () => characterName))])) };
  });
  const lines = configured ?? character.dialogue[action] ?? [];
  return lines[Math.floor(Math.random() * lines.length)]?.replaceAll('{{name}}', () => characterName) ?? '';
}

async function reloadPerformance() {
  try {
    const config = await readConfig(performancePath, performanceDefaults, 'PERFORMANCE_CONFIG', 'performance.json');
    performanceCatalog = compilePerformance(config);
    performanceWarning = undefined;
    updateTray();
  } catch (error) {
    performanceWarning = error.message;
    throw new ControlError('PERFORMANCE_CONFIG', error.message);
  }
}

function performanceSnapshot(media = state.media) {
  return { ...describePerformance(performanceCatalog, media), warning: performanceWarning };
}

function performancePlan(action, selectedExpression) {
  const definition = Object.hasOwn(performanceCatalog.actions, action) ? performanceCatalog.actions[action] : undefined;
  const expression = selectedExpression ?? definition?.expression;
  if (!definition || typeof expression !== 'string' || !Object.hasOwn(performanceCatalog.faces, expression)) {
    throw new ControlError('INVALID_REQUEST', '动作或表情不存在。请用 va actions 查看可用编号。');
  }
  const { motion, seconds, clip, bones } = definition;
  if ((clip || Object.keys(bones ?? {}).length) && state.state === 'ready' && !actionSupported(definition, state.media)) {
    throw new ControlError('MODEL_ACTION', '当前模型缺少此动作需要的动画片段或骨骼。');
  }
  return { motion, seconds: seconds || (expression === 'neutral' ? 0 : 2), clip, bones,
    face: performanceCatalog.faces[expression] };
}

async function perform(command, { selfie = false, source = 'manual', readAloud = true, defaultDialogue = true } = {}) {
  if (doubao?.running()) throw new ControlError('BUSY', '角色正在进行豆包语音对话。');
  const { action = 'idle', expression, speech = '', wait = true } = command;
  if (typeof action !== 'string' || (expression !== undefined && typeof expression !== 'string') ||
      typeof speech !== 'string' || speech.length > 300 || typeof wait !== 'boolean') {
    throw new ControlError('INVALID_REQUEST', '动作、表情或台词无效。台词最多 300 字。');
  }
  if (changingModel) throw new ControlError('BUSY', '正在切换模型，请稍后再试。');
  if (active) throw new ControlError('BUSY', '角色正在表演。等表演结束，或使用 va stop。');
  const plan = performancePlan(action, expression);
  cancelActionVoice();
  const job = { id: ++nextId, action, speech: speech.trim(), source };
  active = job;
  updateTray();
  const selected = defaultDialogue
    ? chooseLine(action, speech, performanceCatalog.actions[action].dialogue)
      .then(line => line || (source === 'input-action' ? '好呀，看这边。' : ''))
    : Promise.resolve(speech.trim());
  const result = selected.then(async line => {
    job.speech = line;
    const actionDialogue = !speech.trim() || source === 'input-action';
    const speak = readAloud && Boolean(line) && (!actionDialogue || await actionSoundEnabled());
    if (job.canceled) throw new ControlError('CANCELED', '表演已停止。');
    job.started = true;
    const automatedReply = ['local-agent', 'api-chat', 'bot-chat'].includes(source);
    const data = await renderer({ type: 'perform', plan, speech: line, selfie, readAloud: speak, speakingStyle,
      showWhilePreparing: automatedReply }, automatedReply ? 120_000 : 80_000);
    if (job.canceled) throw new ControlError('CANCELED', '表演已停止。');
    return {
      id: job.id, action, speech: line, completed: true,
      ...(data.voiceWarning && { voiceWarning: data.voiceWarning }),
      ...(selfie && photoResult(data.image, command.clipboard)),
    };
  }).catch(error => {
    if (job.canceled) throw new ControlError('CANCELED', '表演已停止。');
    const message = error.message.replace(/^Error invoking remote method 'va:speech': Error: /, '');
    throw new ControlError(error.code, message);
  }).finally(() => {
    if (active === job) active = undefined;
    updateTray();
    if (!job.canceled) drainAutomatic();
  });
  job.finished = result;
  if (wait) return result;
  result.catch(error => { if (error.code !== 'CANCELED') console.error(error.message); });
  return { id: job.id, action, speech: await selected, completed: false };
}

async function stopPerformance() {
  const job = active;
  if (job) {
    job.canceled = true;
    job.synthesis?.abort();
  }
  if (!job || job.started) await renderer({ type: 'stop' });
  await job?.finished.catch(() => {});
}

let musicPaused = false;

function queueSpeech(speech, source, readAloud = true, effect = {}) {
  if (channelSpeech.length >= 5) return false;
  channelSpeech.push({ speech, source, readAloud, effect });
  drainAutomatic();
  return true;
}

function supportedDances() {
  return danceActions.filter(action => actionSupported(performanceCatalog.actions[action], state.media));
}

function nextDance() {
  const choices = supportedDances();
  return choices.length ? choices[danceIndex++ % choices.length] : undefined;
}

function queueInputDance(text) {
  const intent = danceIntent(text, characterName);
  if (!intent) return;
  const usable = supportedDances();
  if (!usable.length || (intent.action && !usable.includes(intent.action))) {
    throw new ControlError('MODEL_ACTION', '当前模型不支持这个舞步，可在「动作与表情」查看可用动作。');
  }
  if (inputDances.length + intent.count > 4) {
    throw new ControlError('BUSY', '舞步已经排满，等这几段跳完再试。');
  }
  inputDances.push(...Array.from({ length: intent.count }, () => intent.action));
  lastInputDanceAt = Date.now();
  if (currentMode === 'doubao-client') {
    doubaoClient.noteDance(intent.count, intent.action && performanceCatalog.actions[intent.action].label);
  }
  drainAutomatic();
  return { reply: intent.count > 1 ? `好呀，跳 ${intent.count} 段给你看！` : '好呀，跳给你看！', handled: 'dance' };
}

function clearInputDances() {
  inputDances.length = 0;
  clearTimeout(voiceDanceTimer);
  voiceDanceTimer = undefined;
  cancelActionVoice();
  lastVoicePerformance = undefined;
}

async function actionSoundEnabled() {
  return (await getVoiceConfig().catch(error => { reportAutomaticError(error); return {}; })).actionSound === true;
}

function cancelActionVoice() {
  if (!actionVoiceJob) return;
  actionVoiceJob.synthesis?.abort();
  actionVoiceJob = undefined;
  if (window && !window.isDestroyed()) void renderer({ type: 'action-voice-stop' }).catch(reportAutomaticError);
}

async function speakVoiceAction(action, job) {
  try {
    if (!await actionSoundEnabled() || actionVoiceJob !== job) return;
    const line = await chooseLine(action, '', performanceCatalog.actions[action]?.dialogue);
    if (!line || actionVoiceJob !== job) return;
    const { audio } = await synthesize(line, job);
    if (actionVoiceJob === job && !changingModel) await renderer({ type: 'action-voice', audio }, 80_000);
  } catch (error) {
    if (actionVoiceJob === job) reportAutomaticError(error);
  } finally {
    if (actionVoiceJob === job) actionVoiceJob = undefined;
  }
}

function queueVoicePerformance({ action, expression }, repeat = false) {
  if ((!action && !expression) || active || petting || changingModel || voiceDanceTimer || state.state !== 'ready') return false;
  const key = `${action ?? ''}:${expression ?? ''}`;
  if (!repeat && lastVoicePerformance?.key === key && Date.now() - lastVoicePerformance.at < 6000) return false;
  const plan = performancePlan(action ?? 'idle', expression);
  lastVoicePerformance = { key, at: Date.now() };
  voiceDanceTimer = setTimeout(() => {
    voiceDanceTimer = undefined;
    drainAutomatic();
  }, plan.seconds * 1000 + 100);
  cancelActionVoice();
  const playing = renderer({ type: 'doubao-dance', plan, replaceDance: true });
  if (action && action !== 'idle') {
    const job = { source: 'voice-action' };
    actionVoiceJob = job;
    void playing.then(started => {
      if (actionVoiceJob !== job) return;
      if (started) return speakVoiceAction(action, job);
      actionVoiceJob = undefined;
    }).catch(error => {
      if (actionVoiceJob === job) actionVoiceJob = undefined;
      reportAutomaticError(error);
    });
  } else void playing.catch(reportAutomaticError);
  return true;
}

function queueInputPerformance(text) {
  const effect = requestedPerformance(text, characterName, performanceSnapshot());
  if (!effect) return;
  if (effect.dance) {
    const result = queueInputDance(text);
    lastInputPerformanceAt = Date.now();
    return result;
  }
  const liveVoice = doubao.running() || doubaoCaptions.running();
  const reply = '好呀，看这边。';
  const queued = liveVoice ? queueVoicePerformance(effect)
    : queueSpeech(effect.action && effect.action !== 'idle' ? '' : reply, 'input-action', true, effect);
  if (!queued) throw new ControlError('BUSY', '角色正在表演，请稍后再试。');
  lastInputPerformanceAt = Date.now();
  return { reply, handled: 'action' };
}

function onVoiceOrClientInput(text) {
  try { return Boolean(queueInputPerformance(text)); }
  catch (error) { reportAutomaticError(error); return false; }
}

function drainAutomatic() {
  if (!senses || window.isDestroyed() || state.state !== 'ready' || changingModel || active || petting || voiceDanceTimer) return;
  if (inputDances.length) {
    const action = inputDances.shift() ?? nextDance();
    if (!action || !actionSupported(performanceCatalog.actions[action], state.media)) {
      inputDances.length = 0;
      return;
    }
    if (doubao.running() || doubaoCaptions.running()) {
      queueVoicePerformance({ action }, true);
    } else {
      void perform({ action }, { source: 'input-dance' }).catch(reportAutomaticError);
    }
    return;
  }
  if (doubao.running()) return;
  if (channelSpeech.length) {
    const { speech, source, readAloud, effect } = channelSpeech.shift();
    const catalog = performanceSnapshot();
    const action = catalog.actions[effect.action]?.supported ? effect.action : undefined;
    const expression = catalog.supportedExpressions.includes(effect.expression) ? effect.expression : undefined;
    if (!speech && !action && !expression) { drainAutomatic(); return; }
    perform({ speech, action, expression: expression ?? (action ? undefined : 'smile') }, { source, readAloud })
      .catch(reportAutomaticError);
    return;
  }
  if (!window.isVisible()) return;
  const speech = screenWatch && queuedSpeech?.expires > Date.now() ? queuedSpeech.line : '';
  queuedSpeech = undefined;
  if (speech) {
    perform({ speech, expression: 'smile' }, { source: 'screen' }).catch(reportAutomaticError);
  } else if (musicDance && !musicPaused && senses.status().music.detected) {
    const action = nextDance();
    if (action) perform({ action }, { source: 'music' }).catch(reportAutomaticError);
  }
}

function reportAutomaticError(error) {
  if (error.code !== 'CANCELED') console.error(error.message);
}

function photoResult(imageURL, copy) {
  const png = imageURL?.split(',')[1];
  if (!png) throw new ControlError('PHOTO_ERROR', '角色照片生成失败。');
  if (copy === true) clipboard.writeImage(nativeImage.createFromDataURL(imageURL));
  return { png };
}

function requireMode(mode) {
  if (currentMode !== mode) throw new ControlError('INTEGRATION_MODE', '请先在「智能体与模型」选择对应的接入方式。');
}

async function chatStatus() {
  const config = await getAgentConfig();
  const integration = { ...integrationSnapshot(config), nativeDoubao: mac };
  if (integration.mode === 'local') return { integration, ...await localAgent.status() };
  if (integration.mode === 'doubao-client') return { integration, ...doubaoClient.state(),
    captions: doubaoCaptions.state(), autoActions: (config.doubaoClient?.autoActions ?? config.doubaoClient?.autoDance) !== false,
    listenForActions: (config.doubaoClient?.listenForActions ?? config.doubaoClient?.listenForDance) === true };
  if (integration.mode === 'api') return { integration: { ...integration, ...await apiProfileSnapshot(config) }, ...apiChat.state() };
  if (integration.mode === 'doubao') return { integration: { ...integration, doubao: doubaoSnapshot(config) },
    doubao: doubao.state(), history: [], busy: false };
  return { integration, history: externalHistory, busy: false };
}

async function changeIntegration(value) {
  if (!mac && value?.mode === 'doubao-client') {
    throw new ControlError('UNSUPPORTED_PLATFORM', '豆包客户端联动需要 macOS。');
  }
  const next = await editAgentConfig(config => configureIntegration(config, value));
  if (currentMode !== next.mode) {
    doubaoStartRevision++;
    captionStartRevision++;
    doubao.stop();
    doubaoClient.unbind();
    if (doubaoCaptions.running()) doubaoCaptions.stop();
    currentMode = next.mode;
    apiChat.reset();
    localAgent.cancel();
    externalHistory = [];
    channelSpeech.length = 0;
    clearInputDances();
    lastInputDanceAt = 0;
    lastInputPerformanceAt = 0;
    queuedSpeech = undefined;
    if (['screen', 'music', 'local-agent', 'api-chat', 'bot-chat', 'doubao-client', 'input-dance', 'input-action'].includes(active?.source)) {
      await stopPerformance().catch(reportAutomaticError);
    }
    syncSenses();
  }
  settingsWindow?.webContents.send('va:chat-refresh');
  settingsWindow?.webContents.send('va:settings-changed', settingsSnapshot());
  return chatStatus();
}

async function changeApiProfile(value) {
  requireMode('api');
  let affectsActive;
  await editAgentConfig(async config => {
    if (integrationMode(config) !== 'api') throw new ControlError('INTEGRATION_MODE', '请先选择模型 API。');
    const previous = selectedApiId(config);
    const next = await editApiProfiles(config, value);
    affectsActive = previous !== selectedApiId(next) || (value.op === 'save' && previous === value.id);
    return next;
  });
  if (affectsActive) {
    apiChat.reset();
    queuedSpeech = undefined;
    screenRevision++;
    syncSenses();
  }
  return chatStatus();
}

async function localConfig(value) {
  requireMode('local');
  await localAgent.configure(value);
  return chatStatus();
}

async function bindChat(id) {
  if (currentMode === 'doubao-client' && id === 'current') {
    await doubaoClient.bind(() => currentMode === 'doubao-client');
  } else if (currentMode === 'api' && id === null) apiChat.reset();
  else {
    requireMode('local');
    await localAgent.bind(id);
  }
  return chatStatus();
}

async function sendChat(message, speak) {
  const performance = queueInputPerformance(message);
  if (performance) return performance;
  if (currentMode === 'local') return localAgent.send(message, { speak });
  if (currentMode === 'doubao-client') return doubaoClient.send(message, { context: await conversationPrompt('voice') });
  if (currentMode === 'doubao') throw new ControlError('INTEGRATION_MODE', '请在 VA 的豆包语音页面点击「开始语音对话」。');
  requireMode('api');
  try {
    const result = await apiChat.send(message);
    return { reply: result.reply, bubbleQueued: showReply(result.reply, 'api-chat', speak ?? result.readAloud, result.effect) };
  } finally {
    settingsWindow?.webContents.send('va:chat-refresh');
  }
}

async function syncDoubaoContext() {
  requireMode('doubao-client');
  return doubaoClient.send(undefined, { context: await conversationPrompt('voice'), sync: true });
}

async function conversationPrompt(style) {
  return characterPerformancePrompt(await getCharacter(), performanceSnapshot(), { style });
}

function showReply(text, source, readAloud, effect) {
  const selection = effect ?? replyPerformance(text, performanceSnapshot());
  const speech = selection.speech ?? text;
  return queueSpeech(speech.length > 300 ? speech.slice(0, 299) + '…' : speech, source, readAloud, selection);
}

function performVoiceReply(text, allowDance) {
  const effect = replyPerformance(text, performanceSnapshot());
  const dancing = danceActions.includes(effect.action);
  if (dancing && (!allowDance || Date.now() - lastInputDanceAt < 10_000)) return false;
  return queueVoicePerformance(effect);
}

function canAnimateFromCaption() {
  return captionAutoActions && !active && !petting && !changingModel && !voiceDanceTimer && state.state === 'ready'
    && window && !window.isDestroyed() && window.isVisible() && Date.now() - lastInputPerformanceAt > 8000;
}

function animateFromCaption(text) {
  if (!canAnimateFromCaption()) return true;
  const { action, expression } = replyPerformance(text, performanceSnapshot());
  if (!action && !expression) return false;
  queueVoicePerformance({ action, expression });
  return true;
}

async function presentBot(command) {
  if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 2000) {
    throw new ControlError('INVALID_REQUEST', '机器人需要提供 1–2000 字的回复。');
  }
  const route = checkBotRoute(await getAgentConfig(), command.platform, command.origin);
  if (!route || currentMode !== command.platform || route.target !== command.origin.target) return { accepted: false };
  const effect = replyPerformance(command.text, performanceSnapshot());
  const reply = effect.speech;
  externalHistory = [...externalHistory, { reply }].slice(-20);
  const queued = showReply(reply, 'bot-chat', route.speakReplies, effect);
  settingsWindow?.webContents.send('va:chat-refresh');
  return { accepted: true, queued };
}

async function receiveBotInput(command) {
  const selfie = (command.platform === 'astrbot' || command.origin?.channel === 'telegram')
    && requestsSelfie(command.text, characterName);
  if (!selfie && !requestedPerformance(command.text, characterName, performanceSnapshot())) return { accepted: false };
  const route = checkBotRoute(await getAgentConfig(), command.platform, command.origin);
  if (!route || currentMode !== command.platform || route.target !== command.origin.target) return { accepted: false };
  if (selfie) return { accepted: true, handled: 'selfie' };
  const result = queueInputPerformance(command.text);
  return result ? { accepted: true, ...result } : { accepted: false };
}

async function handle(command) {
  if (!command || typeof command !== 'object') {
    throw new ControlError('INVALID_REQUEST', '缺少 VA 命令。');
  }
  switch (command.type) {
    case 'status': return status();
    case 'actions':
      if (command.reload === true) await reloadPerformance();
      return { ...performanceSnapshot(), ...(command.includeConfigPath === true && { configPath: performancePath }) };
    case 'model-check':
      if (typeof command.path !== 'string') throw new ControlError('MODEL_PATH', '请选择一个模型文件。');
      return { model: await changeModel(command.path, true) };
    case 'model':
      if (command.path === null || typeof command.path === 'string') await changeModel(command.path);
      else if (command.path !== undefined) throw new ControlError('MODEL_PATH', '请选择一个模型文件。');
      return { model: modelSnapshot() };
    case 'bot-events': return { route: null, events: [] };
    case 'bot-chat': throw new ControlError('INTEGRATION_MODE', '请在机器人频道直接对话。VA 负责显示机器人回复。');
    case 'bot-route': {
      const route = externalModes.includes(command.platform) && command.platform === currentMode
        ? botRoute(await getAgentConfig()) : null;
      return { route, ...(route && { character: (await getCharacter()).name }) };
    }
    case 'bot-present': return presentBot(command);
    case 'bot-input': return receiveBotInput(command);
    case 'bot-prompt': {
      const route = checkBotRoute(await getAgentConfig(), command.platform, command.origin);
      if (!route || currentMode !== command.platform || route.target !== command.origin.target) return { accepted: false };
      return { accepted: true, prompt: await conversationPrompt('voice') };
    }
    case 'chat':
      if (command.message === undefined) {
        openChat();
        return { opened: true };
      }
      return sendChat(command.message, command.speak === true ? true : undefined);
    case 'chat-status': return chatStatus();
    case 'chat-context': return syncDoubaoContext();
    case 'chat-use': return localConfig({ provider: command.provider });
    case 'chat-bind': return bindChat(command.sessionId);
    case 'chat-new': return bindChat(null);
    case 'chat-cancel': return currentMode === 'api' ? apiChat.cancel() : localAgent.cancel();
    case 'integration':
      return command.mode === undefined ? (await chatStatus()).integration : changeIntegration({ mode: command.mode });
    case 'bot-perform':
      if (!externalModes.includes(command.platform)) throw new ControlError('INTEGRATION_MODE', '请选择机器人平台。');
      requireMode(command.platform);
      return await perform(command, { source: 'bot-action' });
    case 'senses': return { screenWatch, screenInterval, screenTarget: sensorTarget(), musicDance, ...senses.status(), configPath: agentPath };
    case 'screen-interval': return applySettings({ screenInterval: command.seconds });
    case 'sense':
      if (typeof command.enabled !== 'boolean' || !['screen', 'music'].includes(command.channel)) {
        throw new ControlError('INVALID_REQUEST', '请选择 screen 或 music，再选择 on 或 off。');
      }
      return await applySettings({ [command.channel === 'screen' ? 'screenWatch' : 'musicDance']: command.enabled });
    case 'observe': return await senses.observe();
    case 'character': return { path: characterPath, ...await getCharacter() };
    case 'prompt': return { prompt: await conversationPrompt(command.style) };
    case 'settings':
      openSettings();
      return { opened: true };
    case 'scale': return await applySettings(command.scale === undefined ? undefined : { scale: command.scale });
    case 'show':
      window.showInactive();
      updateTray();
      return { visible: true };
    case 'hide':
      window.hide();
      updateTray();
      return { visible: false };
    case 'click-through':
      if (typeof command.enabled !== 'boolean') throw new ControlError('INVALID_REQUEST', '请选择 on 或 off。');
      return await applySettings({ clickThrough: command.enabled });
    case 'view':
      if (command.platform !== undefined) {
        if (!externalModes.includes(command.platform)) throw new ControlError('INTEGRATION_MODE', '请选择机器人平台。');
        requireMode(command.platform);
      }
      if (!['full', 'portrait'].includes(command.mode)) {
        throw new ControlError('INVALID_REQUEST', '视角可选 full 或 portrait。');
      }
      return { view: (await applySettings({ view: command.mode })).view };
    case 'perform': return await perform(command);
    case 'selfie':
      if (command.bot) {
        if (!externalModes.includes(command.platform)) throw new ControlError('INTEGRATION_MODE', '请选择机器人平台。');
        requireMode(command.platform);
      }
      return await perform({ ...command, action: 'pose', expression: command.expression ?? 'smile', wait: true },
        { selfie: true, source: command.bot === true ? 'bot-action' : 'manual',
          defaultDialogue: command.bot !== true && command.quiet !== true });
    case 'stop':
      clearInputDances();
      if (doubao.running()) {
        doubao.stop();
        return { stopped: true };
      }
      if (active?.source === 'music') musicPaused = true;
      await stopPerformance();
      if (channelSpeech.length) drainAutomatic();
      return { stopped: true };
    case 'photo': return photoResult(await renderer({ type: 'photo' }), command.clipboard);
    case 'quit':
      setTimeout(() => app.quit(), 150);
      return { quitting: true };
    default: throw new ControlError('UNKNOWN_COMMAND', '未知的 VA 命令。');
  }
}

function avatarSize(area) {
  const fullHeight = Math.min(Math.round(500 * scale / 100), area.height - 24);
  return { height: fullHeight - controlsHeight, width: Math.round(fullHeight * 0.70) };
}

function syncBounds() {
  const current = window.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const { width, height } = avatarSize(area);
  const rightEdge = area.x + area.width;
  const x = Math.max(area.x, Math.min(rightEdge - width, current.x + current.width - width));
  const y = Math.max(area.y, Math.min(
    area.y + area.height - height - controlsHeight, current.y + current.height - height));
  const bounds = { x, y, width, height };
  if (Object.keys(bounds).some(key => bounds[key] !== current[key])) window.setBounds(bounds);
  positionControls();
  syncBubble();
}

function publicModel({ url, format, name, builtIn }) {
  return { url, format, name, builtIn };
}

async function findLocalAha() {
  const directories = [process.env.AVATAR_DIR, ...['documents', 'downloads']
    .map(location => join(app.getPath(location), ahaPack))];
  for (const directory of directories) {
    if (!directory) continue;
    const model = await bindModel(resolve(directory, ahaFile), true).catch(() => undefined);
    if (model) return model;
  }
}

function modelSnapshot(binding = selectedModel, report = state) {
  const { name, path, format, builtIn } = binding;
  const media = report.media;
  return { name, path, format, builtIn, ...media,
    checked: Boolean(media), textureWarning: report.textureWarning === true,
    warning: binding === selectedModel ? modelWarning : undefined };
}

function persistSettings() {
  return saveSettings({ theme, speakingStyle, scale, view, modelPath, clickThrough, screenWatch, screenInterval, musicDance });
}

async function changeModel(path, checkOnly = false) {
  if (changingModel || doubao?.running()) throw new ControlError('BUSY', '正在切换模型或进行语音对话，请稍后再试。');
  changingModel = true;
  let next;
  let staged = false;
  try {
    const selectedPath = path ?? defaultModelPath;
    next = await bindModel(selectedPath, selectedPath === bundledModelPath || selectedPath === defaultModelPath);
    assets.set(next.id, next);
    const info = await renderer({ type: 'model-check', model: publicModel(next), checkOnly,
      deadline: Date.now() + 65_000 }, 70_000);
    if (checkOnly) return modelSnapshot(next, info);
    staged = true;
    if (active) await stopPerformance();
    cancelActionVoice();
    await renderer({ type: 'model-activate', key: next.url, portrait: view === 'portrait' });
    staged = false;
    assets.delete(selectedModel.id);
    selectedModel = next;
    state = { state: 'ready', ...info };
    modelPath = path;
    modelWarning = undefined;
    settingsWindow?.webContents.send('va:settings-changed', settingsSnapshot());
    updateTray();
    await persistSettings();
    return modelSnapshot();
  } finally {
    if (staged) await renderer({ type: 'model-discard' }).catch(reportAutomaticError);
    if (next && selectedModel !== next) assets.delete(next.id);
    changingModel = false;
    drainAutomatic();
  }
}

function settingsSnapshot() {
  return { theme, speakingStyle, scale, view, model: modelSnapshot(), characterName, clickThrough, minScale, maxScale,
    screenWatch, screenInterval, integrationMode: currentMode, nativeSenses: mac, musicDance, senses: senses?.status(),
    performance: performanceSnapshot() };
}

async function applySettings(change) {
  if (!change) return settingsSnapshot();
  if (Object.hasOwn(change, 'speakingStyle')) {
    if (!isSpeakingStyle(change.speakingStyle)) throw new ControlError('INVALID_REQUEST', '说话风格无效。');
    speakingStyle = change.speakingStyle;
  }
  if (Object.hasOwn(change, 'theme')) {
    if (!themes.includes(change.theme)) throw new ControlError('INVALID_REQUEST', '界面主题无效。');
    theme = change.theme;
    syncBubble();
  }
  if (Object.hasOwn(change, 'view')) {
    if (!['full', 'portrait'].includes(change.view)) {
      throw new ControlError('INVALID_REQUEST', '视角可选 full 或 portrait。');
    }
    if (state.state === 'ready') await renderer({ type: 'view', mode: change.view });
    view = change.view;
  }
  if (Object.hasOwn(change, 'scale')) {
    if (!isScale(change.scale)) {
      throw new ControlError('INVALID_REQUEST', `缩放范围为 ${minScale}–${maxScale}%，请填写整数。`);
    }
    scale = change.scale;
    syncBounds();
  }
  if (Object.hasOwn(change, 'clickThrough')) {
    clickThrough = change.clickThrough === true;
    window.setIgnoreMouseEvents(clickThrough);
  }
  let changedSensors = false;
  if (Object.hasOwn(change, 'screenInterval')) {
    if (!isScreenInterval(change.screenInterval)) throw new ControlError('INVALID_REQUEST', '请选择 10s、30s、1min、5min、10min、30min、1h、6h 或 24h。');
    screenInterval = change.screenInterval;
    changedSensors = true;
  }
  if (Object.hasOwn(change, 'screenWatch')) {
    screenWatch = change.screenWatch === true;
    changedSensors = true;
  }
  if (Object.hasOwn(change, 'musicDance')) {
    if (!mac && change.musicDance) throw new ControlError('UNSUPPORTED_PLATFORM', '系统音乐检测需要 macOS。');
    if (musicDance !== (change.musicDance === true)) musicPaused = false;
    musicDance = change.musicDance === true;
    changedSensors = true;
  }
  if (changedSensors) syncSenses();
  const settings = settingsSnapshot();
  settingsWindow?.webContents.send('va:settings-changed', settings);
  controlsWindow?.webContents.send('va:settings-changed', settings);
  updateTray();
  await persistSettings();
  return settings;
}

function localWindow(web) {
  web.setWindowOpenHandler(() => ({ action: 'deny' }));
  web.on('will-navigate', event => event.preventDefault());
}

function openSettings(section = 'avatar') {
  settingsSection = section;
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.webContents.send('va:settings-section', section);
    return;
  }
  settingsWindow = new BrowserWindow({
    title: 'VA 设置',
    icon: appIconPath,
    width: 780,
    height: 680,
    minWidth: 520,
    minHeight: 460,
    show: false,
    acceptFirstMouse: true,
    webPreferences: { preload: join(root, 'desktop/preload.cjs'), sandbox: true, contextIsolation: true },
  });
  localWindow(settingsWindow.webContents);
  settingsWindow.on('closed', () => {
    settingsWindow = undefined;
    dropGalleryPreview();
    doubao?.stop();
  });
  settingsWindow.webContents.on('render-process-gone', () => {
    dropGalleryPreview();
    doubao?.stop();
  });
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.loadURL(settingsURL).catch(console.error);
}

function openChat() {
  openSettings('agent');
  settingsWindow?.webContents.send('va:chat-refresh');
}

async function captureScreen() {
  const message = '读取屏幕需要 macOS「屏幕与系统音频录制」权限。授权后退出并重新启动 VA。';
  const permission = mac ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  if (['denied', 'restricted'].includes(permission)) throw new ControlError('SCREEN_PERMISSION', message);
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const ratio = Math.min(1, 1024 / Math.max(width, height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * ratio), height: Math.round(height * ratio) },
  }).catch(() => []);
  const source = sources.find(item => item.display_id === String(display.id))
    ?? (screen.getAllDisplays().length === 1 ? sources[0] : undefined);
  if (!source || source.thumbnail.isEmpty()) {
    if (mac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      throw new ControlError('SCREEN_PERMISSION', message);
    }
    throw new ControlError('SCREEN_UNAVAILABLE', '暂时无法读取主显示器画面。');
  }
  return {
    mime: 'image/jpeg',
    data: source.thumbnail.toJPEG(78).toString('base64'),
    ...source.thumbnail.getSize(),
    capturedAt: new Date().toISOString(),
  };
}

function sensorTarget() {
  return currentMode === 'local' ? 'local' : currentMode === 'api' ? 'vision' : null;
}

function syncSenses() {
  const target = sensorTarget();
  const shown = !window.isDestroyed() && window.isVisible() && Boolean(target);
  if (!shown || !screenWatch) {
    queuedSpeech = undefined;
    if (active?.source === 'screen') stopPerformance().catch(reportAutomaticError).finally(drainAutomatic);
  }
  senses?.update({ screenWatch, musicDance, shown, interval: screenInterval, target, revision: screenRevision });
}

function positionControls() {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const centered = Math.round(bounds.x + (bounds.width - controlsWidth) / 2);
  const x = Math.max(area.x, Math.min(centered, area.x + area.width - controlsWidth));
  const y = bounds.y + bounds.height;
  controlsPosition = [x, y];
  const [currentX, currentY] = controlsWindow.getPosition();
  if (x !== currentX || y !== currentY) controlsWindow.setPosition(x, y);
}

function showControls() {
  if (!controlsReady || !window.isVisible()) return;
  positionControls();
  controlsWindow.showInactive();
}

function syncBubble() {
  if (!bubbleReady || !bubbleWindow || bubbleWindow.isDestroyed() || !window || window.isDestroyed()) return;
  const page = captionText ? captionText.match(/[\s\S]{1,58}/gu)?.at(-1) : bubblePage;
  if (!page || !window.isVisible()) {
    bubbleRevision++;
    if (bubbleWindow.isVisible()) bubbleWindow.hide();
    return;
  }
  const avatar = window.getBounds();
  const area = screen.getDisplayMatching(avatar).workArea;
  const spaceLeft = avatar.x - area.x;
  const spaceRight = area.x + area.width - avatar.x - avatar.width;
  const side = spaceLeft >= bubbleWidth || spaceLeft >= spaceRight ? 'left' : 'right';
  const left = side === 'left' ? avatar.x - bubbleWidth : avatar.x + avatar.width;
  const x = Math.max(area.x, Math.min(area.x + area.width - bubbleWidth, left));
  const y = Math.max(area.y, Math.min(area.y + area.height - bubbleHeight,
    avatar.y + Math.min(48, Math.round(avatar.height * 0.18))));
  const current = bubbleWindow.getBounds();
  if (current.x !== x || current.y !== y) bubbleWindow.setPosition(x, y);
  bubbleWindow.webContents.send('va:bubble-content', { page, side, theme, revision: ++bubbleRevision });
}

function createBubble() {
  bubbleWindow = new BrowserWindow({
    width: bubbleWidth, height: bubbleHeight, transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, resizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, show: false,
    webPreferences: { preload: join(root, 'desktop/preload.cjs'), sandbox: true,
      contextIsolation: true, backgroundThrottling: false },
  });
  bubbleWindow.setIgnoreMouseEvents(true);
  bubbleWindow.setVisibleOnAllWorkspaces(true);
  localWindow(bubbleWindow.webContents);
  bubbleWindow.webContents.once('did-finish-load', () => {
    bubbleReady = true;
    syncBubble();
  });
  bubbleWindow.loadURL(bubbleURL).catch(console.error);
}

function createControls() {
  controlsWindow = new BrowserWindow({
    width: controlsWidth,
    height: controlsHeight,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: { preload: join(root, 'desktop/preload.cjs'), sandbox: true, contextIsolation: true },
  });
  // The toolbar needs to stay clickable above other desktop overlays.
  controlsWindow.setAlwaysOnTop(true, 'status', 1);
  controlsWindow.setVisibleOnAllWorkspaces(true);
  localWindow(controlsWindow.webContents);
  positionControls();
  controlsWindow.on('move', () => {
    if (window.isDestroyed()) return;
    const [x, y] = controlsWindow.getPosition();
    const [oldX, oldY] = controlsPosition;
    controlsPosition = [x, y];
    if (x === oldX && y === oldY) return;
    const [modelX, modelY] = window.getPosition();
    window.setPosition(modelX + x - oldX, modelY + y - oldY);
  });
  controlsWindow.once('ready-to-show', () => {
    controlsReady = true;
    showControls();
  });
  controlsWindow.loadURL(controlsURL).catch(console.error);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = avatarSize(area);
  window = new BrowserWindow({
    title: characterName + ' · VA',
    x: area.x + area.width - width - 20,
    y: area.y + area.height - height - controlsHeight - 8,
    width, height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: join(root, 'desktop/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  window.setVisibleOnAllWorkspaces(true);
  window.setIgnoreMouseEvents(clickThrough);
  localWindow(window.webContents);
  window.on('page-title-updated', event => event.preventDefault());
  window.on('move', syncBubble);
  window.on('show', () => {
    syncBubble();
    showControls();
    syncSenses();
  });
  window.on('hide', () => {
    syncBubble();
    if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.hide();
    syncSenses();
  });
  window.webContents.on('render-process-gone', () => {
    doubao?.stop();
    failPending('桌面渲染进程已退出。请重启 VA。');
  });
  window.once('ready-to-show', () => {
    if (!launchHidden) window.showInactive();
    updateTray();
  });
  window.loadURL(pageURL).catch(error => failPending(error.message));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, args) => {
    if (!args.includes('--va-hidden')) window?.showInactive();
  });
  app.on('activate', () => {
    if (!launchHidden) window?.showInactive();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    doubao?.stop({ immediate: true });
    doubaoClient?.unbind();
    if (doubaoCaptions?.running()) doubaoCaptions.stop();
    localAgent?.cancel();
    apiChat?.cancel();
    senses?.update({ screenWatch: false, musicDance: false, shown: false });
    globalShortcut.unregisterAll();
    server?.close();
  });

  app.whenReady().then(async () => {
    protocol.handle('va-app', asset);
    const settingsMic = web => currentMode === 'doubao' && web === settingsWindow?.webContents && web?.getURL() === settingsURL;
    session.defaultSession.setPermissionCheckHandler((web, permission, _origin, detail) =>
      permission === 'media' && detail.mediaType === 'audio' && settingsMic(web));
    session.defaultSession.setPermissionRequestHandler((web, permission, callback, detail) =>
      callback(permission === 'media' && settingsMic(web) && detail.mediaTypes?.includes('audio') &&
        !detail.mediaTypes.includes('video')));
    doubao = createDoubaoConversation({
      onState: value => settingsWindow?.webContents.send('va:doubao-state', value),
      onOutput: value => {
        if (state.state === 'ready' && !window?.isDestroyed()) window?.webContents.send('va:doubao-output', { ...value, speakingStyle });
      },
      onDance: () => queueVoicePerformance({ action: nextDance() }),
      onInput: onVoiceOrClientInput,
      onReply: performVoiceReply,
    });
    const doubaoHelper = join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'va-doubao-client');
    doubaoClient = createDoubaoClient({
      request: command => callDoubaoClient(doubaoHelper, command),
      onChange: () => settingsWindow?.webContents.send('va:chat-refresh'),
      onInput: onVoiceOrClientInput,
      onReply: reply => {
        if (doubaoCaptions.running()) {
          if (Date.now() - lastCaptionAt > 5000) animateFromCaption(reply);
        } else showReply(reply, 'doubao-client', false);
      },
    });
    doubaoCaptions = createDoubaoCaptions({
      binary: join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'va-doubao-captions'),
      onState: value => settingsWindow?.webContents.send('va:doubao-captions', value),
      onCaption: (text, final) => {
        clearTimeout(captionTimer);
        captionText = text;
        lastCaptionAt = text ? Date.now() : 0;
        syncBubble();
        if (text) captionTimer = setTimeout(() => { captionText = ''; syncBubble(); }, final ? 4000 : 6000);
        return final && text ? animateFromCaption(text) : true;
      },
      onLevel: level => {
        if (state.state !== 'ready' || !window || window.isDestroyed()) return;
        const event = level === null ? { type: 'client-speech-end' } : { type: 'client-speech', level, speakingStyle };
        window.webContents.send('va:doubao-output', event);
      },
      onInput: onVoiceOrClientInput,
      getCandidates: () => {
        const catalog = performanceSnapshot();
        return {
          actions: Object.entries(catalog.actions).filter(([id, action]) => id !== 'idle' && action.supported)
            .map(([id, action]) => ({ id, label: action.label })),
          expressions: catalog.supportedExpressions.filter(id => id !== 'neutral')
            .map(id => ({ id, label: catalog.expressions[id] })),
        };
      },
      onAction: result => {
        if (!canAnimateFromCaption()) return;
        const catalog = performanceSnapshot();
        const action = catalog.actions[result.action]?.supported ? result.action : undefined;
        const expression = catalog.supportedExpressions.includes(result.expression) ? result.expression : undefined;
        queueVoicePerformance({ action, expression });
      },
    });
    await mkdir(app.getPath('userData'), { recursive: true });
    await reloadPerformance().catch(reportAutomaticError);
    defaultCharacter = JSON.parse(await readFile(join(root, 'config/character.json'), 'utf8'));
    defaultVoice = JSON.parse(await readFile(join(root, 'config/voice.json'), 'utf8'));
    const defaultAgent = JSON.parse(await readFile(join(root, 'config/agent.json'), 'utf8'));
    getAgentConfig = () => readConfig(agentPath, defaultAgent, 'MODEL_CONFIG', 'agent.json');
    let edits = Promise.resolve();
    editAgentConfig = edit => {
      const result = edits.catch(() => {}).then(async () => {
        const next = await edit(await getAgentConfig());
        await saveAgent(next);
        return next;
      });
      edits = result;
      return result;
    };
    ({ theme, speakingStyle, scale, view, modelPath, clickThrough, screenWatch, screenInterval, musicDance } = await readSettings(settingsPath));
    if (!mac) musicDance = false;
    const localAha = await findLocalAha();
    defaultModelPath = localAha?.path ?? bundledModelPath;
    if (localAha) defaultCharacter.name = localAhaName;
    modelLibrary = createModelLibrary(join(app.getPath('userData'), 'ai-girls.json'), { bundledModel: bundledModelPath, localAha });
    if (modelPath) {
      selectedModel = await bindModel(modelPath, modelPath === bundledModelPath || modelPath === defaultModelPath)
        .catch(error => { modelWarning = error.message + ' 已显示默认角色。'; });
    }
    selectedModel ??= localAha ?? await bindModel(bundledModelPath, true, { allowMissing: true });
    assets.set(selectedModel.id, selectedModel);
    await getCharacter().catch(error => console.error(error.message));
    try {
      const stored = await getAgentConfig();
      currentMode = integrationMode(stored);
      if (!mac && currentMode === 'doubao-client') currentMode = 'off';
      if (stored?.mode !== currentMode) await saveAgent({ ...defaultAgent, ...stored, mode: currentMode });
    } catch (error) {
      console.error(error.message);
    }
    await getVoiceConfig().catch(error => console.error(error.message));
    const getApiConfig = async () => resolveApiConfig(await getAgentConfig());
    const getPrompt = async extra => chatPerformancePrompt(await getCharacter(), performanceSnapshot(), extra);
    const parseReply = reply => replyPerformance(reply, performanceSnapshot());
    apiChat = createApiChat({
      getConfig: getApiConfig,
      getPrompt, parseReply,
    });
    localAgent = createLocalAgent({
      getConfig: async () => (await getAgentConfig())?.localAgent,
      updateConfig: edit => editAgentConfig(async config => ({ ...config, localAgent: await edit(config?.localAgent) })),
      getPrompt, parseReply,
      sessionPath: join(app.getPath('userData'), 'local-agent-sessions.json'),
      launchDirectory,
      presentReply: (reply, readAloud, effect) => showReply(reply, 'local-agent', readAloud, effect),
      onChange: () => settingsWindow?.webContents.send('va:chat-refresh'),
    });
    senses = createSenses({
      audioHelper: join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'va-audio-monitor'),
      getAgentConfig: async () => resolveApiConfig(await getAgentConfig(), 'vision'),
      getCharacter,
      captureScreen,
      localObserve: localAgent.observe,
      onStatus: info => settingsWindow?.webContents.send('va:senses-state', info),
      onScreen: line => {
        queuedSpeech = { line, expires: Date.now() + 18_000 };
        drainAutomatic();
      },
      onMusic: detected => {
        if (detected) drainAutomatic();
        else {
          musicPaused = false;
          if (active?.source === 'music') {
            stopPerformance().catch(reportAutomaticError).finally(drainAutomatic);
          }
        }
      },
    });
    await app.dock?.hide();
    createWindow();
    createBubble();
    createControls();
    const portrait = nativeImage.createFromPath(appIconPath);
    const icon = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
      const size = (mac ? 18 : 20) * scaleFactor;
      icon.addRepresentation({
        scaleFactor, buffer: portrait.resize({ width: size, height: size, quality: 'best' }).toPNG(),
      });
    }
    tray = new Tray(icon);
    if (mac) tray.setTitle('VA');
    tray.setToolTip('VA · ' + characterName);
    shortcutRegistered = globalShortcut.register('Control+Alt+V', openSettings);
    updateTray();
    server = await startControl(handle);
  }).catch(error => {
    console.error(error);
    app.exit(1);
  });
}
