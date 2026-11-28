import { spokenDialogue, splitReplySpeech } from './speech.js';

const danceFailures = ['MODEL_ACTION', 'BUSY'];

// 把一条已完成的回复排入桌面表演：优先按舞步意图入队，舞步排不进去时降级为台词朗读，
// 避免把一次成功的对话报成失败。依赖全部注入，便于在主进程和单测中复用。
export function createReplyPresenter({ parseReply, queueDance, queueSpeech, queueLines, speechCapacity }) {
  return function showReply(text, source, readAloud, effect) {
    const selection = effect ?? parseReply(text);
    const original = selection.speech ?? text;
    const speech = readAloud ? spokenDialogue(original) : original;
    if (readAloud && speech !== original && !/[\p{L}\p{N}]/u.test(speech)) {
      if (!selection.action && !selection.expression && !selection.dance) return true;
      readAloud = false;
    }
    if (selection.dance) {
      const lines = speech ? splitReplySpeech(speech) : [];
      if (lines.length && !speechCapacity()) return false;
      try {
        queueDance(selection.dance, { expression: selection.expression, source, scope: selection.scope });
      } catch (error) {
        if (!danceFailures.includes(error?.code)) throw error;
        return queueSpeech(speech, source, readAloud, { ...selection, dance: undefined });
      }
      if (lines.length) queueLines(lines, source, readAloud, selection.scope);
      return true;
    }
    return queueSpeech(speech, source, readAloud, selection);
  };
}
