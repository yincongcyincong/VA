import { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage,
  protocol, screen, shell, systemPreferences } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionSupported, compilePerformance, describePerformance, performanceDefaults } from './performance-config.js';
import { chatPerformancePrompt, createRolePrompt, danceRequestProblem, replyPerformance, requestedPerformance, requestsSelfie } from './character-performance.js';
import { createReplyPresenter } from './reply-presenter.js';
import { ControlError, startControl } from '../lib/control.js';
import { createLogger, errorCode } from '../lib/logger.js';
import { mergeConfigEntries, parseConfigCommand } from '../lib/configuration.js';
import { readCodexSession } from '../lib/current-codex.js';
import { agentConfigSnapshot, legacyAgentPrompt, normalizeAgentConfig, patchAgentConfig, removeLegacyAgentPrompts } from './agent-settings.js';
import { clampAvatarPosition, defaultScale, isScale, minScale, maxScale, rolePromptLimit,
  parseCharacter, readCharacter, readConfig, readSettings, restoreAvatarPosition, settingsWriter } from './config.js';
import { speechActionStyles } from './actions.js';
import { defaultSpeakingStyle, isSpeakingStyle, speakingPreset } from './speech-motion.js';
import { defaultScreenInterval, isScreenInterval, screenIntervalLabel, themes } from './preferences.js';
import { createSenses } from './senses.js';
import { botRoute, checkBotRoute, configureIntegration, externalModes, integrationMode, integrationSnapshot, screenMode } from './integration.js';
import { createLocalAgent } from './local-agent.js';
import { createAgentVoice } from './agent-voice.js';
import { createWindowsAgentVoice } from './windows-agent-voice.js';
import { installDeepSeekRole } from './deepseek-profile.js';
import { deepSeekNavigation } from './deepseek-navigation.js';
import { createSystemVoiceCatalog, defaultSystemVoice, splitReplySpeech, systemSpeech } from './speech.js';
import { createSpeechCache } from './speech-cache.js';
import { createZipVoice, zipVoiceReference } from './zipvoice-tts.js';
import { volcDefaults, volcKey, volcSpeech } from './volc-tts.js';
import { callDoubaoClient, createDoubaoClient } from './doubao-client.js';
import { createDoubaoCaptions } from './doubao-captions.js';
import { dialoguePages } from './dialogue-text.js';
import { bindModel, modelFormats, modelMime, modelResource, restoreModelPath } from './model-files.js';
import { aiGirlName, coverName, createModelLibrary, modelPage, modelSources } from './model-library.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const mac = process.platform === 'darwin';
const windows = process.platform === 'win32';
if (!mac && !windows) {
  throw new ControlError('UNSUPPORTED_PLATFORM', 'VA 桌面版目前支持 macOS 和 Windows。');
}
const appIconPath = join(root, 'assets', 'app-icon.png');
const cwd = process.cwd();
const launchDirectory = resolve(process.env.VA_START_CWD || (app.isPackaged && cwd === dirname(cwd)
  ? (mac ? resolve(process.execPath, '../../../..') : dirname(process.execPath)) : cwd));
const logger = createLogger(launchDirectory);
const pageURL = 'va-app://desktop/index.html';
const bubbleURL = 'va-app://desktop/bubble.html';
const settingsURL = 'va-app://desktop/settings.html';
const controlsURL = 'va-app://desktop/controls.html';
const bundledAiGirls = join(root, 'assets', 'models', 'ai-girls');
const coverModelPath = join(root, 'assets', 'models', 'VA Cover.vrm');
const builtInModels = new Set([coverModelPath]);
const ahaPack = '星穹铁道-阿哈_by_崩坏：星穹铁道_df69373aacbea0a160459be2ce0eb56e';
const ahaFile = '星穹铁道-阿哈2.pmx';
let defaultModelPath = coverModelPath;
const mime = {
  ...modelMime,
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
};
const pages = new Set(['index.html', 'style.css', 'renderer.js', 'voice.js', 'avatar.js', 'actions.js',
  'speech-motion.js', 'dialogue-text.js', 'dance-motion.js', 'hand-gestures.js', 'bubble.html', 'bubble.css', 'bubble.js', 'chat.js', 'settings-tabs.js', 'preferences.js',
  'model-loaders.js', 'settings.html', 'settings.css', 'settings.js', 'controls.html', 'controls.css', 'controls.js',
  'doubao-playback.js', 'model-gallery.js']);

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
const zipVoiceDirectory = join(app.getPath('userData'), 'zipvoice-tts');
const zipVoiceDefaults = {
  python: join(zipVoiceDirectory, '.venv', ...(mac ? ['bin', 'python'] : ['Scripts', 'python.exe'])),
  modelDirectory: join(zipVoiceDirectory, 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia'),
  referenceAudio: '',
};
const zipVoice = createZipVoice(app.isPackaged ? join(process.resourcesPath, 'zipvoice-tts.py')
  : join(root, 'native', 'zipvoice-tts.py'));
const systemVoiceCatalog = createSystemVoiceCatalog(join(dirname(voicePath), 'system-voices.json'), {
  onSaveError: error => logger.write('warn', 'voice.catalog_save_failed', { code: errorCode(error) }),
});
const saveSettings = settingsWriter(settingsPath);
const saveAgent = settingsWriter(agentPath);
const saveVoice = settingsWriter(voicePath);
const saveCharacter = settingsWriter(characterPath);
const savePerformance = settingsWriter(performancePath);
const launchHidden = process.argv.includes('--va-hidden');

let window;
let settingsWindow;
let settingsLoad;
let modelLibrary;
let settingsSection = 'avatar';
let screenRevision = 0;
let controlsWindow;
let controlsReady = false;
let controlsPosition;
let windowsPositioningControls = false;
let controlsHoverTimer;
let controlsLastNearAt = -Infinity;
let nameplateBounds;
let ignoringMouse;
let tray;
let server;
let defaultCharacter;
let performanceCatalog = compilePerformance({});
let performanceWarning;
let characterName = 'VA';
let rolePrompt = createRolePrompt();
let nameEdits = Promise.resolve();
let rolePromptEdits = Promise.resolve();
let performanceEdits = Promise.resolve();
let defaultVoice;
let voiceEdits = Promise.resolve();
let zipVoicePreparation;
let windowsVoiceWarning;
const speechCache = createSpeechCache();
let localAgent;
let doubaoClient;
let doubaoCaptions;
let captionStartRevision = 0;
let agentVoice;
let agentVoiceRevision = 0;
let captionAutoActions = false;
let getAgentConfig;
let editAgentConfig;
let codexBindQueue = Promise.resolve();
let currentMode = 'off';
let externalHistory = [];
let channelSpeech = [];
let inputDances = [];
let voiceDanceTimer;
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
let windowPosition;
let positionTimer;
let positionSave;
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
const controlsWidth = 72;
const controlsHeight = 34;
const controlsHoverMargin = 14;
const controlsHideDelay = 250;
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
    if (window && !window.isDestroyed()) {
      window.setTitle(characterName + ' · VA');
      window.webContents.send('va:character-name-changed', characterName);
    }
    updateTray();
    if (selectedModel) {
      const settings = settingsSnapshot();
      settingsWindow?.webContents.send('va:settings-changed', settings);
    }
  }
  return { ...character, prompt: rolePrompt };
}

async function initializeRolePrompt(savedPrompt, agent) {
  const character = await readConfig(characterPath, defaultCharacter, 'CHARACTER_CONFIG', 'character.json')
    .catch(error => { console.error(error.message); });
  const oldAgentPrompt = legacyAgentPrompt(agent);
  const background = typeof character?.prompt === 'string' ? character.prompt.trim() : undefined;
  rolePrompt = savedPrompt ?? createRolePrompt(background, oldAgentPrompt, defaultCharacter.name);
  // Commit the combined prompt before removing fields left by older releases.
  if (!savedPrompt) {
    if (!character || !agent) return;
    await persistSettings();
  }
  if (character && Object.hasOwn(character, 'prompt')) {
    const { prompt, ...profile } = character;
    await saveCharacter(profile);
  }
  const cleaned = removeLegacyAgentPrompts(agent);
  if (cleaned !== agent) await saveAgent(cleaned);
}

function setRolePrompt(value) {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt || prompt.length > rolePromptLimit || prompt.includes('\0')) {
    throw new ControlError('CHARACTER_CONFIG', '请输入角色 Prompt，最多 32000 个字符。');
  }
  rolePromptEdits = rolePromptEdits.catch(() => {}).then(async () => {
    if (prompt === rolePrompt) return settingsSnapshot();
    const previous = rolePrompt;
    rolePrompt = prompt;
    try {
      await persistSettings();
    } catch (error) {
      rolePrompt = previous;
      throw error;
    }
    if (currentMode === 'local') {
      queuedSpeech = undefined;
      screenRevision++;
      syncSenses();
    }
    const settings = settingsSnapshot();
    settingsWindow?.webContents.send('va:settings-changed', settings);
    return settings;
  });
  return rolePromptEdits;
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
  const { provider, actionSound, volc, systemVoice, zipvoice } = stored ?? {};
  return {
    provider: ['volc', 'zipvoice'].includes(provider) ? provider : 'system',
    systemVoice: typeof systemVoice === 'string' ? systemVoice : defaultSystemVoice,
    actionSound: actionSound === true,
    volc: { ...volcDefaults, ...volc },
    zipvoice: Object.fromEntries([...Object.keys(zipVoiceDefaults), 'referenceText']
      .map(key => [key, typeof zipvoice?.[key] === 'string' ? zipvoice[key].trim() : ''])),
  };
}

