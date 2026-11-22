import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ControlError } from '../lib/control.js';

const endpoint = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const defaultVoice = 'zh_female_vv_jupiter_bigtts';
const tool = {
  type: 'function',
  name: 'dance',
  description: '让桌面角色跳一小段舞。适合庆祝或主动表演时调用。明确的跳舞请求由 VA 处理，返回 already_scheduled 时表示已安排舞步。每轮最多一次。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
const transcription = 'conversation.item.input_audio_transcription.';
const clip = text => typeof text === 'string' ? text.slice(0, 2000) : '';
const keyFor = config => config?.apiKey || process.env.VOLC_REALTIME_API_KEY?.trim() || '';

export function doubaoConfig(config) {
  const { voice, prompt, allowDance, apiKey } = config?.doubao ?? {};
  return {
    voice: typeof voice === 'string' && voice.trim() ? voice.trim() : defaultVoice,
    prompt: typeof prompt === 'string' ? prompt : '',
    allowDance: allowDance !== false,
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
  };
}

export function doubaoSnapshot(config) {
  const { apiKey, ...visible } = doubaoConfig(config);
  return { ...visible, hasKey: Boolean(keyFor({ apiKey })) };
}

export function configureDoubao(config, change) {
  const { voice, prompt, apiKey, allowDance, clearKey } = change ?? {};
  if (typeof voice !== 'string' || (voice.trim() && !/^[-_.a-z0-9]{1,160}$/i.test(voice.trim())) ||
      typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n\0]/.test(apiKey) ||
      typeof prompt !== 'string' || prompt.length > 5000 || typeof allowDance !== 'boolean') {
    throw new ControlError('DOUBAO_CONFIG', '请检查实时语音 API Key、音色 ID 和附加 Prompt。');
  }
  return { ...config, doubao: { voice: voice.trim() || defaultVoice, prompt: prompt.trim(), allowDance,
    apiKey: clearKey === true ? '' : apiKey.trim() || doubaoConfig(config).apiKey } };
}

