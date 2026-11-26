import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { repairWindowsDeepSeekVrm } from '../desktop/windows-vrm-materials.js';

const parse = bytes => JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
const tail = bytes => bytes.subarray(20 + bytes.readUInt32LE(12));

test('Windows DeepSeek repair preserves model data and restores only the matching face atlas', async () => {
  const original = await readFile(new URL('../assets/models/ai-girls/01_DeepSeek_V7/model.vrm', import.meta.url));
  const snapshot = Buffer.from(original);
  const fixed = repairWindowsDeepSeekVrm(original);
  const expected = parse(original);
  const face = expected.materials.find(material => material.name === 'Toon face 4');
  face.emissiveTexture.index = expected.materials.find(material => material.name === 'Toon face 3').emissiveTexture.index;
  assert.equal(fixed.readUInt32LE(8), fixed.length);
  assert.equal(fixed.readUInt32LE(12) % 4, 0);
  assert.deepEqual(parse(fixed), JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(tail(fixed), tail(original));
  assert.deepEqual(original, snapshot);
  assert.equal(repairWindowsDeepSeekVrm(fixed), fixed);

  // Same GLB with a different character name must remain byte-for-byte intact.
  const other = Buffer.from(original);
  const nameOffset = other.indexOf(Buffer.from('"name":"DeepSeek"'));
  assert.ok(nameOffset > 20);
  other.write('OtherVRM', nameOffset + '"name":"'.length);
  assert.equal(repairWindowsDeepSeekVrm(other), other);
  const invalid = Buffer.from('invalid model');
  assert.equal(repairWindowsDeepSeekVrm(invalid), invalid);
});
