import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { positionals: [platform], values } = parseArgs({
  allowPositionals: true,
  options: { arch: { type: 'string' }, 'electron-zip-dir': { type: 'string' }, dmg: { type: 'boolean' } },
});
if (platform !== 'darwin') throw new Error('VA 桌面版目前支持打包 macOS。');
const arch = values.arch ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('请选择 arm64 或 x64。');
if (process.platform !== 'darwin' || arch !== process.arch) {
  throw new Error('请在目标架构的 Mac 上打包 macOS 版，以编译对应的 Swift 助手。');
}
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('make', ['audio-helper', 'doubao-helper', `MACOS_ARCH=${arch === 'x64' ? 'x86_64' : arch}`], { cwd: root, stdio: 'inherit' });
const bundles = await packager({
  dir: root,
  name: 'VA',
  platform,
  arch,
  out: 'dist',
  appBundleId: 'local.va.desktop',
  overwrite: true,
  asar: true,
  icon: join(root, 'assets', 'app-icon.icns'),
  electronZipDir: values['electron-zip-dir'],
  ignore: /^\/(dist|build|logs|test|native|skills|scripts|integrations|model-samples|docs|\.github|\.env.*|README\.md|assets\/app-icon\.icns)(\/|$)/,
  extraResource: [...['va-audio-monitor', 'va-doubao-client', 'va-doubao-captions'].map(name => join(root, 'build', name)),
    join(root, 'native', 'zipvoice-tts.py')],
  usageDescription: {
    AudioCapture: 'VA locally detects music or transcribes Doubao playback when you enable these features.',
    Microphone: 'VA uses the microphone for Doubao voice chat and optional on-device dance request recognition.',
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
});
for (const bundle of bundles) {
  console.log(bundle);
  if (values.dmg) console.log(createDmg(bundle));
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
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', `VA ${version}`, '-srcfolder', contents,
      '-format', 'UDZO', image], { stdio: 'inherit' });
    renameSync(image, output);
    return output;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
