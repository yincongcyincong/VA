import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { actions } from './actions.js';
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
  const pmx = model.format === 'pmx';
  const bounds = new THREE.Box3();
  try {
    asset = await loadModel(model, renderer);
    let visible = false;
    asset.object.traverse(node => { if (node.isMesh && node.visible) visible = true; });
    bounds.copy(pmx ? visibleBounds(asset.object) : new THREE.Box3().setFromObject(asset.object));
    const size = bounds.getSize(new THREE.Vector3());
    if (!visible || bounds.isEmpty() || !Number.isFinite(size.lengthSq()) || !size.lengthSq()) {
      throw new Error('模型没有可显示的网格。');
    }
    if (pmx) scene.add(asset.object);
    else {
      const center = bounds.getCenter(new THREE.Vector3());
      const factor = 22 / Math.max(size.x, size.y, size.z);
      const wrapper = new THREE.Group();
      wrapper.position.set(-center.x * factor, -bounds.min.y * factor, -center.z * factor);
      wrapper.scale.setScalar(factor);
      wrapper.add(asset.object);
      scene.add(wrapper);
      bounds.setFromObject(wrapper);
    }
  } catch (error) {
    if (asset) disposeModel(asset.object);
    controls.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const { object: mesh, textureWarning, clips, vrm } = asset;
  const portraitModel = pmx || Boolean(vrm);
  const head = vrm?.humanoid?.getNormalizedBoneNode('head');
  const chest = vrm?.humanoid?.getNormalizedBoneNode('chest') ?? vrm?.humanoid?.getNormalizedBoneNode('spine');
  const expressionManager = vrm?.expressionManager;
  const mixer = clips.length ? new THREE.AnimationMixer(mesh) : undefined;
  const defaultClip = clips.find(clip => /idle|stand|survey/i.test(clip.name)) ?? clips[0];
  if (defaultClip) mixer.clipAction(defaultClip).play();
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
  stage.prepend(renderer.domElement);
  resizeStage();
  resize.observe(stage);

  const rig = Object.fromEntries(Object.entries({
    head: '頭', chest: '上半身2', torso: '上半身', rightArm: '右腕',
    leftArm: '左腕', rightElbow: '右ひじ', rightWrist: '右手首', leftElbow: '左ひじ',
    leftWrist: '左手首', rightLeg: '右足D', leftLeg: '左足D',
    rightKnee: '右ひざD', leftKnee: '左ひざD',
  }).map(([key, name]) => [key, mesh.skeleton?.getBoneByName(name)]));
  const rotate = (key, x, y, z) => rig[key]?.rotation.set(x, y, z);
  const morph = (name, target, fade) => {
    const index = mesh.morphTargetDictionary?.[name];
    if (index !== undefined) {
      const weights = mesh.morphTargetInfluences;
      weights[index] = THREE.MathUtils.lerp(weights[index], target, fade);
    }
  };

  let action = 'idle';
  let expression = 'neutral';
  let startedAt = 0;
  let speech;
  let previousTime = performance.now() / 1000;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const neutralSpeech = createSpeechMotion('', 'natural', 0);
  function draw(time, targetCamera = camera) {
    const now = time / 1000;
    const dt = Math.max(0, Math.min(now - previousTime, 0.1));
    previousTime = now;
    const elapsed = Math.max(0, now - startedAt);
    const length = actions[action].seconds;
    if (length && elapsed >= length) {
      action = 'idle';
    }
    const talking = speech ? speech.sample(now - speech.start) : neutralSpeech(0);
    // The mouth can keep moving during a deliberate pose, wave or dance.
    const gesture = action === 'idle' ? talking : neutralSpeech(0);
    const strength = action === 'idle' ? 0
      : smooth(elapsed / 0.38) * smooth((length - elapsed) / 0.45);
    const breathing = reducedMotion ? 0 : Math.sin(now * 1.65) * 0.017;
    const wave = action === 'wave' ? strength : 0;
    const nod = action === 'nod' ? strength : 0;
    const bow = action === 'bow' ? strength : 0;
    const laugh = action === 'laugh' ? strength : 0;
    const pose = action === 'pose' ? strength : 0;
    const pet = action === 'pet' ? strength : 0;
    const bounce = Math.sin(elapsed * 16) * laugh;
    const beat = elapsed * Math.PI * 2;
    const dance = danceMotion(action, elapsed, strength);
    const { sway, pulse, rightStep, leftStep, rightLift, leftLift } = dance;
    if (pmx) {
      mesh.position.set(dance.x, dance.y - 0.16 * pet, 0);
      mesh.rotation.y = dance.yaw - 0.12 * pose;
    }
    rotate('torso', breathing + bow * 0.52 + gesture.lean * .35, 0, sway * 0.06);
    rotate('chest', -breathing * 0.6 + bounce * 0.045,
      wave * 0.10 + sway * 0.24 + gesture.hand * .13, -0.14 * sway - 0.11 * pose - gesture.tilt * .45);
    rotate('head',
      0.06 + nod * (0.15 + 0.18 * Math.cos(elapsed * 10))
        + bow * 0.18 - laugh * 0.12 + bounce * 0.055 + pulse * 0.08 + pet * 0.14 + gesture.pitch,
      breathing * 1.6 - sway * 0.16 + pose * 0.14,
      wave * 0.08 + sway * 0.12 + pose * 0.16 + pet * (0.21 + 0.05 * Math.sin(beat * 1.8)) + gesture.tilt);
    rotate('rightArm', -0.06 - wave * 0.22 + sway * 0.35 - 0.24 * pose - gesture.hand * .53,
      -wave * 0.22, 0.42 - wave * 0.69 - rightLift * 0.72 - sway * 0.51 - pose * 0.65 - gesture.hand * .57);
    rotate('rightElbow', 0.03, 0.08, -wave * 1.53 - rightLift * 0.72 - pose * 1.48 - gesture.hand * 1.22);
    rotate('rightWrist', 0, wave * 0.32 + pose * 0.4 + gesture.hand * .38,
      wave * Math.sin(elapsed * 13) * 0.37 - pulse * 0.24);
    rotate('leftArm', -0.07 - sway * 0.35 - gesture.oppositeHand * .46, 0,
      -0.42 + laugh * 0.18 + leftLift * 0.72 - sway * 0.51 + gesture.oppositeHand * .6);
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
    morph('まばたき', reducedMotion || expression === 'amused' ? 0 : blink, fade);
    morph('にやり', ['smile', 'amused'].includes(expression) ? 0.55 * (1 - mouth) : 0, fade);
    morph('笑い', expression === 'amused' ? 0.82 * (1 - mouth * .55) : 0, fade);
    morph('びっくり', expression === 'surprised' ? 0.68 : 0, fade);
    morph('あ', mouth * .96 - talking.round * .34, fade);
    morph('お', talking.round * .52 + mouth * .09, fade);
    mixer?.update(dt);
    if (vrm) {
      head?.rotation.set(nod * (0.12 + 0.17 * Math.cos(elapsed * 10)) + 0.12 * pet + gesture.pitch,
        0.08 * sway, 0.12 * pet + 0.07 * sway + gesture.tilt);
      if (chest && !mixer) chest.rotation.set(gesture.lean, gesture.hand * .12, -gesture.tilt * .3);
      const values = {
        blink: reducedMotion ? 0 : blink, aa: mouth * .92 - talking.round * .3, oh: talking.round * .5,
        happy: expression === 'smile' || expression === 'amused' ? 0.5 : 0,
        surprised: expression === 'surprised' ? 0.65 : 0,
      };
      for (const [name, value] of Object.entries(values)) {
        if (expressionManager?.getExpression(name)) {
          expressionManager.setValue(name, THREE.MathUtils.lerp(expressionManager.getValue(name) ?? 0, value, fade));
        }
      }
      vrm.update(dt);
    }
    controls.update();
    renderer.render(scene, targetCamera);
  }
  draw(performance.now());
  renderer.setAnimationLoop(time => draw(time));

  return {
    textureWarning,
    media: {
      mode: pmx ? 'pmx' : vrm ? 'vrm' : clips.length ? 'clips' : 'static',
      animationCount: clips.length,
      mouthSync: pmx ? Object.hasOwn(mesh.morphTargetDictionary ?? {}, 'あ') : Boolean(expressionManager?.getExpression('aa')),
    },
    play(nextAction, nextExpression) {
      action = nextAction;
      expression = nextExpression;
      startedAt = performance.now() / 1000;
    },
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
    dispose() {
      renderer.setAnimationLoop(null);
      resize.disconnect();
      controls.dispose();
      mixer?.stopAllAction();
      disposeModel(mesh);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
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
