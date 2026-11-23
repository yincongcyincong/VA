import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ControlError } from '../lib/control.js';

export async function installDeepSeekRole(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const profile = join(home, 'profiles', 'desktop');
  if (!(await lstat(profile).catch(() => undefined))?.isDirectory()) {
    throw new ControlError('DEEPSEEK_PROFILE', '请先打开 DeepSeek Harness 桌面端完成初始化。');
  }
  const path = join(profile, 'cordis.patch.yml');
  const pluginDir = join(profile, 'va-harness');
  const row = '    - id: va-desktop-role';
  const registration = plugin => `- insert:\n${row}\n      name: ${JSON.stringify(plugin)}\n`;
  const previousRecord = registration(join(profile, 'va-desktop-role.mjs'));
  const record = registration(join(pluginDir, 'deepseek-role.mjs'));
  const previous = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const configured = previous.includes(record);
  const migrate = previous.includes(previousRecord);
  const entries = previous.split(/\r?\n/).filter(line => line.trim() && !/^\s*#/.test(line));
  if (!configured && !migrate && (entries.some(line => /^\S/.test(line) && !/^-\s/.test(line)) ||
      /^\s*- id: va-desktop-role\s*$/m.test(previous))) {
    throw new ControlError('DEEPSEEK_PROFILE', 'DeepSeek Harness 配置使用了其他格式，无法自动添加 VA 角色能力。');
  }

  await mkdir(pluginDir, { mode: 0o700, recursive: true });
  let updated = false;
  for (const [filename, sourceFile] of [
    ['deepseek-role.mjs', 'deepseek-role.mjs'],
    ['client.js', 'deepseek-client.js'],
    ['package.json', 'deepseek-client-package.json'],
  ]) {
    const plugin = join(pluginDir, filename);
    const source = await readFile(new URL(sourceFile, import.meta.url));
    const oldSource = await readFile(plugin).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (oldSource?.equals(source)) continue;
    await replace(plugin, source);
    updated = true;
  }
  if (!configured) {
    const latest = await readFile(path, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (latest !== previous) throw new ControlError('DEEPSEEK_PROFILE', 'DeepSeek Harness 配置刚刚有改动，请重试。');
    await replace(path, migrate ? previous.replace(previousRecord, record) :
      (previous && !previous.endsWith('\n') ? previous + '\n' : previous) + record);
  }
  return { restart: !configured || updated };
}

async function replace(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
