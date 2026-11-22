import { loadAvatar } from './avatar.js';
import { createVoice } from './voice.js';
import { textSpeechDuration } from './speech-motion.js';
import { createDoubaoPlayback } from './doubao-playback.js';
import { speechActionStyles } from './actions.js';

const stage = document.getElementById('stage');
const notice = document.getElementById('notice');
const voice = createVoice();
let avatar;
let portrait = false;
let performance;
let actionVoice;
let staged;
const doubao = createDoubaoPlayback({ getAvatar: () => avatar, bubble: window.va.bubble });
window.va.onDoubaoOutput(event => {
  if (performance && event.type === 'client-speech') return;
  if (event.type === 'clear') actionVoice?.abort();
  doubao.output(event);
});

function message(text = '') {
  notice.textContent = text;
  notice.hidden = !text;
}

async function checkAvatar(model, deadline = Infinity) {
  try {
    const next = await loadAvatar(stage, model);
    if (Date.now() > deadline) {
      next.dispose();
      throw new Error('模型加载超时。');
    }
    return next;
  } catch (error) {
    console.error(error);
    if (error.message?.includes('WebGL')) throw new Error('无法初始化桌面 3D 渲染。');
    throw new Error(`模型检测失败（${model.name}）。${error.message || '请检查模型和贴图。'}`);
  }
}

function clearStaged() {
  clearTimeout(staged?.timer);
  staged?.avatar.dispose();
  staged = undefined;
}

function activateAvatar(next) {
  try {
    next.showPortrait(portrait);
    next.mount();
  } catch (error) {
    next.dispose();
    throw error;
  }
  avatar?.dispose();
  avatar = next;
  message();
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

async function perform({ plan, speech, selfie, speakingStyle, readAloud = true, showWhilePreparing = false }) {
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
      if (plan.motion === 'idle' && !plan.bones && !plan.clip) {
        avatar.play(plan);
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
    const motionMs = Math.max(plan.seconds * 1000,
      speech && (plan.motion === 'idle' || speechActionStyles[plan.motion]) && !plan.bones && !plan.clip ? duration : 0);
    avatar.play({ ...plan, seconds: motionMs / 1000 });
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
      avatar?.play();
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
      return doubao.dance(command.plan);
    case 'action-voice': {
      actionVoice?.abort();
      const controller = new AbortController();
      actionVoice = controller;
      try {
        const buffer = await voice.decode(command.audio, controller.signal);
        await voice.play(buffer, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        if (actionVoice === controller) actionVoice = undefined;
      }
      return;
    }
    case 'action-voice-stop':
      actionVoice?.abort();
      return;
    case 'perform': return await perform(command);
    case 'stop':
      performance?.abort();
      actionVoice?.abort();
      doubao.stopDance();
      doubao.stopClientSpeech();
      avatar?.play();
      return;
    case 'photo': return avatar.capture();
    case 'view':
      portrait = command.mode === 'portrait';
      return avatar?.showPortrait(portrait);
    case 'model-check': {
      clearStaged();
      const next = await checkAvatar(command.model, command.deadline);
      const report = { textureWarning: next.textureWarning, media: next.media };
      if (command.checkOnly) next.dispose();
      else staged = { key: command.model.url, avatar: next, timer: setTimeout(clearStaged, 12_000) };
      return report;
    }
    case 'model-discard':
      return clearStaged();
    case 'model-activate': {
      if (staged?.key !== command.key) throw new Error('模型检测结果已过期，请重新选择文件。');
      const next = staged.avatar;
      clearTimeout(staged.timer);
      staged = undefined;
      portrait = command.portrait;
      actionVoice?.abort();
      doubao.stopDance();
      doubao.stopClientSpeech();
      activateAvatar(next);
      return;
    }
  }
});

try {
  const [initialModel, view] = await Promise.all([window.va.initialModel(), window.va.initialView()]);
  portrait = view === 'portrait';
  const initial = await checkAvatar(initialModel);
  activateAvatar(initial);
  window.va.report({ state: 'ready', textureWarning: initial.textureWarning, media: initial.media });
} catch (error) {
  const detail = error.message;
  message(detail);
  window.va.report({ state: 'error', detail });
}