function zipVoiceSettings(config) {
  const paths = Object.fromEntries(Object.entries(zipVoiceDefaults).map(([key, fallback]) =>
    [key, config[key] ? resolve(launchDirectory, config[key]) : fallback]));
  return { ...paths, referenceText: config.referenceText };
}

function warmZipVoice(config, reference) {
  const paths = zipVoiceSettings(config.zipvoice);
  const preparation = { phase: 'loading' };
  zipVoicePreparation = preparation;
  void (async () => {
    try {
      const sample = reference ?? await zipVoiceReference(paths);
      if (zipVoicePreparation !== preparation) return;
      await zipVoice.warm(paths, sample);
      preparation.phase = 'ready';
    } catch (error) {
      if (zipVoicePreparation !== preparation) return;
      preparation.phase = 'error';
      preparation.message = error.message;
      logger.write('warn', 'voice.zipvoice_warm_failed', { code: errorCode(error) });
    }
    if (zipVoicePreparation === preparation && settingsWindow) {
      const latest = await getVoiceConfig().catch(() => undefined);
      if (latest?.provider === 'zipvoice' && zipVoicePreparation === preparation) {
        settingsWindow?.webContents.send('va:voice-changed', voiceSnapshot(latest));
      }
    }
  })();
}

function voiceSnapshot(config) {
  const { provider, actionSound, systemVoice, volc, zipvoice } = config;
  return {
    provider,
    actionSound,
    systemVoice,
    zipvoice: zipVoiceSettings(zipvoice),
    zipvoicePreparation: provider === 'zipvoice' ? zipVoicePreparation : undefined,
    ...(windows ? { playbackWarning: windowsVoiceWarning } : {}),
    volc: { speaker: volc.speaker, resourceId: volc.resourceId, apiKeyEnv: volc.apiKeyEnv, hasKey: Boolean(volcKey(volc)) },
  };
}

function editVoice(edit) {
  voiceEdits = voiceEdits.catch(() => {}).then(async () => {
    const config = await getVoiceConfig();
    const reference = await edit(config);
    await saveVoice(config);
    if (windows) windowsVoiceWarning = undefined;
    if (config.provider !== 'zipvoice') {
      zipVoicePreparation = undefined;
      zipVoice.stop();
    } else if (reference) {
      warmZipVoice(config, reference);
    }
    const snapshot = voiceSnapshot(config);
    settingsWindow?.webContents.send('va:voice-changed', snapshot);
    return snapshot;
  });
  return voiceEdits;
}

function transferAudio(audio, warning) {
  return { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), warning };
}

function publishWindowsVoiceWarning(warning, config) {
  if (warning === windowsVoiceWarning) return;
  windowsVoiceWarning = warning;
  if (warning) logger.write('warn', 'speech.fallback', { provider: config?.provider, message: warning });
  if (config) settingsWindow?.webContents.send('va:voice-changed', voiceSnapshot(config));
}

async function synthesize(text, job) {
  const controller = new AbortController();
  const { signal } = controller;
  job.synthesis = controller;
  const preview = job.source === 'voice-preview';
  const { rate, volume } = speakingPreset(job.style ?? speakingStyle);
  const prosody = { rate, volume };
  try {
    let warning;
    let config;
    try {
      config = await getVoiceConfig();
      signal.throwIfAborted();
      if (config.provider === 'zipvoice') {
        const settings = zipVoiceSettings(config.zipvoice);
        const { python, modelDirectory } = settings;
        const reference = await zipVoiceReference(settings);
        const { audio, cached } = await speechCache.get(text, ['zipvoice', python, modelDirectory, reference, rate, volume],
          signal, () => zipVoice.speak(text, settings, reference, signal, prosody));
        logger.write('info', 'speech.ready', { provider: 'zipvoice', cached });
        if (windows) publishWindowsVoiceWarning(undefined, config);
        return transferAudio(audio);
      }
      if (config.provider === 'volc') {
        const { speaker, resourceId } = config.volc;
        const apiKey = volcKey(config.volc);
        const { audio, cached } = await speechCache.get(text, ['volc', speaker, resourceId, apiKey, rate, volume],
          signal, () => volcSpeech(text, { speaker, resourceId, apiKey }, signal, prosody));
        logger.write('info', 'speech.ready', { provider: 'volc', cached });
        if (windows) publishWindowsVoiceWarning(undefined, config);
        return transferAudio(audio);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (preview) throw error;
      warning = error.message + ' 本次改用系统声音。';
      if (windows) publishWindowsVoiceWarning(warning, config);
    }
    const voice = config?.systemVoice ?? defaultSystemVoice;
    const { audio, cached } = await speechCache.get(text, ['system', voice, rate, volume],
      signal, () => systemSpeech(text, signal, { voice, ...prosody }));
    logger.write('info', 'speech.ready', { provider: 'system', cached });
    return transferAudio(audio, warning);
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
  if (firstLoad) logger.write(state.state === 'ready' ? 'info' : 'warn', 'avatar.initialized', {
    ready: state.state === 'ready', format: selectedModel.format, textureWarning: state.textureWarning === true,
  });
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
ipcMain.on('va:nameplate-bounds', (event, bounds) => {
  if (!authorized(event) || !bounds ||
    !['top', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0)) return;
  nameplateBounds = bounds;
  syncMousePassthrough();
});
ipcMain.on('va:quit', event => {
  if (settingsAuthorized(event)) app.quit();
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
    case 'bind': return bindChat(value);
    case 'open-session':
      await openAgentSession(value, { bind: true });
      return chatStatus();
    case 'restore-session': return restoreAgentSession(value);
    case 'unbind-session': return unbindAgentSession(value);
    case 'clear-sessions': {
      const { removed } = await clearAgentSessions(value);
      return { ...await chatStatus(), removed };
    }
    case 'agent-voice-start': return startAgentVoice();
    case 'agent-voice-stop': return stopAgentVoice();
    case 'create-session': {
      const openedSession = await createAgentSession();
      return { ...await chatStatus(), openedSession };
    }
    case 'deepseek-install-role': {
      const deepSeekRole = await installBoundDeepSeekRole();
      return { ...await chatStatus(), deepSeekRole };
    }
    case 'prompt':
      await configureAgent({ prompt: value });
      return chatStatus();
    case 'configure': return localConfig(value);
    case 'integration': return changeIntegration(value);
    case 'doubao-client-open': return openDoubaoClient();
    case 'doubao-client-bind':
      requireMode('doubao-client');
      await bindDoubao(() => currentMode === 'doubao-client' && event.sender === settingsWindow?.webContents);
      return chatStatus();
    case 'doubao-client-unbind':
      doubaoClient.unbind();
      return chatStatus();
    case 'doubao-client-read': return readDoubaoClient();
    case 'doubao-client-context':
      await syncDoubaoContext();
      return chatStatus();
    case 'doubao-caption-start': return startDoubaoCaptions(value);
    case 'doubao-caption-stop': return stopDoubaoCaptions();
    case 'open-config': return shell.openPath(agentPath);
    default: throw new Error('无效的 Agent 操作。');
  }
});
ipcMain.on('va:preview-scale', (event, value) => {
  if (!settingsAuthorized(event) || !isScale(value) || value === scale) return;
  scale = value;
  syncBounds();
});
ipcMain.on('va:pet', event => {
  if (!authorized(event) || currentMode !== 'local' ||
      clickThrough || petting || active?.action === 'pet') return;
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
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  return applySettings(change).catch(error => {
    logger.write('warn', 'settings.failed', { code: errorCode(error) });
    throw error;
  });
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

async function prepareGalleryPreview({ id, path }) {
  const entry = id ? await modelLibrary.preview(id) : undefined;
  const model = await bindModel(entry?.path ?? path, entry?.builtIn === true);
  if (entry) model.name = entry.label;
  return model;
}

function publishGalleryPreview(model) {
  dropGalleryPreview();
  galleryPreview = model;
  assets.set(model.id, model);
  return publicModel(model);
}

async function openModelPreview(selection) {
  const revision = ++galleryRevision;
  const model = await prepareGalleryPreview(selection.id ? selection : { path: resolve(launchDirectory, selection.path) });
  if (revision !== galleryRevision) throw new ControlError('CANCELED', '模型预览已变更。');
  const loaded = openSettings('models');
  const target = settingsWindow;
  await loaded;
  if (target !== settingsWindow || target.isDestroyed() || revision !== galleryRevision) {
    throw new ControlError('CANCELED', '模型预览已关闭或变更。');
  }
  const { url, ...info } = publishGalleryPreview(model);
  target.webContents.send('va:model-preview', { url, ...info });
  return { opened: true, model: info };
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
      const selection = operation === 'preview-pack' ? { id: value } : { path: await pickModelFile('预览本机 3D 模型') };
      if (!selection.id && !selection.path) return null;
      const next = await prepareGalleryPreview(selection);
      if (!settingsAuthorized(event) || revision !== galleryRevision) return null;
      return publishGalleryPreview(next);
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
      return perform({ action: value?.action, wait: false });
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
  if (authorized(event) && value === undefined) return characterName;
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 40 || /[\r\n\p{Cc}]/u.test(name)) {
    throw new ControlError('CHARACTER_CONFIG', '请输入 1–40 个字符的角色名。');
  }
  return configureCharacter({ name });
});
ipcMain.handle('va:role-prompt', (event, value) => {
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  return setRolePrompt(value);
});

function configureCharacter(change) {
  const { prompt, ...profile } = change;
  if (prompt !== undefined && !Object.keys(profile).length) return setRolePrompt(prompt);
  nameEdits = nameEdits.catch(() => {}).then(async () => {
    const data = await readConfig(characterPath, defaultCharacter, 'CHARACTER_CONFIG', 'character.json');
    const { prompt: oldPrompt, ...current } = data;
    const next = { ...current, ...profile, dialogue: { ...data.dialogue, ...profile.dialogue } };
    for (const key of Object.keys(change.dialogue ?? {})) {
      if (change.dialogue[key] === null) delete next.dialogue[key];
    }
    parseCharacter(next, defaultCharacter);
    await saveCharacter(next);
    await getCharacter();
    return prompt === undefined ? settingsSnapshot() : setRolePrompt(prompt);
  });
  return nameEdits;
}
ipcMain.handle('va:open-capture-privacy', event => {
  if (!settingsAuthorized(event)) throw new Error('无效的设置请求。');
  if (windows) return;
  return openPrivacySettings('screen');
});

function openPrivacySettings(kind) {
  if (!mac) throw new ControlError('UNSUPPORTED_PLATFORM', '此隐私设置入口仅支持 macOS。');
  const pane = { screen: 'ScreenCapture', microphone: 'Microphone', accessibility: 'Accessibility' }[kind];
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_' + pane);
}

function permissionStatus() {
  if (!mac) throw new ControlError('UNSUPPORTED_PLATFORM', '此权限查询入口仅支持 macOS。');
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
  };
}
ipcMain.handle('va:voice-config', async (event, change) => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  if (!change) return voiceSnapshot(await getVoiceConfig());
  return configureVoice(change);
});
ipcMain.handle('va:system-voices', (event, cached) => {
  if (!settingsAuthorized(event)) throw new Error('无效的音色请求。');
  return cached === true ? systemVoiceCatalog.cached() : systemVoiceCatalog.refresh();
});
ipcMain.handle('va:choose-voice-reference', async event => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindow, {
    title: '选择参考录音',
    properties: ['openFile'],
    filters: [{ name: '参考录音', extensions: ['wav', 'm4a', 'mp3'] }],
  });
  return canceled ? '' : filePaths[0];
});

