#!/usr/bin/env bash
set -euo pipefail

va_zipvoice_dir="$HOME/Library/Application Support/VA Desktop/zipvoice-tts"
va_zipvoice_name=sherpa-onnx-zipvoice-distill-int8-zh-en-emilia
va_zipvoice_model="$va_zipvoice_dir/$va_zipvoice_name"
va_zipvoice_python="$va_zipvoice_dir/.venv/bin/python"
va_zipvoice_script="$(dirname "$0")/../native/zipvoice-tts.py"

mkdir -p "$va_zipvoice_dir"
if [[ ! -x "$va_zipvoice_python" ]]; then
  "${ZIPVOICE_PYTHON:-python3}" -m venv "$va_zipvoice_dir/.venv"
fi
"$va_zipvoice_python" -m pip install 'sherpa-onnx==1.13.8'

check_zipvoice() {
  printf '%s\n' '{"id":1}' | "$va_zipvoice_python" -I "$va_zipvoice_script" "$1" | grep -q '"ok": true'
}

if [[ ! -d "$va_zipvoice_model" ]]; then
  va_zipvoice_stage=$(mktemp -d "$va_zipvoice_dir/download.XXXXXX")
  trap 'rm -rf "$va_zipvoice_stage"' EXIT
  if [[ -n "${ZIPVOICE_MODEL_DIR:-}" ]]; then
    cp -R "$ZIPVOICE_MODEL_DIR" "$va_zipvoice_stage/$va_zipvoice_name"
  else
    va_zipvoice_release=https://github.com/k2-fsa/sherpa-onnx/releases/download
    curl -fL --connect-timeout 10 --retry 2 "$va_zipvoice_release/tts-models/$va_zipvoice_name.tar.bz2" \
      -o "$va_zipvoice_stage/model.tar.bz2"
    tar -xf "$va_zipvoice_stage/model.tar.bz2" -C "$va_zipvoice_stage"
    curl -fL --connect-timeout 10 --retry 2 "$va_zipvoice_release/vocoder-models/vocos_24khz.onnx" \
      -o "$va_zipvoice_stage/$va_zipvoice_name/vocos_24khz.onnx"
  fi
  check_zipvoice "$va_zipvoice_stage/$va_zipvoice_name"
  mv "$va_zipvoice_stage/$va_zipvoice_name" "$va_zipvoice_model"
else
  check_zipvoice "$va_zipvoice_model"
fi
printf '%s\n' 'VA → 设置 → 语音 → 本地音色复刻'
