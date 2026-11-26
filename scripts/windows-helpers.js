import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildWindowsDoubaoHelper(output) {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上构建豆包客户端助手。');
  const framework = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const source = fileURLToPath(new URL('../native/WindowsDoubaoClient.cs', import.meta.url));
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/optimize+', '/codepage:65001',
    `/out:${output}`, '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => `/reference:${join(framework, 'WPF', name)}`), source],
  { stdio: 'inherit', windowsHide: true });
  return output;
}

export function buildWindowsDoubaoCaptions(output) {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上构建通话字幕助手。');
  const framework = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const source = fileURLToPath(new URL('../native/WindowsDoubaoCaptions.cs', import.meta.url));
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/codepage:65001',
    `/out:${output}`, '/reference:System.Web.Extensions.dll', `/reference:${join(framework, 'WPF', 'System.Speech.dll')}`, source],
  { stdio: 'inherit', windowsHide: true });
  return output;
}
