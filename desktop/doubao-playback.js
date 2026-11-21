import { actions, danceActions } from './actions.js';

export function createDoubaoPlayback({ getAvatar, bubble }) {
  let context;
  let analyser;
  let nextStart = 0;
  const playing = new Set();
  const samples = new Float32Array(512);
  let closeCaption;
  let danceTimer;
  let clientSpeechTimer;
  let clientLevel = 0;
  let ended = true;

  function level() {
    if (!playing.size) return 0;
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    return Math.min(.95, Math.sqrt(energy / samples.length) * 4.4);
  }

  function afterAudio() {
    if (playing.size || !ended) return;
    getAvatar()?.stopSpeaking();
    clearTimeout(closeCaption);
    closeCaption = setTimeout(() => bubble('', ''), 3000);
  }

  function append(pcm, speakingStyle) {
    const avatar = getAvatar();
    if (!avatar) return;
    if (!context) {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = samples.length;
      analyser.connect(context.destination);
      void context.resume().catch(console.error);
    }
    ended = false;
    clearTimeout(closeCaption);
    if (!playing.size) avatar.speak('实时语音', speakingStyle, 300_000, level);
    const audio = context.createBuffer(1, pcm.byteLength / 2, 24_000);
    const input = new DataView(pcm);
    const output = audio.getChannelData(0);
    for (let i = 0; i < output.length; i++) output[i] = input.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(analyser);
    playing.add(source);
    source.onended = () => {
      playing.delete(source);
      source.disconnect();
      afterAudio();
    };
    const now = context.currentTime;
    if (nextStart <= now) nextStart = now + .04;
    source.start(nextStart);
    nextStart += audio.duration;
  }

  function clear() {
    for (const source of playing) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    playing.clear();
    nextStart = 0;
    ended = true;
    getAvatar()?.stopSpeaking();
    clearTimeout(closeCaption);
    bubble('', '');
  }

  function stopDance() {
    if (!danceTimer) return;
    clearTimeout(danceTimer);
    danceTimer = undefined;
    getAvatar()?.play('idle', 'neutral');
  }

  function stopClientSpeech() {
    if (!clientSpeechTimer) return;
    clearTimeout(clientSpeechTimer);
    clientSpeechTimer = undefined;
    clientLevel = 0;
    getAvatar()?.stopSpeaking();
  }

  function clientSpeech(level, speakingStyle) {
    clientLevel = level;
    if (level < .025) return;
    const avatar = getAvatar();
    if (!avatar) return;
    if (!clientSpeechTimer) avatar.speak('豆包正在说话', speakingStyle, 300_000, () => clientLevel);
    clearTimeout(clientSpeechTimer);
    clientSpeechTimer = setTimeout(stopClientSpeech, 260);
  }

  return {
    output(event) {
      switch (event.type) {
        case 'client-speech': clientSpeech(event.level, event.speakingStyle); break;
        case 'client-speech-end': stopClientSpeech(); break;
        case 'audio': append(event.pcm, event.speakingStyle); break;
        case 'subtitle':
          clearTimeout(closeCaption);
          bubble(event.text, event.text.match(/[\s\S]{1,58}/gu)?.at(-1) ?? '');
          break;
        case 'done':
          ended = true;
          afterAudio();
          break;
        case 'interrupt':
          clear();
          break;
        case 'clear':
          clear();
          stopClientSpeech();
          stopDance();
          break;
      }
    },
    dance(action) {
      const avatar = getAvatar();
      if (!avatar || danceTimer || !danceActions.includes(action)) return false;
      avatar.play(action, 'amused');
      danceTimer = setTimeout(stopDance, actions[action].seconds * 1000);
      return true;
    },
    stopDance,
    stopClientSpeech,
  };
}
