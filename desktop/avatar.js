import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { actions, facePresets } from './actions.js';
import { danceMotion } from './dance-motion.js';
import { disposeModel, loadModel } from './model-loaders.js';
import { createSpeechMotion } from './speech-motion.js';

const smooth = value => {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function visibleBounds(mesh) {
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  const { groups, index, attributes } = mesh.geometry;
  for (const group of groups) {
    if (!mesh.material[group.materialIndex].visible) continue;
    for (let i = group.start; i < group.start + group.count; i++) {
      bounds.expandByPoint(vertex.fromBufferAttribute(attributes.position, index.getX(i)));
    }
  }
  return bounds;
}

const idle = { motion: 'idle', seconds: 0, face: {} };
const weightFor = (map, name) => map && Object.hasOwn(map, name) ? map[name] : undefined;
const pmxSpeech = ['まばたき', 'あ', 'お'];
const basicPmxMorphs = new Set([...pmxSpeech, ...Object.values(facePresets).flatMap(face => Object.keys(face.pmx ?? {}))]);
const humanoid = {
  head: 'head', chest: 'chest', torso: 'spine', rightArm: 'rightUpperArm', leftArm: 'leftUpperArm',
  rightElbow: 'rightLowerArm', leftElbow: 'leftLowerArm', rightWrist: 'rightHand', leftWrist: 'leftHand',
  rightLeg: 'rightUpperLeg', leftLeg: 'leftUpperLeg', rightKnee: 'rightLowerLeg', leftKnee: 'leftLowerLeg',
};

export async function loadAvatar(stage, model) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 240);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.8;
  controls.maxPolarAngle = 1.82;
  controls.minDistance = 13;
  controls.maxDistance = 100;
  scene.add(new THREE.HemisphereLight(0xfff1db, 0xb5a5ce, 1.15));
  const key = new THREE.DirectionalLight(0xfff2da, 1.05);
  key.position.set(5, 16, 18);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb693, 0.65);
  rim.position.set(-7, 16, -10);
  scene.add(rim);

  let asset;
  let modelRoot;
  const pmx = model.format === 'pmx';
  const bounds = new THREE.Box3();
  try {
    asset = await loadModel(model, renderer);
    if (model.builtIn && model.format === 'glb') {
      // Gemini's source model faces +X. Face the initial camera at +Z.
      asset.object.rotation.y -= Math.PI / 2;
    }
    let visible = false;
    asset.object.traverse(node => { if (node.isMesh && node.visible) visible = true; });
    bounds.copy(pmx ? visibleBounds(asset.object) : new THREE.Box3().setFromObject(asset.object));
    const size = bounds.getSize(new THREE.Vector3());
    if (!visible || bounds.isEmpty() || !Number.isFinite(size.lengthSq()) || !size.lengthSq()) {
      throw new Error('模型没有可显示的网格。');
    }
    if (pmx) {
      modelRoot = asset.object;
      scene.add(modelRoot);
    }
    else {
      const center = bounds.getCenter(new THREE.Vector3());
      const factor = 22 / Math.max(size.x, size.y, size.z);
      const wrapper = new THREE.Group();
      wrapper.position.set(-center.x * factor, -bounds.min.y * factor, -center.z * factor);
      wrapper.scale.setScalar(factor);
      wrapper.add(asset.object);
      scene.add(wrapper);
      bounds.setFromObject(wrapper);
      modelRoot = wrapper;
    }
  } catch (error) {
    if (asset) disposeModel(asset.object);
    controls.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const { object: mesh, textureWarning, clips, vrm, pmxMorphs, vrmExpressions } = asset;
  const origin = modelRoot.position.clone();
  const portraitModel = pmx || Boolean(vrm);
  const head = vrm?.humanoid?.getNormalizedBoneNode('head');
  const chest = vrm?.humanoid?.getNormalizedBoneNode('chest') ?? vrm?.humanoid?.getNormalizedBoneNode('spine');
  const expressionManager = vrm?.expressionManager;
  const vrmMorphs = (expressionManager?.expressions ?? []).map(expression => expression.expressionName).filter(name => {
    if (!vrmExpressions) return true;
    const expression = vrmExpressions[name];
    return expression?.morphTargetBinds?.length || expression?.materialColorBinds?.length ||
      expression?.textureTransformBinds?.length;
  });
  const vrmMouthSync = vrmExpressions
    ? ['aa', 'ih', 'ou', 'ee', 'oh'].some(name => vrmExpressions[name]?.morphTargetBinds?.length)
    : vrmMorphs.includes('aa');
  const mixer = clips.length ? new THREE.AnimationMixer(mesh) : undefined;
  const defaultClip = clips.find(clip => /idle|stand|survey/i.test(clip.name)) ?? clips[0];
  let clipPlaying;
  let clipLength;
  function playClip(clip, seconds) {
    if (clipPlaying === clip && clip === defaultClip && !seconds && !clipLength) return;
    if (clipPlaying) mixer.clipAction(clipPlaying).stop();
    clipPlaying = clip;
    clipLength = seconds;
    if (!clip) return;
    const player = mixer.clipAction(clip).reset();
    player.clampWhenFinished = Boolean(seconds);
    if (seconds) player.setLoop(THREE.LoopOnce, 1).setDuration(seconds);
    else player.setLoop(THREE.LoopRepeat, Infinity).setEffectiveTimeScale(1);
    player.play();
  }
  playClip(defaultClip);
  const height = bounds.max.y - bounds.min.y;
  let portrait = false;
  function frame(targetCamera, closeup, portraitSpan = 0.56) {
    const aspect = targetCamera.aspect;
    const portraitView = closeup && portraitModel;
    const targetY = bounds.min.y + height * (portraitView ? 0.78 : 0.50);
    const width = bounds.max.x - bounds.min.x;
    const span = pmx
      ? height * (portraitView ? Math.max(portraitSpan, 0.41 / aspect) : Math.max(1.12, 0.79 / aspect))
      : portraitView ? Math.max(height * portraitSpan, width * 0.72 / aspect)
        : Math.max(height * 1.14, width * 1.14 / aspect);
    const depth = pmx ? 0 : (bounds.max.z - bounds.min.z) * 0.6;
    const distance = Math.max(2, span / (2 * Math.tan(THREE.MathUtils.degToRad(targetCamera.fov / 2))) + depth);
    targetCamera.position.set(distance * 0.075, targetY + distance * 0.025, distance);
    targetCamera.lookAt(0, targetY, 0);
    targetCamera.updateProjectionMatrix();
    return targetY;
  }

  function view() {
    controls.target.set(0, frame(camera, portrait), 0);
    controls.update();
  }

  let sized = false;
  function resizeStage() {
    const { clientWidth, clientHeight } = stage;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight, false);
    if (!sized) view();
    sized = true;
  }
  const resize = new ResizeObserver(resizeStage);
  resizeStage();

  const pmxBones = {
    head: '頭', chest: '上半身2', torso: '上半身', rightArm: '右腕',
    leftArm: '左腕', rightElbow: '右ひじ', rightWrist: '右手首', leftElbow: '左ひじ',
    leftWrist: '左手首', rightLeg: '右足D', leftLeg: '左足D',
    rightKnee: '右ひざD', leftKnee: '左ひざD',
  };
  const rig = Object.fromEntries(Object.keys(pmxBones).map(key => [key, pmx
    ? mesh.skeleton?.getBoneByName(pmxBones[key])
    : vrm?.humanoid?.getNormalizedBoneNode(humanoid[key])]));
  const proceduralIdle = Boolean(vrm && !defaultClip && rig.leftArm && rig.rightArm);
  const bones = new Map();
  const genericMorphs = new Map();
  mesh.traverse(node => {
    if (node.isBone && node.name) bones.set(node.name, node);
    if (pmx || vrm) return;
    for (const [name, index] of Object.entries(node.morphTargetDictionary ?? {})) {
      if (!genericMorphs.has(name)) genericMorphs.set(name, []);
      genericMorphs.get(name).push({ values: node.morphTargetInfluences, index, base: node.morphTargetInfluences[index] });
    }
  });
  for (const [key, bone] of Object.entries(rig)) {
    if (bone) bones.set(key, bone);
  }
  function setPmxTargets(names = []) {
    if (!pmxMorphs) return;
    const needed = [...new Set([...basicPmxMorphs, ...names])].filter(name => pmxMorphs.has(name));
    if (needed.length === mesh.geometry.morphAttributes.position?.length &&
        needed.every(name => Object.hasOwn(mesh.morphTargetDictionary ?? {}, name))) return;
    const old = new Map(Object.entries(mesh.morphTargetDictionary ?? {}).map(([name, index]) =>
      [name, mesh.morphTargetInfluences[index]]));
    mesh.geometry.dispose();
    mesh.geometry.morphAttributes.position = needed.map(name => pmxMorphs.get(name));
    mesh.morphTargetDictionary = {};
    mesh.morphTargetInfluences = [];
    mesh.updateMorphTargets();
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
      mesh.morphTargetInfluences[index] = old.get(name) ?? 0;
    }
  }
  setPmxTargets();
  const morph = (name, target, fade) => {
    const index = mesh.morphTargetDictionary?.[name];
    if (index !== undefined) {
      const weights = mesh.morphTargetInfluences;
      weights[index] = THREE.MathUtils.lerp(weights[index], target, fade);
    }
  };

  let plan = idle;
  let lastCustomPose = new Map();
  const vrmRest = new Map(Object.values(rig).filter(Boolean).map(bone => [bone, bone.rotation.clone()]));
  const affectedMorphs = new Set();
  const affectedVrm = new Set();
  let procedural = false;
  const rotate = (key, x, y, z) => {
    if (pmx || procedural) rig[key]?.rotation.set(x, y, z);
  };
  let startedAt = 0;
  let speech;
  let previousTime = performance.now() / 1000;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const neutralSpeech = createSpeechMotion('', 'natural', 0);
  function play(next = idle) {
    if (procedural && vrm) {
      for (const [bone, rest] of vrmRest) bone.rotation.copy(rest);
    }
    for (const [bone, rotation] of lastCustomPose) bone.rotation.copy(rotation);
    lastCustomPose.clear();
    plan = next;
    startedAt = performance.now() / 1000;
    setPmxTargets(Object.keys(next.face?.pmx ?? {}));
    for (const name of Object.keys(next.face?.morphs ?? {})) affectedMorphs.add(name);
    for (const name of Object.keys(next.face?.vrm ?? {})) affectedVrm.add(name);
    const clip = next.clip && clips.find(item => item.name === next.clip);
    if (clip) playClip(clip, next.seconds);
    else if (vrm && next.motion !== 'idle') playClip(undefined);
    else if (clipPlaying !== defaultClip || next === idle) playClip(defaultClip);
  }
  function draw(time, targetCamera = camera) {
    const now = time / 1000;
    const dt = Math.max(0, Math.min(now - previousTime, 0.1));
    previousTime = now;
    const elapsed = Math.max(0, now - startedAt);
    if (plan.seconds && elapsed >= plan.seconds) play();
    const { motion: action, seconds: length, face = {}, clip, bones: offsets } = plan;
    const motionTime = length ? elapsed * actions[action].seconds / length : 0;
    procedural = Boolean(vrm && !clip && (action !== 'idle' || proceduralIdle));
    for (const [bone, rotation] of lastCustomPose) bone.rotation.copy(rotation);
    lastCustomPose.clear();
    mixer?.update(dt);
    const talking = speech ? speech.sample(now - speech.start) : neutralSpeech(0);
    // The mouth can keep moving during a deliberate pose, wave or dance.
    const gesture = action === 'idle' ? talking : neutralSpeech(0);
    const strength = length ? smooth(elapsed / Math.min(.38, length / 3)) *
      smooth((length - elapsed) / Math.min(.45, length / 3)) : 0;
    const armRest = proceduralIdle ? (1 - strength) * .65 : 0;
    const breathing = reducedMotion ? 0 : Math.sin(now * 1.65) * 0.017;
    const wave = action === 'wave' ? strength : 0;
    const nod = action === 'nod' ? strength : 0;
    const bow = action === 'bow' ? strength : 0;
    const laugh = action === 'laugh' ? strength : 0;
    const pose = action === 'pose' ? strength : 0;
    const pet = action === 'pet' ? strength : 0;
    const happy = action === 'happy' ? strength : 0;
    const angry = action === 'angry' ? strength : 0;
    const sad = action === 'sad' ? strength : 0;
    const kiss = action === 'kiss' ? strength : 0;
    const throwKiss = kiss * smooth((elapsed / (length || 1) - .42) / .24);
    const bounce = Math.sin(motionTime * 16) * laugh;
    const beat = motionTime * Math.PI * 2;
    const dance = danceMotion(action, motionTime, strength);
    const { sway, pulse, rightStep, leftStep, rightLift, leftLift } = dance;
    if (pmx || vrm) {
      modelRoot.position.set(origin.x + dance.x, origin.y + dance.y - .16 * pet + .24 * happy, origin.z);
      modelRoot.rotation.y = dance.yaw - .12 * pose - .12 * kiss;
    }
    rotate('torso', breathing + bow * 0.52 + gesture.lean * .35 + .22 * sad, 0, sway * 0.06);
    rotate('chest', -breathing * 0.6 + bounce * 0.045,
      wave * 0.10 + sway * 0.24 + gesture.hand * .13, -0.14 * sway - 0.11 * pose - gesture.tilt * .45);
    rotate('head',
      0.06 + nod * (0.15 + 0.18 * Math.cos(motionTime * 10))
        + bow * 0.18 - laugh * 0.12 + bounce * 0.055 + pulse * 0.08 + pet * 0.14 + gesture.pitch
        - .12 * happy + .22 * angry + .31 * sad + .1 * kiss,
      breathing * 1.6 - sway * 0.16 + pose * 0.14,
      wave * 0.08 + sway * 0.12 + pose * 0.16 + pet * (0.21 + 0.05 * Math.sin(beat * 1.8)) + gesture.tilt + .16 * kiss);
    rotate('rightArm', -0.06 - wave * 0.22 + sway * 0.35 - 0.24 * pose - gesture.hand * .53,
      -wave * 0.22 - .3 * kiss, 0.42 + armRest - wave * 0.69 - rightLift * 0.72 - sway * 0.51 - pose * 0.65 - gesture.hand * .57
        - .68 * happy + .22 * angry - .6 * kiss - .48 * throwKiss);
    rotate('rightElbow', 0.03, 0.08, -wave * 1.53 - rightLift * 0.72 - pose * 1.48 - gesture.hand * 1.22
      - 1.72 * kiss + 1.14 * throwKiss - .62 * angry);
    rotate('rightWrist', 0, wave * 0.32 + pose * 0.4 + gesture.hand * .38,
      wave * Math.sin(motionTime * 13) * 0.37 - pulse * 0.24 + .46 * throwKiss);
    rotate('leftArm', -0.07 - sway * 0.35 - gesture.oppositeHand * .46, 0,
      -0.42 - armRest + laugh * 0.18 + leftLift * 0.72 - sway * 0.51 + gesture.oppositeHand * .6 + .76 * happy - .18 * angry);
    rotate('leftElbow', -pet * 0.4, -0.05 - laugh * 0.50,
      laugh * 0.20 + leftLift * 0.72 + pet * 0.5 + gesture.oppositeHand);
    rotate('leftWrist', 0, 0, pulse * 0.24);
    rotate('rightLeg', -rightStep * 0.24, 0, sway * 0.12);
    rotate('leftLeg', -leftStep * 0.24, 0, sway * 0.12);
    rotate('rightKnee', rightStep * 0.44, 0, 0);
    rotate('leftKnee', leftStep * 0.44, 0, 0);

    const fade = 1 - Math.exp(-dt * 19);
    const blinkTime = now % 4.6;
    const blink = Math.max(0, 1 - Math.abs(blinkTime - 0.14) / 0.14);
    const mouth = Math.max(talking.open, laugh * (0.28 + bounce * 0.18));
    const automaticPmx = { まばたき: reducedMotion || face.pmx?.笑い ? 0 : blink,
      あ: Math.max(0, mouth * .96 - talking.round * .34), お: talking.round * .52 + mouth * .09 };
    if (pmx) {
      for (const name of Object.keys(mesh.morphTargetDictionary ?? {})) {
        const weight = (weightFor(face.pmx, name) ?? 0) * (name === 'にやり' ? 1 - mouth : name === '笑い' ? 1 - mouth * .55 : 1);
        morph(name, Math.max(weight, weightFor(automaticPmx, name) ?? 0), fade);
      }
    }
    if (vrm) {
      if (!procedural && !clip) {
        head?.rotation.set(gesture.pitch, 0, gesture.tilt);
        if (chest && !mixer) chest.rotation.set(gesture.lean, gesture.hand * .12, -gesture.tilt * .3);
      }
      const automatic = { blink: reducedMotion ? 0 : blink,
        aa: Math.max(0, mouth * .92 - talking.round * .3), oh: talking.round * .5 };
      for (const name of new Set([...Object.keys(automatic), ...affectedVrm])) {
        if (!expressionManager?.getExpression(name)) continue;
        const target = weightFor(face.vrm, name);
        const value = Math.max(target ?? 0, weightFor(automatic, name) ?? 0);
        const blended = THREE.MathUtils.lerp(expressionManager.getValue(name) ?? 0, value, fade);
        expressionManager.setValue(name, blended);
        if (target === undefined && blended < .001) affectedVrm.delete(name);
      }
    }
    for (const [name, angles] of Object.entries(offsets ?? {})) {
      const bone = bones.get(name);
      if (!bone) continue;
      lastCustomPose.set(bone, bone.rotation.clone());
      bone.rotation.x += THREE.MathUtils.degToRad(angles[0]) * strength;
      bone.rotation.y += THREE.MathUtils.degToRad(angles[1]) * strength;
      bone.rotation.z += THREE.MathUtils.degToRad(angles[2]) * strength;
    }
    for (const name of affectedMorphs) {
      const target = weightFor(face.morphs, name);
      const tracks = genericMorphs.get(name) ?? [];
      for (const { values, index, base } of tracks) {
        values[index] = THREE.MathUtils.lerp(values[index], target ?? base, fade);
      }
      if (target === undefined && tracks.every(({ values, index, base }) => Math.abs(values[index] - base) < .001)) {
        affectedMorphs.delete(name);
      }
    }
    vrm?.update(dt);
    controls.update();
    renderer.render(scene, targetCamera);
  }
  function dispose() {
    renderer.setAnimationLoop(null);
    resize.disconnect();
    controls.dispose();
    mixer?.stopAllAction();
    disposeModel(mesh);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }
  try {
    const size = 128;
    const probe = new THREE.WebGLRenderTarget(size, size);
    try {
      const targetCamera = camera.clone();
      targetCamera.aspect = 1;
      frame(targetCamera, false);
      renderer.setRenderTarget(probe);
      draw(performance.now(), targetCamera);
      const pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(probe, 0, 0, size, size, pixels);
      if (!pixels.some((value, index) => index % 4 === 3 && value > 16)) {
        throw new Error('没有渲染出可见的模型。');
      }
    } finally {
      renderer.setRenderTarget(null);
      probe.dispose();
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    textureWarning,
    media: {
      mode: pmx ? 'pmx' : vrm ? 'vrm' : clips.length ? 'clips' : 'static',
      animationCount: clips.length,
      clips: clips.filter(clip => clip.name && clip.duration > 0).slice(0, 256).map(clip => clip.name),
      bones: [...bones.keys()].slice(0, 1024),
      morphs: [...(pmxMorphs?.keys() ?? (vrm ? vrmMorphs : genericMorphs.keys()))].slice(0, 512),
      motions: Object.keys(actions).filter(id => id === 'idle' || (rig.head && ['nod', 'sad', 'pet'].includes(id)) ||
        ((pmx || vrm) && rig.rightArm && ['wave', 'pose', 'kiss', 'happy', 'angry'].includes(id)) ||
        (rig.torso && ['bow', 'laugh'].includes(id)) ||
        (rig.leftArm && rig.rightArm && rig.torso && id.startsWith('dance'))),
      mouthSync: pmx ? Object.hasOwn(mesh.morphTargetDictionary ?? {}, 'あ') : vrmMouthSync,
    },
    mount() {
      stage.prepend(renderer.domElement);
      resizeStage();
      resize.observe(stage);
      draw(performance.now());
      renderer.setAnimationLoop(time => draw(time));
    },
    play,
    speak(text, style, durationMs, audioLevel) {
      speech = { start: performance.now() / 1000,
        sample: createSpeechMotion(text, style, durationMs / 1000, audioLevel, reducedMotion) };
    },
    stopSpeaking() {
      speech = undefined;
    },
    showPortrait(closeup) {
      portrait = closeup;
      view();
    },
    dispose,
    hits(clientX, clientY) {
      const canvas = renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((clientX - rect.left) / rect.width * canvas.width);
      const y = canvas.height - 1 - Math.floor((clientY - rect.top) / rect.height * canvas.height);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
      draw(performance.now());
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[3] > 16;
    },
    capture(selfie = false) {
      if (!selfie) {
        draw(performance.now());
        return renderer.domElement.toDataURL('image/png');
      }
      const size = renderer.getSize(new THREE.Vector2());
      const ratio = renderer.getPixelRatio();
      const snapshot = camera.clone();
      snapshot.aspect = 780 / 1040;
      frame(snapshot, true, 0.70);
      renderer.setPixelRatio(1);
      renderer.setSize(780, 1040, false);
      try {
        draw(performance.now(), snapshot);
        return renderer.domElement.toDataURL('image/png');
      } finally {
        renderer.setPixelRatio(ratio);
        renderer.setSize(size.x, size.y, false);
        draw(performance.now());
      }
    },
  };
}
