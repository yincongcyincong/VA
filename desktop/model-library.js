import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ControlError } from '../lib/control.js';
import { settingsWriter } from './config.js';

export const modelSources = {
  aplaybox: 'https://www.aplaybox.com/',
  vroid: 'https://hub.vroid.com/en',
};
const localAhaName = '星神';
export const coverName = 'VA 封面角色';

const packEntry = /^\d{2}_(.+)_V\d+$/u;
const packFormats = { 'model.vrm': 'VRM', 'model.glb': 'GLB' };

export function aiGirlName(id) {
  const name = id.match(packEntry)?.[1];
  return name === 'Gemini 娘' ? 'Gemini' : name;
}

export function modelPage(value) {
  if (typeof value !== 'string' || value.length > 2000) {
    throw new ControlError('MODEL_LINK', '请粘贴模之屋或 VRoid Hub 的模型详情链接。');
  }
  let url;
  try { url = new URL(value.trim()); } catch {}
  if (url?.protocol === 'https:' && !url.username && !url.password && !url.port) {
    if (['www.aplaybox.com', 'aplaybox.com'].includes(url.hostname) &&
        /^\/details\/model\/[a-z0-9_-]+\/?$/iu.test(url.pathname)) {
      return 'https://www.aplaybox.com' + url.pathname;
    }
    if (url.hostname === 'hub.vroid.com' &&
        /^\/(?:[a-z]{2}\/)?characters\/\d+\/models\/\d+\/?$/u.test(url.pathname)) {
      return url.origin + url.pathname;
    }
  }
  throw new ControlError('MODEL_LINK', '请粘贴模之屋或 VRoid Hub 的 HTTPS 模型详情链接。');
}

export function createModelLibrary(manifest, { bundledPack, coverModel, localAha }) {
  const save = settingsWriter(manifest);
  let importing = false;

  async function currentEntries() {
    const pack = await readFile(manifest, 'utf8').then(JSON.parse).catch(() => undefined);
    if (typeof pack?.folder !== 'string' || !isAbsolute(pack.folder) || !Array.isArray(pack.models)) return [];
    const entries = await Promise.all(pack.models.map(async model => {
      const label = typeof model?.id === 'string' && aiGirlName(model.id);
      if (!label || /[/\\]/u.test(model.id)) return;
      const filename = model.file ?? 'model.glb';
      if (typeof filename !== 'string' || !Object.hasOwn(packFormats, filename)) return;
      const path = join(pack.folder, model.id, filename);
      if (await realpath(path).catch(() => undefined) !== path) return;
      const file = await lstat(path).catch(() => undefined);
      if (!file?.isFile() || file.size !== model.size || file.mtimeMs !== model.modified) return;
      return { path, id: model.id, label, size: file.size, format: packFormats[filename],
        rigged: model.rigged, mouthSync: model.mouthSync };
    }));
    return entries.filter(Boolean);
  }

  async function bundledEntries() {
    if (!bundledPack) return [];
    const folders = await readdir(bundledPack, { withFileTypes: true }).catch(() => []);
    const entries = await Promise.all(folders.sort((a, b) => a.name.localeCompare(b.name)).map(async folder => {
      const id = folder.name;
      const label = aiGirlName(id);
      if (!label || !folder.isDirectory()) return;
      const path = join(bundledPack, id, 'model.vrm');
      const file = await lstat(path).catch(() => undefined);
      if (!file?.isFile() || !file.size) return;
      return { path, id, label, size: file.size, format: 'VRM', builtIn: true, rigged: true, mouthSync: true };
    }));
    return entries.filter(Boolean);
  }

  async function availableEntries() {
    const [imported, pack, aha, cover] = await Promise.all([
      currentEntries(), bundledEntries(),
      localAha && lstat(localAha.path).catch(() => undefined),
      coverModel && lstat(coverModel).catch(() => undefined),
    ]);
    const entries = [];
    if (cover?.isFile()) entries.push({ path: coverModel, id: 'va-cover', label: coverName, format: 'VRM',
      size: cover.size, builtIn: true, isDefault: true, rigged: true, mouthSync: true });
    if (aha?.isFile()) entries.push({ path: localAha.path, id: 'aha-default', label: localAhaName, format: 'PMX',
      size: aha.size, builtIn: true, rigged: true, mouthSync: true });
    const packIds = new Set(pack.map(model => model.id));
    return entries.concat(pack, imported.filter(model => !packIds.has(model.id)));
  }

  return {
    async list() {
      return (await availableEntries()).map(({ path, ...model }) => model);
    },
    async preview(id) {
      const entries = await availableEntries();
      const entry = entries.find(model => model.id === id);
      if (!entry) throw new ControlError('MODEL_LIBRARY', '模型已移动或更新，请重新导入模型包。');
      return entry;
    },
    async importPack(selection, checkModel) {
      if (importing) throw new ControlError('BUSY', '正在检测模型包，请稍候。');
      importing = true;
      try {
        const selected = await realpath(selection);
        const nested = join(selected, '模型');
        const folder = (await lstat(nested).catch(() => undefined))?.isDirectory() ? nested : selected;
        const entries = await readdir(folder, { withFileTypes: true });
        const models = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() || !packEntry.test(entry.name)) continue;
          for (const filename of Object.keys(packFormats)) {
            const path = join(folder, entry.name, filename);
            const file = await lstat(path).catch(() => undefined);
            if (!file?.isFile() || !file.size) continue;
            try {
              const result = await checkModel(path);
              if (!result.checked || result.textureWarning) continue;
              models.push({ id: entry.name, file: filename, size: file.size, modified: file.mtimeMs,
                rigged: Boolean(result.bones?.length), mouthSync: result.mouthSync === true });
              break;
            } catch (error) {
              if (error.code === 'BUSY') throw error;
            }
          }
        }
        if (!models.length) {
          throw new ControlError('MODEL_LIBRARY', '这个目录没有检测通过的 VRM 或 GLB。请选解压后的 AI 娘全家桶目录。');
        }
        await save({ folder, models });
        return { count: models.length };
      } finally {
        importing = false;
      }
    },
  };
}
