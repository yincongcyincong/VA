import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installDeepSeekRole } from '../desktop/deepseek-profile.js';
import { deepSeekNavigation, navigateDeepSeek } from '../desktop/deepseek-navigation.js';

test('DeepSeek profile installation migrates the old registration and is idempotent', async t => {
  const home = await mkdtemp(join(tmpdir(), 'va-deepseek-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(installDeepSeekRole(home), { code: 'DEEPSEEK_PROFILE' });
  const profile = join(home, 'profiles', 'desktop');
  await mkdir(profile, { recursive: true });
  const patch = join(profile, 'cordis.patch.yml');
  await writeFile(patch, 'options:\n  preserve: true\n');
  await assert.rejects(installDeepSeekRole(home), { code: 'DEEPSEEK_PROFILE' });
  assert.equal(await readFile(patch, 'utf8'), 'options:\n  preserve: true\n');
  const prefix = '# existing plugin\n- insert:\n    - id: keep\n      name: keep\n';
  await writeFile(patch, prefix + '- insert:\n    - id: va-desktop-role\n      name: ' +
    JSON.stringify(join(profile, 'va-desktop-role.mjs')) + '\n');
  assert.deepEqual(await installDeepSeekRole(home), { restart: true });
  const result = await readFile(patch, 'utf8');
  assert.equal(result, prefix + '- insert:\n    - id: va-desktop-role\n      name: ' +
    JSON.stringify(join(profile, 'va-harness', 'deepseek-role.mjs')) + '\n');
  const manifest = JSON.parse(await readFile(join(profile, 'va-harness', 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.deepEqual(await installDeepSeekRole(home), { restart: false });
  await writeFile(join(profile, 'va-harness', 'client.js'), 'outdated');
  assert.deepEqual(await installDeepSeekRole(home), { restart: true });
  assert.equal(await readFile(patch, 'utf8'), result);
  await rm(patch);
  assert.deepEqual(await installDeepSeekRole(home), { restart: true });
});

test('DeepSeek navigation waits for the matching acknowledgement and cleans up failed requests', async () => {
  const { signal } = new AbortController();
  await navigateDeepSeek('session-target', async () => {
    const { navigation } = deepSeekNavigation();
    assert.equal(navigation.id, 'session-target');
    assert.deepEqual(deepSeekNavigation('wrong token'), {});
    assert.deepEqual(deepSeekNavigation(), { navigation });
    assert.deepEqual(deepSeekNavigation(navigation.token), {});
    assert.deepEqual(deepSeekNavigation(), {});
    return true;
  }, signal);
  await assert.rejects(navigateDeepSeek('session-unavailable', async () => false, signal), { code: 'AGENT_LAUNCH' });
  assert.deepEqual(deepSeekNavigation(), {});
  const canceled = AbortSignal.abort(new Error('接入已切换'));
  await assert.rejects(navigateDeepSeek('session-canceled', async () => true, canceled), /接入已切换/);
  assert.deepEqual(deepSeekNavigation(), {});
});
