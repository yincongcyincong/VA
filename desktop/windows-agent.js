import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import crossSpawn from 'cross-spawn';
import { ControlError } from '../lib/control.js';

const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const taskkill = join(system32, 'taskkill.exe');

// Wait for the normal close so the process releases its working directory. A
// descendant can keep the inherited pipes open after the parent has exited.
export function stopWindowsAgent(child, killTree = execFile) {
  return new Promise(resolve => {
    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(); } catch {}
    };
    const complete = () => {
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      child.off('close', complete);
      killChild();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      complete();
    }, 5500);
    child.once('close', complete);
    try {
      killTree(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 },
        error => { if (error) killChild(); });
    } catch {
      killChild();
    }
  });
}

export async function openWindowsDeepSeekDesktop({ openPath, env = process.env } = {}) {
  const candidates = [
    env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'),
    env.ProgramData && join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'),
    env.USERPROFILE && join(env.USERPROFILE, 'Desktop', 'DeepSeek Harness.lnk'),
    ...[env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter(Boolean).flatMap(directory => ['DeepSeekHarness', 'DeepSeek Harness'].flatMap(folder =>
        ['DeepSeekHarness.exe', 'DeepSeek Harness.exe'].map(file => join(directory, folder, file)))),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!(await stat(candidate).catch(() => undefined))?.isFile()) continue;
    try {
      const open = openPath ?? (await import('electron')).shell.openPath;
      if (await open(candidate) === '') return true;
    } catch { /* Try another installed entry, then let the caller use dsh web. */ }
  }
  return false;
}

export async function launchWindowsTerminal(agent, args, path, { launch = crossSpawn, freshOmp = false } = {}) {
  const extensions = ['.com', '.exe', '.bat', '.cmd'];
  const directories = isAbsolute(agent.command) || /[\\/]/u.test(agent.command)
    ? [''] : [agent.cwd, ...path.split(delimiter).filter(Boolean)];
  const suffixes = extname(agent.command) ? [''] : extensions;
  let executable;
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(agent.cwd, directory, agent.command + suffix);
      if (extensions.includes(extname(candidate).toLowerCase()) &&
          (await stat(candidate).catch(() => undefined))?.isFile()) {
        executable = candidate;
        break;
      }
    }
    if (executable) break;
  }
  if (!executable) throw new ControlError('AGENT_LAUNCH',
    `找不到 ${agent.label} 的启动命令「${agent.command}」。请检查安装位置或配置 .exe、.com、.cmd、.bat 的完整路径。`);

  let folder;
  const terminalArgs = [...args];
  try {
    const promptIndex = ['claude', 'omp'].includes(agent.provider) ? terminalArgs.indexOf('--append-system-prompt') : -1;
    if (freshOmp || promptIndex >= 0) {
      folder = await mkdtemp(join(tmpdir(), 'va-windows-agent-'));
    }
    if (promptIndex >= 0 && typeof terminalArgs[promptIndex + 1] === 'string') {
      const promptFile = join(folder, 'role-prompt.txt');
      await writeFile(promptFile, terminalArgs[promptIndex + 1], { mode: 0o600 });
      terminalArgs[promptIndex + 1] = promptFile;
      if (agent.provider === 'claude') terminalArgs[promptIndex] = '--append-system-prompt-file';
    }
    if (['.cmd', '.bat'].includes(extname(executable).toLowerCase()) && terminalArgs.some(arg => /[\r\n]/u.test(arg))) {
      throw new ControlError('AGENT_LAUNCH', 'Windows 终端不能通过 CMD/BAT 可靠传入多行参数，请使用支持提示词文件的 Agent。');
    }
    if (freshOmp) {
      const overlay = join(folder, 'new-session.yml');
      await writeFile(overlay, 'autoResume: false\n', { mode: 0o600 });
      terminalArgs.push('--config', overlay);
    }
    await new Promise((resolve, reject) => {
      // A detached Windows process gets its own console. cross-spawn handles
      // command shims and argument escaping, including npm's .cmd entry points.
      const child = launch(executable, terminalArgs, {
        cwd: agent.cwd, env: { ...process.env, PATH: path },
        detached: true, windowsHide: false, stdio: 'ignore',
      });
      if (folder) child.once('close', () => { void rm(folder, { recursive: true, force: true }).catch(() => {}); });
      child.once('error', () => reject(new ControlError('AGENT_LAUNCH',
        `无法打开 ${agent.label} 的终端，请检查启动命令「${agent.command}」是否能在 Windows 终端正常运行。`)));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch (error) {
    if (folder) await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
