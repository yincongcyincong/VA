import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { listPackage } from '@electron/asar';

const fixture = fileURLToPath(new URL('./fixtures/desktop-smoke.mjs', import.meta.url));
const source = fileURLToPath(new URL('../', import.meta.url));
const archive = process.env.VA_TEST_ASAR && resolve(process.env.VA_TEST_ASAR);
const macVersion = process.platform === 'darwin'
  ? Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]) : 0;

test('the packaged model directory contains only the cover and attribution', { skip: !archive }, () => {
  const models = listPackage(archive).map(path => path.replaceAll(sep, '/'))
    .filter(path => path.startsWith('/assets/models/')).sort();
  assert.deepEqual(models, ['/assets/models/ATTRIBUTION.md', '/assets/models/VA Cover.vrm']);
});

test('the desktop renders the default cover after upgrade and keeps listening when opening a session fails',
  { skip: macVersion < 26 && 'requires a macOS 26+ desktop session', timeout: 45_000 }, async t => {
    const { default: electron } = await import('electron');
    const profile = await realpath(await mkdtemp(join(tmpdir(), 'va-desktop-smoke-')));
    t.after(() => rm(profile, { recursive: true, force: true }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(profile, 'claude'), VA_START_CWD: profile };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VA_CHARACTER_CONFIG', 'VA_PERFORMANCE_CONFIG',
      'VA_AGENT_CONFIG', 'VA_VOICE_CONFIG', 'AVATAR_DIR']) delete env[key];
    await promisify(execFile)(electron, [fixture, archive ?? source, profile, '--va-hidden'], {
      cwd: profile, env, timeout: 40_000,
    });
  });
