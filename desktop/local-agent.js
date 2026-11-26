import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';
import { ControlError } from '../lib/control.js';
import { readConfig, settingsWriter } from './config.js';
import { createSessionReplies, findSessionFile, replySessionKey, supportsSessionReplies } from './session-replies.js';
import { createSessionTitles, sessionPreview } from './session-titles.js';
import { navigateDeepSeek } from './deepseek-navigation.js';
import { deepSeekArchives, deepSeekSessionId } from './deepseek-sessions.js';
import { launchWindowsTerminal, openWindowsDeepSeekDesktop, stopWindowsAgent } from './windows-agent.js';
import { deepSeekPresetUnsupported, runWindowsDeepSeek } from './windows-deepseek.js';

const providers = { codex: 'Codex', claude: 'Claude Code', deepseekharness: 'DeepSeek Harness', omp: 'OMP', custom: '自定义 Agent' };
const defaultCommands = { deepseekharness: 'dsh', custom: '' };
const timeout = 75_000;
const maxOutput = 8 * 1024 * 1024;
const maxReply = 20_000;
const sessionPattern = /^[a-z0-9][a-z0-9_.:-]{0,159}$/i;
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const nativeResume = new Set(['codex', 'claude']);
const exec = promisify(execFile);
const deepSeekApps = ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications/DeepSeek Harness.app')];
const deepSeekCliDirectory = 'Contents/Resources/runtime/cli/bin';
const windows = process.platform === 'win32';

function field(value, max, label) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new ControlError('AGENT_INPUT', `${label}最长 ${max} 字，且必须是文本。`);
  }
  return value.trim();
}

function preference(value) {
  const { provider = '', cwd = '', speakReplies = false } = value ?? {};
  if (typeof provider !== 'string' || (provider !== '' && !Object.hasOwn(providers, provider)) || typeof speakReplies !== 'boolean') {
    throw new ControlError('AGENT_CONFIG', '请选择受支持的 Agent。');
  }
  return { provider, cwd: field(cwd, 4096, '工作目录'), speakReplies, allowMultipleSessions: value?.allowMultipleSessions === true };
}

function profileModel(config, provider) {
  return field(config?.[provider]?.model ?? '', 200, '模型名');
}