async function configureVoice(change) {
  if (Object.hasOwn(change, 'systemVoice')) {
    const voice = change.systemVoice;
    const hasVoice = voices => voices.some(item => item.name === voice);
    if (voice !== '' && !hasVoice(await systemVoiceCatalog.cached()) && !hasVoice(await systemVoiceCatalog.refresh())) {
      throw new ControlError('VOICE_CONFIG', '请选择本机已安装的朗读音色。');
    }
  }
  return editVoice(async config => {
    if (Object.hasOwn(change, 'systemVoice')) config.systemVoice = change.systemVoice;
    if (Object.hasOwn(change, 'actionSound')) {
      if (typeof change.actionSound !== 'boolean') throw new ControlError('VOICE_CONFIG', '无效的动作发声设置。');
      config.actionSound = change.actionSound;
    }
    if (change.volc) {
      const { speaker, resourceId } = { ...config.volc, ...change.volc };
      const { apiKey = '', apiKeyEnv, clearKey } = change.volc;
      if (typeof speaker !== 'string' || !/^[-_a-z0-9.]{1,160}$/i.test(speaker) ||
          !['seed-tts-2.0', 'seed-icl-2.0'].includes(resourceId) ||
          typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) {
        throw new ControlError('VOICE_CONFIG', '请检查火山 TTS 的音色 ID、模型资源和 API Key。');
      }
      Object.assign(config.volc, { speaker, resourceId });
      if (clearKey) delete config.volc.apiKey;
      else if (apiKey.trim()) config.volc.apiKey = apiKey.trim();
      if (apiKeyEnv !== undefined) config.volc.apiKeyEnv = apiKeyEnv;
    }
    if (change.zipvoice) {
      for (const [key, value] of Object.entries(change.zipvoice)) {
        const limit = key === 'referenceText' ? 1000 : 4096;
        if (!Object.hasOwn(config.zipvoice, key) || typeof value !== 'string' || value.length > limit || value.includes('\0')) {
          throw new ControlError('VOICE_CONFIG', '请检查 ZipVoice 的参考录音、录音原文和运行路径。');
        }
        config.zipvoice[key] = value.trim();
      }
    }
    if (Object.hasOwn(change, 'provider')) {
      if (!['system', 'volc', 'zipvoice'].includes(change.provider)) throw new ControlError('VOICE_CONFIG', '无效的声音来源。');
      if (change.provider === 'volc' && !volcKey(config.volc)) {
        throw new ControlError('VOICE_CONFIG', '请填写火山 TTS 的 API Key。');
      }
      config.provider = change.provider;
    }
    if (config.provider === 'zipvoice' && (change.provider === 'zipvoice' || change.zipvoice)) {
      const paths = zipVoiceSettings(config.zipvoice);
      const [python, model] = await Promise.all([paths.python, paths.modelDirectory]
        .map(path => stat(path).catch(() => undefined)));
      if (!python?.isFile() || !model?.isDirectory()) {
        throw new ControlError('VOICE_ZIPVOICE', '请检查 ZipVoice 的 Python 和模型目录，或运行 make zipvoice-tts。');
      }
      return zipVoiceReference(paths);
    }
  });
}

ipcMain.handle('va:open-voice-config', event => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  return shell.openPath(voicePath);
});
ipcMain.handle('va:voice-preview', async event => {
  if (!settingsAuthorized(event)) throw new Error('无效的声音设置请求。');
  return previewVoice();
});

