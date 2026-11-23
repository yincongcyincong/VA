export function createDoubaoPlayback({ getAvatar }) {
  let danceTimer;
  let clientSpeechTimer;
  let clientLevel = 0;

  function stopDance() {
    if (!danceTimer) return;
    clearTimeout(danceTimer);
    danceTimer = undefined;
    getAvatar()?.play();
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
        case 'clear':
          stopClientSpeech();
          stopDance();
          break;
      }
    },
    dance(plan) {
      const avatar = getAvatar();
      if (!avatar || danceTimer) return false;
      avatar.play(plan);
      danceTimer = setTimeout(stopDance, plan.seconds * 1000);
      return true;
    },
    stopDance,
    stopClientSpeech,
  };
}