async function runtime(config, launchDirectory) {
  const settings = preference(config);
  const { provider } = settings;
  const cwd = await realpath(resolve(settings.cwd.startsWith('~/') ? homedir() : launchDirectory, settings.cwd === '~' ? homedir() : settings.cwd.replace(/^~\//, ''))).catch(() => '');
  if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw new ControlError('AGENT_WORKDIR', 'Agent 工作目录不存在或不可读取。');
  }
  const profile = config?.[provider];
  const command = field(profile?.command ?? (defaultCommands[provider] ?? provider), 4096, 'Agent 命令');
  const model = provider === 'custom' ? '' : profileModel(config, provider);
  const models = Object.fromEntries(Object.keys(providers).map(name => [name,
    name === provider ? model : typeof config?.[name]?.model === 'string' ? config[name].model : '',
  ]));
  const args = provider === 'custom' ? profile?.args ?? [] : [];
  if ((provider === 'custom' && command && !isAbsolute(command)) || (provider && provider !== 'custom' && !command) ||
      /[\r\n]/.test(command) ||
      (!isAbsolute(command) && command.includes('/')) || !Array.isArray(args) || args.length > 50 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    throw new ControlError('AGENT_CONFIG', '请检查 Agent 命令和参数。自定义 Agent 需要可执行文件的绝对路径。');
  }
  const key = createHash('sha256').update(JSON.stringify([provider, cwd, command, args])).digest('hex');
  return { ...settings, label: providers[provider] ?? '请选择 Agent', cwd, cwdSetting: settings.cwd, command, model, models, args, key };
}

export async function patchLocalAgentConfig(current, patch, launchDirectory) {
  const config = { ...current, ...patch };
  for (const provider of Object.keys(providers)) {
    if (!Object.hasOwn(patch, provider)) continue;
    config[provider] = { ...current?.[provider], ...patch[provider] };
    await runtime({ ...config, provider }, launchDirectory);
  }
  const settings = preference(config);
  await runtime(settings.provider ? config : settings, launchDirectory);
  return { ...config, ...settings };
}

function agentPath() {
  if (windows) return [process.env.PATH, join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm')].filter(Boolean).join(delimiter);
  return [process.env.PATH, join(homedir(), '.local/bin'), join(homedir(), '.bun/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ...deepSeekApps.map(app => join(app, deepSeekCliDirectory))].filter(Boolean).join(delimiter);
}

function runAgent(agent, signal, build) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const launch = windows ? crossSpawn : spawn;
    const child = launch(agent.command, agent.args, {
      cwd: agent.cwd, detached: !windows, windowsHide: windows, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: agentPath() },
    });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    let stderr = '';
    let stopped = false;

    function finish(error, result) {
      if (stopped) return;
      stopped = true;
      signal.removeEventListener('abort', abort);
      const settle = () => error ? reject(error) : resolve(result);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (windows) {
          void stopWindowsAgent(child).then(settle);
          return;
        } else {
          const kill = sig => {
            try { process.kill(-child.pid, sig); } catch {}
          };
          kill('SIGTERM');
          setTimeout(() => kill('SIGKILL'), 1000).unref();
        }
      }
      settle();
    }

    function abort() { finish(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
    const stream = build({ send, stdin: child.stdin, finish });
    child.stdin.on('error', () => {}); // An early exit is handled on the child.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1500); });
    let total = 0;
    child.stdout.on('data', chunk => {
      if (stopped) return;
      total += Buffer.byteLength(chunk);
      if (total > maxOutput) return finish(new ControlError('AGENT_OUTPUT', 'Agent 输出超出大小限制。'));
      try { stream.data(chunk); } catch (error) { finish(error); }
    });
    child.once('error', error => finish(new ControlError('AGENT_LAUNCH',
      error.code === 'ENOENT' ? `找不到 ${agent.label}。请安装它或配置可执行文件路径。`
        : `无法启动 ${agent.label}。`)));
    child.once('close', code => {
      if (stopped) return;
      try {
        if (code === 0 && stream.end) return finish(null, stream.end());
        const detail = stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
        throw failure(detail.slice(-600) || `${agent.label} 未返回完整回复（退出码 ${code}）。`);
      } catch (error) { finish(error); }
    });
  });
}

function failure(message) {
  if (typeof message === 'string' && /already has an active writer|(?:conversation|thread) is open in another app/i.test(message)) {
    return new ControlError('CODEX_SESSION_IN_USE', '这条 Codex 会话正由另一个窗口使用。可在原窗口继续聊天，或关闭那里打开的会话后在 VA 重试。');
  }
  return new ControlError('AGENT_FAILED', typeof message === 'string' && message.trim()
    ? message.slice(0, 650) : 'Agent 未完成本轮对话。');
}

function runCodex(agent, input, signal) {
  return runAgent({ ...agent, args: ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}',
    ...(input.image ? ['-c', 'features.shell_tool=false'] : [])] }, signal,
    ({ send, finish }) => {
      let pending = '';
      let threadId;
      let turnId;
      let lastReply;
      const request = (id, method, params) => send({ id, method, params });
      request(1, 'initialize', {
        clientInfo: { name: 'va-desktop', title: 'VA Desktop', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });

      function startTurn() {
        const items = [{ type: 'text', text: input.message, text_elements: [] }];
        if (input.image) items.push({ type: 'image', url: `data:${input.image.mime};base64,${input.image.data}` });
        request(3, 'turn/start', { threadId, input: items });
      }

      function event(message) {
        const { id, method, params, result, error } = message;
        if (id !== undefined && method) {
          send({ id, error: { code: -32601, message: 'This VA chat does not grant tool approvals.' } });
          return;
        }
        if (id !== undefined && error) throw failure(error.message);
        if (id === 1) {
          send({ method: 'initialized' });
          request(2, input.sessionId ? 'thread/resume' : 'thread/start', {
            ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true }
              : { developerInstructions: input.prompt, ...(input.image && { ephemeral: true }) }),
            ...(agent.model && { model: agent.model }),
            cwd: agent.cwd, sandbox: 'read-only', approvalPolicy: 'never',
          });
        } else if (id === 2) {
          threadId = result?.thread?.id;
          if (!threadId || (input.sessionId && input.sessionId !== threadId)) {
            throw failure('Codex 未能续接指定会话。请检查会话 ID。');
          }
          if (input.sessionId) {
            // Resumed threads keep their original instruction context.
            request(4, 'thread/inject_items', { threadId, items: [{
              type: 'message', role: 'developer', content: [{ type: 'input_text',
                text: '以下是本轮最新的 VA 提示词，替换此前的 VA 提示词。\n\n' + input.prompt }],
            }] });
          } else startTurn();
        } else if (id === 4) {
          if (input.syncRole) finish(null, { synced: true, sessionId: threadId });
          else startTurn();
        } else if (id === 3) {
          turnId = result?.turn?.id;
          if (!turnId) throw failure();
        } else if (params?.threadId === threadId && threadId) {
          if (method === 'turn/started') turnId ??= params.turn?.id;
          if (method === 'item/completed' && params.turnId === turnId &&
              params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') {
            lastReply = params.item.text;
          }
          if (method === 'turn/completed' && params.turn?.id === turnId) {
            if (params.turn.status !== 'completed') throw failure(params.turn.error?.message);
            const finalItem = params.turn.items?.findLast(item => item.type === 'agentMessage' && item.phase !== 'commentary');
            finish(null, { reply: finalItem?.text ?? lastReply, sessionId: threadId });
          }
        }
      }

      return { data(chunk) {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          let json;
          try { json = JSON.parse(line); } catch { continue; }
          event(json);
        }
      } };
    });
}

