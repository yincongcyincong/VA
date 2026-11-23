import { randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ControlError } from '../lib/control.js';

export const modelFormats = ['pmx', 'vrm', 'glb', 'gltf', 'fbx', 'obj'];

export const modelMime = {
  '.pmx': 'application/octet-stream',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.tga': 'application/octet-stream',
  '.dds': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

export async function bindModel(path, builtIn = false, { allowMissing = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new ControlError('MODEL_PATH', '请选择模型的绝对路径。');
  }
  const format = extname(path).slice(1).toLowerCase();
  if (!modelFormats.includes(format)) {
    throw new ControlError('MODEL_FORMAT', '支持 PMX、VRM、GLB、glTF、FBX 和 OBJ。');
  }
  const resolved = await realpath(path).catch(() => undefined);
  const file = resolved && await stat(resolved).catch(() => undefined);
  if ((!file?.isFile() || !file.size) && !allowMissing) {
    throw new ControlError('MODEL_PATH', '模型文件不存在或无法读取。');
  }
  if (!allowMissing && file?.size && ['pmx', 'glb', 'vrm'].includes(format)) {
    const handle = await open(resolved, 'r');
    try {
      const prefix = Buffer.alloc(4);
      const { bytesRead } = await handle.read(prefix);
      if (bytesRead !== 4 || prefix.toString('ascii') !== (format === 'pmx' ? 'PMX ' : 'glTF')) {
        throw new ControlError('MODEL_FORMAT', '文件内容与 .' + format + ' 格式不符。');
      }
    } finally {
      await handle.close();
    }
  }
  const modelPath = resolved ?? resolve(path);
  const name = basename(path);
  const id = randomUUID();
  return { id, path: modelPath, root: dirname(modelPath), name, format, builtIn,
    url: '/assets/' + id + '/' + encodeURIComponent(basename(modelPath)) };
}

export async function modelResource(binding, parts) {
  if (!binding || !parts.length || !Object.hasOwn(modelMime, extname(parts.at(-1)).toLowerCase())) return;
  const root = await realpath(binding.root);
  const candidates = [resolve(root, ...parts)];
  const extension = extname(parts[0]).toLowerCase();
  // FBXLoader keeps the basename of texture paths with backslashes.
  if (binding.format === 'fbx' && parts.length === 1 &&
      (modelMime[extension]?.startsWith('image/') || ['.dds', '.tga'].includes(extension))) {
    candidates.push(resolve(root, 'Textures', parts[0]), resolve(root, 'textures', parts[0]));
  }
  for (const candidate of candidates) {
    const file = await realpath(candidate).catch(() => undefined);
    if (!file) continue;
    const subpath = relative(root, file);
    if (!subpath || subpath === '..' || subpath.startsWith('..' + sep) || isAbsolute(subpath)) continue;
    return file;
  }
}
