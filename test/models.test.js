import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { readCharacter, readSettings, restoreAvatarPosition, settingsWriter } from '../desktop/config.js';
import { bindModel, modelResource, restoreModelPath } from '../desktop/model-files.js';
import { createModelLibrary, modelPage } from '../desktop/model-library.js';

async function temporary(t) {
  const folder = await mkdtemp(join(tmpdir(), 'va-model-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('model file validation checks headers and resolves only assets in the model directory', async t => {
  const folder = await temporary(t);
  const assets = join(folder, 'assets');
  await mkdir(assets);
  const good = join(assets, 'Gemini.glb');
  await writeFile(good, 'glTF fixture');
  const model = await bindModel(good);
  assert.equal(model.format, 'glb');
  assert.equal(model.name, 'Gemini.glb');
  assert.equal(basename(await modelResource(model, ['Gemini.glb'])), 'Gemini.glb');
  await writeFile(join(folder, 'outside.png'), 'a fixture');
  assert.equal(await modelResource(model, ['..', 'outside.png']), undefined);
  const bad = join(assets, 'invalid.glb');
  await writeFile(bad, 'invalid header');
  await assert.rejects(bindModel(bad), { code: 'MODEL_FORMAT' });
});

test('library imports previewable VRM and GLB models', async t => {
  const folder = await temporary(t);
  for (const id of ['04_Gemini_V2', '08_Claude_V2', '09_GPT_V2']) await mkdir(join(folder, id));
  await writeFile(join(folder, '04_Gemini_V2', 'model.vrm'), 'glTF rigged');
  await writeFile(join(folder, '08_Claude_V2', 'model.glb'), 'glTF preview');
  await writeFile(join(folder, '09_GPT_V2', 'model.glb'), 'unusable');
  const library = createModelLibrary(join(folder, 'library.json'), {});
  assert.deepEqual(await library.list(), []);
  const imported = await library.importPack(folder, async file => {
    const fixture = await readFile(file, 'utf8');
    return { checked: fixture.startsWith('glTF'), bones: fixture.endsWith('rigged') ? ['head'] : [] };
  });
  assert.equal(imported.count, 2);
  assert.deepEqual((await library.list()).map(model => [model.label, model.format, model.rigged]),
    [['Gemini', 'VRM', true], ['Claude', 'GLB', false]]);
  assert.equal((await library.preview('08_Claude_V2')).label, 'Claude');
  assert.equal(modelPage('https://www.aplaybox.com/details/model/abc123?ref=fixture'),
    'https://www.aplaybox.com/details/model/abc123');
  assert.throws(() => modelPage('http://example.invalid/details/model/abc123'), { code: 'MODEL_LINK' });
});

test('the local asset pack supplies rigged models and takes priority over matching imports', async t => {
  const folder = await temporary(t);
  const bundledPack = join(folder, 'ai-girls');
  const variants = ['01_DeepSeek_V7', '04_Gemini_V2'];
  for (const id of variants) {
    await mkdir(join(bundledPack, id), { recursive: true });
    await writeFile(join(bundledPack, id, 'model.vrm'), 'bundled VRM');
  }
  await mkdir(join(folder, '04_Gemini_V2'));
  await writeFile(join(folder, '04_Gemini_V2', 'model.glb'), 'imported static Gemini');
  const library = createModelLibrary(join(folder, 'library.json'), { bundledPack });
  assert.equal((await library.importPack(folder, async () => ({ checked: true }))).count, 1);
  assert.deepEqual((await library.list()).map(model => [model.label, model.format, model.rigged]),
    [['DeepSeek', 'VRM', true], ['Gemini', 'VRM', true]]);
  assert.equal((await library.preview(variants[1])).path, join(bundledPack, variants[1], 'model.vrm'));
  await assert.rejects(library.preview('gemini-default'), { code: 'MODEL_LIBRARY' });
});

test('saved selections of the retired built-in Gemini use the default model', async t => {
  const folder = await temporary(t);
  const settings = join(folder, 'settings.json');
  const save = settingsWriter(settings);
  const retired = join('assets', 'models', 'Gemini 娘.glb');
  for (const modelPath of [join(folder, retired), join(folder, 'old-install', 'app.asar', retired)]) {
    await save({ modelPath });
    assert.equal(restoreModelPath((await readSettings(settings)).modelPath, folder), null);
  }
  for (const modelPath of [join(folder, 'custom', 'Gemini 娘.glb'), join(folder, 'ai-girls', '04_Gemini_V2', 'model.vrm')]) {
    assert.equal(restoreModelPath(modelPath, folder), modelPath);
  }
});

test('3D model gallery searches built-in and imported names', async () => {
  const handlers = new Map();
  const elements = new Map();
  class Element {
    children = [];
    dataset = {};
    value = '';
    addEventListener(event, fn) { if (this.id) handlers.set(this.id + ':' + event, fn); }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    querySelectorAll() { return []; }
  }
  const document = {
    createElement: () => new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, Object.assign(new Element(), { id }));
      return elements.get(id);
    },
  };
  const models = [
    { label: '星神', builtIn: true, size: 20 },
    { label: 'Gemini', builtIn: true, size: 20 },
    { label: 'Claude', size: 20 },
  ];
  runInNewContext(await readFile(new URL('../desktop/model-gallery.js', import.meta.url), 'utf8'), {
    document, MutationObserver: class { observe() {} },
    window: { va: { modelLibrary: async () => models, onModelPreview: () => {} } },
  });
  await setImmediate();
  const input = elements.get('gallery-search');
  const filter = query => {
    input.value = query;
    handlers.get('gallery-search:input')();
    return elements.get('gallery-list').children.map(item => item.children[0].textContent);
  };
  assert.deepEqual(filter(' ＧＥＭＩＮＩ '), ['Gemini']);
  assert.deepEqual(filter('星'), ['星神']);
  assert.deepEqual(filter('clau'), ['Claude']);
  assert.deepEqual(filter('无此模型'), []);
  assert.equal(elements.get('gallery-no-results').hidden, false);
  assert.deepEqual(filter(''), ['星神', 'Gemini', 'Claude']);
});

