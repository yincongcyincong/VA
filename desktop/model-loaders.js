import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';

function preparePmx(mesh) {
  const base = mesh.geometry.attributes.position.array;
  const pmxMorphs = new Map((mesh.geometry.morphAttributes.position ?? [])
    .filter(attribute => attribute.array.some((value, index) => value !== base[index]))
    .map(attribute => [attribute.name, attribute]));
  mesh.frustumCulled = false;
  for (const material of mesh.material) material.visible = material.opacity > 0;
  return { object: mesh, clips: [], pmxMorphs };
}

async function loadGltf(manager, model, renderer) {
  const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/loaders/KTX2Loader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const draco = new DRACOLoader(manager).setDecoderPath('/three/addons/libs/draco/gltf/');
  const basis = new KTX2Loader(manager).setTranscoderPath('/three/addons/libs/basis/').detectSupport(renderer);
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(basis).setMeshoptDecoder(MeshoptDecoder);
  try {
    if (model.format === 'vrm') {
      const { VRMLoaderPlugin, VRMUtils } = await import('/vendor/three-vrm.js');
      loader.register(parser => new VRMLoaderPlugin(parser));
      const asset = await loader.loadAsync(model.url);
      const vrm = asset.userData.vrm;
      if (!vrm) throw new Error('文件缺少 VRM 人形定义。');
      VRMUtils.rotateVRM0(vrm);
      vrm.scene.traverse(object => { if (object.isSkinnedMesh) object.frustumCulled = false; });
      const expressions = asset.parser.json.extensions?.VRMC_vrm?.expressions;
      const vrmExpressions = expressions && { ...expressions.custom, ...expressions.preset };
      return { object: vrm.scene, clips: asset.animations, vrm, vrmExpressions };
    }
    const asset = await loader.loadAsync(model.url);
    return { object: asset.scene, clips: asset.animations };
  } finally {
    draco.dispose();
    basis.dispose();
  }
}

async function loadObj(manager, url) {
  const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
    import('three/addons/loaders/OBJLoader.js'), import('three/addons/loaders/MTLLoader.js'),
  ]);
  const text = await new THREE.FileLoader(manager).loadAsync(url);
  const loader = new OBJLoader(manager);
  const materialFile = /^\s*mtllib\s+(.+?)\s*$/m.exec(text)?.[1];
  if (materialFile) {
    try {
      const materialURL = new URL(materialFile.replaceAll('\\', '/'), new URL(url, location.href));
      const materials = await new MTLLoader(manager).loadAsync(materialURL.href);
      materials.preload();
      loader.setMaterials(materials);
    } catch {
      // Missing materials can still be displayed with a default mesh material.
    }
  }
  return { object: loader.parse(text), clips: [] };
}

export async function loadModel(model, renderer) {
  let finish;
  let idle = Promise.resolve();
  const manager = new THREE.LoadingManager();
  manager.onStart = () => { idle = new Promise(resolve => { finish = resolve; }); };
  manager.onLoad = () => finish?.();
  let textureWarning = false;
  manager.onError = () => { textureWarning = true; };

  let asset;
  switch (model.format) {
    case 'pmx': {
      if (model.builtIn) {
        // The original Aha bundle omits a texture for a hidden material.
        manager.addHandler(/\/颜赤\.tga$/, new THREE.TextureLoader(manager));
        manager.setURLModifier(path => path.endsWith('/颜赤.tga') ? new URL('颜.png', new URL(model.url, location.href)).href : path);
      }
      asset = preparePmx(await new MMDLoader(manager).loadAsync(model.url));
      break;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const object = await new FBXLoader(manager).loadAsync(model.url);
      asset = { object, clips: object.animations };
      break;
    }
    case 'obj':
      asset = await loadObj(manager, model.url);
      break;
    default:
      asset = await loadGltf(manager, model, renderer);
  }

  await idle;
  if (model.format === 'fbx' && textureWarning) {
    asset.object.traverse(node => {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        const map = material?.map;
        if (map && !map.image) {
          map.dispose();
          material.map = null;
        }
      }
    });
  }
  return { ...asset, textureWarning };
}

export function disposeModel(object) {
  const resources = new Set();
  object.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    if (node.skeleton) resources.add(node.skeleton);
    for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) resources.add(value);
      }
    }
  });
  for (const resource of resources) resource.dispose();
}
