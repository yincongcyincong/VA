import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const windows = process.platform === 'win32';
const loopback = '127.0.0.1';
const controlDir = windows
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VA Desktop IPC')
  : join('/tmp', 'va-desktop-' + process.getuid());
const socketPath = join(controlDir, 'control.sock');
const connectionFile = join(controlDir, 'connection.json');
const isToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const maxRequestBytes = 8192;
const maxResponseBytes = 32 * 1024 * 1024;
const timeout = 90_000;

export class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function verifyDirectory() {
  const info = await lstat(controlDir);
  if (windows) {
    if (!info.isDirectory()) throw new ControlError('UNSAFE_SOCKET', 'VA 控制目录不可用。');
    return;
  }
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new ControlError('UNSAFE_SOCKET', 'VA 控制目录的权限必须为 0700，且属于当前用户。');
  }
}

async function removeStaleSocket() {
  const previous = await lstat(socketPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid()) {
      throw new ControlError('UNSAFE_SOCKET', 'VA 控制路径已经被其他文件占用。');
    }
    const inUse = await new Promise(resolve => {
      const probe = createConnection(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => resolve(error.code !== 'ECONNREFUSED'));
    });
    if (inUse) throw new ControlError('ALREADY_RUNNING', 'VA 控制接口已在运行。');
    await rm(socketPath);
  }
}

export async function startControl(handler) {
  await mkdir(controlDir, { mode: 0o700, recursive: true });
  await verifyDirectory();
  if (!windows) await removeStaleSocket();
  const token = windows ? randomBytes(32) : undefined;
  const server = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async function read(chunk) {
      input += chunk;
      if (Buffer.byteLength(input) > maxRequestBytes) {
        socket.end(JSON.stringify({ ok: false, error: {
          code: 'REQUEST_TOO_LARGE', message: 'VA 命令过长。',
        } }) + '\n');
        socket.off('data', read);
        return;
      }
      const end = input.indexOf('\n');
      if (end === -1) return;
      socket.off('data', read);
      let reply;
      try {
        let command;
        try {
          command = JSON.parse(input.slice(0, end));
        } catch {
          throw new ControlError('INVALID_REQUEST', '请求必须是一行 JSON。');
        }
        if (token) {
          if (!isToken(command?.token) || !timingSafeEqual(token, Buffer.from(command.token, 'hex'))) {
            throw new ControlError('CONTROL_AUTH', 'VA 控制请求未通过验证。');
          }
          command = command.command;
        }
        reply = { ok: true, ...(await handler(command)) };
      } catch (error) {
        const code = error instanceof ControlError ? error.code : 'INTERNAL_ERROR';
        if (code === 'INTERNAL_ERROR') console.error(error);
        reply = { ok: false, error: { code, message: code === 'INTERNAL_ERROR'
          ? 'VA 命令执行失败。' : error.message } };
      }
      socket.end(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(windows ? { host: loopback, port: 0 } : { path: socketPath }, () => {
      server.off('error', reject);
      server.on('error', console.error);
      resolve();
    });
  });
  if (token) {
    const temporary = join(controlDir, 'connection-' + process.pid + '.tmp');
    try {
      await writeFile(temporary, JSON.stringify({ port: server.address().port, token: token.toString('hex') }),
        { mode: 0o600, flag: 'wx' });
      await rename(temporary, connectionFile);
    } catch (error) {
      server.close();
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  return server;
}

export async function request(command) {
  let address = { path: socketPath };
  let payload = command;
  try {
    await verifyDirectory();
    if (windows) {
      const info = await lstat(connectionFile);
      if (!info.isFile() || info.size > 512) throw new ControlError('UNSAFE_SOCKET', 'VA 控制配置不可用。');
      const { port, token } = JSON.parse(await readFile(connectionFile, 'utf8'));
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !isToken(token)) {
        throw new ControlError('UNSAFE_SOCKET', 'VA 控制配置不可用。');
      }
      address = { host: loopback, port };
      payload = { token, command };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new ControlError('NOT_RUNNING', 'VA 没有运行。请先执行 va start。');
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () => socket.destroy(new ControlError('TIMEOUT', 'VA 未在规定时间内响应。')));
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', chunk => {
      output += chunk;
      if (output.length > maxResponseBytes) {
        socket.destroy(new ControlError('RESPONSE_TOO_LARGE', 'VA 返回的数据过大。'));
      }
    });
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
        reject(new ControlError('NOT_RUNNING', 'VA 没有运行。请先执行 va start。'));
      } else {
        reject(error);
      }
    });
    socket.once('close', hadError => {
      if (hadError) return;
      try {
        const result = JSON.parse(output);
        if (!result.ok) throw new ControlError(result.error.code, result.error.message);
        const { ok, ...data } = result;
        resolve(data);
      } catch (error) {
        reject(error instanceof ControlError ? error
          : new ControlError('INVALID_RESPONSE', 'VA 控制接口返回了无效响应。'));
      }
    });
  });
}
