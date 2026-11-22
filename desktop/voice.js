export function createVoice() {
  let context;
  let analyser;
  let source;
  const samples = new Float32Array(512);

  async function prepare(text, signal) {
    signal.throwIfAborted();
    let cancel;
    const canceled = new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    let response;
    try {
      response = await Promise.race([window.va.speech(text), canceled]);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    return { audio: await decode(response.audio, signal), warning: response.warning };
  }

  async function decode(audio, signal) {
    signal.throwIfAborted();
    if (!context) {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = samples.length;
      analyser.connect(context.destination);
    }
    const buffer = await context.decodeAudioData(audio);
    await context.resume();
    signal.throwIfAborted();
    return buffer;
  }

  function play(buffer, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const playing = context.createBufferSource();
      playing.buffer = buffer;
      playing.connect(analyser);
      source = playing;
      const cancel = () => {
        playing.stop();
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      playing.onended = () => {
        if (source === playing) source = undefined;
        playing.disconnect();
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      playing.start();
    });
  }

  function level() {
    if (!source) return 0;
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    return Math.min(0.95, Math.sqrt(energy / samples.length) * 4.4);
  }

  return { prepare, decode, play, level };
}
