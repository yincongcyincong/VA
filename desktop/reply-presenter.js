import { splitReplySpeech } from './speech.js';

const danceFailures = ['MODEL_ACTION', 'BUSY'];

// 把一条已完成的回复排入桌面表演：优先按舞步意图入队，舞步排不进去时降级为台词朗读，
// 避免把一次成功的对话报成失败。依赖全部注入，便于在主进程和单测中复用。
export function createReplyPresenter({ parseReply, queueDance, queueSpeech, queueLines, speechCapacity }) {
  return function showReply(text, source, readAloud, effect) {
    const selection = effect ?? parseReply(text);
    const speech = selection.speech ?? text;
    if (selection.dance) {
      const [first, ...rest] = splitReplySpeech(speech);
      if (rest.length && !speechCapacity()) return false;
      try {
        queueDance(selection.dance, { speech: first, expression: selection.expression, readAloud, source, scope: selection.scope });
      } catch (error) {
        if (!danceFailures.includes(error?.code)) throw error;
        return queueSpeech(speech, source, readAloud, { ...selection, dance: undefined });
      }
      if (rest.length) queueLines(rest, source, readAloud, selection.scope);
      return true;
    }
    return queueSpeech(speech, source, readAloud, selection);
  };
}