function runJsonAgent(agent, input, signal) {
  const claude = agent.provider === 'claude';
  const multimodal = claude && input.image;
  const command = claude ? { ...agent, args: [
    '--print', '--output-format', multimodal ? 'stream-json' : 'json', '--tools', '', '--strict-mcp-config',
    ...(multimodal ? ['--input-format', 'stream-json', '--verbose', '--no-session-persistence'] : []),
    '--system-prompt-snapshot', 'off', '--append-system-prompt', input.prompt,
    ...(agent.model ? ['--model', agent.model] : []), ...(input.sessionId ? ['--resume', input.sessionId] : []),
  ] } : agent;
  return runAgent(command, signal, ({ stdin }) => {
    if (multimodal) {
      stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'text', text: input.message },
        { type: 'image', source: { type: 'base64', media_type: input.image.mime, data: input.image.data } },
      ] } }) + '\n');
    } else stdin.end(claude ? input.message : JSON.stringify(input) + '\n');
    let output = '';
    return {
      data: chunk => { output += chunk; },
      end() {
        let result;
        try { result = multimodal ? events(output).findLast(event => event.type === 'result') : JSON.parse(output); }
        catch { throw failure('Agent 的输出不是有效 JSON。'); }
        if (result?.is_error || result?.error) throw failure(result?.result ?? result?.error);
        return claude ? { reply: result?.result, sessionId: result?.session_id } : result;
      },
    };
  });
}

function events(output) {
  return output.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function runEventAgent(agent, args, input, signal, result) {
  return runAgent({ ...agent, args }, signal, ({ stdin }) => {
    stdin.end(input);
    let output = '';
    return { data: chunk => { output += chunk; }, end: () => result(events(output)) };
  });
}

async function runOmp(agent, input, signal) {
  const args = ['-p', '--mode', 'json', '--no-tools', '--no-skills', '--no-extensions', '--no-context-files',
    '--allow-home', '--no-title', '--append-system-prompt', input.prompt,
    ...(agent.model ? ['--model', agent.model] : []), ...(input.sessionId ? ['--resume', input.sessionId] : []),
  ];
  const imageDir = input.image ? await mkdtemp(join(tmpdir(), 'va-screen-')) : undefined;
  try {
    if (imageDir) {
      const file = join(imageDir, 'screen.jpg');
      await writeFile(file, Buffer.from(input.image.data, 'base64'), { mode: 0o600 });
      args.push('--no-session', '--', '@' + file, input.message);
    }
    return await runEventAgent(agent, args, imageDir ? undefined : input.message, signal, rows => {
      const final = rows.findLast(event => event.type === 'agent_end');
      const message = final?.messages?.findLast(item => item.role === 'assistant');
      if (!message || ['error', 'aborted'].includes(message.stopReason)) throw failure(message?.errorMessage);
      const reply = message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return { reply, sessionId: rows.find(event => event.type === 'session')?.id };
    });
  } finally {
    if (imageDir) await rm(imageDir, { recursive: true, force: true });
  }
}

function dispatch(agent, input, signal) {
  if (agent.provider === 'codex') return runCodex(agent, input, signal);
  if (agent.provider === 'omp') return runOmp(agent, input, signal);
  if (agent.provider === 'deepseekharness') {
    const args = ['--profile', 'headless', '--json', '--permission-mode', 'read-only',
      ...(input.sessionId ? ['--session-id', input.sessionId] : [])];
    return runEventAgent(agent, args, input.prompt + '\n\n用户消息：\n' + input.message, signal, rows => {
      const final = rows.findLast(event => event.type === 'final');
      if (!final?.text) throw failure(rows.findLast(event => event.type === 'error')?.message);
      return { reply: final.text, sessionId: final.sessionId };
    }).catch(error => {
      if (windows && input.sessionId && deepSeekPresetUnsupported(error)) {
        return runWindowsDeepSeek({ ...agent, env: { PATH: agentPath() } }, input, signal);
      }
      throw error;
    });
  }
  return runJsonAgent(agent, input, signal);
}

function validSession(provider, id) {
  return Object.hasOwn(providers, provider) && typeof id === 'string' &&
    (nativeResume.has(provider) ? uuidPattern : sessionPattern).test(id);
}

function archivedSession(sessions, provider, id) {
  return provider === 'deepseekharness' && typeof id === 'string' && sessions.archived.has(id.toLowerCase());
}

function rememberSession(sessions, agent, id, boundAt, firstMessage) {
  const ref = `${agent.key}:${id}`;
  const previous = sessions.history.find(item => item.provider === agent.provider && item.id === id);
  const titlePreview = previous?.titlePreview ?? sessionPreview(firstMessage);
  const record = { ref, provider: agent.provider, cwd: agent.cwd, id, boundAt, titlePreview };
  sessions.history = [record, ...sessions.history.filter(item => item.ref !== ref)]
    .filter((entry, index) => index < 100 || sessions.listening.has(entry.ref));
}

function addBinding(sessions, agent, id, firstMessage) {
  if (agent.allowMultipleSessions) {
    sessions.bindings[agent.key] = id;
    sessions.listening.add(`${agent.key}:${id}`);
  } else keepSingleBinding(sessions, agent, id);
  rememberSession(sessions, agent, id, new Date().toISOString(), firstMessage);
}

function keepSingleBinding(sessions, agent, id) {
  sessions.bindings = id ? { [agent.key]: id } : {};
  sessions.listening = new Set(id ? [`${agent.key}:${id}`] : []);
}

function boundKey(record, bindings) {
  const key = record.ref.slice(0, 64);
  if (record.ref === `${key}:${record.id}` && bindings[key] === record.id) return key;
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function launchTerminal(agent, args, { freshOmp = false } = {}) {
  const path = agentPath();
  if (windows) return launchWindowsTerminal(agent, args, path, { freshOmp });
  const candidates = isAbsolute(agent.command) ? [agent.command]
    : path.split(delimiter).map(directory => resolve(agent.cwd, directory, agent.command));
  let executable;
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => undefined))?.isFile() &&
        await access(candidate, constants.X_OK).then(() => true, () => false)) {
      executable = candidate;
      break;
    }
  }
  if (!executable) throw new ControlError('AGENT_LAUNCH', `找不到可执行的 ${agent.label}。请安装它或检查 Agent 命令路径。`);

  const folder = await mkdtemp(join(tmpdir(), 'va-agent-session-'));
  const script = join(folder, `VA ${agent.label}.command`);
  try {
    const overlay = freshOmp ? join(folder, 'new-session.yml') : undefined;
    if (overlay) await writeFile(overlay, 'autoResume: false\n', { mode: 0o600 });
    const command = [executable, ...args, ...(overlay ? ['--config', overlay] : [])].map(quote).join(' ');
    await writeFile(script, [
      '#!/bin/bash',
      '/bin/rm -f -- "$0"',
      overlay ? `trap ${quote('/bin/rm -f -- ' + quote(overlay) + '; /bin/rmdir -- ' + quote(folder))} EXIT`
        : '/bin/rmdir -- ' + quote(folder),
      'cd -- ' + quote(agent.cwd) + ' || exit 1',
      'export PATH=' + quote(path),
      overlay ? command : 'exec ' + command,
      '',
    ].join('\n'), { mode: 0o700 });
    await exec('/usr/bin/open', ['-a', 'Terminal', script], { timeout: 10_000 });
  } catch {
    await rm(folder, { recursive: true, force: true });
    throw new ControlError('AGENT_LAUNCH', '无法在「终端」打开 Agent 会话。');
  }
}

