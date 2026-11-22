import { readFile, rename, writeFile } from 'node:fs/promises';
import { ControlError } from '../lib/control.js';
import { defaultSpeakingStyle, isSpeakingStyle } from './speech-motion.js';
import { defaultScreenInterval, normalizeScreenInterval, themes } from './preferences.js';

export const defaultScale = 68;
export const minScale = 40;
export const maxScale = 110;
const defaultSettings = { theme: 'default', speakingStyle: defaultSpeakingStyle, scale: defaultScale, view: 'full', modelPath: null, clickThrough: false, screenWatch: false,
  screenInterval: defaultScreenInterval, musicDance: false };

export function isScale(value) {
  return Number.isInteger(value) && value >= minScale && value <= maxScale;
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
      musicDance: settings?.musicDance === true,
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
  const config = await readConfig(path, defaults, 'CHARACTER_CONFIG', 'character.json');
  const { name, prompt, dialogue } = config ?? {};
  if (typeof name !== 'string' || !name.trim() || typeof prompt !== 'string' || !prompt.trim()) {
    throw new ControlError('CHARACTER_CONFIG', '角色配置需要填写 name 和 prompt。');
  }
  const displayName = name.trim();
  const previousNames = [defaults.name, '阿哈', '星神', 'Gemini 娘'];
  const expand = (line, templates) => {
    const legacy = templates.find(template => previousNames.some(oldName =>
      template.replaceAll('{{name}}', () => oldName) === line));
    return (legacy ?? line).replaceAll('{{name}}', () => displayName);
  };
  const lines = {};
  for (const [action, templates] of Object.entries(defaults.dialogue)) {
    const override = dialogue?.[action];
    const valid = (Array.isArray(override) ? override : [override])
      .filter(line => typeof line === 'string' && line.trim() && line.length <= 300);
    lines[action] = (valid.length ? valid : templates).map(line => expand(line.trim(), templates));
  }
  return { name: displayName, prompt: expand(prompt.trim(), [defaults.prompt]), dialogue: lines };
}
