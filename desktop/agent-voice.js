import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createAgentVoice({ binary, send, onState, launch = spawn, resumeDelay = 450 }) {
  let target;
  let child;
  let sending = false;
  let playing = false;
  let retry;
  let view = { enabled: false, text: '', message: '', problem: '' };

  function update(change) {
    view = { ...view, ...change, enabled: Boolean(target) };
    onState(view);
    return view;
  }

  function release() {
    clearTimeout(retry);
    retry = undefined;
    const current = child;
    child = undefined;
    if (current) {
      current.stdin.destroy();
      current.kill();
    }
  }

  function stop(problem = '') {
    target = undefined;
    release();
    return update({ text: '', message: '', problem });
  }

  function resume() {
    if (!target || child || sending || playing || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      listen();
    }, resumeDelay);
    retry.unref();
  }

  async function forward(text) {
    const recipient = target;
    sending = true;
    release();
    update({ text, message: '正在发送给本地 Agent…', problem: '' });
    try {
      await send(text, recipient);
      if (target === recipient) update({ message: '已发送。等待角色回复结束。' });
    } catch (error) {
      if (target !== recipient) return;
      if (['AGENT_SESSION_CHANGED', 'AGENT_SESSION_ARCHIVED', 'INTEGRATION_MODE', 'DEEPSEEK_RESTART'].includes(error.code)) stop(error.message);
      else update({ problem: error.message });
    } finally {
      sending = false;
      resume();
    }
  }

  function listen() {
    if (!target || child || sending || playing) return;
    const current = launch(binary, ['--agent-microphone'], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = current;
    current.stdin.on('error', () => {});
    current.on('error', () => { if (child === current) stop('无法启动本机语音输入组件。'); });
    current.on('close', () => { if (child === current) stop('本机语音输入已结束，请重新开启。'); });
    const lines = createInterface({ input: current.stdout, crlfDelay: Infinity });
    update({ message: '正在启动本机语音识别…' });
    lines.on('line', line => {
      if (child !== current || !target) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === 'error') stop(event.message);
      if (['loading', 'ready'].includes(event?.type)) update({ message: event.message });
      if (event?.type !== 'user-input' || typeof event.text !== 'string') return;
      const text = event.text.trim().slice(0, 2000).toWellFormed();
      if (text) void forward(text);
    });
  }

  return {
    state: () => view,
    start(session) {
      if (!target) {
        target = session;
        update({ text: '', message: '等待麦克风就绪…', problem: '' });
        listen();
      }
      return view;
    },
    stop,
    setPlayback(value) {
      if (playing === value) return;
      playing = value;
      if (!playing) { resume(); return; }
      if (target) {
        release();
        update({ message: 'VA 正在说话，语音输入已暂停。' });
      }
    },
  };
}
