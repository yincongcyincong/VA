export const speakingStyles = {
  natural: { label: '自然聊天', rate: 0, volume: 0, tempo: .48, nod: .06, tilt: .05, lean: .035, hand: .26, mouth: .56 },
  lively: { label: '活泼雀跃', rate: 19, volume: 8, tempo: .78, nod: .11, tilt: .105, lean: .07, hand: .53, mouth: .66 },
  thoughtful: { label: '轻声思考', rate: -23, volume: -22, tempo: .29, nod: .035, tilt: .22, lean: .07, hand: .085, mouth: .45 },
  dramatic: { label: '舞台演说', rate: -9, volume: 22, tempo: .58, nod: .13, tilt: .09, lean: .16, hand: .80, mouth: .62 },
};
export const defaultSpeakingStyle = 'natural';
export const isSpeakingStyle = value => typeof value === 'string' && Object.hasOwn(speakingStyles, value);
export const speakingPreset = style => speakingStyles[isSpeakingStyle(style) ? style : defaultSpeakingStyle];

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const rest = { open: 0, round: 0, pitch: 0, tilt: 0, lean: 0, hand: 0, oppositeHand: 0 };

export function textSpeechDuration(text, style) {
  return Math.max(2100, Math.min(12_000, Array.from(text).length * 140 / (1 + speakingPreset(style).rate / 100)));
}

function syllables(text) {
  let end = 0;
  const units = Array.from(text, char => {
    const pause = /[\s\p{P}\p{S}]/u.test(char);
    const length = /[。！？.!?\n]/u.test(char) ? 2.2 : pause ? .9 : /[a-z]/i.test(char) ? .65 : 1;
    const start = end;
    end += length;
    return { start, end, pause, round: /[ou]/i.test(char) };
  });
  return { units, end };
}

export function createSpeechMotion(text, style, duration, audioLevel, reducedMotion = false) {
  const { units, end } = syllables(text);
  const preset = speakingPreset(style);
  return elapsed => {
    if (elapsed < 0 || elapsed >= duration) return rest;
    const position = elapsed / duration * end;
    const unit = units.find(unit => position < unit.end);
    const cycle = unit ? (position - unit.start) / (unit.end - unit.start) : 0;
    const shape = unit && !unit.pause ? Math.sin(Math.PI * cycle) : 0;
    const mouthFade = smooth(elapsed / .11) * smooth((duration - elapsed) / .16);
    const level = audioLevel ? clamp((audioLevel() - .055) / .84) : shape * .76;
    const open = level * preset.mouth * mouthFade;
    const round = open * (.43 + (unit?.round ? .22 * shape : 0));
    const gesture = smooth(elapsed / .28) * smooth((duration - elapsed) / .36) * (reducedMotion ? .18 : 1);
    const beat = elapsed * preset.tempo * 2 * Math.PI;
    const swell = Math.sin(beat * .5) ** 4;
    const lift = (.08 + .72 * swell) * gesture;
    const alternate = (.5 + .5 * Math.sin(beat * .32)) * lift;
    return {
      open, round,
      pitch: preset.nod * Math.sin(beat) * gesture * (.42 + .4 * swell),
      tilt: preset.tilt * (style === 'thoughtful' ? .65 + .13 * Math.sin(beat * .4) : Math.sin(beat * .37)) * gesture,
      lean: preset.lean * lift,
      hand: preset.hand * lift,
      oppositeHand: preset.hand * alternate * (style === 'dramatic' ? .95 : style === 'lively' ? .82 : .32),
    };
  };
}

export function smoothMouthWeight(current, target, dt) {
  const response = target > current ? 16 : 11;
  return current + (target - current) * (1 - Math.exp(-dt * response));
}
