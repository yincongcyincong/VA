import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ControlError } from '../lib/control.js';
import { analyzeScreen, visionSettings } from './vision-agent.js';

const audioSilence = 3600;
const emptyObservation = () => ({ activity: '', speech: '' });

export function createSenses({ audioHelper, getAgentConfig, getCharacter, captureScreen, localObserve, onScreen, onMusic, onStatus }) {
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

  function setMusic(state, detected = false, detail) {
    if (state === musicStatus.state && detected === musicStatus.detected && detail === musicStatus.detail) return;
    const changed = detected !== musicStatus.detected;
    musicStatus = { state, detected, ...(detail && { detail }) };
    onStatus(status());
    if (changed) onMusic(detected);
  }

  async function observe() {
    if (!screenEnabled) {
      throw new ControlError('SCREEN_DISABLED', '请先显示 VA 并开启「定时看屏幕」。');
    }
    const frame = await captureScreen();
    if (!screenEnabled) throw new ControlError('SCREEN_DISABLED', '屏幕观察已关闭。');
    return frame;
  }

  async function tick() {
    if (!screenEnabled) return;
    setScreen({ nextCaptureAt: new Date(Date.now() + screenInterval * 1000).toISOString() });
    if (capturing !== undefined) return;
    const started = generation;
    capturing = started;
    try {
      const frame = await observe();
      if (started !== generation) return;
      pendingFrame = frame;
      setScreen({ lastCapturedAt: frame.capturedAt });
      void analyzeLatest();
    } catch (error) {
      if (started === generation) setScreen({ state: 'error', detail: error.message });
    } finally {
      if (capturing === started) capturing = undefined;
    }
  }

  async function analyzeLatest() {
    if (!screenEnabled || controller || !pendingFrame) return;
    const frame = pendingFrame;
    pendingFrame = undefined;
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    setScreen({ state: 'analyzing', detail: undefined });
    try {
      const local = screenTarget === 'local' ? localObserve : undefined;
      const [settings, character] = await Promise.all([
        local ? undefined : getAgentConfig().then(visionSettings), getCharacter(),
      ]);
      signal.throwIfAborted();
      const result = await analyzeScreen(settings, character, frame, previous, signal, local);
      signal.throwIfAborted();
      const { activity, speech } = result;
      const newLine = speech && speech !== previous.speech;
      previous = { activity, speech: speech || previous.speech };
      setScreen({ state: 'waiting', lastActivity: activity, checkedAt: frame.capturedAt });
      if (newLine) onScreen(speech);
    } catch (error) {
      if (!signal.aborted) setScreen({ state: 'error', detail: error.message });
    } finally {
      if (controller === current) {
        controller = undefined;
        void analyzeLatest();
      }
    }
  }

  function startMusic() {
    high = low = 0;
    setMusic('starting');
    const proc = spawn(audioHelper, [String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
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
        setMusic('error', false, message.message);
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
          : '系统音频组件无法启动。');
      }
    });
    proc.on('close', () => {
      if (musicProcess !== proc) return;
      clearTimeout(silenceTimer);
      musicProcess = undefined;
      if (musicStatus.state !== 'error') {
        setMusic('error', false, '系统音频监听已结束。请关闭开关再重新开启。');
      }
    });
  }

  function update({ screenWatch, musicDance, shown, interval = 10, target = 'vision', revision = 0 }) {
    const startAudio = musicDance && shown && !(dance && visible);
    watch = screenWatch;
    dance = musicDance;
    visible = shown;
    const shouldWatch = watch && visible;
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
      screenStatus = { state: watch ? 'paused' : 'off' };
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