async function openCodexDesktop(id, cwd) {
  if (windows) return false;
  const url = new URL(`codex://threads/${id ?? 'new'}`);
  if (cwd) url.searchParams.set('path', cwd);
  const result = await exec('/usr/bin/open', [url.href], { timeout: 10_000 }).catch(() => null);
  return Boolean(result);
}

async function openDeepSeekDesktop(command) {
  if (windows) return openWindowsDeepSeekDesktop();
  const embedded = command.match(/^(.+\.app)\/Contents\/Resources\/runtime\/cli\/bin\/dsh$/u)?.[1];
  for (const app of new Set([embedded, ...deepSeekApps].filter(Boolean))) {
    if (!(await stat(app).catch(() => undefined))?.isDirectory()) continue;
    if (await exec('/usr/bin/open', [app], { timeout: 10_000 }).catch(() => null)) return true;
  }
  return false;
}

export function createLocalAgent({ getConfig, updateConfig, getPrompt, parseReply, sessionPath, launchDirectory = process.cwd(),
  presentReply, onReplySessionsRemoved = () => {}, onChange = () => {}, onReplyError = () => {},
  openTerminal = launchTerminal, openCodex = openCodexDesktop,
  openDeepSeek = openDeepSeekDesktop, openDeepSeekSession = navigateDeepSeek }) {
  const writeSessions = settingsWriter(sessionPath);
  const saveSessions = ({ bindings, history, listening }) => writeSessions({ bindings, history, listening: [...listening] });
  const sessionTitles = createSessionTitles();
  const history = new Map();
  let active;
  let pendingReply;
  let replyMonitorEnabled = false;
  let replyMonitorRevision = 0;
  let replyTargets = new Set();
  let forwardedReplies = [];
  const replies = createSessionReplies({
    paused: session => pendingReply === session.scope,
    onError: onReplyError,
    present(text, session) {
      forwardedReplies = forwardedReplies.filter(reply => reply.until > Date.now());
      const duplicate = forwardedReplies.findIndex(reply => reply.scope === session.scope && reply.text === text);
      if (duplicate >= 0) {
        forwardedReplies.splice(duplicate, 1);
        return true;
      }
      const effect = parseReply(text.slice(0, maxReply));
      if (!effect.speech && !effect.action && !effect.expression && !effect.dance) return true;
      return presentReply(effect.speech, session.speakReplies, effect, session.scope);
    },
  });

  const getSessions = async (agent, allowMultipleSessions = agent?.allowMultipleSessions === true) => {
    const value = await readConfig(sessionPath, {}, 'AGENT_SESSIONS', 'local-agent-sessions.json');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ControlError('AGENT_SESSIONS', '会话文件需要是一个 JSON 对象。');
    }
    const bindings = Object.fromEntries(Object.entries(value.bindings ?? value)
      .filter(([key, id]) => /^[a-f0-9]{64}$/.test(key) && typeof id === 'string'));
    const records = Array.isArray(value.history) ? value.history : [];
    const listening = new Set(Array.isArray(value.listening)
      ? value.listening.filter(ref => typeof ref === 'string' && /^[a-f0-9]{64}:[a-z0-9_.:-]{1,160}$/i.test(ref))
      : Object.entries(bindings).map(([key, id]) => `${key}:${id}`));
    const sessions = { bindings, listening, history: records.filter(entry => entry && validSession(entry.provider, entry.id) &&
      typeof entry.cwd === 'string' && isAbsolute(entry.cwd) && typeof entry.ref === 'string') };
    const id = agent && sessions.bindings[agent.key];
    if (id && validSession(agent.provider, id) && !sessions.history.some(entry => entry.ref === `${agent.key}:${id}`)) {
      rememberSession(sessions, agent, id, null);
    }
    if (!allowMultipleSessions) keepSingleBinding(sessions, agent, id && validSession(agent.provider, id) ? id : undefined);
    sessions.archived = agent?.provider === 'deepseekharness' || sessions.history.some(entry => entry.provider === 'deepseekharness')
      ? await deepSeekArchives().catch(error => { onReplyError(error); return new Set(); }) : new Set();
    return sessions;
  };

  function listeningSessions(sessions) {
    return sessions.history.filter(({ ref, provider, id }) =>
      sessions.listening.has(ref) && !archivedSession(sessions, provider, id));
  }

  function countListening(sessions) {
    return new Set(listeningSessions(sessions).filter(({ provider, id }) => supportsSessionReplies(provider, id))
      .map(({ provider, id }) => replySessionKey(provider, id))).size;
  }

  function selectReplyTargets(targets = []) {
    const next = new Set(targets.map(({ provider, id }) => replySessionKey(provider, id)));
    const removed = new Set([...replyTargets].filter(scope => !next.has(scope)));
    replyTargets = next;
    const selecting = replies.select(targets);
    if (removed.size) {
      forwardedReplies = forwardedReplies.filter(reply => !removed.has(reply.scope));
      onReplySessionsRemoved(removed);
    }
    return selecting;
  }

  async function refreshReplyMonitor() {
    const revision = ++replyMonitorRevision;
    if (!replyMonitorEnabled) return selectReplyTargets();
    try {
      const config = await getConfig();
      const agent = await runtime(config, launchDirectory).catch(() => undefined);
      const sessions = await getSessions(agent, config?.allowMultipleSessions === true);
      if (revision === replyMonitorRevision) {
        await selectReplyTargets(listeningSessions(sessions).map(({ provider, id }) =>
          ({ provider, id, speakReplies: config?.speakReplies === true })));
      }
    } catch (error) {
      if (revision === replyMonitorRevision) {
        await selectReplyTargets();
        onReplyError(error);
      }
    }
  }

  async function snapshot(agent, sessions) {
    const config = agent ?? await runtime(await getConfig(), launchDirectory);
    const saved = sessions ?? await getSessions(config);
    const { provider, label, cwd, speakReplies, models, key } = config;
    const visible = saved.history.filter(entry => !archivedSession(saved, entry.provider, entry.id));
    const titles = await sessionTitles(visible);
    const id = saved.bindings[key];
    const sessionId = archivedSession(saved, provider, id) ? null : id ?? null;
    return { provider, label, cwd, workingDirectory: config.cwdSetting, launchDirectory, speakReplies, models,
      allowMultipleSessions: config.allowMultipleSessions,
      listeningCount: countListening(saved),
      sessionId, hasSessionRecords: saved.history.some(entry => entry.provider === provider),
      sessionHistory: visible.map(({ titlePreview, ...entry }) => ({ ...entry, title: titles.get(entry.ref) ?? null,
        label: providers[entry.provider], canOpen: nativeResume.has(entry.provider) ||
          (entry.provider === 'omp' && uuidPattern.test(entry.id)) ||
          (!windows && entry.provider === 'deepseekharness' && deepSeekSessionId(entry.id)),
        bound: saved.listening.has(entry.ref), active: entry.ref === `${key}:${sessionId}` })),
      history: archivedSession(saved, provider, id) ? [] : history.get(key) ?? [], busy: Boolean(active) };
  }

  async function recordFor(ref, config) {
    const current = await runtime(config, launchDirectory).catch(() => undefined);
    const sessions = await getSessions(current, config?.allowMultipleSessions === true);
    const record = sessions.history.find(entry => entry.ref === ref);
    if (!record) throw new ControlError('AGENT_SESSION', '找不到这条会话绑定记录。');
    return { record, sessions, current };
  }

  async function persistBindingPolicy(previous, next, signal) {
    const wasMultiple = previous?.allowMultipleSessions === true;
    const staysMultiple = next?.allowMultipleSessions === true;
    const selected = await runtime(wasMultiple && !staysMultiple ? next : previous, launchDirectory).catch(() => undefined);
    const sessions = await getSessions(selected, wasMultiple && staysMultiple);
    signal.throwIfAborted();
    await saveSessions(sessions);
  }

  function exclusive(job) {
    if (active) throw new ControlError('AGENT_BUSY', 'Agent 正在处理请求，请等待或点击停止。');
    const controller = new AbortController();
    active = controller;
    onChange();
    const timer = setTimeout(() => controller.abort(new ControlError('AGENT_TIMEOUT', 'Agent 超时，请重试。')), timeout);
    return job(controller.signal).finally(async () => {
      clearTimeout(timer);
      try {
        if (replyMonitorEnabled) await refreshReplyMonitor();
      } finally {
        active = undefined;
        pendingReply = undefined;
        onChange();
      }
    });
  }

  async function restoreBinding(ref, signal) {
    let restored;
    await updateConfig(async config => {
      const { sessions, record } = await recordFor(ref, config);
      if (archivedSession(sessions, record.provider, record.id)) {
        throw new ControlError('AGENT_SESSION_ARCHIVED', '这条 DeepSeek Harness 会话已归档。');
      }
      const next = { ...config, provider: record.provider, cwd: record.cwd };
      const agent = await runtime(next, launchDirectory);
      signal.throwIfAborted();
      addBinding(sessions, agent, record.id);
      await saveSessions(sessions);
      history.delete(agent.key);
      restored = await snapshot(agent, sessions);
      return next;
    });
    return { ...restored, busy: false };
  }

  function restoreSession(ref) {
    return exclusive(signal => restoreBinding(ref, signal));
  }

  async function saveBinding(agent, id, signal) {
    const sessions = await getSessions(agent);
    signal.throwIfAborted();
    if (archivedSession(sessions, agent.provider, id)) {
      throw new ControlError('AGENT_SESSION_ARCHIVED', '这条 DeepSeek Harness 会话已归档，请绑定另一条会话。');
    }
    if (id) {
      addBinding(sessions, agent, id);
    } else {
      sessions.listening.delete(`${agent.key}:${sessions.bindings[agent.key]}`);
      delete sessions.bindings[agent.key];
    }
    await saveSessions(sessions);
    history.delete(agent.key);
    return sessions;
  }

  function removeBinding(sessions, record) {
    const key = boundKey(record, sessions.bindings);
    if (key) {
      delete sessions.bindings[key];
      history.delete(key);
    }
    return sessions.listening.delete(record.ref) || Boolean(key);
  }

  async function screenAgent() {
    const agent = await runtime(await getConfig(), launchDirectory);
    if (!agent.provider) throw new ControlError('AGENT_UNSELECTED', '请在「智能体接入」选择接收截图的本地 Agent。');
    if (agent.provider === 'deepseekharness') {
      throw new ControlError('AGENT_IMAGE_UNSUPPORTED', 'DeepSeek Harness 的 headless CLI 不接收图片，请选择支持图片输入的 Agent。');
    }
    if (!agent.command) throw new ControlError('AGENT_CONFIG', '请先配置自定义 Agent 的可执行文件。');
    return agent;
  }

  return {
    status: () => snapshot(),
    async voiceTarget() {
      const agent = await runtime(await getConfig(), launchDirectory);
      const sessions = await getSessions(agent);
      const sessionId = sessions.bindings[agent.key];
      if (!validSession(agent.provider, sessionId) || archivedSession(sessions, agent.provider, sessionId)) {
        throw new ControlError('AGENT_SESSION', '请先绑定一个可用的本地 Agent 会话。');
      }
      return { key: agent.key, sessionId };
    },
    monitorReplies(enabled) {
      replyMonitorEnabled = enabled;
      return refreshReplyMonitor();
    },
    async prepareObservation() {
      const agent = await screenAgent();
      return async ({ frame, message, prompt, signal }) => {
        const limit = AbortSignal.timeout(timeout);
        const result = await dispatch(agent, { message, prompt, sessionId: null, image: frame }, AbortSignal.any([signal, limit]))
          .catch(error => {
            if (limit.aborted && !signal.aborted) throw new ControlError('AGENT_TIMEOUT', '本地 Agent 观察超时，请重试。');
            throw error;
          });
        return result?.reply;
      };
    },
    cancel() {
      active?.abort(new ControlError('AGENT_CANCELED', '已停止等待 Agent 回复。'));
      return { canceled: Boolean(active) };
    },
    configureBindingPolicy(edit) {
      return exclusive(signal => edit((previous, next) => persistBindingPolicy(previous, next, signal)));
    },
    configure(value) {
      return exclusive(async signal => {
        await updateConfig(async previous => {
          const next = preference({ ...previous, ...value });
          const config = { ...previous, ...next };
          if (['codex', 'claude', 'omp'].includes(next.provider) && typeof value?.model === 'string') {
            config[next.provider] = { ...previous?.[next.provider], model: field(value.model, 200, '模型名') };
          }
          await runtime(config, launchDirectory);
          await persistBindingPolicy(previous, config, signal);
          return config;
        });
        const result = await snapshot();
        return { ...result, busy: false };
      });
    },
    bind(value) {
      return exclusive(async signal => {
        const agent = await runtime(await getConfig(), launchDirectory);
        if (!agent.provider) throw new ControlError('AGENT_UNSELECTED', '请先选择 Agent。');
        const id = value === null ? null : field(value, 160, '会话 ID');
        if (id !== null && !validSession(agent.provider, id)) throw new ControlError('AGENT_SESSION', '会话 ID 格式无效。');
        const normalized = id && nativeResume.has(agent.provider) ? id.toLowerCase() : id;
        const sessions = await saveBinding(agent, normalized, signal);
        const result = await snapshot(agent, sessions);
        return { ...result, busy: false };
      });
    },
    bindCodex({ id, cwd }) {
      return exclusive(async signal => {
        let binding;
        await updateConfig(async previous => {
          const next = { ...previous, provider: 'codex', cwd };
          const agent = await runtime(next, launchDirectory);
          const sessions = await saveBinding(agent, id, signal);
          binding = { provider: agent.provider, sessionId: id, cwd: agent.cwd, listeningCount: countListening(sessions) };
          return next;
        }, 'local');
        return binding;
      });
    },
    restoreSession,
    async matchesDeepSeekSession(id) {
      if (!deepSeekSessionId(id)) return false;
      const config = await getConfig();
      const agent = await runtime(config, launchDirectory).catch(() => undefined);
      const sessions = await getSessions(agent, config?.allowMultipleSessions === true);
      return listeningSessions(sessions).some(entry =>
        entry.provider === 'deepseekharness' && replySessionKey(entry.provider, entry.id) === replySessionKey('deepseekharness', id));
    },
    unbindSession(ref) {
      return exclusive(async signal => {
        const { record, sessions } = await recordFor(ref, await getConfig());
        signal.throwIfAborted();
        if (removeBinding(sessions, record)) await saveSessions(sessions);
      });
    },
    clearSessions({ ref, provider }) {
      return exclusive(async signal => {
        const current = await runtime(await getConfig(), launchDirectory);
        const sessions = await getSessions(current);
        const removed = sessions.history.filter(entry => ref ? entry.ref === ref : entry.provider === provider);
        const refs = new Set(removed.map(entry => entry.ref));
        signal.throwIfAborted();
        for (const record of removed) removeBinding(sessions, record);
        if (removed.length) {
          sessions.history = sessions.history.filter(entry => !refs.has(entry.ref));
          await saveSessions(sessions);
        }
        return { removed: removed.length };
      });
    },
    syncSessionRole(ref) {
      return exclusive(async signal => {
        const config = await getConfig();
        const { record } = await recordFor(ref, config);
        if (record.provider !== 'codex') {
          throw new ControlError('AGENT_SESSION', '此操作用于同步已记录的 Codex 会话。');
        }
        const agent = await runtime({ ...config, provider: record.provider, cwd: record.cwd }, launchDirectory);
        const prompt = await getPrompt();
        return runCodex(agent, { sessionId: record.id, prompt, syncRole: true }, signal);
      });
    },
    async openSession(ref, { bind = false } = {}) {
      const open = async signal => {
        const config = await getConfig();
        const { record, sessions, current } = await recordFor(ref, config);
        if (record.provider === 'deepseekharness' || record.provider === 'omp') {
          if (windows && record.provider === 'deepseekharness') {
            throw new ControlError('UNSUPPORTED_PLATFORM', 'Windows 请在 DeepSeek Harness 内打开会话，再回到 VA 绑定。');
          }
          const launch = async signal => {
            if (archivedSession(sessions, record.provider, record.id)) {
              throw new ControlError('AGENT_SESSION_ARCHIVED', '这条 DeepSeek Harness 会话已归档。');
            }
            const path = await findSessionFile(record.provider, record.id);
            if (!path) throw new ControlError('AGENT_SESSION', `找不到这条 ${providers[record.provider]} 会话。`);
            const agent = await runtime({ ...config, provider: record.provider, cwd: record.cwd }, launchDirectory);
            const deepseek = record.provider === 'deepseekharness';
            if (deepseek) {
              await openDeepSeekSession(record.id, () => openDeepSeek(agent.command), signal);
            } else {
              const model = agent.model ? ['--model', agent.model] : [];
              const prompt = await getPrompt();
              signal.throwIfAborted();
              await openTerminal(agent, ['--allow-home', '--append-system-prompt', prompt, ...model, '--resume', path]);
            }
            if (bind && (!current || sessions.bindings[current.key] !== record.id)) await restoreBinding(ref, signal);
            return deepseek ? 'deepseek' : 'terminal';
          };
          return signal ? launch(signal) : exclusive(launch);
        }
        if (!nativeResume.has(record.provider)) {
          throw new ControlError('AGENT_SESSION', '当前支持打开 Codex 和 Claude Code 会话。');
        }
        signal?.throwIfAborted();
        const openedInCodex = record.provider === 'codex' && await openCodex(record.id);
        if (!openedInCodex) {
          const agent = await runtime({ ...config, provider: record.provider, cwd: record.cwd }, launchDirectory);
          const prompt = await getPrompt();
          const model = agent.model ? ['--model', agent.model] : [];
          const args = record.provider === 'codex'
            ? ['resume', '--config', 'developer_instructions=' + JSON.stringify(prompt), ...model, record.id]
            : ['--resume', record.id, '--append-system-prompt', prompt, ...model];
          signal?.throwIfAborted();
          await openTerminal(agent, args);
        }
        signal?.throwIfAborted();
        if (bind && (!current || boundKey(record, sessions.bindings) !== current.key)) await restoreBinding(ref, signal);
        return openedInCodex ? 'codex' : 'terminal';
      };
      return bind ? exclusive(open) : open();
    },
    openNewSession() {
      return exclusive(async signal => {
        const agent = await runtime(await getConfig(), launchDirectory);
        const { provider, cwd, model } = agent;
        if (!provider) throw new ControlError('AGENT_UNSELECTED', '请先选择 Agent。');
        signal.throwIfAborted();
        if (provider === 'codex' && await openCodex(null, cwd)) {
          return { opened: true, application: 'codex', provider };
        }
        if (provider === 'deepseekharness' && await openDeepSeek(agent.command)) {
          return { opened: true, application: 'deepseek', provider };
        }
        const modelArgs = model ? ['--model', model] : [];
        const id = provider === 'claude' ? randomUUID() : undefined;
        const sessions = id ? await getSessions(agent) : undefined;
        let args = agent.args;
        if (provider === 'codex') args = ['--config', 'developer_instructions=' + JSON.stringify(await getPrompt()), ...modelArgs];
        if (provider === 'claude') args = ['--session-id', id, '--append-system-prompt', await getPrompt(), ...modelArgs];
        if (provider === 'omp') args = ['--allow-home', '--append-system-prompt', await getPrompt(), ...modelArgs];
        if (provider === 'deepseekharness') args = ['web'];
        signal.throwIfAborted();
        await openTerminal(agent, args, { freshOmp: provider === 'omp' });
        signal.throwIfAborted();
        if (id) {
          addBinding(sessions, agent, id);
          await saveSessions(sessions);
          history.delete(agent.key);
        }
        return { opened: true, application: provider === 'deepseekharness' ? 'deepseek' : 'terminal', provider, sessionId: id };
      });
    },
    send(value, options = {}) {
      const message = field(value, 2200, '消息');
      if (!message) throw new ControlError('AGENT_INPUT', '请输入消息。');
      return exclusive(async signal => {
        const agent = await runtime(await getConfig(), launchDirectory);
        if (!agent.provider) throw new ControlError('AGENT_UNSELECTED', '请先选择 Agent。');
        if (!agent.command) throw new ControlError('AGENT_CONFIG', '请在 agent.json 的 localAgent.custom.command 填写可执行文件的绝对路径。');
        const sessions = await getSessions(agent);
        const sessionId = options.newSession ? null : (sessions.bindings[agent.key] ?? null);
        if (options.voiceTarget && (options.voiceTarget.key !== agent.key ||
            options.voiceTarget.sessionId !== sessionId)) {
          throw new ControlError('AGENT_SESSION_CHANGED', '本地 Agent 会话已变更，请重新开启语音输入。');
        }
        if (archivedSession(sessions, agent.provider, sessionId)) {
          throw new ControlError('AGENT_SESSION_ARCHIVED', '这条 DeepSeek Harness 会话已归档，请绑定另一条会话。');
        }
        if (!options.newSession && (nativeResume.has(agent.provider) || sessionId !== null) &&
            !validSession(agent.provider, sessionId)) {
          throw new ControlError('AGENT_SESSION', '请先创建会话或绑定一个有效的 Agent 会话。');
        }
        const prompt = await getPrompt() + '\n\n在 VA 内处理的对话通过回复触发动作。需要表演时，请直接写台词并附上末行动作标记。';
        if (prompt.length > 45000) throw new ControlError('AGENT_INPUT', '角色与 Agent 的 Prompt 合计太长。');
        const input = { message, prompt, sessionId };
        pendingReply = sessionId ? replySessionKey(agent.provider, sessionId) : undefined;
        const result = await dispatch(agent, input, signal);
        signal.throwIfAborted();
        const fullReply = typeof result?.reply === 'string' ? result.reply.trim() : '';
        const raw = fullReply.slice(0, maxReply);
        const effect = { ...parseReply(raw), ...options.requestedEffect };
        const reply = effect.speech;
        if (!reply && !effect.action && !effect.expression && !effect.dance) throw failure('Agent 没有返回可显示的回复。');
        if (!validSession(agent.provider, result?.sessionId) || (sessionId && sessionId !== result.sessionId)) {
          throw failure('Agent 返回了无效或不一致的会话 ID。');
        }
        if (sessionId !== result.sessionId) {
          addBinding(sessions, agent, result.sessionId, message);
          await saveSessions(sessions);
          history.delete(agent.key);
        }
        signal.throwIfAborted();
        history.set(agent.key, [...(history.get(agent.key) ?? []), { message, reply }].slice(-20));
        const readAloud = options.speak ?? agent.speakReplies;
        const scope = replySessionKey(agent.provider, result.sessionId);
        const bubbleQueued = presentReply(reply, readAloud, effect, scope);
        if (bubbleQueued && raw && replyMonitorEnabled) {
          forwardedReplies = [...forwardedReplies.slice(-9), { scope, text: fullReply, until: Date.now() + 15_000 }];
        }
        return { provider: agent.provider, reply, sessionId: result.sessionId, bubbleQueued,
          spoken: readAloud && bubbleQueued };
      });
    },
  };
}
