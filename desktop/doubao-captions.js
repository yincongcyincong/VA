import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createDoubaoCaptions({ binary, onState, onCaption, onLevel, getCandidates, onAction, onInput, launch = spawn }) {
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
    start({ autoActions, listen = false, micStatus = '' }) {
      if (child) return view;
      const flags = [...(autoActions ? ['--actions'] : []), ...(listen ? ['--listen'] : [])];
      const current = launch(binary, flags, { stdio: ['pipe', 'pipe', 'ignore'] });
      child = current;
      let canDecide = false;
      let requestId = 0;
      let pending;
      current.stdin.on('error', () => { canDecide = false; });
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
          const final = event.final === true;
          const handled = onCaption(text, final);
          if (final && handled && pending) pending.stale = true;
          if (final && autoActions && canDecide && !handled && !pending) {
            const candidates = getCandidates();
            if (candidates.actions.length || candidates.expressions.length) {
              pending = { id: ++requestId, at: Date.now() };
              current.stdin.write(JSON.stringify({ id: pending.id, text: text.slice(-500), ...candidates }) + '\n');
            }
          }
          update({ text, heardAudio: true, message: '正在显示豆包的语音字幕。' });
        } else if (event?.type === 'audio') {
          update({ heardAudio: true, message: '已收到豆包音频，正在识别…' });
        } else if (event?.type === 'level' && Number.isFinite(event.value)) {
          onLevel(Math.min(.95, Math.max(0, event.value)));
        } else if (['loading', 'ready'].includes(event?.type)) {
          if (event.type === 'ready') {
            canDecide = event.actions === true;
            update({ phase: 'active', message: view.heardAudio ? view.message : event.message });
          } else {
            update({ message: event.message });
          }
        } else if (event?.type === 'error') {
          stop(event.message);
        } else if (event?.type === 'action-choice' && pending && pending.id === event.id) {
          const fresh = !pending.stale && Date.now() - pending.at < 8000;
          pending = undefined;
          if (fresh && autoActions && view.phase === 'active') onAction(event);
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
