import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'electron-zip-dir': { type: 'string' } } });
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('make', ['audio-helper', 'doubao-helper'], { cwd: root, stdio: 'inherit' });
const bundles = await packager({
  dir: root,
  name: 'VA',
  platform: 'darwin',
  out: 'dist',
  appBundleId: 'local.va.desktop',
  overwrite: true,
  asar: true,
  electronZipDir: values['electron-zip-dir'],
  ignore: /^\/(dist|build|native|skills|scripts|integrations|model-samples|\.env.*|README\.md)(\/|$)/,
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
});
for (const bundle of bundles) console.log(bundle);
