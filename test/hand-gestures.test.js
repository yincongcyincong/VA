import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group, Quaternion, Vector3 } from 'three';
import { armBindDrop, createHandGestures } from '../desktop/hand-gestures.js';

function armsFixture() {
  const root = new Group();
  const rig = {};
  const fingers = {};
  const joint = (parent, x, y) => {
    const child = new Group();
    child.position.set(x, y, 0);
    parent.add(child);
    return child;
  };
  for (const [side, sign] of [['right', -1], ['left', 1]]) {
    const upper = joint(root, sign * .2, 1.25);
    const elbow = joint(upper, sign * .25, 0);
    const wrist = joint(elbow, sign * .22, 0);
    rig[side + 'Arm'] = upper;
    rig[side + 'Elbow'] = elbow;
    rig[side + 'Wrist'] = wrist;
    fingers[side] = { index: joint(wrist, sign * .08, .025), middle: joint(wrist, sign * .08, 0), little: joint(wrist, sign * .07, -.025) };
    fingers[side].indexTip = joint(fingers[side].index, sign * .03, 0);
  }
  return { rig, fingers, ...createHandGestures(rig, root, (side, finger, segment) =>
    segment === 'Intermediate' ? fingers[side][finger + 'Tip'] : fingers[side][finger]) };
}

test('wave raises the wrist and keeps the palm facing the viewer', () => {
  const { rig, apply } = armsFixture();
  apply('wave', .6, 1);
  const wrist = rig.rightWrist.getWorldPosition(new Vector3());
  const palm = new Vector3(0, 0, 1).applyQuaternion(rig.rightWrist.getWorldQuaternion(new Quaternion()));
  assert.ok(wrist.y > 1.4);
  assert.ok(wrist.z > .1);
  assert.ok(palm.z > .98);
});

test('procedural arm motion compensates for an A-pose bind angle', () => {
  const upper = new Group();
  const elbow = new Group();
  upper.add(elbow);
  elbow.position.set(1, 0, 0);
  assert.equal(armBindDrop(upper, elbow), 0);
  elbow.position.set(1, -1, 0);
  assert.ok(Math.abs(armBindDrop(upper, elbow) - Math.PI / 4) < 1e-6);
});

test('heart brings both wrists in front of and near the center of the chest', () => {
  const { rig, fingers, apply, reset } = armsFixture();
  apply('pose-heart', 1, 1);
  const right = rig.rightWrist.getWorldPosition(new Vector3());
  const left = rig.leftWrist.getWorldPosition(new Vector3());
  assert.ok(right.z > .23 && left.z > .23);
  assert.ok(right.x < 0 && left.x > 0 && left.x - right.x < .2);
  assert.ok(Math.abs(left.y - right.y) < .001);
  const neutral = new Quaternion();
  assert.ok(fingers.right.indexTip.quaternion.angleTo(neutral) > .6);
  reset();
  assert.ok(fingers.right.indexTip.quaternion.angleTo(neutral) < .001);
});