export function createDoubaoConversation({ onState, onOutput, onDance, onInput, onReply, connect = (url, options) => new WebSocket(url, options) }) {
  let session;
  let view = { phase: 'idle', error: '', history: [], input: '', reply: '' };
  let stateTimer;

  function publish(change, immediate = false) {
    view = { ...view, ...change };
    if (!immediate) {
      stateTimer ??= setTimeout(() => publish({}, true), 80);
      return;
    }
    clearTimeout(stateTimer);
    stateTimer = undefined;
    onState(view);
  }

  function remember(role, text) {
    if (text.trim()) view.history = [...view.history, { role, text: text.trim() }].slice(-40);
  }

  function conclude(call, error = '', terminate = true) {
    if (session !== call) return;
    session = undefined;
    clearTimeout(call.timer);
    if (terminate) call.socket.terminate();
    if (call.phase === 'connecting') call.reject(new ControlError('DOUBAO_CONNECTION', error || '已取消连接。'));
    remember('assistant', view.reply);
    publish({ phase: 'idle', error, input: '', reply: '' }, true);
    onOutput({ type: 'clear' });
  }

  function send(call, event) {
    try {
      call.socket.send(JSON.stringify({ ...event, event_id: randomUUID() }));
      return true;
    } catch {
      conclude(call, '豆包连接已断开。');
      return false;
    }
  }

  function endReply(type) {
    remember('assistant', view.reply);
    publish({ reply: '' });
    onOutput({ type });
  }

  async function executeTool(call, item) {
    let args;
    try { args = JSON.parse(item.arguments || '{}'); } catch {}
    if (session !== call || call.phase !== 'active' || !call.allowDance || item.name !== tool.name ||
        !args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) {
      return { status: 'unavailable' };
    }
    if (call.localDance) return { status: 'already_scheduled' };
    if (call.danced) return { status: 'unavailable' };
    call.danced = true;
    try {
      return { status: await onDance() ? 'started' : 'busy' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async function toolCalls(call, items) {
    if (!Array.isArray(items)) return;
    const pending = [];
    for (const item of items.slice(0, 16)) {
      const id = item?.call_id;
      if (typeof id !== 'string' || !id || id.length > 256) continue;
      let result = call.results.get(id);
      if (!result) {
        result = executeTool(call, item);
        call.results.set(id, result);
        if (call.results.size > 64) call.results.delete(call.results.keys().next().value);
      }
      pending.push(result.then(value => ({
        type: 'message', call_id: id, role: 'tool', content: [{ type: 'input_text', text: JSON.stringify(value) }],
      })));
    }
    const results = await Promise.all(pending);
    if (session === call && call.phase === 'active' && results.length) {
      send(call, { type: 'conversation.item.create', items: results });
    }
  }

  function receive(call, event) {
    if (session !== call || !event) return;
    if (event.type === 'error') {
      const raw = String(event.error?.code ?? event.error?.status_code ?? event.status_code ?? event.code ?? '');
      conclude(call, /^\d{3,10}$/.test(raw) ? `豆包实时语音返回错误（${raw}）。` : '豆包实时语音返回错误，请检查服务权限和音色。');
      return;
    }
    if (event.type === 'session.closed') {
      call.socket.close();
      conclude(call, call.phase === 'closing' ? '' : '豆包已结束会话。', false);
      return;
    }
    if (call.phase === 'connecting' && event.type === 'session.created') {
      clearTimeout(call.timer);
      call.phase = 'active';
      publish({ phase: 'active' }, true);
      call.resolve(call.id);
      return;
    }
    if (call.phase !== 'active') return;
    const responseId = event.response_id;
    if (event.type?.startsWith('response.')) {
      if (call.inputActive || (responseId && responseId === call.interruptedResponse)) return;
      if (responseId) call.responseId = responseId;
    }

    switch (event.type) {
      case transcription + 'started':
        if (view.reply) endReply('interrupt');
        else onOutput({ type: 'interrupt' });
        call.inputActive = true;
        call.interruptedResponse = call.responseId;
        call.danced = false;
        call.localDance = false;
        publish({ input: '' });
        break;
      case transcription + 'delta':
        publish({ input: clip(typeof event.delta === 'string' ? view.input + event.delta : event.transcript ?? event.text) || view.input });
        break;
      case transcription + 'completed': {
        const text = (clip(event.transcript ?? event.text) || view.input).trim();
        remember('user', text);
        if (!call.danced && onInput?.(text)) {
          call.localDance = true;
          call.danced = true;
        }
        call.inputActive = false;
        publish({ input: '' });
        break;
      }
      case transcription + 'failed':
        call.inputActive = false;
        publish({ input: '' });
        break;
      case 'response.output_text.delta':
      case 'response.output_text.done': {
        const reply = clip(event.type.endsWith('.delta') && typeof event.delta === 'string'
          ? view.reply + event.delta : event.text ?? event.transcript) || view.reply;
        if (reply !== view.reply) {
          publish({ reply });
          onOutput({ type: 'subtitle', text: reply });
        }
        break;
      }
      case 'response.output_audio.delta':
        if (typeof event.delta === 'string' && event.delta.length <= 256_000) {
          const pcm = Buffer.from(event.delta, 'base64');
          if (pcm.length && pcm.length % 2 === 0) onOutput({ type: 'audio', pcm: Uint8Array.from(pcm).buffer });
        }
        break;
      case 'response.done':
        if (!call.danced && view.reply) call.danced = onReply?.(view.reply, call.allowDance) === true;
        endReply('done');
        break;
      case 'response.canceled':
      case 'response.cancelled':
        endReply('interrupt');
        break;
      case 'response.function_call_arguments.done':
        void toolCalls(call, event.items);
        break;
    }
  }

  function start(config, prompt, characterName) {
    if (session) throw new ControlError('BUSY', '豆包语音正在连接或通话。');
    const key = keyFor(config);
    if (!key) throw new ControlError('DOUBAO_CONFIG', '请填写有实时语音权限的火山 API Key。');
    const socket = connect(endpoint, { headers: { 'X-Api-Key': key }, handshakeTimeout: 10_000, maxPayload: 512_000 });
    const result = Promise.withResolvers();
    const call = { socket, id: randomUUID(), phase: 'connecting', allowDance: config.allowDance,
      results: new Map(), ...result };
    session = call;
    call.timer = setTimeout(() => conclude(call, '等待豆包建立会话超时。'), 12_000);
    socket.on('open', () => {
      if (session !== call || call.phase !== 'connecting') return;
      send(call, { type: 'session.create', session: {
        model: '1.2.6.1',
        instructions: [config.prompt?.replaceAll('{{name}}', () => characterName), prompt,
          '用自然、简短的中文和用户语音聊天。' + (call.allowDance ? '可以用跳舞工具主动表演，每轮最多一次。' : '')].filter(Boolean).join('\n\n'),
        audio: {
          input: { format: { type: 'pcm', rate: 16_000 } },
          output: { format: { type: 'pcm_s16le', rate: 24_000 }, voice: config.voice },
        },
        tools: call.allowDance ? [tool] : [],
      }, extension: { asr: {}, tts: {}, dialog: {} } });
    });
    socket.on('message', (frame, binary) => {
      if (binary) return;
      let event;
      try { event = JSON.parse(frame.toString()); } catch { return; }
      receive(call, event);
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      conclude(call, `豆包连接返回 HTTP ${response.statusCode}，请检查 API Key 的实时语音权限。`);
    });
    socket.on('error', () => conclude(call, '无法连接豆包实时语音，请检查网络和 API Key。'));
    socket.on('close', () => conclude(call, call.phase === 'closing' ? '' : '豆包连接已断开。', false));
    publish({ phase: 'connecting', error: '', history: [], input: '', reply: '' }, true);
    return result.promise;
  }

  return {
    state: () => view,
    running: () => Boolean(session),
    start,
    audio(id, pcm) {
      const call = session;
      if (call?.phase !== 'active' || call.id !== id || !(pcm instanceof ArrayBuffer) || pcm.byteLength !== 640) return;
      if (call.socket.bufferedAmount > 32_000) {
        conclude(call, '语音上传跟不上，请重新连接。');
        return;
      }
      send(call, { type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') });
    },
    stop({ immediate = false } = {}) {
      const call = session;
      if (!call) return;
      if (immediate || call.phase === 'connecting') {
        conclude(call);
      } else if (call.phase === 'active') {
        clearTimeout(call.timer);
        call.phase = 'closing';
        publish({ phase: 'closing' }, true);
        onOutput({ type: 'clear' });
        call.timer = setTimeout(() => conclude(call), 1400);
        send(call, { type: 'session.close' });
      }
    },
  };
}
