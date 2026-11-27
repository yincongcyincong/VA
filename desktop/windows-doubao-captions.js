import { spawn } from 'node:child_process';
import { ControlError } from '../lib/control.js';
import { createDoubaoCaptions } from './doubao-captions.js';

export function windowsCaptionRecognition(config = {}) {
  const recognitionEngine = config.recognitionEngine ?? 'system';
  if (!['system', 'sensevoice'].includes(recognitionEngine)) throw new ControlError('INVALID_REQUEST', '请选择有效的字幕识别引擎。');
  const fields = { recognitionEngine };
  for (const key of ['recognitionPython', 'recognitionModelDirectory']) {
    const value = config[key] ?? '';
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new ControlError('INVALID_REQUEST', '识别模型路径无效。');
    fields[key] = value.trim();
  }
  return fields;
}

// Conservative local phrase matching. Only select actions present in this
// model's supported catalog; no cloud classifier or transcript upload.
export function windowsCaptionAction(text, { actions = [], expressions = [] } = {}) {
  if (/[“”「」『』"'`]/u.test(text) || /(?:不要|不能|不想|不会|别|不必|无法).{0,20}(?:挥手|点头|鞠躬|跳.{0,4}舞|飞吻|摆姿势|侧步摇摆|转身亮相|弹跳挥手)/u.test(text)) return undefined;
  const rules = [
    ['wave', /(?:我来|我向你|我朝你|给你|向你|朝你).{0,5}挥(?:挥)?手/u],
    ['nod', /(?:我|向你).{0,4}点(?:点)?头/u],
    ['bow', /(?:我|向你|给你).{0,5}鞠(?:个|一)?躬/u],
    ['dance-side', /(?:我来|我给你|给你).{0,5}侧步摇摆/u],
    ['dance-spin', /(?:我来|我给你|给你).{0,5}转身亮相/u],
    ['dance-bounce', /(?:我来|我给你|给你).{0,5}弹跳挥手/u],
    [(['dance-side', 'dance-spin', 'dance-bounce', 'dance'].find(id => actions.some(item => item.id === id))), /(?:我来|我给你|给你).{0,5}跳(?:一支|个|一段)?舞/u],
    ['kiss', /(?:给你|送你).{0,4}飞吻/u],
    ['pose', /(?:我来|我给你).{0,4}摆(?:个|一个)?姿势/u],
  ];
  const action = rules.find(([id, pattern]) => actions.some(item => item.id === id) && pattern.test(text))?.[0];
  const expression = expressions.some(item => item.id === 'smile') && /我微笑/u.test(text) ? 'smile' : undefined;
  return action || expression ? { action, expression } : undefined;
}

export function createWindowsDoubaoCaptions(options) {
  let autoActions = false;
  const history = [];
  let partial = '';
  let recognition = windowsCaptionRecognition();
  const present = state => ({ ...state, text: [...history, partial].filter(Boolean).join('\n'), captureScope: 'default-output-mix',
    message: state.message === '正在显示豆包的语音字幕。' ? '正在显示默认扬声器的语音字幕（包含其他应用声音）。'
      : state.message === '已收到豆包音频，正在识别…' ? '已收到扬声器音频，正在本机识别…' : state.message });
  const controller = createDoubaoCaptions({
    ...options,
    launch: (binary, flags) => {
      const senseVoice = recognition.recognitionEngine === 'sensevoice';
      return (options.launch ?? spawn)(senseVoice ? recognition.recognitionPython : binary,
        senseVoice ? ['-I', '-u', '-X', 'utf8', options.senseVoiceScript, recognition.recognitionModelDirectory,
          '--capture', binary, '--system-output'] : ['--system-output', ...flags],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    },
    onState: state => options.onState(present(state)),
    onCaption: (text, final) => {
      if (!text) { history.length = 0; partial = ''; }
      else if (final) {
        history.push(text); partial = '';
        while (history.length > 1 && history.join('\n').length > 6000) history.shift();
      } else partial = text;
      const handled = options.onCaption(text, final);
      if (final && autoActions && !handled) {
        const choice = windowsCaptionAction(text, options.getCandidates());
        if (choice) options.onAction(choice);
      }
      return handled;
    },
  });
  return { ...controller, state: () => present(controller.state()), start(value = {}) {
    if (value.systemOutput !== true) throw new ControlError('AUDIO_CAPTURE_CONSENT', '请先勾选允许采集默认扬声器的所有播放声音。');
    if (!controller.running()) {
      recognition = windowsCaptionRecognition(value);
      if (recognition.recognitionEngine === 'sensevoice') {
        if (!recognition.recognitionPython || !recognition.recognitionModelDirectory || !options.senseVoiceScript)
          throw new ControlError('ASR_SETUP', '请先安装 SenseVoice，并填写 Python 路径和模型目录。');
        if (value.listen) throw new ControlError('ASR_SETUP', 'SenseVoice 暂不支持麦克风动作监听，请取消该选项。');
      }
      autoActions = value.autoActions === true;
    }
    return present(controller.start(value));
  } };
}
