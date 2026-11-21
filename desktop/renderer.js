import { actions } from './actions.js';
import { loadAvatar } from './avatar.js';
import { createVoice } from './voice.js';
import { textSpeechDuration } from './speech-motion.js';
import { createDoubaoPlayback } from './doubao-playback.js';

const stage = document.getElementById('stage');
const notice = document.getElementById('notice');
const voice = createVoice();
let avatar;
let portrait = false;
let performance;
const doubao = createDoubaoPlayback({ getAvatar: () => avatar, bubble: window.va.bubble });
window.va.onDoubaoOutput(event => {
  if (performance && event.type === 'client-speech') return;
  doubao.output(event);
});

function message(text = '') {
  notice.textContent = text;
  notice.hidden = !text;
}

async function setAvatar(model, deadline = Infinity) {
  message(`正在加载 ${model.name}…`);
  try {
    const next = await loadAvatar(stage, model);
    if (Date.now() > deadline) {
      next.dispose();
      throw new Error('模型加载超时。');
    }
    next.showPortrait(portrait);
    avatar?.dispose();
    avatar = next;
    return { textureWarning: next.textureWarning, media: next.media };
  } catch (error) {
    console.error(error);
    if (error.message?.includes('WebGL')) throw new Error('无法初始化桌面 3D 渲染。');
    throw new Error(`无法加载 ${model.name}。请检查格式、模型文件和贴图。`);
  } finally {
    message();
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function startBubble(text) {
  const pages = text.match(/[\s\S]{1,58}/gu);
  let page = 0;
  window.va.bubble(text, pages[0]);
  let timer;
  return {
    paginate(duration) {
      if (pages.length > 1) timer = setInterval(() => {
        page = Math.min(page + 1, pages.length - 1);
        window.va.bubble(text, pages[page]);
      }, duration / pages.length);
    },
    close() {
      clearInterval(timer);
      window.va.bubble('', '');
    },
  };
}

async function perform({ action, expression, speech, selfie, speakingStyle, readAloud = true, showWhilePreparing = false }) {
  doubao.stopDance();
  doubao.stopClientSpeech();
  const controller = new AbortController();
  const { signal } = controller;
  performance = controller;
  let dialogue;
  let animatingText = false;
  try {
    let audio;
    let voiceWarning;
    const textDuration = textSpeechDuration(speech);
    if (speech && showWhilePreparing) {
      dialogue = startBubble(speech);
      if (action === 'idle') {
        avatar.play(action, expression);
        avatar.speak(speech, speakingStyle, textDuration);
        animatingText = true;
      }
    }
    if (speech && readAloud) {
      if (!dialogue) message('正在准备语音…');
      try {
        const prepared = await voice.prepare(speech, signal);
        audio = prepared.audio;
        voiceWarning = prepared.warning;
      } catch (error) {
        signal.throwIfAborted();
        voiceWarning = error.message.replace(/^Error invoking remote method 'va:speech': Error: /, '');
      }
    }
    signal.throwIfAborted();
    message();
    const duration = audio ? audio.duration * 1000 : textDuration;
    if (speech) {
      dialogue ??= startBubble(speech);
      dialogue.paginate(duration);
      if (!animatingText || readAloud) avatar.speak(speech, speakingStyle, duration, audio ? voice.level : undefined);
    }
    avatar.play(action, expression);
    const motionMs = actions[action].seconds * 1000;
    const shutterMs = Math.max(850, Math.min(duration + 60, motionMs - 500));
    const shot = selfie ? delay(shutterMs, signal).then(() => avatar.capture(true)) : undefined;
    const [image] = await Promise.all([
      shot,
      delay(motionMs, signal),
      audio ? voice.play(audio, signal) : speech && delay(duration, signal),
    ]);
    return { image, voiceWarning };
  } finally {
    controller.abort();
    if (performance === controller) {
      performance = undefined;
      avatar?.stopSpeaking();
      dialogue?.close();
      message();
    }
  }
}

let press;
stage.addEventListener('pointerdown', event => {
  if (event.button === 0 && event.isPrimary) press = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
stage.addEventListener('pointermove', event => {
  if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press = undefined;
});
stage.addEventListener('pointercancel', () => { press = undefined; });
stage.addEventListener('pointerup', event => {
  const clicked = press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6;
  press = undefined;
  if (clicked && avatar?.hits(event.clientX, event.clientY)) window.va.pet();
});
window.va.onCommand(async command => {
  switch (command.type) {
    case 'doubao-dance':
      if (performance) return false;
      if (command.replaceDance) doubao.stopDance();
      return doubao.dance(command.action);
    case 'perform': return await perform(command);
    case 'stop':
      performance?.abort();
      doubao.stopDance();
      doubao.stopClientSpeech();
      avatar.play('idle', 'neutral');
      return;
    case 'photo': return avatar.capture();
    case 'view':
      portrait = command.mode === 'portrait';
      return avatar.showPortrait(portrait);
    case 'model':
      doubao.stopDance();
      doubao.stopClientSpeech();
      return await setAvatar(command.model, command.deadline);
  }
});

try {
  const [initialModel, view] = await Promise.all([window.va.initialModel(), window.va.initialView()]);
  portrait = view === 'portrait';
  window.va.report({ state: 'ready', ...await setAvatar(initialModel) });
} catch (error) {
  const detail = error.message;
  message(detail);
  window.va.report({ state: 'error', detail });
}
