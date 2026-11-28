import { ControlError } from './control.js';

export const cameraAgents = ['codex', 'claude', 'omp', 'custom'];
export const cameraQuestionLimit = 1500;
export const cameraModelLimit = 200;

export function cameraQuestion({ question, agent, model }) {
  const invalid = message => { throw new ControlError('INVALID_ARGUMENTS', message); };
  if (question === undefined) {
    if (agent !== undefined || model !== undefined) invalid('指定 Agent 或模型时请同时提供照片问题。');
    return;
  }
  if (typeof question !== 'string' || !question.trim() || question.length > cameraQuestionLimit || question.includes('\0')) {
    invalid('照片问题需要 1–1500 字。');
  }
  if (agent !== undefined && !cameraAgents.includes(agent)) invalid('照片支持 Codex、Claude Code、OMP 和自定义 Agent。');
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > cameraModelLimit ||
      model.includes('\0') || agent === 'custom')) invalid('请为支持模型选项的 Agent 提供有效的模型名称。');
  return { question: question.trim(), agent, model: model?.trim() };
}
