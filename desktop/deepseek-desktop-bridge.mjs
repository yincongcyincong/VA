import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { constants } from 'node:fs';
import { join } from 'node:path';

const socketName = /^dsh-[a-f0-9]{24}\.sock$/u;
const requestLimit = 16 * 1024;
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const sessionIdPattern = new RegExp('^session-' + uuid + '$', 'iu');
const requestIdPattern = new RegExp('^' + uuid + '$', 'iu');
const uid = process.getuid?.();
const defaultDirectory = '/tmp/va-desktop-' + uid;
const error = (code, message) => Object.assign(new Error(message), { code });
const restart = () => error('DEEPSEEK_RESTART', '请在 VA 同步 DeepSeek 角色能力，退出并重新打开 DeepSeek Harness，再开启监听。');

async function verifyDirectory(directory) {
  const info = await lstat(directory).catch(() => undefined);
  if (uid === undefined || !info?.isDirectory() || info.uid !== uid || (info.mode & 0o077)) throw restart();
}

export async function continueDesktopTurn(controller, input, signal) {
  const { requestId, sessionId, message } = input;
  const state = await controller.state({ sessionId }, signal);
  if (state.running || state.pendingInput?.length || state.queue?.length) {
    throw error('AGENT_BUSY', '这条 DeepSeek 会话正在处理消息，请稍后再试。');
  }
  // Subscribe before sending and match the durable request ID to its turn.
  const stream = controller.observeEvent({ address: { kind: 'session', sessionId } }, signal);
  try {
    if ((await stream.next()).value?.type !== 'ready') throw restart();
    const receipt = await controller.prompt({ sessionId, requestId, mode: 'queue',
      content: [{ type: 'text', text: message }] }, signal);
    if (receipt?.accepted !== true) throw error('AGENT_FAILED', 'DeepSeek 未确认接收消息。');
    let turn;
    let requestedTurn;
    let reply;
    while (true) {
      const frame = await stream.next();
      if (frame.done) throw error('AGENT_FAILED', 'DeepSeek 会话事件流已关闭。');
      const { type, data } = frame.value.event ?? {};
      if (type === 'turn/start') turn = data?.turn;
      if (type === 'user/message' && data?.source?.rpcId === requestId && Number.isSafeInteger(turn)) {
        requestedTurn = turn;
      }
      if (requestedTurn === undefined || data?.turn !== requestedTurn) continue;
      if (type === 'assistant/message') {
        const content = data.message?.content ?? [];
        reply = content.some(part => part.type === 'tool-call') ? '' :
          content.filter(part => part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text).join('\n').trim();
      }
      if (type === 'turn/end') {
        if (data.reason?.kind !== 'completed' || !reply) throw error('AGENT_FAILED', 'DeepSeek 本轮未返回完整回复。');
        return { reply, sessionId };
      }
    }
  } finally {
    await stream.return();
  }
}

export async function startDeepSeekDesktopBridge(controller, directory = defaultDirectory) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await verifyDirectory(directory);
  const name = 'dsh-' + randomBytes(12).toString('hex') + '.sock';
  const endpoint = join(directory, 'deepseek.endpoint');
  const staging = join(directory, name + '.endpoint');
  const sockets = new Set();
  const busy = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(75_000)]);
    socket.once('close', () => { sockets.delete(socket); abort.abort(); });
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.setTimeout(80_000, () => socket.destroy());
    let input = '';
    socket.on('data', async function receive(chunk) {
      input += chunk;
      const end = input.indexOf('\n');
      if (Buffer.byteLength(input) > requestLimit) { socket.destroy(); return; }
      if (end === -1) return;
      socket.off('data', receive);
      let sessionId;
      try {
        const request = JSON.parse(input.slice(0, end));
        if (!sessionIdPattern.test(request?.sessionId ?? '') || !requestIdPattern.test(request?.requestId ?? '') ||
            typeof request?.message !== 'string' || !request.message.trim() || request.message.length > 2200) {
          throw error('INVALID_REQUEST', 'DeepSeek 桌面会话请求无效。');
        }
        if (busy.has(request.sessionId)) throw error('AGENT_BUSY', '这条 DeepSeek 会话正在处理消息，请稍后再试。');
        sessionId = request.sessionId;
        busy.add(sessionId);
        const result = await continueDesktopTurn(controller, request, signal);
        socket.end(JSON.stringify({ ok: true, ...result }) + '\n');
      } catch (failure) {
        socket.end(JSON.stringify({ ok: false, code: failure.code || 'AGENT_FAILED', message: failure.message }) + '\n');
      } finally {
        if (sessionId) busy.delete(sessionId);
      }
    });
  });
  const close = () => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(directory, name), resolve);
  });
  try {
    await writeFile(staging, name, { flag: 'wx', mode: 0o600 });
    await rename(staging, endpoint);
  } catch (failure) {
    await close();
    throw failure;
  } finally {
    await rm(staging, { force: true });
  }
  return close;
}

export async function requestDeepSeekDesktopTurn(input, signal, directory = defaultDirectory) {
  signal.throwIfAborted();
  await verifyDirectory(directory);
  const handle = await open(join(directory, 'deepseek.endpoint'), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => { throw restart(); });
  let name;
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) || file.size > 64) throw restart();
    name = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  if (!socketName.test(name)) throw restart();
  const path = join(directory, name);
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isSocket() || info.uid !== uid) throw restart();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, signal });
    let output = '';
    const fail = problem => { reject(problem); socket.destroy(); };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ ...input, requestId: randomUUID() }) + '\n'));
    socket.once('error', problem => fail(signal.aborted ? signal.reason :
      ['ENOENT', 'ECONNREFUSED'].includes(problem.code) ? restart() : error('AGENT_FAILED', '无法连接 DeepSeek 桌面会话。')));
    socket.once('close', () => reject(error('AGENT_FAILED', 'DeepSeek 桌面会话在回复前断开。')));
    socket.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 1024 * 1024) return fail(error('AGENT_OUTPUT', 'DeepSeek 回复过长。'));
      const end = output.indexOf('\n');
      if (end === -1) return;
      try {
        const result = JSON.parse(output.slice(0, end));
        if (!result.ok) return fail(error(result.code || 'AGENT_FAILED', result.message || 'DeepSeek 会话发送失败。'));
        if (result.sessionId !== input.sessionId || typeof result.reply !== 'string' || !result.reply.trim()) {
          return fail(error('AGENT_OUTPUT', 'DeepSeek 返回了无效或不一致的会话回复。'));
        }
        resolve({ reply: result.reply, sessionId: result.sessionId });
        socket.destroy();
      } catch {
        fail(error('AGENT_OUTPUT', 'DeepSeek 桌面会话响应无效。'));
      }
    });
  });
}
