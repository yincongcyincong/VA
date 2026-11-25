import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';

const uid = process.getuid?.();
const controlDir = uid === undefined ? undefined : join('/tmp', 'va-desktop-' + uid);
const socketPath = controlDir && join(controlDir, 'control.sock');
const windows = process.platform === 'win32';
const maxRequestBytes = 512 * 1024 + 1024;
const maxResponseBytes = 32 * 1024 * 1024;
const timeout = 90_000;

export class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function windowsEndpoint() {
  if (!process.env.APPDATA) throw new ControlError('UNSUPPORTED_PLATFORM', '找不到 Windows 用户配置目录。');
  return join(process.env.APPDATA, 'VA Desktop', 'control.endpoint');
}

function windowsPipe(id) {
  return '\\\\.\\pipe\\va-desktop-' + id;
}

async function verifyDirectory() {
  if (!controlDir) throw new ControlError('UNSUPPORTED_PLATFORM', 'VA 控制接口需要 Unix socket。');
  const info = await lstat(controlDir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077)) {
    throw new ControlError('UNSAFE_SOCKET', 'VA 控制目录的权限必须为 0700，且属于当前用户。');
  }
}

async function removeStaleSocket() {
  const previous = await lstat(socketPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== uid) {
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
  const id = windows ? randomUUID() : undefined;
  const endpoint = windows ? windowsEndpoint() : undefined;
  if (!windows) {
    if (!controlDir) throw new ControlError('UNSUPPORTED_PLATFORM', 'VA 控制接口需要 Unix socket。');
    await mkdir(controlDir, { mode: 0o700, recursive: true });
    await verifyDirectory();
    await removeStaleSocket();
  }
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
        if (command?.type !== 'configuration' && Buffer.byteLength(input.slice(0, end)) > 8192) {
          throw new ControlError('REQUEST_TOO_LARGE', 'VA 命令过长。');
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
    server.listen(windows ? windowsPipe(id) : socketPath, () => {
      server.off('error', reject);
      server.on('error', console.error);
      resolve();
    });
  });
  if (endpoint) {
    // Publish the random pipe name only in the current user's application data.
    const staging = endpoint + '.' + id;
    try {
      await mkdir(dirname(endpoint), { recursive: true });
      await writeFile(staging, id, { flag: 'wx' });
      await rename(staging, endpoint);
    } catch (error) {
      server.close();
      await rm(staging, { force: true }).catch(() => {});
      throw error;
    }
  }
  return server;
}

export async function request(command) {
  let path = socketPath;
  try {
    if (windows) {
      const id = await readFile(windowsEndpoint(), 'utf8');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) {
        throw new ControlError('UNSAFE_SOCKET', 'VA 控制路径无效。');
      }
      path = windowsPipe(id);
    } else {
      await verifyDirectory();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new ControlError('NOT_RUNNING', 'VA 没有运行。请先执行 va start。');
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () => socket.destroy(new ControlError('TIMEOUT', 'VA 未在规定时间内响应。')));
    socket.once('connect', () => socket.write(JSON.stringify(command) + '\n'));
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
