param(
    [Parameter(Mandatory=$true)][string]$Python,
    [string]$Destination = (Join-Path $PSScriptRoot '../build/sensevoice')
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows only' }
$Destination = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
& $Python -m pip install 'sherpa-onnx>=1.12,<2' numpy
if ($LASTEXITCODE -ne 0) { throw 'Unable to install local speech recognition dependencies.' }
$archive = Join-Path $Destination 'sensevoice.tar.bz2'
$release = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
$name = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
if (!(Test-Path (Join-Path $Destination 'model.int8.onnx')) -or !(Test-Path (Join-Path $Destination 'tokens.txt'))) {
    Invoke-WebRequest -Uri ($release + $name + '.tar.bz2') -OutFile $archive
    # Only extract the two required regular files; no archive paths are used.
    $extract = @'
import pathlib, shutil, sys, tarfile
folder = pathlib.Path(sys.argv[1])
with tarfile.open(folder / 'sensevoice.tar.bz2') as archive:
    for name in ('model.int8.onnx', 'tokens.txt'):
        members = [m for m in archive.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name == name]
        if len(members) != 1:
            raise ValueError('Missing or ambiguous model file: ' + name)
        with archive.extractfile(members[0]) as source, open(folder / (name + '.part'), 'wb') as output:
            shutil.copyfileobj(source, output)
        (folder / (name + '.part')).replace(folder / name)
'@
    & $Python -c $extract $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract SenseVoice model.' }
}
if (!(Test-Path (Join-Path $Destination 'silero_vad.onnx'))) {
    Invoke-WebRequest -Uri ($release + 'silero_vad.onnx') -OutFile (Join-Path $Destination 'silero_vad.onnx.part')
    Move-Item -LiteralPath (Join-Path $Destination 'silero_vad.onnx.part') -Destination (Join-Path $Destination 'silero_vad.onnx')
}
& $Python -I -u -X utf8 (Join-Path $PSScriptRoot '../native/windows-sensevoice.py') $Destination --check
if ($LASTEXITCODE -ne 0) { throw 'SenseVoice model validation failed.' }
Write-Output "SenseVoice ready. Python: $Python"
Write-Output "Model directory: $Destination"
