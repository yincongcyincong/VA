import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { ControlError } from '../lib/control.js';

let pending;

export async function navigateDeepSeek(id, launch, signal) {
  const request = { id, token: randomUUID(), acknowledged: false };
  pending = request;
  try {
    if (!await launch()) throw new ControlError('AGENT_LAUNCH', '无法打开 DeepSeek Harness 桌面端。');
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (request.acknowledged) return;
      await setTimeout(100);
    }
    throw new ControlError('DEEPSEEK_NAVIGATION', 'DeepSeek Harness 没有确认打开这条会话。请点「同步角色能力」，重启 DeepSeek Harness 后再试。');
  } finally {
    if (pending === request) pending = undefined;
  }
}

export function deepSeekNavigation(done) {
  if (!pending || pending.acknowledged) return {};
  if (done !== null && done !== undefined) {
    if (done === pending.token) pending.acknowledged = true;
    return {};
  }
  return { navigation: { id: pending.id, token: pending.token } };
}
