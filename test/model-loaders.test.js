import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three';
import { disposeModel, loadModel } from '../desktop/model-loaders.js';

const dataUrl = (mime, body) => `data:${mime};base64,${Buffer.from(body).toString('base64')}`;

test('model loader opens OBJ and glTF meshes and releases their resources', async t => {
  if (typeof globalThis.ProgressEvent !== 'function') {
    globalThis.ProgressEvent = class ProgressEvent extends Event {
      constructor(type, properties) {
        super(type);
        Object.assign(this, properties);
      }
    };
    t.after(() => { delete globalThis.ProgressEvent; });
  }
  const vertices = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ uri: dataUrl('application/octet-stream', vertices), byteLength: vertices.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  const renderer = { extensions: { has: () => false }, capabilities: { isWebGL2: false } };
  const assets = [
    ['obj', dataUrl('text/plain', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')],
    ['gltf', dataUrl('model/gltf+json', JSON.stringify(gltf))],
  ];
  for (const [format, url] of assets) {
    const asset = await loadModel({ format, url }, renderer);
    assert.equal(asset.textureWarning, false);
    assert.deepEqual(asset.clips, []);
    const [mesh] = asset.object.children;
    assert.equal(mesh.isMesh, true);
    assert.equal(mesh.geometry.getAttribute('position').count, 3);
    let disposed = false;
    mesh.geometry.addEventListener('dispose', () => { disposed = true; });
    disposeModel(asset.object);
    assert.equal(disposed, true);
  }
  await assert.rejects(loadModel({ format: 'gltf', url: dataUrl('text/plain', '{}') }, renderer));
});

test('disposing a model releases shared materials, textures and geometry exactly once', () => {
  const texture = new Texture();
  const material = new MeshBasicMaterial({ map: texture });
  const geometry = new BufferGeometry();
  const root = new Group();
  root.add(new Mesh(geometry, material), new Mesh(geometry, [material]));
  const disposed = [];
  for (const [name, resource] of [['texture', texture], ['material', material], ['geometry', geometry]]) {
    resource.addEventListener('dispose', () => disposed.push(name));
  }
  disposeModel(root);
  assert.deepEqual(disposed.sort(), ['geometry', 'material', 'texture']);
});
