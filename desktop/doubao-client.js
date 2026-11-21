import { execFile } from 'node:child_process';
import { ControlError } from '../lib/control.js';

export function callDoubaoClient(binary, command) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, { timeout: 5000, maxBuffer: 24_000 }, (error, stdout) => {
      if (error) {
        reject(new ControlError('CLIENT_HELPER', '无法运行豆包客户端助手。请使用新版 VA，或用 make dev 启动。'));
        return;
      }
      let result;
      try { result = JSON.parse(stdout); } catch {}
      if (!result?.ok) {
        reject(new ControlError(result?.code ?? 'CLIENT_HELPER', result?.message ?? '无法读取豆包客户端。'));
      } else {
        resolve(result.data);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(command));
  });
}

export function createDoubaoClient({ request, onChange, onReply, onInput }) {
  let binding;
  let timer;
  let pending;
  let history = [];
  let problem = '';

  function finish(error, reply) {
    if (!pending) return;
    const { resolve, reject, timeout } = pending;
    pending = undefined;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve({ reply });
    onChange();
  }

  function cancel() {
    finish(new ControlError('CANCELED', '已停止等待豆包回复。'));
  }

  function observe(bound) {
    timer = setTimeout(async () => {
      if (binding !== bound) return;
      try {
        const message = await request({ op: 'inspect', route: bound.route });
        if (binding !== bound) return;
        const changed = problem !== '';
        problem = '';
        const turn = message.userTurn;
        if (turn?.text && (turn.text !== bound.userTurn?.text || (turn.id && turn.id !== bound.userTurn?.id))) {
          bound.userTurn = turn;
          if (turn.text !== pending?.wireText) onInput(turn.text);
        }
        if (message.reply && message.reply !== bound.lastReply && (!pending || pending.delivered)) {
          bound.lastReply = message.reply;
          history = [...history, { message: pending?.message, reply: message.reply }].slice(-20);
          finish(null, message.reply);
          onReply(message.reply);
          onChange();
        } else if (changed) onChange();
      } catch (error) {
        if (binding === bound && problem !== error.message) {
          problem = error.message;
          onChange();
        }
      } finally {
        if (binding === bound) observe(bound);
      }
    }, 1000);
  }

  function unbind() {
    binding = undefined;
    clearTimeout(timer);
    problem = '';
    history = [];
    cancel();
  }

  return {
    state: () => ({ history, busy: Boolean(pending),
      client: { title: binding?.title, problem, contextSent: Boolean(binding?.context) } }),
    async bind(isActive) {
      const current = await request({ op: 'inspect' });
      if (!isActive()) throw new ControlError('CANCELED', '已取消绑定。');
      unbind();
      binding = { route: current.route, title: current.title, lastReply: current.reply, userTurn: current.userTurn };
      observe(binding);
    },
    unbind,
    cancel,
    noteDance(count, label) {
      if (binding) binding.danceNotice = { count, label };
    },
    async read() {
      if (!binding) throw new ControlError('CLIENT_ROUTE', '请先绑定豆包对话。');
      await request({ op: 'read', route: binding.route });
    },
    async send(text, { context, sync = false } = {}) {
      const bound = binding;
      if (!bound) throw new ControlError('CLIENT_ROUTE', '请先绑定豆包对话。');
      if (!sync && (typeof text !== 'string' || !text.trim() || text.length > 2200)) {
        throw new ControlError('INVALID_REQUEST', '请输入 1–2200 字的消息。');
      }
      if (pending) throw new ControlError('BUSY', '还在等豆包回复。');
      const message = sync ? '同步 VA 角色能力' : text.trim();
      const instruction = context && (sync || context !== bound.context) ? '【VA 角色能力】' + context : '';
      const notice = bound.danceNotice;
      const detail = notice
        ? `【VA 动作反馈】VA 已收到上一条跳舞请求，并在本机安排 ${notice.count} 段${notice.label ? '「' + notice.label + '」' : '舞蹈'}。`
        : '';
      const userText = sync ? '请简单确认你了解角色可以在 VA 桌面上跳舞。' : message;
      const wireText = instruction || detail
        ? [instruction, detail, '【本轮消息】' + userText].filter(Boolean).join('\n\n')
        : userText;
      const result = Promise.withResolvers();
      const job = { message, wireText, ...result, timeout: setTimeout(() => {
        finish(new ControlError('TIMEOUT', '还没读到新回复。请检查豆包对话中消息是否已发送。'));
      }, 65_000) };
      pending = job;
      void request({ op: 'send', route: bound.route, text: wireText }).then(() => {
        if (instruction) bound.context = context;
        if (bound.danceNotice === notice) bound.danceNotice = undefined;
        if (pending === job) job.delivered = true;
        onChange();
      }).catch(error => {
        if (pending === job) finish(error);
      });
      return await result.promise;
    },
  };
}
