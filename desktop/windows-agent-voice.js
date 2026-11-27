import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createAgentVoice } from './agent-voice.js';
import { ControlError } from '../lib/control.js';
import { windowsRecognition, senseVoiceMicrophone } from './windows-recognition.js';

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Keep Windows capture entirely separate from the macOS Swift helper. Both
// helpers emit the same JSON-lines protocol to the existing session controller.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Emit($event) {
  [Console]::WriteLine((ConvertTo-Json -InputObject $event -Compress))
  [Console]::Out.Flush()
}
$recognizer = $null
try {
  Add-Type -AssemblyName System.Speech
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($args -contains '--probe') {
    Emit @{ type = 'probe'; languages = @($installed | ForEach-Object { $_.Culture.Name }) }
    exit 0
  }
  Emit @{ type = 'loading'; message = '正在启动 Windows 本机语音识别…' }
  $preferred = [Globalization.CultureInfo]::CurrentUICulture.Name
  $info = $installed | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (!$info) { $info = $installed | Where-Object { $_.Culture.Name -eq $preferred } | Select-Object -First 1 }
  if (!$info) { $info = $installed | Select-Object -First 1 }
  if (!$info) {
    throw '未找到 Windows 本机语音识别引擎。请在 Windows 设置的语言选项中安装语音识别组件，然后重新开启监听。'
  }
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new([string]$info.Id)
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(2)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(15)
  $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(700)
  try { $recognizer.SetInputToDefaultAudioDevice() }
  catch { throw '无法打开 Windows 默认麦克风。请检查输入设备，并在「隐私和安全性 → 麦克风」允许桌面应用访问麦克风。' }
  # Watch the pipe on a background thread so a crashed parent cannot leave the
  # microphone helper running. No shell or child process is launched here.
  Add-Type -TypeDefinition @'
using System;
using System.Threading;
public static class VaMicrophoneLifetime {
    public static void Watch() {
        var thread = new Thread(() => { Console.ReadLine(); Environment.Exit(0); });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@
  [VaMicrophoneLifetime]::Watch()
  Emit @{ type = 'ready'; message = ('正在监听 Windows 麦克风（' + $info.Culture.Name + '），说完后会自动发送。') }
  while ($true) {
    $result = $recognizer.Recognize([TimeSpan]::FromSeconds(2))
    if ($null -ne $result -and ![string]::IsNullOrWhiteSpace($result.Text)) {
      Emit @{ type = 'user-input'; text = $result.Text }
      # The controller ends this helper before forwarding the utterance. Wait
      # for pipe closure instead of recording a second, potentially stale turn.
      [Threading.Thread]::Sleep([Threading.Timeout]::Infinite)
    }
  }
} catch {
  Emit @{ type = 'error'; message = ('Windows 语音输入失败：' + $_.Exception.Message) }
  exit 1
} finally {
  if ($null -ne $recognizer) { $recognizer.Dispose() }
}
`;

export function launchWindowsAgentVoice({ launch = spawn, probe = false } = {}) {
  // EncodedCommand is UTF-16LE, preserving Chinese messages without shell
  // interpolation. The script is bundled in JS, so it also works inside ASAR.
  const command = probe ? "& {\n" + script + "\n} '--probe'" : script;
  return launch(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
}

export function createWindowsAgentVoice({ send, onState, launch = spawn, resumeDelay, senseVoiceScript, captureBinary } = {}) {
  let recognition = windowsRecognition();
  const controller = createAgentVoice({
    send: async (...args) => {
      try { return await send(...args); }
      catch (error) {
        if (['DEEPSEEK_RESTART', 'DEEPSEEK_PROFILE'].includes(error.code)) {
          throw new ControlError('AGENT_SESSION_CHANGED', error.message);
        }
        throw error;
      }
    }, onState, resumeDelay,
    launch: () => recognition.engine === 'sensevoice'
      ? senseVoiceMicrophone(recognition, senseVoiceScript, captureBinary, launch)
      : launchWindowsAgentVoice({ launch }),
  });
  return { ...controller, start(target, settings) {
    if (!controller.state().enabled) recognition = windowsRecognition(settings);
    if (recognition.engine === 'sensevoice' && (!recognition.python || !recognition.modelDirectory))
      throw new ControlError('ASR_SETUP', '请在「语音 → 语音识别」配置 SenseVoice。');
    return controller.start(target);
  } };
}
