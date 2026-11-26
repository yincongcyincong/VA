// Installed as a standalone .mjs in DeepSeek's desktop profile on Windows.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'va-windows-bridge';
export const inject = ['sessionController'];

export async function bridgeTurn(controller, input, requestId, signal) {
  const { sessionId, prompt, message } = input;
  const before = await controller.state({ sessionId }, signal);
  if (!Number.isSafeInteger(before?.cursor) || before.cursor < 0) throw new Error('DeepSeek 会话游标无效。');
  if (before.running || before.pendingInput?.length || before.queue?.length) {
    throw Object.assign(new Error('这条 DeepSeek 会话正在处理消息，请稍后再说话。'), { code: 'AGENT_BUSY' });
  }
  let admitted = false;
  let completed = false;
  try {
    signal.throwIfAborted();
    const receipt = await controller.prompt({ requestId, sessionId, mode: 'queue',
      content: [{ type: 'text', text: prompt + '\n\n用户消息：\n' + message }] }, signal);
    admitted = receipt?.accepted === true;
    if (!admitted) throw new Error('DeepSeek 未确认接收消息。');
    while (true) {
      signal.throwIfAborted();
      const result = await controller.wait({ sessionId, afterSeq: before.cursor, timeoutMs: 10_000, maxMessages: 20 }, signal);
      if (result.reason === 'timeout') continue;
      // Approvals stay in the original desktop UI; this bridge never answers them.
      if (result.reason === 'input-required') { await delay(500, undefined, { signal }); continue; }
      if (result.reason !== 'idle') throw new Error('DeepSeek 返回了无效的完成状态。');
      const events = (result.output?.records ?? []).map(record => record.event)
        .filter(event => event?.seq > before.cursor && event.type === 'assistant/message')
        .sort((a, b) => b.seq - a.seq);
      const assistant = events[0]?.data?.message;
      const reply = assistant?.content?.filter(part => part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text).join('\n').trim();
      if (!reply || ['error', 'aborted'].includes(assistant.stopReason)) throw new Error('DeepSeek 本轮未返回完整回复，请在原会话查看错误。');
      completed = true;
      return { reply, sessionId };
    }
  } finally {
    if (admitted && !completed) controller.cancel({ sessionId });
  }
}

export async function startWindowsDeepSeekBridge(controller, endpoint) {
  const pipe = '\\\\.\\pipe\\va-deepseek-' + randomUUID();
  const token = randomBytes(32).toString('hex');
  const busy = new Set();
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    const canceled = new AbortController();
    const signal = AbortSignal.any([canceled.signal, AbortSignal.timeout(75_000)]);
    socket.once('close', () => { sockets.delete(socket); canceled.abort(); });
    socket.setTimeout(80_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async function receive(chunk) {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.off('data', receive);
      let sessionId;
      try {
        const request = JSON.parse(buffer.slice(0, end));
        const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
        if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) throw new Error('VA 桥接认证失败。');
        const { input, requestId } = request;
        if (!/^session-[a-f0-9-]{36}$/i.test(input?.sessionId ?? '') ||
            !/^[a-f0-9-]{36}$/i.test(requestId ?? '') || typeof input?.prompt !== 'string' || input.prompt.length > 45_000 ||
            typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 2200) throw new Error('VA 桥接请求无效。');
        if (busy.has(input.sessionId)) throw Object.assign(new Error('这条 DeepSeek 会话正在处理消息。'), { code: 'AGENT_BUSY' });
        sessionId = input.sessionId;
        busy.add(sessionId);
        const result = await bridgeTurn(controller, input, requestId, signal);
        socket.end(JSON.stringify({ ok: true, ...result }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: { code: error.code || 'AGENT_FAILED', message: error.message } }) + '\n');
      } finally { if (sessionId) busy.delete(sessionId); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  await mkdir(dirname(endpoint), { recursive: true });
  await writeFile(endpoint, JSON.stringify({ pipe, token }), { mode: 0o600 });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const current = await readFile(endpoint, 'utf8').then(JSON.parse).catch(() => undefined);
    if (current?.pipe === pipe) await rm(endpoint, { force: true });
  };
}

export async function apply(ctx, config) {
  if (process.platform !== 'win32') return;
  const close = await startWindowsDeepSeekBridge(ctx.sessionController, config.endpoint);
  ctx.on('dispose', close);
}