test('settings normalize old intervals and legacy character names', async t => {
  const folder = await temporary(t);
  const settings = join(folder, 'settings.json');
  assert.equal((await readSettings(settings)).screenWatch, false);
  const save = settingsWriter(settings);
  await Promise.all([save({ screenInterval: 27 }), save({ screenInterval: 61, screenWatch: true })]);
  assert.equal((await readSettings(settings)).screenInterval, 60);
  assert.equal((await readSettings(settings)).screenWatch, true);
  const character = join(folder, 'character.json');
  const defaults = { name: 'Gemini', prompt: '我是{{name}}', dialogue: { wave: ['你好，我是{{name}}'] } };
  await writeFile(character, JSON.stringify({
    name: 'Gemini 娘', prompt: '我是Gemini 娘', dialogue: { wave: '你好，我是Gemini 娘' },
  }));
  assert.deepEqual(await readCharacter(character, defaults),
    { name: 'Gemini', prompt: '我是Gemini', dialogue: { wave: ['你好，我是Gemini'] } });
});

test('an avatar can retain negative desktop coordinates and recover from an unavailable display', async t => {
  const settings = join(await temporary(t), 'settings.json');
  const position = { x: -35, y: 672 };
  const size = { width: 140, height: 200 };
  const primary = { x: 0, y: 30, width: 1440, height: 870 };
  await settingsWriter(settings)({ windowPosition: position });
  const saved = (await readSettings(settings)).windowPosition;
  assert.deepEqual(saved, position);
  assert.deepEqual(restoreAvatarPosition(saved, size, primary), position);
  assert.deepEqual(restoreAvatarPosition({ x: -800, y: 1920 }, size, primary), { x: 0, y: 700 });
  await writeFile(settings, JSON.stringify({ windowPosition: { x: '-35', y: 672 } }));
  assert.equal((await readSettings(settings)).windowPosition, undefined);
});

