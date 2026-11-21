import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ControlError, request } from './control.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

async function available() {
  try {
    return await request({ type: 'status' });
  } catch (error) {
    if (error.code !== 'NOT_RUNNING') throw error;
  }
}

export async function startDesktop({ hidden = false } = {}) {
  const platform = process.platform;
  if (!['darwin', 'win32'].includes(platform)) {
    throw new ControlError('UNSUPPORTED_PLATFORM', 'VA 桌面版支持 macOS 和 Windows。');
  }
  let status = await available();
  let launchError;
  if (!status) {
    const bundle = join(root, 'dist', 'VA-' + platform + '-' + process.arch);
    const executable = platform === 'win32' ? join(bundle, 'VA.exe') : join(bundle, 'VA.app', 'Contents', 'MacOS', 'VA');
    const hasBundle = await access(executable).then(() => true, () => false);
    const args = hidden ? ['--va-hidden'] : [];
    const launch = { cwd: root, env: { ...process.env, VA_START_CWD: process.cwd() }, stdio: 'ignore', detached: true };
    const child = hasBundle
      ? spawn(executable, args, launch)
      : spawn(process.execPath, [require.resolve('electron/cli.js'), '.', ...args], launch);
    child.on('error', error => { launchError = error; });
    child.once('exit', code => {
      if (code) launchError = new ControlError('LAUNCH_FAILED', 'VA 无法启动。运行 npm start 可查看启动日志。');
    });
    child.unref();
  }
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && (!status || status.state === 'loading')) {
    if (launchError) throw launchError;
    await setTimeout(220);
    status = await available();
  }
  if (status?.state !== 'ready') {
    throw new ControlError('NOT_READY', status?.detail || 'VA 未准备就绪。运行 npm start 可查看启动日志。');
  }
  return hidden ? status : { ...status, ...await request({ type: 'show' }) };
}

export async function takeSelfie(options) {
  const command = { type: 'selfie', ...options };
  try {
    return await request(command);
  } catch (error) {
    if (!['NOT_RUNNING', 'NOT_READY'].includes(error.code)) throw error;
    await startDesktop({ hidden: true });
    return await request(command);
  }
}
