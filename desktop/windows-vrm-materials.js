// The DeepSeek face replacement uses projected UVs, while this exported mesh
// still has the original atlas UVs. Restore its matching atlas in memory.
export function repairWindowsDeepSeekVrm(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length ||
      bytes.readUInt32LE(16) !== 0x4e4f534a) return bytes;
  const length = bytes.readUInt32LE(12);
  if (length % 4 || length > bytes.length - 20) return bytes;
  let gltf;
  try { gltf = JSON.parse(bytes.toString('utf8', 20, 20 + length)); } catch { return bytes; }
  if (gltf.extensions?.VRMC_vrm?.meta?.name !== 'DeepSeek') return bytes;
  const face = gltf.materials?.find(material => material.name === 'Toon face 4');
  const atlas = gltf.materials?.find(material => material.name === 'Toon face 3')?.emissiveTexture;
  const image = texture => gltf.images?.[gltf.textures?.[texture?.index]?.source];
  if (image(face?.emissiveTexture)?.name !== 'clean_skin_without_duplicate_brows' ||
      image(atlas)?.name !== 'Color') return bytes;
  face.emissiveTexture = { ...face.emissiveTexture, index: atlas.index };
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const tail = bytes.subarray(20 + length);
  const header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + tail.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, tail]);
}
