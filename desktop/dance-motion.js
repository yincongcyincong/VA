const fullTurn = Math.PI * 2;
const stepLift = value => Math.max(0, value) ** 2;
const still = {
  sway: 0, pulse: 0, rightStep: 0, leftStep: 0, rightLift: 0, leftLift: 0,
  x: 0, y: 0, yaw: 0,
};

export function danceMotion(action, elapsed, strength) {
  if (!strength) return still;
  switch (action) {
    case 'dance': {
      const beat = elapsed * fullTurn * .70;
      const sway = Math.sin(beat);
      const step = Math.cos(beat);
      return {
        sway: sway * .56 * strength, pulse: Math.sin(beat * 2) * .36 * strength,
        rightStep: stepLift(step) * .68 * strength, leftStep: stepLift(-step) * .68 * strength,
        rightLift: (.46 + sway * .14) * strength, leftLift: (.46 - sway * .14) * strength,
        x: sway * .48 * strength, y: step * step * .12 * strength, yaw: sway * .13 * strength,
      };
    }
    case 'dance-side': {
      const beat = elapsed * fullTurn * .46;
      const stride = Math.sin(beat);
      const step = Math.cos(beat);
      return {
        sway: stride * .68 * strength, pulse: step * .42 * strength,
        rightStep: stepLift(step) * .95 * strength, leftStep: stepLift(-step) * .95 * strength,
        rightLift: (.38 + stride * .25) * strength, leftLift: (.38 - stride * .25) * strength,
        x: stride * .96 * strength, y: step * step * .11 * strength, yaw: stride * .15 * strength,
      };
    }
    case 'dance-spin': {
      const progress = Math.min(1, Math.max(0, (elapsed - .65) / 4.7));
      const turn = fullTurn * progress * progress * (3 - 2 * progress);
      const beat = elapsed * fullTurn * .83;
      const step = Math.sin(beat);
      const flourish = Math.sin(Math.PI * progress);
      return {
        sway: step * .12 * strength, pulse: Math.cos(beat) * .22 * strength,
        rightStep: stepLift(step) * .52 * strength, leftStep: stepLift(-step) * .52 * strength,
        rightLift: (.34 + flourish * .32) * strength, leftLift: (.34 - flourish * .15) * strength,
        x: Math.sin(turn) * flourish * .24 * strength, y: step * step * .08 * strength, yaw: turn,
      };
    }
    case 'dance-bounce': {
      const beat = elapsed * fullTurn * .90;
      const step = Math.sin(beat);
      const jump = stepLift(step);
      const bend = stepLift(-step);
      const swing = Math.sin(beat * .5);
      return {
        sway: swing * .26 * strength, pulse: Math.cos(beat) * .50 * strength,
        rightStep: bend * .62 * strength, leftStep: bend * .62 * strength,
        rightLift: (.44 + swing * .27 + jump * .11) * strength,
        leftLift: (.44 - swing * .27 + jump * .11) * strength,
        x: swing * .24 * strength, y: (jump * .27 - bend * .09) * strength, yaw: swing * .10 * strength,
      };
    }
    default: return still;
  }
}
