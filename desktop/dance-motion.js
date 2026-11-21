const fullTurn = Math.PI * 2;
const still = {
  sway: 0, pulse: 0, rightStep: 0, leftStep: 0, rightLift: 0, leftLift: 0,
  x: 0, y: 0, yaw: 0,
};

export function danceMotion(action, elapsed, strength) {
  if (!strength) return still;
  const beat = elapsed * fullTurn;
  switch (action) {
    case 'dance': {
      const sway = Math.sin(beat) * strength;
      const step = Math.cos(beat) * strength;
      return {
        sway, pulse: Math.cos(beat * 2) * strength,
        rightStep: Math.max(0, step), leftStep: Math.max(0, -step),
        rightLift: strength, leftLift: strength,
        x: sway * .64, y: Math.abs(sway) * .35, yaw: sway * .25,
      };
    }
    case 'dance-side': {
      const stride = Math.sin(beat * .56) * strength;
      const step = Math.cos(beat * .56) * strength;
      const accent = Math.abs(step);
      return {
        sway: stride, pulse: step * .65,
        rightStep: Math.max(0, step) * 1.32, leftStep: Math.max(0, -step) * 1.32,
        rightLift: stride * .55 + strength * .55, leftLift: strength * .55 - stride * .55,
        x: stride * 1.32, y: accent * .14, yaw: stride * .16,
      };
    }
    case 'dance-spin': {
      const progress = Math.min(1, Math.max(0, (elapsed - .9) / 3.8));
      const turn = fullTurn * progress * progress * (3 - 2 * progress);
      const step = Math.sin(beat * 1.25) * strength;
      const flourish = Math.sin(Math.PI * progress) * strength;
      return {
        sway: step * .22, pulse: Math.cos(beat) * strength * .45,
        rightStep: Math.max(0, step) * .68, leftStep: Math.max(0, -step) * .68,
        rightLift: strength * .62 + flourish * .53, leftLift: strength * .62 - flourish * .32,
        x: Math.sin(turn) * flourish * .46, y: Math.abs(step) * .17, yaw: turn,
      };
    }
    case 'dance-bounce': {
      const jump = Math.max(0, Math.sin(beat * 1.55)) * strength;
      const bend = Math.max(0, -Math.sin(beat * 1.55)) * strength;
      const swing = Math.sin(beat * .775) * strength;
      return {
        sway: swing * .30, pulse: Math.cos(beat * 1.55) * strength * 1.45,
        rightStep: bend * .83, leftStep: bend * .83,
        rightLift: strength * .66 + swing * .45 + jump * .22,
        leftLift: strength * .66 - swing * .45 + jump * .22,
        x: swing * .28, y: jump * .55 - bend * .05, yaw: swing * .15,
      };
    }
    default: return still;
  }
}
