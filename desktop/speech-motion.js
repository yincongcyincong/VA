export const speakingStyles = {
  natural: { label: '自然聊天', tempo: 1.55, nod: .09, tilt: .035, lean: .025, hand: .28, mouth: .92 },
  lively: { label: '活泼雀跃', tempo: 2.45, nod: .15, tilt: .12, lean: .075, hand: .58, mouth: 1.12 },
  thoughtful: { label: '轻声思考', tempo: .85, nod: .045, tilt: .14, lean: .05, hand: .13, mouth: .72 },
  dramatic: { label: '舞台演说', tempo: 1.18, nod: .12, tilt: .05, lean: .13, hand: .82, mouth: 1.02 },
};
export const defaultSpeakingStyle = 'natural';
export const isSpeakingStyle = value => typeof value === 'string' && Object.hasOwn(speakingStyles, value);

const clamp = value => Math.max(0, Math.min(1, value));
const rest = { open: 0, round: 0, pitch: 0, tilt: 0, lean: 0, hand: 0, oppositeHand: 0 };

export function textSpeechDuration(text) {
  return Math.max(2100, Math.min(12_000, Array.from(text).length * 140));
}

function syllables(text) {
  let end = 0;
  const units = Array.from(text, char => {
    const pause = /[\s\p{P}\p{S}]/u.test(char);
    const length = /[。！？.!?\n]/u.test(char) ? 2.2 : pause ? .9 : /[a-z]/i.test(char) ? .65 : 1;
    const start = end;
    end += length;
    return { start, end, pause,
      round: /[ou]/i.test(char) || char.codePointAt(0) % 5 === 0 ? .68 : .2 };
  });
  return { units, end };
}

export function createSpeechMotion(text, style, duration, audioLevel, reducedMotion = false) {
  const { units, end } = syllables(text);
  const preset = speakingStyles[style] ?? speakingStyles[defaultSpeakingStyle];
  return elapsed => {
    if (elapsed < 0 || elapsed >= duration) return rest;
    const position = elapsed / duration * end;
    const unit = units.find(unit => position < unit.end);
    const cycle = unit ? (position - unit.start) / (unit.end - unit.start) : 0;
    const shape = unit && !unit.pause ? Math.sin(Math.PI * cycle) : 0;
    const fade = clamp(elapsed / .16) * clamp((duration - elapsed) / .23);
    const level = audioLevel ? clamp((audioLevel() - .025) * 1.12) : shape * .72;
    const open = clamp(level * preset.mouth * fade);
    const round = open * (unit?.round ?? .2);
    const gesture = reducedMotion ? fade * .18 : fade;
    const beat = elapsed * preset.tempo * 2 * Math.PI;
    const emphasis = level * .52;
    const lift = (.24 + .5 * (1 - Math.cos(beat * .51)) * .5 + emphasis) * gesture;
    const alternate = (.5 + .5 * Math.sin(beat * .29)) * lift;
    return {
      open, round,
      pitch: preset.nod * Math.sin(beat) * gesture * (.4 + emphasis),
      tilt: preset.tilt * (style === 'thoughtful' ? .55 + .25 * Math.sin(beat * .4) : Math.sin(beat * .48)) * gesture,
      lean: preset.lean * lift,
      hand: preset.hand * lift,
      oppositeHand: preset.hand * alternate * (style === 'lively' ? .8 : .38),
    };
  };
}
