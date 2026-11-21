import { actions, expressions } from '../desktop/actions.js';
import { ControlError, request } from './control.js';
import { startDesktop, takeSelfie } from './start.js';

const invalid = message => new ControlError('INVALID_ARGUMENTS', message);

async function readCommand() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 8192) throw invalid('机器人请求超过 8 KB。');
    chunks.push(chunk);
  }
  try {
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error();
    return command;
  } catch {
    throw invalid('请从 stdin 传入一个 JSON 对象。');
  }
}

function voiceParams(command) {
  const { speech, expression } = command;
  if (speech !== undefined && (typeof speech !== 'string' || speech.length > 300)) {
    throw invalid('台词最多 300 字。');
  }
  if (expression !== undefined && (typeof expression !== 'string' || !Object.hasOwn(expressions, expression))) {
    throw invalid('表情可选 neutral、smile、amused 或 surprised。');
  }
  return { speech, expression };
}

async function withDesktop(command) {
  try {
    return await request(command);
  } catch (error) {
    if (!['NOT_RUNNING', 'NOT_READY'].includes(error.code)) throw error;
    await startDesktop();
    return await request(command);
  }
}

export async function runBotBridge() {
  const command = await readCommand();
  switch (command.op) {
    case 'status': {
      const state = await request({ type: 'status' }).catch(error => {
        if (error.code !== 'NOT_RUNNING') throw error;
        return { state: 'off', visible: false };
      });
      const { state: status, visible, scale, view, character, performance } = state;
      return { state: status, visible, scale, view, character, action: performance?.action ?? null };
    }
    case 'events': {
      if (!['astrbot', 'openclaw'].includes(command.platform) ||
          (command.cursor !== undefined && (typeof command.cursor !== 'string' || command.cursor.length > 120))) {
        throw invalid('频道事件请求无效。');
      }
      return await request({ type: 'bot-events', platform: command.platform, cursor: command.cursor })
        .catch(error => {
          if (error.code !== 'NOT_RUNNING') throw error;
          return { route: null, events: [] };
        });
    }
    case 'chat':
      if (!['astrbot', 'openclaw'].includes(command.platform) || typeof command.conversation !== 'string' ||
          !command.conversation.trim() || command.conversation.length > 240 || typeof command.text !== 'string' ||
          !command.text.trim() || command.text.length > 1500) throw invalid('请提供对话会话和 1–1500 字的消息。');
      return await withDesktop({
        type: 'bot-chat', platform: command.platform, conversation: command.conversation, text: command.text,
      });
    case 'present':
      return await request({ type: 'bot-present', platform: command.platform, origin: command.origin, text: command.text })
        .catch(error => {
          if (error.code === 'NOT_RUNNING') return { accepted: false };
          throw error;
        });
    case 'input':
      return await request({ type: 'bot-input', platform: command.platform, origin: command.origin, text: command.text })
        .catch(error => {
          if (error.code === 'NOT_RUNNING') return { accepted: false };
          throw error;
        });
    case 'route':
      return await request({ type: 'bot-route', platform: command.platform }).catch(error => {
        if (error.code === 'NOT_RUNNING') return { route: null };
        throw error;
      });
    case 'say': {
      const params = voiceParams(command);
      if (!params.speech?.trim()) throw invalid('请提供要朗读的台词。');
      return await withDesktop({ type: 'bot-perform', platform: command.platform, ...params, wait: true });
    }
    case 'perform': {
      const params = voiceParams(command);
      if (typeof command.action !== 'string' || !Object.hasOwn(actions, command.action) || command.action === 'idle') {
        throw invalid('请指定有效的动作。');
      }
      return await withDesktop({ type: 'bot-perform', platform: command.platform, action: command.action, ...params, wait: true });
    }
    case 'selfie': {
      const { png, ...result } = await takeSelfie({ ...voiceParams(command), bot: true, platform: command.platform });
      return { ...result, image: { mimeType: 'image/png', data: png } };
    }
    case 'view':
      if (!['full', 'portrait'].includes(command.mode)) throw invalid('视角可选 full 或 portrait。');
      return await withDesktop({ type: 'view', platform: command.platform, mode: command.mode });
    default:
      throw invalid('未知的机器人操作。');
  }
}
