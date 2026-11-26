import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import crossSpawn from 'cross-spawn';
import { launchWindowsTerminal, openWindowsDeepSeekDesktop } from '../desktop/windows-agent.js';

test('Windows session launcher runs CMD and BAT shims from PATH with arguments',
  { skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'va terminal 中文 '));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const recorder = join(directory, 'record.cjs');
    const output = join(directory, 'args.json');
    await writeFile(recorder, `const fs=require('node:fs'); const args=process.argv.slice(2);
      const config=args.includes('--config') ? fs.readFileSync(args.at(-1),'utf8') : null;
      const index=Math.max(args.indexOf('--append-system-prompt'),args.indexOf('--append-system-prompt-file'));
      const prompt=index>=0 ? fs.readFileSync(args[index+1],'utf8') : null;
      fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({args,config,prompt}));`);
    for (const command of ['claude', 'codex', 'omp', 'dsh']) for (const extension of ['cmd', 'bat']) {
      await writeFile(join(directory, `${command}.${extension}`), `@echo off\r\n"${process.execPath}" "%~dp0record.cjs" %*\r\n`);
      let completed;
      const args = ['web', 'with spaces', '中文', 'a&b', 'a"b'];
      const prompt = '角色第一行\n角色第二行，保留 "引号" 与 & 符号。';
      if (['claude', 'omp'].includes(command)) args.push('--append-system-prompt', prompt);
      await launchWindowsTerminal({ provider: command, command: `${command}.${extension}`, label: command, cwd: directory }, args, directory, {
        freshOmp: command === 'omp',
        launch(file, values, options) {
          assert.equal(options.detached, true);
          assert.equal(options.windowsHide, false);
          const child = crossSpawn(file, values, { ...options, detached: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', data => { stderr += data; });
          completed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`)));
          });
          return child;
        },
      });
      await completed;
      const received = JSON.parse(await readFile(output, 'utf8'));
      const forwarded = [...received.args];
      if (command === 'omp') {
        assert.equal(forwarded.at(-2), '--config');
        forwarded.splice(-2);
        assert.equal(received.config, 'autoResume: false\n');
      } else {
        assert.equal(received.config, null);
      }
      if (['claude', 'omp'].includes(command)) {
        assert.equal(received.prompt, prompt);
        assert.equal(forwarded.at(-2), command === 'claude' ? '--append-system-prompt-file' : '--append-system-prompt');
        forwarded.splice(-2, 2, '--append-system-prompt', prompt);
      }
      assert.deepEqual(forwarded, args);
    }
    await assert.rejects(launchWindowsTerminal({ command: 'missing-agent', label: 'DeepSeek Harness', cwd: directory }, [], directory),
      error => error.code === 'AGENT_LAUNCH' && error.message.includes('missing-agent'));
  });

test('Windows DeepSeek opens installed software before allowing a web fallback',
  { skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'va-deepseek-desktop-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env = { APPDATA: join(directory, 'user'), ProgramData: join(directory, 'common') };
    const user = join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk');
    const common = join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk');
    for (const file of [user, common]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'fixture'); }
    const calls = [];
    assert.equal(await openWindowsDeepSeekDesktop({ env, openPath: async file => { calls.push(file); return ''; } }), true);
    assert.deepEqual(calls, [user]);
    calls.length = 0;
    assert.equal(await openWindowsDeepSeekDesktop({ env, openPath: async file => {
      calls.push(file); return file === user ? 'broken shortcut' : '';
    } }), true);
    assert.deepEqual(calls, [user, common]);
    assert.equal(await openWindowsDeepSeekDesktop({ env, openPath: async () => 'unavailable' }), false);
    assert.equal(await openWindowsDeepSeekDesktop({ env: {}, openPath: async () => { throw Error('must not call'); } }), false);
  });

test('Windows session launcher resolves an extensionless shim and reports native launch errors',
  { skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'va-terminal-path-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, 'dsh.cmd'), '@echo off\r\n');
    await assert.rejects(launchWindowsTerminal({ command: 'dsh', label: 'DeepSeek Harness', cwd: directory }, ['web'], directory, {
      launch(file, args) {
        assert.equal(file, join(directory, 'dsh.cmd'));
        assert.deepEqual(args, ['web']);
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('error', new Error('native spawn failure')));
        return child;
      },
    }), { code: 'AGENT_LAUNCH' });
  });
