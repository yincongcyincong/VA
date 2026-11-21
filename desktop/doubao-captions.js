import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createDoubaoCaptions({ binary, onState, onCaption, onLevel, onDance, onInput, launch = spawn }) {
  let child;
  let view = { phase: 'idle', message: '', text: '', heardAudio: false };

  function update(change) {
    view = { ...view, ...change };
    onState(view);
  }

  function stop(message = '') {
    const current = child;
    child = undefined;
    if (current?.exitCode === null && current.signalCode === null) {
      current.kill();
      const deadline = setTimeout(() => {
        if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL');
      }, 1500);
      deadline.unref();
      current.once('exit', () => clearTimeout(deadline));
    }
    onCaption('', true);
    onLevel(null);
    update({ phase: 'idle', text: '', message, heardAudio: false, micStatus: '' });
  }

  return {
    state: () => view,
    running: () => Boolean(child),
    stop,
    start({ dance, listen = false, micStatus = '' }) {
      if (child) return view;
      const flags = [...(dance ? ['--dance'] : []), ...(listen ? ['--listen'] : [])];
      const current = launch(binary, flags, { stdio: ['ignore', 'pipe', 'ignore'] });
      child = current;
      update({ phase: 'starting', message: '正在启动本机转写…', text: '', heardAudio: false, micStatus });
      current.on('error', () => {
        if (child === current) stop('无法启动豆包字幕组件。');
      });
      current.on('close', code => {
        if (child === current) stop(code === 0 ? '本机转写已结束。' : '本机转写中断，请重新开启字幕。');
      });
      const lines = createInterface({ input: current.stdout });
      lines.on('line', line => {
        if (child !== current) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.type === 'caption' && typeof event.text === 'string') {
          const text = event.text.slice(0, 2000);
          onCaption(text, event.final === true);
          update({ text, heardAudio: true, message: '正在显示豆包的语音字幕。' });
        } else if (event?.type === 'audio') {
          update({ heardAudio: true, message: '已收到豆包音频，正在识别…' });
        } else if (event?.type === 'level' && Number.isFinite(event.value)) {
          onLevel(Math.min(.95, Math.max(0, event.value)));
        } else if (['loading', 'ready', 'dance-error'].includes(event?.type)) {
          if (event.type === 'ready') {
            update({ phase: 'active', message: view.heardAudio ? view.message : event.message });
          } else {
            update({ message: event.message });
          }
        } else if (event?.type === 'error') {
          stop(event.message);
        } else if (event?.type === 'dance' && dance && view.phase === 'active') {
          onDance();
        } else if (event?.type === 'user-input' && listen && typeof event.text === 'string') {
          onInput(event.text);
        } else if (event?.type === 'mic-status' && listen) {
          update({ micStatus: event.message });
        }
      });
      return view;
    },
  };
}
