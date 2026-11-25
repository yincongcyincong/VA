import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { ControlError } from '../lib/control.js';

const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const taskkill = join(system32, 'taskkill.exe');
const openTerminal = Buffer.from(`
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
$program = Get-Command -Name $data.command -CommandType Application | Select-Object -First 1
if (!$program -or [IO.Path]::GetExtension($program.Source) -notin '.exe', '.com') { exit 2 }
$options = @{ FilePath = $program.Source; WorkingDirectory = $data.cwd; WindowStyle = 'Normal' }
if ($data.arguments) { $options.ArgumentList = $data.arguments }
Start-Process @options
`, 'utf16le').toString('base64');

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

// Escape a single argument according to the Windows native argv convention.
function quoteArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&') + '"';
}

export async function launchWindowsTerminal(agent, args, path) {
  const request = Buffer.from(JSON.stringify({ command: agent.command, cwd: agent.cwd,
    arguments: args.map(quoteArgument).join(' ') })).toString('base64');
  await new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', openTerminal], {
      cwd: agent.cwd, env: { ...process.env, PATH: path }, windowsHide: true, timeout: 10_000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const launchError = () => reject(new ControlError('AGENT_LAUNCH',
      `无法打开 ${agent.label} 的终端。请配置 Windows 原生可执行文件，或在终端打开会话后回到 VA 绑定。`));
    child.once('error', launchError);
    child.stdin.on('error', launchError);
    child.once('close', code => code === 0 ? resolve() : launchError());
    child.stdin.end(request + '\n');
  });
}
