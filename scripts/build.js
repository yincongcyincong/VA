import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { positionals: [platform], values } = parseArgs({
  allowPositionals: true,
  options: { arch: { type: 'string' }, 'electron-zip-dir': { type: 'string' } },
});
const mac = platform === 'darwin';
if (!mac && platform !== 'win32') throw new Error('请选择 darwin 或 win32。');
const arch = values.arch ?? (mac ? process.arch : 'x64');
if (!['arm64', 'x64'].includes(arch)) throw new Error('请选择 arm64 或 x64。');
if (mac && (process.platform !== 'darwin' || arch !== process.arch)) {
  throw new Error('请在目标架构的 Mac 上打包 macOS 版，以编译对应的 Swift 助手。');
}
const root = fileURLToPath(new URL('../', import.meta.url));
if (mac) execFileSync('make', ['audio-helper', 'doubao-helper'], { cwd: root, stdio: 'inherit' });
const bundles = await packager({
  dir: root,
  name: 'VA',
  platform,
  arch,
  out: 'dist',
  appBundleId: 'local.va.desktop',
  overwrite: true,
  asar: true,
  icon: join(root, 'assets', mac ? 'app-icon.icns' : 'app-icon.ico'),
  electronZipDir: values['electron-zip-dir'],
  ignore: /^\/(dist|build|logs|test|native|skills|scripts|integrations|model-samples|docs|\.env.*|README\.md|assets\/app-icon\.(icns|ico))(\/|$)/,
  ...(mac && {
    extraResource: ['va-audio-monitor', 'va-doubao-client', 'va-doubao-captions'].map(name => join(root, 'build', name)),
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
  }),
});
for (const bundle of bundles) console.log(bundle);
