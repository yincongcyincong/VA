import { spawn } from 'node:child_process';
import { join } from 'node:path';

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
$request = ConvertFrom-Json -InputObject $inputJson
Add-Type -AssemblyName System.Speech
$speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voices = @($speech.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo })
  if ($request.operation -eq 'list') {
    $result = @($voices | ForEach-Object { @{ name = $_.Name; language = $_.Culture.Name } })
    ConvertTo-Json -InputObject $result -Compress
  } else {
    if ($request.voice) { $speech.SelectVoice($request.voice) }
    elseif ($request.text -match '\\p{IsCJKUnifiedIdeographs}') {
      $chinese = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'zh' } | Select-Object -First 1
      if ($chinese) { $speech.SelectVoice($chinese.Name) }
    }
    $speech.Rate = [Math]::Max(-10, [Math]::Min(10, [Math]::Round($request.rate / 10)))
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(22050, 16, 1)
    $speech.SetOutputToWaveFile($request.output, $format)
    $speech.Speak($request.text)
  }
} finally { $speech.Dispose() }
`, 'utf16le').toString('base64');

function invoke(request, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true, timeout: 15_000, signal, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Windows speech exited with code ${code}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(Buffer.from(JSON.stringify(request)).toString('base64') + '\n');
  });
}

export async function windowsVoices() {
  return JSON.parse(await invoke({ operation: 'list' }));
}

export async function windowsSpeech(text, signal, { voice, rate, output }) {
  await invoke({ operation: 'speak', text, voice, rate, output }, signal);
}