test('the bundled cover is a rigged VRM and wins the default model selection', async t => {
  const folder = await temporary(t);
  const coverModel = new URL('../assets/models/VA Cover.vrm', import.meta.url);
  const bytes = await readFile(coverModel);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  const vrm = json.extensions.VRMC_vrm;
  assert.equal(vrm.specVersion, '1.0');
  const bones = vrm.humanoid.humanBones;
  const joints = new Set(json.skins[0].joints);
  for (const bone of ['head', 'hips', 'leftHand', 'rightHand']) {
    assert.ok(joints.has(bones[bone]?.node), bone);
  }
  for (const side of ['left', 'right']) {
    for (const digit of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      const segments = digit === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let parent = bones[side + 'Hand'].node;
      for (const segment of segments) {
        const name = side + digit + segment;
        const node = bones[name]?.node;
        assert.ok(joints.has(node), name);
        assert.ok(json.nodes[parent].children.includes(node), name);
        parent = node;
      }
    }
  }
  assert.ok(vrm.expressions.preset.aa.morphTargetBinds.length);
  for (const [name, expression] of Object.entries(vrm.expressions.preset)) {
    for (const { node, index } of expression.morphTargetBinds ?? []) {
      const mesh = json.meshes[json.nodes[node]?.mesh];
      assert.ok(mesh?.primitives.some(primitive => primitive.targets?.[index]), name);
    }
  }
  const trousers = json.nodes.filter(node => typeof node.mesh === 'number' &&
    node.name === 'One-piece fitted navy trousers');
  assert.equal(trousers.length, 1);
  assert.equal(trousers[0].skin, 0);
  for (const side of ['Left', 'Right']) {
    for (const part of ['stacked heel', 'forefoot sole']) {
      const footwear = json.nodes.find(node => node.name === side + ' boot · ' + part);
      assert.equal(footwear?.skin, 0, side + ' ' + part);
    }
  }
  for (const vowel of ['aa', 'oh']) {
    assert.ok(vrm.expressions.preset[vowel].morphTargetBinds.every(({ weight }) => weight > 0 && weight < 0.65),
      vowel);
  }
  const binding = vrm.expressions.preset.aa.morphTargetBinds
    .find(({ node }) => json.nodes[node]?.name === 'Mouth interior · elliptical speech');
  assert.ok(binding);
  const lips = json.meshes[json.nodes[binding.node].mesh].primitives[0];
  const binaryStart = 28 + bytes.readUInt32LE(12);
  const readPosition = (index, vertex, axis) => {
    const accessor = json.accessors[index];
    const view = json.bufferViews[accessor.bufferView];
    return bytes.readFloatLE(binaryStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) +
      vertex * (view.byteStride ?? 12) + axis * 4);
  };
  const count = json.accessors[lips.attributes.POSITION].count;
  const extent = [0, 1].map(axis => {
    const values = Array.from({ length: count }, (_, vertex) => readPosition(lips.attributes.POSITION, vertex, axis) +
      binding.weight * readPosition(lips.targets[binding.index].POSITION, vertex, axis));
    return Math.max(...values) - Math.min(...values);
  });
  assert.ok(extent[1] > .004 && extent[0] > extent[1] * 2.3, 'the open lip contour is a horizontal oval');
  const localAha = { path: join(folder, '星神.pmx') };
  await writeFile(localAha.path, 'PMX fixture');
  const library = createModelLibrary(join(folder, 'library.json'), { coverModel: fileURLToPath(coverModel), localAha });
  assert.deepEqual((await library.list()).map(({ id, isDefault }) => [id, Boolean(isDefault)]),
    [['va-cover', true], ['aha-default', false]]);
});
