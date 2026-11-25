import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ControlError } from '../lib/control.js';
import { errorCode } from '../lib/logger.js';
import { analyzeScreen } from './vision-agent.js';

const audioSilence = 3600;
const emptyObservation = () => ({ activity: '', speech: '' });

export function createSenses({ audioHelper, getCharacter, captureScreen, prepareObservation, onScreen, onMusic, onStatus,
  launchAudio = spawn }) {
  let screenStatus = { state: 'off' };
  let musicStatus = { state: 'off', detected: false };
  let screenEnabled = false;
  let screenTimer;
  let screenInterval;
  let screenTarget;
  let screenRevision;
  let generation = 0;
  let capturing;
  let pendingFrame;
  let controller;
  let previous = emptyObservation();
  let musicProcess;
  let silenceTimer;
  let high = 0;
  let low = 0;
  let visible = false;
  let watch = false;
  let dance = false;

  function status() {
    return { screen: { ...screenStatus }, music: { ...musicStatus } };
  }

  function setScreen(next) {
    screenStatus = { ...screenStatus, ...next };
    onStatus(status());
  }

  function setMusic(state, detected = false, detail, code) {
    if (state === musicStatus.state && detected === musicStatus.detected &&
        detail === musicStatus.detail && code === musicStatus.code) return;
    const changed = detected !== musicStatus.detected;
    musicStatus = { state, detected, ...(detail && { detail }), ...(code && { code }) };
    onStatus(status());
    if (changed) onMusic(detected);
  }

  async function captureFrame() {
    if (!screenEnabled) {
      throw new ControlError('SCREEN_DISABLED', '请先显示 VA 并开启「看屏幕」。');
    }
    const started = generation;
    const observer = await prepareObservation();
    if (started !== generation) throw new ControlError('SCREEN_CHANGED', '屏幕观察设置已变更。');
    const frame = await captureScreen();
    if (started !== generation) throw new ControlError('SCREEN_CHANGED', '屏幕观察设置已变更。');
    return { frame, observer };
  }

  async function observe() {
    if (controller || capturing !== undefined) throw new ControlError('SCREEN_BUSY', '正在观察屏幕，请稍后重试。');
    const current = new AbortController();
    controller = current;
    try {
      const capture = await captureFrame();
      return { ...await inspect(capture, emptyObservation(), current.signal), capturedAt: capture.frame.capturedAt };
    } finally {
      finishObservation(current);
    }
  }

  async function tick() {
    if (!screenEnabled) return;
    setScreen({ nextCaptureAt: new Date(Date.now() + screenInterval * 1000).toISOString() });
    if (capturing !== undefined) return;
    const started = generation;
    capturing = started;
    try {
      const capture = await captureFrame();
      if (started !== generation) return;
      pendingFrame = capture;
      setScreen({ lastCapturedAt: capture.frame.capturedAt });
      void analyzeLatest();
    } catch (error) {
      if (started === generation) setScreen({ state: 'error', detail: error.message, code: errorCode(error) });
    } finally {
      capturing = undefined;
      if (screenEnabled && started !== generation) void tick();
    }
  }

  async function inspect({ frame, observer }, last, signal) {
    const character = await getCharacter();
    signal.throwIfAborted();
    const result = await analyzeScreen(character, frame, last, signal, observer);
    signal.throwIfAborted();
    return result;
  }

  function finishObservation(current) {
    if (controller === current) {
      controller = undefined;
      void analyzeLatest();
    }
  }

  async function analyzeLatest() {
    if (!screenEnabled || controller || !pendingFrame) return;
    const capture = pendingFrame;
    pendingFrame = undefined;
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    setScreen({ state: 'analyzing', detail: undefined, code: undefined });
    try {
      const result = await inspect(capture, previous, signal);
      const { activity, speech } = result;
      const newLine = speech && speech !== previous.speech;
      previous = { activity, speech: speech || previous.speech };
      setScreen({ state: 'waiting', lastActivity: activity, checkedAt: capture.frame.capturedAt });
      if (newLine) onScreen(speech);
    } catch (error) {
      if (!signal.aborted) setScreen({ state: 'error', detail: error.message, code: errorCode(error) });
    } finally {
      finishObservation(current);
    }
  }

  function startMusic() {
    high = low = 0;
    setMusic('starting');
    const proc = launchAudio(audioHelper, [String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    musicProcess = proc;
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', line => {
      if (musicProcess !== proc) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === 'error') {
        setMusic('error', false, message.message, 'AUDIO_MONITOR_ERROR');
      } else if (message.type === 'ready') {
        setMusic('listening', musicStatus.detected);
      } else if (message.type === 'score' && typeof message.music === 'number') {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          high = low = 0;
          if (musicProcess === proc) setMusic('listening');
        }, audioSilence);
        high = message.music >= 0.6 ? high + 1 : 0;
        low = message.music < 0.32 ? low + 1 : 0;
        const detected = high >= 2 || (musicStatus.detected && low < 3);
        setMusic(detected ? 'music' : 'listening', detected);
      }
    });
    proc.on('error', error => {
      if (musicProcess === proc) {
        setMusic('error', false, error.code === 'ENOENT'
          ? '缺少系统音频组件，请重新构建 VA 或执行 make audio-helper。'
          : '系统音频组件无法启动。', errorCode(error));
      }
    });
    proc.on('close', () => {
      if (musicProcess !== proc) return;
      clearTimeout(silenceTimer);
      musicProcess = undefined;
      if (musicStatus.state !== 'error') {
        setMusic('error', false, '系统音频监听已结束。请关闭开关再重新开启。', 'AUDIO_MONITOR_EXIT');
      }
    });
  }

  function update({ screenWatch, musicDance, shown, interval = 10, target = null, revision = 0 }) {
    const startAudio = musicDance && shown && !(dance && visible);
    watch = screenWatch;
    dance = musicDance;
    visible = shown;
    const shouldWatch = watch && visible && Boolean(target);
    if (screenEnabled !== shouldWatch || screenInterval !== interval || screenTarget !== target || screenRevision !== revision) {
      generation++;
      screenEnabled = shouldWatch;
      screenInterval = interval;
      screenTarget = target;
      screenRevision = revision;
      clearInterval(screenTimer);
      controller?.abort();
      controller = undefined;
      pendingFrame = undefined;
      previous = emptyObservation();
      if (shouldWatch) {
        screenStatus = { state: 'waiting' };
        screenTimer = setInterval(tick, screenInterval * 1000);
        void tick();
      }
    }
    if (!shouldWatch) {
      screenStatus = watch
        ? { state: 'paused', ...(!target && { detail: '当前接入方式无法处理截图。' }) }
        : { state: 'off' };
      onStatus(status());
    }
    if (startAudio) {
      startMusic();
    } else if (!(dance && visible)) {
      clearTimeout(silenceTimer);
      const proc = musicProcess;
      musicProcess = undefined;
      proc?.kill();
      setMusic(dance ? 'paused' : 'off');
    }
  }

  return { status, update, observe };
}