async function previewVoice() {
  if (active && ['music', 'screen'].includes(active.source)) await stopPerformance();
  return await perform({ speech: `嗨，我是${characterName}。听听我现在的声音！`, expression: 'smile' },
    { source: 'voice-preview' });
}
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
    multiSessionBinding: true,
    sessionBindingPolicy: true,
    ...state,
    visible: window.isVisible(),
    clickThrough,
    scale,
    avatarHeight: window.getBounds().height,
    controlsVisible: controlsWindow?.isVisible() ?? false,
    screenWatch,
    musicDance,
    senses: senses?.status(),
    speech: speechText || captionText || null,
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
    { label: '智能体接入…', click: () => openChat() },
    ...(agentVoice?.state().enabled ? [{ label: '停止 Agent 语音输入', click: () => stopAgentVoice() }] : []),
    { label: '动作…', click: () => openSettings('performance') },
    { label: '模型库…', click: () => openSettings('models') },
    { label: '设置…', click: () => openSettings() },
    { label: (window.isVisible() ? '隐藏' : '显示') + characterName,
      click: () => run({ type: window.isVisible() ? 'hide' : 'show' }) },
    { label: '鼠标穿透', type: 'checkbox', checked: clickThrough,
      click: item => run({ type: 'click-through', enabled: item.checked }) },
    { label: `看屏幕 · ${screenIntervalLabel(screenInterval)}`, type: 'checkbox', checked: screenWatch,
      enabled: Boolean(screenMode(currentMode)) || screenWatch,
      click: item => run({ type: 'sense', channel: 'screen', enabled: item.checked }) },
    { label: '检测音乐并自动跳舞', type: 'checkbox', checked: musicDance, enabled: !windows && currentMode !== 'off',
      click: item => run({ type: 'sense', channel: 'music', enabled: item.checked }) },
    { label: view === 'full' ? '半身视角' : '全身视角',
      click: () => run({ type: 'view', mode: view === 'full' ? 'portrait' : 'full' }) },
    { type: 'separator' },
    { label: '打招呼', enabled: state.state === 'ready', click: () => run({
      type: 'perform', action: 'wave', expression: 'smile',
    }) },
    { label: '跳舞', enabled: supportedDances().length > 0, submenu: danceChoices().map(action => ({
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

async function perform(command, { selfie = false, source = 'manual', readAloud = true, defaultDialogue = true, scope } = {}) {
  const { action = 'idle', expression, speech = '', wait = true } = command;
  if (typeof action !== 'string' || (expression !== undefined && typeof expression !== 'string') ||
      typeof speech !== 'string' || speech.length > 300 || typeof wait !== 'boolean') {
    throw new ControlError('INVALID_REQUEST', '动作、表情或台词无效。台词最多 300 字。');
  }
  if (changingModel) throw new ControlError('BUSY', '正在切换模型，请稍后再试。');
  if (active) throw new ControlError('BUSY', '角色正在表演。等表演结束，或使用 va stop。');
  const plan = performancePlan(action, expression);
  const style = speechActionStyles[plan.motion] ?? speakingStyle;
  const job = { id: ++nextId, action, speech: speech.trim(), source, style, scope };
  active = job;
  let voicePlayback = false;
  const startedAt = Date.now();
  const context = { id: job.id, action, source };
  logger.write('info', 'performance.started', context);
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
    if (speak) {
      voicePlayback = true;
      agentVoice?.setPlayback(true);
    }
    job.started = true;
    const automatedReply = ['local-agent', 'bot-chat'].includes(source);
    const data = await renderer({ type: 'perform', plan, speech: line, selfie, readAloud: speak, speakingStyle: style },
      automatedReply ? 120_000 : 80_000);
    if (job.canceled) throw new ControlError('CANCELED', '表演已停止。');
    logger.write('info', 'performance.completed', { ...context, durationMs: Date.now() - startedAt });
    return {
      id: job.id, action, speech: line, completed: true,
      ...(data.voiceWarning && { voiceWarning: data.voiceWarning }),
      ...(selfie && photoResult(data.image, command.clipboard)),
    };
  }).catch(error => {
    logger.write(job.canceled ? 'info' : 'warn', 'performance.ended', {
      ...context, durationMs: Date.now() - startedAt, code: job.canceled ? 'CANCELED' : errorCode(error),
    });
    if (job.canceled) throw new ControlError('CANCELED', '表演已停止。');
    const message = error.message.replace(/^Error invoking remote method 'va:speech': Error: /, '');
    throw new ControlError(error.code, message);
  }).finally(() => {
    if (active === job) active = undefined;
    if (voicePlayback) agentVoice?.setPlayback(false);
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
  channelSpeech.push({ lines: splitReplySpeech(speech), source, readAloud, effect, scope: effect.scope });
  drainAutomatic();
  return true;
}

function danceChoices() {
  return Object.entries(performanceCatalog.actions)
    .filter(([id, action]) => id !== 'dance' && action.category === 'dance').map(([id]) => id);
}

function supportedDances() {
  return danceChoices().filter(action => actionSupported(performanceCatalog.actions[action], state.media));
}

function nextDance() {
  const choices = supportedDances();
  return choices.length ? choices[danceIndex++ % choices.length] : undefined;
}

function currentDanceProblem(intent) {
  return danceRequestProblem(intent, performanceSnapshot(), inputDances.length);
}

function ensureDanceRequest(effect) {
  const problem = effect?.dance && currentDanceProblem(effect.dance);
  if (problem) throw problem;
}

function queueInputDance(intent, introduction = {}) {
  const problem = currentDanceProblem(intent);
  if (problem) throw problem;
  inputDances.push({ action: intent.action, ...introduction },
    ...Array.from({ length: intent.count - 1 }, () => ({ action: intent.action, source: introduction.source, scope: introduction.scope })));
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
  lastVoicePerformance = undefined;
}

function discardLocalAgentReplies(removed) {
  channelSpeech = channelSpeech.filter(item => !removed.has(item.scope));
  inputDances = inputDances.filter(item => !removed.has(item.scope));
  if (removed.has(active?.scope)) {
    void stopPerformance().catch(reportAutomaticError).finally(drainAutomatic);
  }
}

async function actionSoundEnabled() {
  return (await getVoiceConfig().catch(error => { reportAutomaticError(error); return {}; })).actionSound === true;
}

function queueVoicePerformance({ action, expression }) {
  if ((!action && !expression) || active || petting || changingModel || voiceDanceTimer || state.state !== 'ready') return false;
  const key = `${action ?? ''}:${expression ?? ''}`;
  if (lastVoicePerformance?.key === key && Date.now() - lastVoicePerformance.at < 6000) return false;
  const plan = performancePlan(action ?? 'idle', expression);
  lastVoicePerformance = { key, at: Date.now() };
  const revision = captionStartRevision;
  const reservation = voiceDanceTimer = setTimeout(() => {
    release();
    drainAutomatic();
  }, plan.seconds * 1000 + 100);
  function release() {
    if (voiceDanceTimer !== reservation) return;
    clearTimeout(reservation);
    voiceDanceTimer = undefined;
  }
  void (async () => {
    const voiced = action && action !== 'idle' && await actionSoundEnabled();
    if (voiceDanceTimer !== reservation || revision !== captionStartRevision || changingModel || active) return false;
    if (!voiced) return renderer({ type: 'doubao-dance', plan, replaceDance: true });
    release();
    await perform({ action, expression }, { source: 'voice-action' });
    return true;
  })().then(playing => {
    if (!playing) { release(); drainAutomatic(); }
  }).catch(error => { release(); reportAutomaticError(error); drainAutomatic(); });
  return true;
}

function queueInputPerformance(text) {
  const effect = requestedPerformance(text, characterName, performanceSnapshot());
  if (!effect) return;
  if (effect.dance) {
    const result = queueInputDance(effect.dance);
    lastInputPerformanceAt = Date.now();
    return result;
  }
  const reply = '好呀，看这边。';
  const queued = queueSpeech(effect.action && effect.action !== 'idle' ? '' : reply, 'input-action', true, effect);
  if (!queued) throw new ControlError('BUSY', '角色正在表演，请稍后再试。');
  lastInputPerformanceAt = Date.now();
  return { reply, handled: 'action' };
}

function onVoiceOrClientInput(text) {
  try { return Boolean(queueInputPerformance(text)); }
  catch (error) { reportAutomaticError(error); return false; }
}

function drainAutomatic() {
  if (!senses || !window || window.isDestroyed() || state.state !== 'ready' || changingModel || active || petting || voiceDanceTimer) return;
  if (inputDances.length) {
    const { action: requested, speech, expression, readAloud, source = 'input-dance', scope } = inputDances.shift();
    const action = requested ?? nextDance();
    if (!action || !actionSupported(performanceCatalog.actions[action], state.media)) {
      inputDances.length = 0;
      return;
    }
    void perform({ action, speech, expression }, { source, readAloud, scope }).catch(reportAutomaticError);
    return;
  }
  if (channelSpeech.length) {
    const { lines, source, readAloud, effect, scope } = channelSpeech.shift();
    const speech = lines.shift();
    if (lines.length) channelSpeech.unshift({ lines, source, readAloud, scope, effect: {}, continuation: true });
    const catalog = performanceSnapshot();
    const action = catalog.actions[effect.action]?.supported ? effect.action : undefined;
    const expression = catalog.supportedExpressions.includes(effect.expression) ? effect.expression : undefined;
    if (!speech && !action && !expression) { drainAutomatic(); return; }
    perform({ speech, action, expression: expression ?? (action ? undefined : 'smile') }, { source, readAloud, scope })
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
  if (error.code !== 'CANCELED') {
    logger.write('warn', 'automatic.failed', { code: errorCode(error) });
    console.error(error.message);
  }
}

function photoResult(imageURL, copy) {
  const png = imageURL?.split(',')[1];
  if (!png) throw new ControlError('PHOTO_ERROR', '角色照片生成失败。');
  if (copy === true) clipboard.writeImage(nativeImage.createFromDataURL(imageURL));
  return { png };
}

function requireMode(mode) {
  if (currentMode !== mode) throw new ControlError('INTEGRATION_MODE', '请先在「智能体接入」选择对应的接入方式。');
}

function requireChatInput() {
  if (['local', 'doubao-client'].includes(currentMode)) return;
  if (externalModes.includes(currentMode)) throw new ControlError('INTEGRATION_MODE', '请在已绑定的机器人频道对话。');
  throw new ControlError('INTEGRATION_MODE', '交互已关闭，请先选择一种接入方式。');
}

async function chatStatus() {
  const config = await getAgentConfig();
  const integration = integrationSnapshot(config, currentMode);
  const prompt = rolePrompt;
  if (integration.mode === 'local') return { integration, prompt, platform: process.platform, ...await localAgent.status(), voiceInput: agentVoice?.state() };
  if (integration.mode === 'doubao-client') return { integration, prompt, ...doubaoClient.state(),
    captions: doubaoCaptions.state(), autoActions: (config.doubaoClient?.autoActions ?? config.doubaoClient?.autoDance) !== false,
    listenForActions: (config.doubaoClient?.listenForActions ?? config.doubaoClient?.listenForDance) === true };
  return { integration, prompt, platform: process.platform, history: externalHistory, busy: false };
}

function requireSupportedIntegration(mode) {
  if (windows && mode === 'doubao-client') {
    throw new ControlError('UNSUPPORTED_PLATFORM', '豆包客户端联动和通话字幕暂不支持 Windows。');
  }
}

async function changeIntegration(value) {
  requireSupportedIntegration(value?.mode);
  const next = await editAgentConfig(config => configureIntegration(config, value));
  await activateIntegration(next.mode);
  return chatStatus();
}

async function activateIntegration(mode) {
  if (currentMode !== mode) {
    stopAgentVoice();
    logger.write('info', 'integration.changed', { previous: currentMode, mode });
    currentMode = mode;
    captionStartRevision++;
    doubaoClient.unbind();
    if (doubaoCaptions.running()) doubaoCaptions.stop();
    clearTimeout(captionTimer);
    captionText = '';
    lastCaptionAt = 0;
    syncBubble();
    localAgent.cancel();
    externalHistory = [];
    channelSpeech.length = 0;
    clearInputDances();
    lastInputDanceAt = 0;
    lastInputPerformanceAt = 0;
    const clearSensors = currentMode === 'off' && (screenWatch || musicDance);
    if (clearSensors) screenWatch = musicDance = false;
    queuedSpeech = undefined;
    screenRevision++;
    const stop = ['screen', 'music', 'local-agent', 'bot-chat', 'bot-action', 'doubao-client',
      'input-dance', 'input-action', 'voice-action'].includes(active?.source)
      ? stopPerformance().catch(reportAutomaticError) : undefined;
    syncSenses();
    await localAgent.monitorReplies(mode === 'local');
    await stop;
    drainAutomatic();
    if (clearSensors) await persistSettings();
  }
  updateTray();
  settingsWindow?.webContents.send('va:chat-refresh');
  settingsWindow?.webContents.send('va:settings-changed', settingsSnapshot());
}

async function configureAgent(change) {
  const { prompt, ...settings } = change;
  if (prompt !== undefined && typeof prompt !== 'string') throw new ControlError('CHARACTER_CONFIG', '角色 Prompt 无效。');
  requireSupportedIntegration(settings.mode);
  if (change.localAgent) stopAgentVoice();
  const edit = prepareBindings => editAgentConfig(async config => {
    const nextConfig = await patchAgentConfig(config, settings, launchDirectory);
    await prepareBindings?.(config.localAgent, nextConfig.localAgent);
    return nextConfig;
  });
  const next = Object.hasOwn(settings.localAgent ?? {}, 'allowMultipleSessions')
    ? await localAgent.configureBindingPolicy(edit)
    : Object.keys(settings).length ? await edit() : await getAgentConfig();
  if (prompt !== undefined) await setRolePrompt(prompt.trim() || createRolePrompt());
  const configuredMode = integrationMode(next);
  const mode = windows && configuredMode === 'doubao-client' ? 'off' : configuredMode;
  if (mode === currentMode && mode === 'local' && change.localAgent) {
    localAgent.cancel();
    await localAgent.monitorReplies(true);
    queuedSpeech = undefined;
    screenRevision++;
    syncSenses();
  }
  await activateIntegration(mode);
  return agentConfigSnapshot(next, currentMode, rolePrompt);
}

async function localConfig(value) {
  requireMode('local');
  if (value?.provider !== undefined || value?.cwd !== undefined) stopAgentVoice();
  await localAgent.configure(value);
  queuedSpeech = undefined;
  screenRevision++;
  syncSenses();
  const status = await chatStatus();
  logger.write('info', 'agent.configured', { provider: status.provider || null });
  return status;
}

async function bindDoubao(isActive) {
  logger.write('info', 'doubao.bind_started');
  try {
    await doubaoClient.bind(isActive);
    logger.write('info', 'doubao.bind_completed');
  } catch (error) {
    logger.write('warn', 'doubao.bind_failed', { code: errorCode(error) });
    throw error;
  }
}

async function openDoubaoClient() {
  requireMode('doubao-client');
  const paths = ['/Applications/Doubao.app', join(homedir(), 'Applications/Doubao.app')];
  for (const path of paths) {
    if (!(await stat(path).catch(() => null))?.isDirectory()) continue;
    if (!await shell.openPath(path)) return chatStatus();
  }
  throw new ControlError('CLIENT_CLOSED', '请先安装豆包 macOS 客户端。');
}

async function readDoubaoClient() {
  requireMode('doubao-client');
  await doubaoClient.read();
  return chatStatus();
}

async function installBoundDeepSeekRole() {
  if (windows) throw new ControlError('UNSUPPORTED_PLATFORM', 'DeepSeek Harness 桌面角色插件暂不支持 Windows。');
  requireMode('local');
  const status = await localAgent.status();
  if (status.provider !== 'deepseekharness' || !await localAgent.matchesDeepSeekSession(status.sessionId)) {
    throw new ControlError('AGENT_SESSION', '请先绑定一个 DeepSeek Harness 会话。');
  }
  requireMode('local');
  return installDeepSeekRole();
}

async function bindChat(id) {
  if (currentMode === 'doubao-client' && id === 'current') {
    await bindDoubao(() => currentMode === 'doubao-client');
  } else {
    requireMode('local');
    stopAgentVoice();
    await localAgent.bind(id);
  }
  return chatStatus();
}

function bindCurrentCodexSession(id) {
  const binding = codexBindQueue.catch(() => {}).then(async () => {
    const session = await readCodexSession(id);
    const result = await localAgent.bindCodex(session);
    stopAgentVoice();
    if (currentMode === 'local') {
      queuedSpeech = undefined;
      screenRevision++;
      syncSenses();
    }
    await activateIntegration('local');
    return result;
  });
  codexBindQueue = binding;
  return binding;
}

async function openAgentSession(ref, options) {
  requireMode('local');
  const application = await localAgent.openSession(ref, options);
  if (options?.bind) {
    stopAgentVoice();
    screenRevision++;
    syncSenses();
  }
  return { opened: true, application };
}

async function restoreAgentSession(ref) {
  requireMode('local');
  stopAgentVoice();
  await localAgent.restoreSession(ref);
  screenRevision++;
  syncSenses();
  return chatStatus();
}

async function unbindAgentSession(ref) {
  requireMode('local');
  stopAgentVoice();
  await localAgent.unbindSession(ref);
  return chatStatus();
}

async function clearAgentSessions(value) {
  requireMode('local');
  const { value: selection } = parseConfigCommand({ operation: 'run', target: 'chat-clear-sessions', value });
  stopAgentVoice();
  const result = await localAgent.clearSessions(selection);
  screenRevision++;
  syncSenses();
  return result;
}

function createAgentSession(message) {
  requireMode('local');
  stopAgentVoice();
  if (message === undefined) return localAgent.openNewSession();
  const requestedEffect = requestedPerformance(message, characterName, performanceSnapshot());
  ensureDanceRequest(requestedEffect);
  return localAgent.send(message, { newSession: true, requestedEffect });
}

async function startDoubaoCaptions(value) {
  requireMode('doubao-client');
  const revision = ++captionStartRevision;
  const stored = (await getAgentConfig()).doubaoClient;
  const { autoActions = (stored?.autoActions ?? stored?.autoDance) !== false,
    listen = (stored?.listenForActions ?? stored?.listenForDance) === true } = value ?? {};
  if (typeof autoActions !== 'boolean' || typeof listen !== 'boolean') {
    throw new ControlError('INVALID_REQUEST', '请选择通话字幕选项。');
  }
  if (revision !== captionStartRevision) throw new ControlError('CANCELED', '已取消启动字幕。');
  const microphoneAllowed = !listen || (mac ? await systemPreferences.askForMediaAccess('microphone')
    : !['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('microphone')));
  if (revision !== captionStartRevision) throw new ControlError('CANCELED', '已取消启动字幕。');
  requireMode('doubao-client');
  await editAgentConfig(config => ({ ...config, doubaoClient: {
    ...config.doubaoClient, autoActions, listenForActions: listen && microphoneAllowed,
  } }));
  if (revision !== captionStartRevision) throw new ControlError('CANCELED', '已取消启动字幕。');
  requireMode('doubao-client');
  captionAutoActions = autoActions;
  return doubaoCaptions.start({ autoActions, listen: listen && microphoneAllowed,
    micStatus: microphoneAllowed ? '' : (mac ? '请在 macOS 系统设置允许 VA 使用麦克风。'
      : '请在 Windows 隐私设置中允许桌面应用使用麦克风。') });
}

function stopDoubaoCaptions() {
  captionStartRevision++;
  if (active?.source === 'voice-action') void stopPerformance().catch(reportAutomaticError);
  doubaoCaptions.stop();
  return doubaoCaptions.state();
}

function stopAgentVoice() {
  agentVoiceRevision++;
  return agentVoice?.stop();
}

async function startAgentVoice() {
  if (windows) {
    requireMode('local');
    if (agentVoice.state().enabled) return agentVoice.state();
    const revision = ++agentVoiceRevision;
    const target = await localAgent.voiceTarget();
    if (revision !== agentVoiceRevision || currentMode !== 'local') return agentVoice.state();
    return agentVoice.start(target);
  }
  requireMode('local');
  if (agentVoice.state().enabled) return agentVoice.state();
  if (Number(process.getSystemVersion().split('.')[0]) < 26) {
    throw new ControlError('VOICE_INPUT_UNAVAILABLE', '本机语音输入需要 macOS 26 或更新版本。');
  }
  const revision = ++agentVoiceRevision;
  const target = await localAgent.voiceTarget();
  if (!await systemPreferences.askForMediaAccess('microphone')) {
    throw new ControlError('MICROPHONE_PERMISSION', '请在 macOS「隐私与安全性 → 麦克风」允许 VA 使用麦克风。');
  }
  if (revision !== agentVoiceRevision || currentMode !== 'local') return agentVoice.state();
  return agentVoice.start(target);
}

async function sendChat(message, speak, voiceTarget) {
  const mode = currentMode;
  const startedAt = Date.now();
  try {
    const result = await dispatchChat(message, speak, voiceTarget);
    logger.write('info', 'chat.completed', { mode, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logger.write('warn', 'chat.failed', { mode, durationMs: Date.now() - startedAt, code: errorCode(error) });
    throw error;
  }
}

async function dispatchChat(message, speak, voiceTarget) {
  if (voiceTarget) requireMode('local');
  requireChatInput();
  if (currentMode === 'local') {
    const requestedEffect = requestedPerformance(message, characterName, performanceSnapshot());
    ensureDanceRequest(requestedEffect);
    try {
      return await localAgent.send(message, { speak, requestedEffect, voiceTarget });
    } catch (error) {
      if (error.code !== 'AGENT_SESSION' || !requestedEffect || currentMode !== 'local') throw error;
      return queueInputPerformance(message);
    }
  }
  const performance = queueInputPerformance(message);
  if (performance) return performance;
  return sendDoubaoClient(message);
}

async function syncDoubaoContext() {
  requireMode('doubao-client');
  return sendDoubaoClient(undefined, true);
}

async function sendDoubaoClient(message, sync = false) {
  const revision = captionStartRevision;
  const context = await conversationPrompt('voice');
  if (revision !== captionStartRevision || currentMode !== 'doubao-client') {
    throw new ControlError('CANCELED', '豆包客户端交互已停止。');
  }
  return doubaoClient.send(message, { context, sync });
}

async function conversationPrompt(style) {
  return chatPerformancePrompt(await getCharacter(), performanceSnapshot(), '', style);
}

async function deepSeekContext(sessionId) {
  if (currentMode !== 'local' || !await localAgent.matchesDeepSeekSession(sessionId)) return { prompt: '' };
  const role = await conversationPrompt('text');
  if (currentMode !== 'local' || !await localAgent.matchesDeepSeekSession(sessionId)) return { prompt: '' };
  return { prompt: role + '\n\n本会话已绑定 VA。挥手、跳舞等可用桌面动作由 VA 读取回复末行后执行。需要表演时，直接写台词和末行动作标记即可。' };
}

const showReply = createReplyPresenter({
  parseReply: text => replyPerformance(text, performanceSnapshot()),
  queueDance: queueInputDance,
  queueSpeech,
  queueLines: (lines, source, readAloud, scope) => channelSpeech.push({ lines, source, readAloud, scope, effect: {} }),
  speechCapacity: () => channelSpeech.length < 5,
});

function canAnimateFromCaption() {
  return currentMode === 'doubao-client' && captionAutoActions && !active && !petting && !changingModel && !voiceDanceTimer && state.state === 'ready'
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
  logger.write('info', 'bot.reply_received', { mode: currentMode });
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

function configureActions(change) {
  performanceEdits = performanceEdits.catch(() => {}).then(async () => {
    const previous = await readConfig(performancePath, performanceDefaults, 'PERFORMANCE_CONFIG', 'performance.json');
    const next = {
      actions: mergeConfigEntries(previous.actions, change.actions),
      expressions: mergeConfigEntries(previous.expressions, change.expressions),
    };
    let catalog;
    try { catalog = compilePerformance(next); }
    catch (error) { throw new ControlError('PERFORMANCE_CONFIG', error.message); }
    await savePerformance(next);
    performanceCatalog = catalog;
    performanceWarning = undefined;
    updateTray();
    settingsWindow?.webContents.send('va:settings-changed', settingsSnapshot());
    return performanceSnapshot();
  });
  return performanceEdits;
}

async function handleConfiguration(command) {
  const { operation, target, value } = parseConfigCommand(command);
  if (operation === 'get') {
    switch (target) {
      case 'desktop': return { theme, speakingStyle, scale, view, clickThrough, screenWatch, screenInterval, musicDance, windowPosition };
      case 'character': {
        const { name, dialogue } = await readConfig(characterPath, defaultCharacter, 'CHARACTER_CONFIG', 'character.json');
        return { name, displayName: (await getCharacter()).name, prompt: rolePrompt, dialogue };
      }
      case 'actions': return readConfig(performancePath, performanceDefaults, 'PERFORMANCE_CONFIG', 'performance.json');
      case 'voice': return voiceSnapshot(await getVoiceConfig());
      case 'agent': return agentConfigSnapshot(await getAgentConfig(), currentMode, rolePrompt);
      case 'model': return { model: modelSnapshot(), useDefault: modelPath === null };
    }
  }
  if (operation === 'set') {
    switch (target) {
      case 'desktop': return applySettings(value);
      case 'character': return configureCharacter(value);
      case 'actions': return configureActions(value);
      case 'voice': return configureVoice(value);
      case 'agent': return configureAgent(value);
      case 'model': {
        const path = value.id ? (await modelLibrary.preview(value.id)).path : value.path;
        return { model: await changeModel(path === null || path === defaultModelPath ? null : resolve(launchDirectory, path)) };
      }
    }
  }
  switch (target) {
    case 'model-library': return { models: await modelLibrary.list() };
    case 'model-import': return modelLibrary.importPack(resolve(launchDirectory, value.path), path => changeModel(path, true));
    case 'model-check': return { model: await changeModel(resolve(launchDirectory, value.path), true) };
    case 'model-preview': return openModelPreview(value);
    case 'voice-preview': return previewVoice();
    case 'system-voices': return { voices: await systemVoiceCatalog.refresh() };
    case 'actions-reload':
      await reloadPerformance();
      settingsWindow?.webContents.send('va:settings-changed', settingsSnapshot());
      return performanceSnapshot();
    case 'chat-bind': {
      const status = await bindChat(value.id);
      settingsWindow?.webContents.send('va:chat-refresh');
      return { client: status.client ?? null, sessionId: status.sessionId ?? null, listeningCount: status.listeningCount };
    }
    case 'chat-bind-current': return bindCurrentCodexSession(value?.id);
    case 'agent-voice-status': return agentVoice.state();
    case 'agent-voice-start': return startAgentVoice();
    case 'agent-voice-stop': return stopAgentVoice();
    case 'deepseek-install-role': return { deepSeekRole: await installBoundDeepSeekRole() };
    case 'doubao-client-open': return openDoubaoClient();
    case 'doubao-client-read': return readDoubaoClient();
    case 'doubao-unbind':
      requireMode('doubao-client');
      doubaoClient.unbind();
      settingsWindow?.webContents.send('va:chat-refresh');
      return { bound: false };
    case 'doubao-context': return syncDoubaoContext();
    case 'doubao-caption-start': return startDoubaoCaptions(value);
    case 'doubao-caption-stop': return stopDoubaoCaptions();
    case 'chat-sessions': return { sessions: (await localAgent.status()).sessionHistory };
    case 'chat-open-session': return openAgentSession(value.ref, { bind: value.bind });
    case 'chat-restore-session': return restoreAgentSession(value.ref);
    case 'chat-unbind-session': return unbindAgentSession(value.ref);
    case 'chat-clear-sessions': return clearAgentSessions(value);
    case 'chat-sync-role': return localAgent.syncSessionRole(value.ref);
    case 'chat-create-session': return createAgentSession(value?.message);
    case 'permissions-status': return permissionStatus();
    case 'permissions-open':
      await openPrivacySettings(value.kind);
      return { opened: true, kind: value.kind };
    default: throw new ControlError('CONFIG_COMMAND', '未知的配置操作。');
  }
}

async function handle(command) {
  if (!command || typeof command !== 'object') {
    throw new ControlError('INVALID_REQUEST', '缺少 VA 命令。');
  }
  switch (command.type) {
    case 'status': return status();
    case 'configuration': return handleConfiguration(command);
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
      if (!externalModes.includes(command.platform) || command.platform !== currentMode) return { route: null };
      const [config, character] = await Promise.all([getAgentConfig(), getCharacter()]);
      if (command.platform !== currentMode || command.platform !== integrationMode(config)) return { route: null };
      const route = botRoute(config);
      return { route, ...(route && { character: character.name }) };
    }
    case 'bot-present': return presentBot(command);
    case 'bot-input': return receiveBotInput(command);
    case 'bot-prompt': {
      const config = await getAgentConfig();
      const route = checkBotRoute(config, command.platform, command.origin);
      if (!route || currentMode !== command.platform || route.target !== command.origin.target) return { accepted: false };
      const prompt = await conversationPrompt('voice');
      return currentMode === command.platform ? { accepted: true, prompt } : { accepted: false };
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
    case 'chat-cancel': return currentMode === 'doubao-client' ? doubaoClient.cancel() : localAgent.cancel();
    case 'integration':
      return command.mode === undefined ? (await chatStatus()).integration : changeIntegration({ mode: command.mode });
    case 'bot-perform':
      if (!externalModes.includes(command.platform)) throw new ControlError('INTEGRATION_MODE', '请选择机器人平台。');
      requireMode(command.platform);
      return await perform(command, { source: 'bot-action' });
    case 'senses': return { screenWatch, screenInterval, screenTarget: screenMode(currentMode), musicDance, ...senses.status(), configPath: agentPath };
    case 'screen-interval': return applySettings({ screenInterval: command.seconds });
    case 'sense':
      if (typeof command.enabled !== 'boolean' || !['screen', 'music'].includes(command.channel)) {
        throw new ControlError('INVALID_REQUEST', '请选择 screen 或 music，再选择 on 或 off。');
      }
      return await applySettings({ [command.channel === 'screen' ? 'screenWatch' : 'musicDance']: command.enabled });
    case 'observe': return await senses.observe();
    case 'character': {
      const character = await getCharacter();
      return { path: characterPath, ...character, prompt: character.prompt
        .replaceAll('{{actionCommands}}', '').replaceAll('{{name}}', () => character.name) };
    }
    case 'prompt': return { prompt: await conversationPrompt(command.style) };
    case 'deepseek-context': return deepSeekContext(command.sessionId);
    case 'deepseek-navigation': return currentMode === 'local' ? deepSeekNavigation(command.done) : {};
    case 'settings':
      openSettings();
      return { opened: true };
    case 'scale': return await applySettings(command.scale === undefined ? undefined : { scale: command.scale });
    case 'show':
      showAvatar();
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
      if (channelSpeech[0]?.continuation) channelSpeech.shift();
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

function avatarBounds(position, fit = restoreAvatarPosition) {
  const primary = screen.getPrimaryDisplay();
  const display = position
    ? screen.getDisplayMatching({ ...position, ...avatarSize(primary.workArea) }) : primary;
  const area = display.workArea;
  const { width, height } = avatarSize(area);
  const start = position ?? { x: area.x + area.width - width - 20, y: area.y + area.height - height - controlsHeight - 8 };
  return { ...fit(start, { width, height: height + controlsHeight }, area), width, height };
}

function moveAvatar(position) {
  window.setBounds(avatarBounds(position, clampAvatarPosition));
  const { x, y } = window.getBounds();
  windowPosition = { x, y };
  positionControls();
  syncBubble();
}

function syncBounds() {
  const current = window.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const { width, height } = avatarSize(area);
  const anchor = { x: current.x + current.width - width, y: current.y + current.height - height };
  const bounds = { ...clampAvatarPosition(anchor, { width, height: height + controlsHeight }, area), width, height };
  if (windows) {
    window.setMinimumSize(0, 0);
    window.setMaximumSize(0, 0);
    window.setBounds(bounds);
    window.setMinimumSize(width, height);
    window.setMaximumSize(width, height);
    positionControls();
    syncBubble();
    return;
  }
  if (Object.keys(bounds).some(key => bounds[key] !== current[key])) window.setBounds(bounds);
  positionControls();
  syncBubble();
}

function publicModel({ url, format, name, builtIn, path }) {
  if (path === defaultModelPath) name = coverName;
  if (basename(path) === 'model.vrm' || basename(path) === 'model.glb') {
    name = aiGirlName(basename(dirname(path))) ?? name;
  }
  return { url, format, name, builtIn };
}

function isBuiltInModel(path) {
  return builtInModels.has(path) || (basename(path) === 'model.vrm' && dirname(dirname(path)) === bundledAiGirls);
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
  const { name, format, builtIn } = publicModel(binding);
  const { path } = binding;
  const media = report.media;
  return { name, path, format, builtIn, ...media,
    checked: Boolean(media), textureWarning: report.textureWarning === true,
    warning: binding === selectedModel ? modelWarning : undefined };
}

function persistSettings() {
  return saveSettings({ theme, speakingStyle, scale, view, modelPath, clickThrough, screenWatch, screenInterval, musicDance, rolePrompt, windowPosition });
}

function saveWindowPosition() {
  clearTimeout(positionTimer);
  positionTimer = undefined;
  const saving = persistSettings().catch(reportAutomaticError).finally(() => {
    if (positionSave === saving) positionSave = undefined;
  });
  positionSave = saving;
  return saving;
}

function rememberWindowPosition() {
  const { x, y } = window.getBounds();
  if (windowPosition?.x === x && windowPosition.y === y) return;
  windowPosition = { x, y };
  clearTimeout(positionTimer);
  positionTimer = setTimeout(saveWindowPosition, 180);
}

async function changeModel(path, checkOnly = false) {
  if (changingModel) throw new ControlError('BUSY', '正在切换模型，请稍后再试。');
  changingModel = true;
  let next;
  let staged = false;
  try {
    const selectedPath = path ?? defaultModelPath;
    next = await bindModel(selectedPath, isBuiltInModel(selectedPath));
    assets.set(next.id, next);
    const info = await renderer({ type: 'model-check', model: publicModel(next), checkOnly,
      deadline: Date.now() + 65_000 }, 70_000);
    logger.write('info', 'model.checked', { format: next.format, checkOnly, textureWarning: info.textureWarning === true });
    if (checkOnly) return modelSnapshot(next, info);
    staged = true;
    if (active) await stopPerformance();
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
    logger.write('info', 'model.activated', { format: next.format });
    return modelSnapshot();
  } catch (error) {
    logger.write('warn', 'model.failed', { format: next?.format ?? null, checkOnly, code: errorCode(error) });
    throw error;
  } finally {
    if (staged) await renderer({ type: 'model-discard' }).catch(reportAutomaticError);
    if (next && selectedModel !== next) assets.delete(next.id);
    changingModel = false;
    drainAutomatic();
  }
}

function settingsSnapshot() {
  return { theme, speakingStyle, scale, view, model: modelSnapshot(), characterName, rolePrompt, clickThrough, minScale, maxScale,
    screenWatch, screenInterval, screenTarget: screenMode(currentMode), integrationMode: currentMode, windowPosition,
    nativeSenses: !windows, platform: process.platform, musicDance, senses: senses?.status(),
    performance: performanceSnapshot() };
}

async function applySettings(change) {
  if (!change) return settingsSnapshot();
  if (windows && change.musicDance === true) {
    throw new ControlError('UNSUPPORTED_PLATFORM', 'Windows 暂不支持系统音乐识别。仍可手动播放舞步。');
  }
  if (change.screenWatch === true) {
    const revision = screenRevision;
    await prepareObservation();
    if (revision !== screenRevision) throw new ControlError('SCREEN_CHANGED', '接入方式已变更，请重试。');
  }
  if (change.musicDance === true && currentMode === 'off') {
    throw new ControlError('INTEGRATION_MODE', '交互已关闭，请先选择一种接入方式。');
  }
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
  }
  if (Object.hasOwn(change, 'windowPosition')) moveAvatar(change.windowPosition);
  else if (Object.hasOwn(change, 'scale')) syncBounds();
  if (Object.hasOwn(change, 'clickThrough')) {
    clickThrough = change.clickThrough === true;
    syncMousePassthrough();
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
    if (musicDance !== (change.musicDance === true)) musicPaused = false;
    musicDance = change.musicDance === true;
    changedSensors = true;
  }
  if (changedSensors) {
    logger.write('info', 'senses.configured', { screenWatch, screenInterval, musicDance, mode: currentMode });
    syncSenses();
  }
  const settings = settingsSnapshot();
  settingsWindow?.webContents.send('va:settings-changed', settings);
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
    return settingsLoad;
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
    settingsLoad = undefined;
    dropGalleryPreview();
  });
  settingsWindow.webContents.on('render-process-gone', dropGalleryPreview);
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsLoad = settingsWindow.loadURL(settingsURL);
  settingsLoad.catch(console.error);
  return settingsLoad;
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

async function prepareObservation() {
  if (currentMode === 'local') return localAgent.prepareObservation();
  throw new ControlError('SCREEN_MODE', '请选用支持截图的本地 Agent。');
}

function syncSenses() {
  const target = screenMode(currentMode);
  const shown = !window.isDestroyed() && window.isVisible();
  if (!shown || !screenWatch || !target) {
    queuedSpeech = undefined;
    if (active?.source === 'screen') stopPerformance().catch(reportAutomaticError).finally(drainAutomatic);
  }
  senses?.update({ screenWatch, musicDance: currentMode !== 'off' && musicDance, shown, target, interval: screenInterval, revision: screenRevision });
}

function positionControls() {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const centered = Math.round(bounds.x + (bounds.width - controlsWidth) / 2);
  const x = Math.max(area.x, Math.min(centered, area.x + area.width - controlsWidth));
  const y = bounds.y + bounds.height;
  if (windows) {
    // Windows may apply native frame minimums when moving a tiny toolbar.
    // Keep its size explicit and do not interpret this move as a user drag.
    const current = controlsWindow.getBounds();
    windowsPositioningControls = true;
    try {
      if (current.x !== x || current.y !== y || current.width !== controlsWidth || current.height !== controlsHeight) {
        controlsWindow.setBounds({ x, y, width: controlsWidth, height: controlsHeight });
      }
      controlsPosition = controlsWindow.getPosition();
    } finally {
      windowsPositioningControls = false;
    }
    return;
  }
  controlsPosition = [x, y];
  const [currentX, currentY] = controlsWindow.getPosition();
  if (x !== currentX || y !== currentY) controlsWindow.setPosition(x, y);
}

function syncControlsVisibility() {
  const cursor = screen.getCursorScreenPoint();
  const near = ({ x, y, width, height }) =>
    cursor.x >= x - controlsHoverMargin && cursor.x <= x + width + controlsHoverMargin &&
    cursor.y >= y - controlsHoverMargin && cursor.y <= y + height + controlsHoverMargin;
  const now = performance.now();
  if (near(window.getBounds()) || near(controlsWindow.getBounds())) {
    controlsLastNearAt = now;
    if (!controlsWindow.isVisible()) setControlsVisibility(true);
  } else if (controlsWindow.isVisible() && now - controlsLastNearAt >= controlsHideDelay) {
    setControlsVisibility(false);
  }
  syncMousePassthrough(cursor);
}

function syncMousePassthrough(cursor) {
  if (!window || window.isDestroyed()) return;
  let ignore = clickThrough;
  if (ignore && nameplateBounds && window.isVisible() && controlsWindow &&
      !controlsWindow.isDestroyed() && controlsWindow.isVisible()) {
    const { top, width, height } = nameplateBounds;
    const avatar = window.getBounds();
    const x = avatar.x + (avatar.width - width) / 2;
    const y = avatar.y + top;
    cursor ??= screen.getCursorScreenPoint();
    if (cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height) ignore = false;
  }
  if (ignore === ignoringMouse) return;
  window.setIgnoreMouseEvents(ignore);
  ignoringMouse = ignore;
}

function setControlsVisibility(visible) {
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    if (visible) controlsWindow.showInactive();
    else if (controlsWindow.isVisible()) controlsWindow.hide();
  }
  if (window && !window.isDestroyed()) window.webContents.send('va:controls-visible', visible);
}

function trackControlsHover() {
  if (!controlsReady || !window.isVisible() || controlsHoverTimer) return;
  positionControls();
  syncControlsVisibility();
  controlsHoverTimer = setInterval(syncControlsVisibility, 60);
}

function showAvatar() {
  if (!window || window.isDestroyed()) return;
  window.showInactive();
  trackControlsHover();
}

function stopControlsHover() {
  clearInterval(controlsHoverTimer);
  controlsHoverTimer = undefined;
  controlsLastNearAt = -Infinity;
  setControlsVisibility(false);
  syncMousePassthrough();
}

function syncBubble() {
  if (!bubbleReady || !bubbleWindow || bubbleWindow.isDestroyed() || !window || window.isDestroyed()) return;
  const page = bubblePage || dialoguePages(captionText).at(-1);
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
  if (mac) bubbleWindow.setVisibleOnAllWorkspaces(true);
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
    ...(windows ? {
      // Explicit equal limits avoid Windows rounding a non-resizable window's
      // cached size up again every time it moves at fractional display scaling.
      resizable: true, thickFrame: false,
      minWidth: controlsWidth, maxWidth: controlsWidth,
      minHeight: controlsHeight, maxHeight: controlsHeight,
      minimizable: false, maximizable: false,
    } : {}),
    webPreferences: { preload: join(root, 'desktop/preload.cjs'), sandbox: true, contextIsolation: true },
  });
  // The toolbar needs to stay clickable above other desktop overlays.
  controlsWindow.setAlwaysOnTop(true, 'status', 1);
  if (mac) controlsWindow.setVisibleOnAllWorkspaces(true);
  localWindow(controlsWindow.webContents);
  positionControls();
  controlsWindow.on('move', () => {
    if (windows && windowsPositioningControls) return;
    if (window.isDestroyed()) return;
    const [x, y] = controlsWindow.getPosition();
    const [oldX, oldY] = controlsPosition;
    controlsPosition = [x, y];
    if (x === oldX && y === oldY) return;
    controlsLastNearAt = performance.now();
    const [modelX, modelY] = window.getPosition();
    window.setPosition(modelX + x - oldX, modelY + y - oldY);
  });
  controlsWindow.once('ready-to-show', () => {
    controlsReady = true;
    trackControlsHover();
  });
  controlsWindow.once('closed', () => {
    controlsReady = false;
    stopControlsHover();
  });
  controlsWindow.loadURL(controlsURL).catch(console.error);
}

function createWindow() {
  const { x, y, width, height } = avatarBounds(windowPosition);
  windowPosition = { x, y };
  window = new BrowserWindow({
    title: characterName + ' · VA',
    ...windowPosition,
    width, height,
    transparent: true,
    frame: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    show: false,
    ...(windows ? {
      resizable: true, thickFrame: false,
      minWidth: width, maxWidth: width, minHeight: height, maxHeight: height,
      minimizable: false, maximizable: false,
    } : {}),
    webPreferences: {
      preload: join(root, 'desktop/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (mac) window.setVisibleOnAllWorkspaces(true);
  syncMousePassthrough();
  localWindow(window.webContents);
  window.on('page-title-updated', event => event.preventDefault());
  window.on('move', () => {
    rememberWindowPosition();
    positionControls();
    syncBubble();
  });
  window.on('show', () => {
    syncBubble();
    trackControlsHover();
    syncSenses();
  });
  window.on('hide', () => {
    syncBubble();
    stopControlsHover();
    syncSenses();
  });
  window.once('closed', stopControlsHover);
  window.webContents.on('render-process-gone', () => {
    logger.write('error', 'avatar.renderer_exited');
    failPending('桌面渲染进程已退出。请重启 VA。');
  });
  window.once('ready-to-show', () => {
    if (!launchHidden) showAvatar();
    updateTray();
  });
  window.loadURL(pageURL).catch(error => failPending(error.message));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  logger.write('info', 'app.start', { version: app.getVersion(), platform: process.platform, packaged: app.isPackaged });
  process.on('uncaughtExceptionMonitor', error => logger.write('error', 'app.uncaught_exception', { code: errorCode(error) }));
  app.on('second-instance', (_event, args) => {
    if (!args.includes('--va-hidden')) showAvatar();
  });
  app.on('activate', () => {
    if (!launchHidden) showAvatar();
  });
  app.on('window-all-closed', () => app.quit());
  let flushingPosition = false;
  app.on('before-quit', event => {
    if (window && !window.isDestroyed()) rememberWindowPosition();
    if (positionTimer || positionSave || flushingPosition) {
      event.preventDefault();
      if (!flushingPosition) {
        flushingPosition = true;
        const saved = positionTimer ? saveWindowPosition() : positionSave;
        void saved.finally(() => { flushingPosition = false; app.quit(); });
      }
      return;
    }
    logger.write('info', 'app.stop');
    zipVoicePreparation = undefined;
    zipVoice.stop();
    stopControlsHover();
    doubaoClient?.unbind();
    if (doubaoCaptions?.running()) doubaoCaptions.stop();
    stopAgentVoice();
    localAgent?.cancel();
    void localAgent?.monitorReplies(false);
    senses?.update({ screenWatch: false, musicDance: false, shown: false });
    globalShortcut.unregisterAll();
    server?.close();
  });

  app.whenReady().then(async () => {
    protocol.handle('va-app', asset);
    const doubaoHelper = join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'va-doubao-client');
    let lastDoubaoProblem;
    doubaoClient = createDoubaoClient({
      request: command => callDoubaoClient(doubaoHelper, command),
      onChange: () => {
        const code = doubaoClient.state().client.problemCode;
        if (code && code !== lastDoubaoProblem) logger.write('warn', 'doubao.client_unavailable', { code });
        lastDoubaoProblem = code;
        settingsWindow?.webContents.send('va:chat-refresh');
      },
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
          actions: Object.entries(catalog.actions).filter(([id, action]) => id !== 'idle' && action.supported && !action.alternate)
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
        const next = normalizeAgentConfig(await edit(normalizeAgentConfig(await getAgentConfig())));
        await saveAgent(next);
        return next;
      });
      edits = result;
      return result;
    };
    const savedSettings = await readSettings(settingsPath);
    ({ theme, speakingStyle, scale, view, clickThrough, screenWatch, screenInterval, musicDance, windowPosition } = savedSettings);
    modelPath = restoreModelPath(savedSettings.modelPath, root);
    const localAha = await findLocalAha();
    if (localAha) builtInModels.add(localAha.path);
    const cover = await bindModel(coverModelPath, true);
    defaultModelPath = cover.path;
    builtInModels.add(cover.path);
    modelLibrary = createModelLibrary(join(app.getPath('userData'), 'ai-girls.json'), {
      bundledPack: bundledAiGirls, localAha, coverModel: cover.path,
    });
    if (modelPath) {
      selectedModel = await bindModel(modelPath, isBuiltInModel(modelPath))
        .catch(error => { modelWarning = error.message + ' 已显示默认角色。'; });
    }
    selectedModel ??= cover;
    assets.set(selectedModel.id, selectedModel);
    let storedAgent;
    try {
      storedAgent = await getAgentConfig();
      currentMode = integrationMode(storedAgent);
      if (windows && currentMode === 'doubao-client') currentMode = 'off';
    } catch (error) {
      console.error(error.message);
    }
    await initializeRolePrompt(savedSettings.rolePrompt, storedAgent).catch(error => console.error(error.message));
    await getCharacter().catch(error => console.error(error.message));
    if (windows && musicDance) {
      musicDance = false;
      await persistSettings();
    }
    if (currentMode === 'off' && (screenWatch || musicDance)) {
      screenWatch = musicDance = false;
      await persistSettings();
    } else if (screenWatch && savedSettings.screenSource === 'local' && currentMode !== 'local') {
      screenWatch = false;
      await persistSettings();
    }
    const initialVoice = await getVoiceConfig().catch(error => console.error(error.message));
    if (initialVoice?.provider === 'zipvoice') warmZipVoice(initialVoice);
    const getPrompt = () => conversationPrompt('text');
    const parseReply = reply => replyPerformance(reply, performanceSnapshot());
    localAgent = createLocalAgent({
      getConfig: async () => (await getAgentConfig())?.localAgent,
      updateConfig: (edit, mode) => editAgentConfig(async config => ({
        ...config, ...(mode && { mode }), localAgent: await edit(config?.localAgent),
      })),
      getPrompt, parseReply,
      sessionPath: join(app.getPath('userData'), 'local-agent-sessions.json'),
      launchDirectory,
      presentReply: (reply, readAloud, effect, scope) =>
        currentMode === 'local' && showReply(reply, 'local-agent', readAloud, { ...effect, scope }),
      onReplySessionsRemoved: removed => { if (currentMode === 'local') discardLocalAgentReplies(removed); },
      onReplyError: error => logger.write('warn', 'agent.reply_monitor_failed', { code: errorCode(error) }),
      onChange: () => settingsWindow?.webContents.send('va:chat-refresh'),
    });
    await localAgent.monitorReplies(currentMode === 'local');
    agentVoice = (windows ? createWindowsAgentVoice : createAgentVoice)({
      binary: join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'va-doubao-captions'),
      send: (text, target) => sendChat(text, undefined, target),
      onState: value => {
        settingsWindow?.webContents.send('va:agent-voice', value);
        updateTray();
      },
    });
    const sensorStates = new Map();
    senses = createSenses({
      audioHelper: join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'va-audio-monitor'),
      getCharacter: async () => {
        const character = await getCharacter();
        return { ...character, prompt: character.prompt.replaceAll('{{actionCommands}}', '')
          .replaceAll('{{name}}', () => character.name) };
      },
      captureScreen,
      prepareObservation,
      onStatus: info => {
        for (const [sensor, { state, code }] of Object.entries(info)) {
          if (state === 'analyzing') continue;
          const status = state + (code ?? '');
          if (sensorStates.get(sensor) === status) continue;
          sensorStates.set(sensor, status);
          logger.write(state === 'error' ? 'warn' : 'info', 'senses.state', { sensor, state, code });
        }
        settingsWindow?.webContents.send('va:senses-state', info);
      },
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
      const size = 18 * scaleFactor;
      icon.addRepresentation({
        scaleFactor, buffer: portrait.resize({ width: size, height: size, quality: 'best' }).toPNG(),
      });
    }
    tray = new Tray(icon);
    if (windows) tray.setToolTip('VA · ' + characterName);
    shortcutRegistered = globalShortcut.register('Control+Alt+V', openSettings);
    updateTray();
    server = await startControl(async command => {
      try {
        return await handle(command);
      } catch (error) {
        logger.write('warn', 'control.command_failed', { code: errorCode(error), mode: currentMode });
        throw error;
      }
    });
    logger.write('info', 'app.control_ready', { mode: currentMode });
  }).catch(error => {
    logger.write('error', 'app.start_failed', { code: errorCode(error) });
    console.error(error);
    app.exit(1);
  });
}
