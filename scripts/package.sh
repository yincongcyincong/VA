#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：bash scripts/package.sh [dmg|app|integrations]

  dmg           生成并验证 macOS DMG 和 SHA256SUMS.txt（默认）
  app           生成并验证 macOS VA.app
  integrations  生成 AstrBot ZIP 和 OpenClaw TGZ

可通过 ELECTRON_ZIP_DIR 指定本机 Electron ZIP 所在的目录。
EOF
}

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
target=${1:-dmg}
case "$target" in
  -h|--help) usage; exit 0 ;;
  integrations) exec make integrations ;;
  app|dmg) ;;
  *) usage >&2; exit 2 ;;
esac

if [[ $(uname -s) != Darwin ]]; then
  printf '%s\n' '请在目标架构的 Mac 上构建 VA.app 或 DMG。' >&2
  exit 1
fi

if [[ ! -f node_modules/@electron/packager/package.json ]]; then
  npm ci
fi

arch=$(node -p 'process.arch')
version=$(node -p 'require("./package.json").version')
bundle="dist/VA-darwin-$arch/VA.app"
if [[ "$target" == app ]]; then
  make build
else
  make dmg
fi
codesign --verify --deep --strict "$bundle"

if [[ "$target" == dmg ]]; then
  image="VA-$version-mac-$arch.dmg"
  hdiutil verify "dist/$image"
  (cd dist && shasum -a 256 "$image" > SHA256SUMS.txt)
  printf '安装包 %s\n校验文件 %s\n' "$PWD/dist/$image" "$PWD/dist/SHA256SUMS.txt"
else
  printf '应用 %s\n' "$PWD/$bundle"
fi
