import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { readCharacter, readSettings, settingsWriter } from '../desktop/config.js';
import { bindModel, modelResource } from '../desktop/model-files.js';
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

test('library keeps previewable models and prefers the rigged Gemini', async t => {
  const folder = await temporary(t);
  const bundledModel = join(folder, 'Gemini 娘.glb');
  await writeFile(bundledModel, 'glTF fixture');
  for (const id of ['04_Gemini_V2', '08_Claude_V2', '09_GPT_V2']) await mkdir(join(folder, id));
  await writeFile(join(folder, '04_Gemini_V2', 'model.vrm'), 'glTF rigged');
  await writeFile(join(folder, '08_Claude_V2', 'model.glb'), 'glTF preview');
  await writeFile(join(folder, '09_GPT_V2', 'model.glb'), 'unusable');
  const library = createModelLibrary(join(folder, 'library.json'), { bundledModel });
  assert.equal((await library.list())[0].label, 'Gemini');
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
    window: { va: { modelLibrary: async () => models } },
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
