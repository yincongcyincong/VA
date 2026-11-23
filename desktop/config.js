import { readFile, rename, writeFile } from 'node:fs/promises';
import { ControlError } from '../lib/control.js';
import { defaultSpeakingStyle, isSpeakingStyle } from './speech-motion.js';
import { defaultScreenInterval, normalizeScreenInterval, themes } from './preferences.js';

export const defaultScale = 68;
export const minScale = 40;
export const maxScale = 110;
export const rolePromptLimit = 32_000;
export const defaultRoleBackground = '你是住在用户桌面上的{{name}}。你喜欢热闹和玩笑，语气俏皮又友好。用简短、口语化的中文说话，回应用户当下的请求。台词控制在一两句话，直接说出口，不写括号里的舞台说明。';
const defaultSettings = { theme: 'default', speakingStyle: defaultSpeakingStyle, scale: defaultScale, view: 'full', modelPath: null, clickThrough: false, screenWatch: false,
  screenInterval: defaultScreenInterval, musicDance: false };

export function isScale(value) {
  return Number.isInteger(value) && value >= minScale && value <= maxScale;
}

export function clampAvatarPosition({ x, y }, { width, height }, workArea) {
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
  };
}

export function restoreAvatarPosition(position, size, workArea) {
  const { x, y } = position;
  const { width, height } = size;
  const visibleWidth = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
  const visibleHeight = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y);
  if (visibleWidth >= Math.min(48, width) && visibleHeight >= Math.min(48, height)) return position;
  return clampAvatarPosition(position, size, workArea);
}

export async function readSettings(path) {
  try {
    const settings = JSON.parse(await readFile(path, 'utf8'));
    return {
      theme: themes.includes(settings?.theme) ? settings.theme : 'default',
      speakingStyle: isSpeakingStyle(settings?.speakingStyle) ? settings.speakingStyle : defaultSpeakingStyle,
      scale: isScale(settings?.scale) ? settings.scale : defaultScale,
      view: settings?.view === 'portrait' ? 'portrait' : 'full',
      modelPath: typeof settings?.modelPath === 'string' ? settings.modelPath : null,
      clickThrough: settings?.clickThrough === true,
      screenWatch: settings?.screenWatch === true,
      screenInterval: normalizeScreenInterval(settings?.screenInterval),
      screenSource: settings?.screenSource,
      musicDance: settings?.musicDance === true,
      windowPosition: Number.isSafeInteger(settings?.windowPosition?.x) && Number.isSafeInteger(settings?.windowPosition?.y)
        ? { x: settings.windowPosition.x, y: settings.windowPosition.y } : undefined,
      rolePrompt: typeof settings?.rolePrompt === 'string' && settings.rolePrompt.trim()
        ? settings.rolePrompt.trim() : undefined,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('VA settings:', error.message);
    return { ...defaultSettings };
  }
}

export function settingsWriter(path) {
  let last = Promise.resolve();
  return settings => {
    const data = JSON.stringify(settings, null, 2) + '\n';
    last = last.catch(() => {}).then(async () => {
      const temp = path + '.tmp';
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, path);
    });
    return last;
  };
}

export async function readConfig(path, defaults, code, name) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      await writeFile(path, JSON.stringify(defaults, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        .catch(writeError => { if (writeError.code !== 'EEXIST') throw writeError; });
      return await readConfig(path, defaults, code, name);
    }
    throw new ControlError(code, `无法读取 ${name}，请检查文件权限和 JSON 格式。`);
  }
}

export async function readCharacter(path, defaults) {
  return parseCharacter(await readConfig(path, defaults, 'CHARACTER_CONFIG', 'character.json'), defaults);
}

export function parseCharacter(config, defaults) {
  const { name, prompt, dialogue } = config ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    throw new ControlError('CHARACTER_CONFIG', '角色配置需要填写 name。');
  }
  const displayName = name.trim() === 'Gemini 娘' ? 'Gemini' : name.trim();
  const previousNames = [defaults.name, '阿哈', '星神', 'Gemini', 'Gemini 娘'];
  const expand = (line, templates) => {
    const legacy = templates.find(template => previousNames.some(oldName =>
      template.replaceAll('{{name}}', () => oldName) === line));
    return (legacy ?? line).replaceAll('{{name}}', () => displayName);
  };
  const actions = new Set([...Object.keys(defaults.dialogue), ...Object.keys(dialogue ?? {})]);
  const lines = Object.fromEntries([...actions].map(action => {
    const templates = Object.hasOwn(defaults.dialogue, action) ? defaults.dialogue[action] : [];
    const override = dialogue?.[action];
    const valid = (Array.isArray(override) ? override : [override])
      .filter(line => typeof line === 'string' && line.trim() && line.length <= 300);
    return [action, (valid.length ? valid : templates).map(line => expand(line.trim(), templates))];
  }));
  const background = defaults.prompt ?? defaultRoleBackground;
  return { name: displayName, prompt: expand(typeof prompt === 'string' && prompt.trim() ? prompt.trim() : background,
    [background]), dialogue: lines };
}
