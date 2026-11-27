import { ControlError } from '../lib/control.js';
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
export async function windowsRecognitionStatus(config, { script, binary, run = execFile } = {}) {
  const recognition = windowsRecognition(config);
  const setup = {
    workingDirectory: 'VA 仓库根目录',
    command: 'powershell -File scripts/setup-windows-sensevoice.ps1 -Python ' + quote(recognition.python || 'C:\\path\\to\\python.exe') +
      (recognition.modelDirectory ? ' -Destination ' + quote(recognition.modelDirectory) : ''),
    modelUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
    documentationUrl: 'https://github.com/yincongcyincong/VA/blob/main/WIN.md',
  };
  if (recognition.engine === 'system') return { engine: 'system', ready: true, missing: [], message: '使用 Windows 系统识别，无需下载 SenseVoice 模型。' };
  const files = [
    ['python', recognition.python], ['helper', binary], ['worker', script],
    ...['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'].map(name => [name, recognition.modelDirectory && join(recognition.modelDirectory, name)]),
  ];
  const missing = [];
  for (const [component, path] of files) {
    const info = path && await stat(path).catch(() => undefined);
    if (!info?.isFile() || !info.size) missing.push({ component, path: path || '' });
  }
  if (missing.length) return { engine: 'sensevoice', ready: false, missing, setup,
    message: 'SenseVoice 尚未就绪，缺少：' + missing.map(item => item.component).join('、') + '。请先下载模型并安装依赖，或在「语音 → 语音识别」修正路径。' };
  const checked = await new Promise(resolve => {
    run(recognition.python, ['-I', '-u', '-X', 'utf8', script, recognition.modelDirectory, '--check'],
      { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve(false);
        resolve(String(stdout).split(/\r?\n/).some(line => {
          try { const event = JSON.parse(line); return event.type === 'check' && event.ok === true; } catch { return false; }
        }));
      });
  });
  return { engine: 'sensevoice', ready: checked, missing: checked ? [] : [{ component: 'runtime-or-model', path: recognition.python }], setup,
    message: checked ? 'SenseVoice 环境和模型已就绪。' : 'SenseVoice 环境或模型无法加载。请运行安装脚本补齐 sherpa-onnx、numpy 和模型文件，并检查模型目录。' };
}

export async function requireWindowsRecognition(config, options) {
  const status = await windowsRecognitionStatus(config, options);
  if (!status.ready) throw new ControlError('ASR_SETUP', status.message + '\n安装命令（在 VA 仓库根目录运行）：' + status.setup.command);
  return status;
}

export function windowsRecognition(config = {}, legacy = {}) {
  const value = config ?? { engine: legacy.recognitionEngine, python: legacy.recognitionPython,
    modelDirectory: legacy.recognitionModelDirectory };
  const result = { engine: value.engine ?? 'system', python: value.python ?? '', modelDirectory: value.modelDirectory ?? '' };
  if (!['system', 'sensevoice'].includes(result.engine)) throw new ControlError('VOICE_CONFIG', '请选择有效的语音识别引擎。');
  for (const key of ['python', 'modelDirectory']) {
    if (typeof result[key] !== 'string' || result[key].length > 4096 || result[key].includes('\0'))
      throw new ControlError('VOICE_CONFIG', '语音识别路径无效。');
    result[key] = result[key].trim();
  }
  return result;
}

export function captionRecognition(value) {
  return { recognitionEngine: value.engine, recognitionPython: value.python, recognitionModelDirectory: value.modelDirectory };
}

export function senseVoiceMicrophone(config, script, binary, launch) {
  if (!config.python || !config.modelDirectory || !script || !binary)
    throw new ControlError('ASR_SETUP', '请在「语音 → 语音识别」配置 Python 和 SenseVoice 模型目录。');
  return launch(config.python, ['-I', '-u', '-X', 'utf8', script, config.modelDirectory,
    '--capture', binary, '--microphone'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}
