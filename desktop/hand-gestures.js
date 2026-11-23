import { Matrix4, Quaternion, Vector3 } from 'three';

function basis(direction, normal) {
  const x = direction.clone().normalize();
  const y = new Vector3().crossVectors(normal, x).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)));
}

function worldDirection(from, to) {
  return to.getWorldPosition(new Vector3()).sub(from.getWorldPosition(new Vector3()));
}

export function armBindDrop(upper, lower) {
  if (!upper || !lower) return 0;
  const arm = worldDirection(upper, lower);
  return Math.max(0, Math.atan2(-arm.y, Math.hypot(arm.x, arm.z)));
}

function bend(joint, child, direction, weight) {
  const current = worldDirection(joint, child).normalize();
  const parent = joint.parent.getWorldQuaternion(new Quaternion());
  const delta = new Quaternion().setFromUnitVectors(current, direction.normalize());
  const goal = parent.clone().invert().multiply(delta).multiply(parent).multiply(joint.quaternion);
  joint.quaternion.slerp(goal, weight);
  joint.updateWorldMatrix(true, true);
}

function aimArm({ upper, lower, hand, palmBasis }, wrist, elbowOut, fingers, palm, weight) {
  const shoulder = upper.getWorldPosition(new Vector3());
  const upperLength = worldDirection(upper, lower).length();
  const lowerLength = worldDirection(lower, hand).length();
  if (Math.min(upperLength, lowerLength) < 1e-5) return;
  const reach = wrist.clone().sub(shoulder);
  const span = reach.length();
  if (span < 1e-5) return;
  reach.divideScalar(span);
  const distance = Math.max(Math.abs(upperLength - lowerLength) + 1e-6, Math.min(span, (upperLength + lowerLength) * .995));
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const pole = elbowOut.clone().addScaledVector(reach, -elbowOut.dot(reach)).normalize();
  const elbow = shoulder.clone().addScaledVector(reach, along).addScaledVector(pole, height);
  const target = shoulder.clone().addScaledVector(reach, distance);
  bend(upper, lower, elbow.clone().sub(shoulder), weight);
  bend(lower, hand, target.sub(elbow), weight);
  const parent = hand.parent.getWorldQuaternion(new Quaternion());
  const facing = parent.invert().multiply(basis(fingers, palm)).multiply(palmBasis);
  hand.quaternion.slerp(facing, weight);
}

export function createHandGestures(rig, model, findFinger) {
  const arms = {};
  const fingerRest = new Map();
  const forward = new Vector3(0, 0, 1).applyQuaternion(model.getWorldQuaternion(new Quaternion()));
  for (const [side, sign] of [['right', -1], ['left', 1]]) {
    const upper = rig[side + 'Arm'];
    const lower = rig[side + 'Elbow'];
    const hand = rig[side + 'Wrist'];
    if (!upper || !lower || !hand) continue;
    const middle = findFinger(side, 'middle');
    const index = findFinger(side, 'index');
    const little = findFinger(side, 'little');
    const forearm = worldDirection(lower, hand);
    const fingers = middle ? worldDirection(hand, middle) : forearm;
    const inverse = hand.getWorldQuaternion(new Quaternion()).invert();
    const thumbward = index && little ? worldDirection(little, index) : forward.clone().multiplyScalar(-1);
    const palm = new Vector3().crossVectors(fingers, thumbward).multiplyScalar(sign);
    if (palm.lengthSq() < 1e-8) palm.set(0, -1, 0);
    const palmBasis = basis(fingers.clone().applyQuaternion(inverse), palm.applyQuaternion(inverse)).invert();
    const knuckles = ['index', 'middle', 'ring', 'little'].map(digit => findFinger(side, digit, 'Intermediate'));
    arms[side] = { upper, lower, hand, palmBasis, sign, knuckles, palmLength: middle ? fingers.length() : forearm.length() * .38 };
  }

  function reset() {
    for (const [joint, rotation] of fingerRest) joint.quaternion.copy(rotation);
    fingerRest.clear();
  }

  function curl(arm, front, strength) {
    for (const [index, joint] of arm.knuckles.entries()) {
      if (!joint) continue;
      fingerRest.set(joint, joint.quaternion.clone());
      const localAxis = front.clone().applyQuaternion(joint.parent.getWorldQuaternion(new Quaternion()).invert());
      joint.quaternion.premultiply(new Quaternion().setFromAxisAngle(localAxis, arm.sign * (.73 + index * .14) * strength));
    }
  }

  function apply(action, elapsed, strength) {
    reset();
    if (!strength || (action !== 'wave' && action !== 'pose-heart') || !arms.right) return;
    const rotation = model.getWorldQuaternion(new Quaternion());
    const vector = (x, y, z) => new Vector3(x, y, z).applyQuaternion(rotation);
    const front = vector(0, 0, 1);
    if (action === 'wave') {
      const arm = arms.right;
      const span = worldDirection(arm.upper, arm.lower).length() + worldDirection(arm.lower, arm.hand).length();
      const sway = Math.sin(elapsed * 13);
      const target = arm.upper.getWorldPosition(new Vector3()).add(vector(span * (-.53 + sway * .065), span * .46, span * .32));
      aimArm(arm, target, vector(-.8, -.7, .05), vector(-.24 + sway * .32, 1, 0), front, strength);
    } else if (arms.left) {
      const gap = (arms.right.palmLength + arms.left.palmLength) * .50;
      const center = arms.right.upper.getWorldPosition(new Vector3()).lerp(arms.left.upper.getWorldPosition(new Vector3()), .5);
      for (const arm of [arms.right, arms.left]) {
        const span = worldDirection(arm.upper, arm.lower).length() + worldDirection(arm.lower, arm.hand).length();
        const target = center.clone().add(vector(gap * arm.sign, -span * .28, span * .66));
        aimArm(arm, target, vector(arm.sign, -1, 0), vector(-arm.sign * .29, 1, 0),
          vector(arm.sign * .18, 0, 1), strength);
        curl(arm, front, strength);
      }
    }
  }

  return { apply, reset };
}
