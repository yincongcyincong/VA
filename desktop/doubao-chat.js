const panel = document.getElementById('doubao-panel');
const form = document.getElementById('doubao-configuration');
const start = document.getElementById('doubao-start');
const stop = document.getElementById('doubao-stop');
const status = document.getElementById('doubao-status');
const history = document.getElementById('doubao-history');
const call = window.va.localChat;
const labels = { idle: '', connecting: '正在连接豆包…', active: '通话中 · 麦克风已开启', closing: '正在结束对话…' };
let config;
let state;
let capture;
let saving = false;

function controls() {
  const inCall = Boolean(capture) || (state && state.phase !== 'idle');
  start.disabled = !config?.hasKey || inCall || saving;
  stop.disabled = !inCall || state?.phase === 'closing';
  for (const field of form.elements) field.disabled = Boolean(inCall || saving);
}

function dispose(job) {
  if (job.node) job.node.port.onmessage = null;
  job.stream?.getTracks().forEach(track => track.stop());
  if (job.context && job.context.state !== 'closed') void job.context.close().catch(() => {});
}

function release() {
  const job = capture;
  capture = undefined;
  if (job) dispose(job);
}

function drawHistory(view) {
  const messages = [...view.history];
  if (view.input) messages.push({ role: 'user', text: view.input });
  if (view.reply) messages.push({ role: 'assistant', text: view.reply });
  const rows = messages.map(({ role, text }) => {
    const item = document.createElement('li');
    item.className = role === 'user' ? 'user' : 'agent';
    const author = document.createElement('small');
    const paragraph = document.createElement('p');
    author.textContent = role === 'user' ? '你' : '豆包';
    paragraph.textContent = text;
    item.append(author, paragraph);
    return item;
  });
  history.replaceChildren(...rows);
  history.scrollTop = history.scrollHeight;
}

function update(view) {
  if (view.phase === 'closing' || (view.phase === 'idle' && (capture?.id || view.error))) release();
  state = view;
  drawHistory(view);
  status.textContent = view.error || labels[view.phase] || (!config?.hasKey ? '请先配置实时语音 API Key。' : '');
  controls();
}

export function renderDoubao(profile, view, syncFields) {
  config = profile;
  panel.hidden = !profile;
  if (!profile) {
    release();
    state = undefined;
    return;
  }
  if (syncFields) {
    form.elements.voice.value = profile.voice;
    form.elements.prompt.value = profile.prompt;
    form.elements.allowDance.checked = profile.allowDance;
    form.elements.apiKey.value = '';
    form.elements.apiKey.placeholder = profile.hasKey ? '已配置，留空保留' : '火山引擎 API Key';
    form.elements.clearKey.checked = false;
    document.getElementById('doubao-clear').hidden = !profile.hasKey;
  }
  update(view);
}

function errorMessage(error) {
  if (['NotAllowedError', 'PermissionDeniedError'].includes(error.name)) {
    return '麦克风未授权。请在 macOS「隐私与安全性 → 麦克风」里允许 VA。';
  }
  if (error.name === 'NotFoundError') return '没有找到可用的麦克风。';
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const { apiKey, voice, prompt, allowDance, clearKey } = form.elements;
  saving = true;
  controls();
  try {
    const next = await call('doubao-config', { apiKey: apiKey.value, voice: voice.value, prompt: prompt.value,
      allowDance: allowDance.checked, clearKey: clearKey.checked });
    if (!config) return;
    renderDoubao(next.integration.doubao, next.doubao, true);
    status.textContent = '已保存豆包设置。';
  } catch (error) {
    status.textContent = errorMessage(error);
  } finally {
    saving = false;
    controls();
  }
});

start.addEventListener('click', async () => {
  if (start.disabled) return;
  const job = {};
  capture = job;
  controls();
  status.textContent = '正在打开麦克风…';
  try {
    job.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (capture !== job) return;
    for (const track of job.stream.getTracks()) track.addEventListener('ended', () => {
      if (capture === job) {
        release();
        void call('doubao-stop').catch(() => {});
      }
    });
    job.context = new AudioContext({ sampleRate: 16_000 });
    await job.context.audioWorklet.addModule('/doubao-mic.js');
    if (capture !== job) return;
    job.node = new AudioWorkletNode(job.context, 'doubao-microphone', { channelCount: 1 });
    const muted = job.context.createGain();
    muted.gain.value = 0;
    job.node.connect(muted).connect(job.context.destination);
    job.context.createMediaStreamSource(job.stream).connect(job.node);
    await job.context.resume();
    if (capture !== job) return;
    job.id = await call('doubao-start');
    if (capture !== job) return;
    job.node.port.onmessage = event => window.va.doubaoAudio(job.id, event.data);
  } catch (error) {
    if (capture === job) {
      release();
      status.textContent = errorMessage(error);
    }
  } finally {
    if (capture !== job) dispose(job);
    controls();
  }
});

stop.addEventListener('click', async () => {
  release();
  controls();
  try { await call('doubao-stop'); }
  catch (error) { status.textContent = errorMessage(error); }
});

window.va.onDoubaoState(view => { if (config) update(view); });
window.addEventListener('pagehide', release);
