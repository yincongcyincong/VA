import { listPackage } from '@electron/asar';
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { positionals: [platform], values } = parseArgs({
  allowPositionals: true,
  options: { arch: { type: 'string' }, 'electron-zip-dir': { type: 'string' }, dmg: { type: 'boolean' } },
});
if (!['darwin', 'win32'].includes(platform)) throw new Error('请选择打包 macOS 或 Windows 版。');
const mac = platform === 'darwin';
if (values.dmg && !mac) throw new Error('DMG 仅适用于 macOS 版。');
const arch = values.arch ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('请选择 arm64 或 x64。');
if (mac && (process.platform !== 'darwin' || arch !== process.arch)) {
  throw new Error('请在目标架构的 Mac 上打包 macOS 版，以编译对应的 Swift 助手。');
}
const root = fileURLToPath(new URL('../', import.meta.url));
// Only runtime sources, shipped assets and npm dependencies belong in the archive.
const releasePaths = [
  'LICENSE',
  'package\\.json',
  'assets(?:/app-icon\\.png|/models(?:/VA Cover\\.vrm|/Gemini 娘\\.glb|/ATTRIBUTION\\.md)?)?',
  'config(?:/(?:agent|character|voice)\\.json)?',
  'desktop/deepseek-client-package\\.json',
  '(?:bin|desktop|lib)(?:/[^./][^/]*\\.(?:[cm]?js|css|html))?',
  'node_modules(?:/.*)?',
];
const excludedReleasePath = new RegExp(`^/(?!(?:${releasePaths.join('|')})$)`, 'u');
const extraResource = [join(root, 'native', 'zipvoice-tts.py')];
if (mac) {
  execFileSync('make', ['audio-helper', 'doubao-helper', `MACOS_ARCH=${arch === 'x64' ? 'x86_64' : arch}`],
    { cwd: root, stdio: 'inherit' });
  extraResource.push(...['va-audio-monitor', 'va-doubao-client', 'va-doubao-captions'].map(name => join(root, 'build', name)));
}
const bundles = await packager({
  dir: root,
  name: 'VA',
  platform,
  arch,
  out: join(root, 'dist'),
  overwrite: true,
  asar: true,
  icon: join(root, 'assets', mac ? 'app-icon.icns' : 'app-icon.ico'),
  electronZipDir: values['electron-zip-dir'],
  ignore: excludedReleasePath,
  afterAsar: [async ({ buildPath }) => {
    const paths = new Set(listPackage(`${buildPath}.asar`).map(path => path.replaceAll(sep, '/')));
    for (const path of paths) {
      if (excludedReleasePath.test(path)) throw new Error(`Unexpected release file: ${path}`);
    }
    for (const path of ['/package.json', '/desktop/main.js', '/bin/va.js', '/assets/models/VA Cover.vrm',
      '/assets/models/Gemini 娘.glb', '/config/agent.json', '/config/character.json', '/config/voice.json']) {
      if (!paths.has(path)) throw new Error(`Missing release file: ${path}`);
    }
  }],
  extraResource,
  ...macOptions(),
});
for (const bundle of bundles) {
  console.log(bundle);
  if (values.dmg) console.log(createDmg(bundle));
}

function macOptions() {
  if (!mac) return {};
  return {
    appBundleId: 'local.va.desktop',
    usageDescription: {
      AudioCapture: 'VA locally detects music or transcribes Doubao playback when you enable these features.',
      Microphone: 'VA uses the microphone when you enable Agent voice input or Doubao action recognition.',
      ScreenCapture: 'VA can send a screenshot of your primary display to the vision model you configure.',
    },
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      continueOnError: false,
      // Ad-hoc signatures have no team ID for hardened library validation.
      optionsForFile: () => ({ hardenedRuntime: false, signatureFlags: '0' }),
    },
  };
}

function createDmg(bundle) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const output = join(dirname(bundle), `VA-${version}-mac-${arch}.dmg`);
  const staging = mkdtempSync(join(dirname(bundle), '.va-dmg-'));
  try {
    const contents = join(staging, 'contents');
    const image = join(staging, 'VA.dmg');
    mkdirSync(contents);
    execFileSync('/usr/bin/ditto', [join(bundle, 'VA.app'), join(contents, 'VA.app')], { stdio: 'inherit' });
    symlinkSync('/Applications', join(contents, 'Applications'));
    // ULMO is supported on every macOS version VA targets.
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', `VA ${version}`, '-srcfolder', contents,
      '-format', 'ULMO', image], { stdio: 'inherit' });
    renameSync(image, output);
    return output;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
