import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { ControlError } from '../lib/control.js';
import { readConfig, settingsWriter } from './config.js';

const providers = { codex: 'Codex', claude: 'Claude Code', deepseekharness: 'DeepSeek Harness', omp: 'OMP', custom: '自定义 Agent' };
const defaultCommands = { deepseekharness: 'dsh', custom: '' };
const timeout = 75_000;
const maxOutput = 8 * 1024 * 1024;
const sessionPattern = /^[a-z0-9][a-z0-9_.:-]{0,159}$/i;
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function field(value, max, label) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new ControlError('AGENT_INPUT', `${label}最长 ${max} 字，且必须是文本。`);
  }
  return value.trim();
}

function preference(value) {
  const { provider = '', cwd = '', prompt = '', speakReplies = false } = value ?? {};
  if (typeof provider !== 'string' || (provider !== '' && !Object.hasOwn(providers, provider)) || typeof speakReplies !== 'boolean') {
    throw new ControlError('AGENT_CONFIG', '请选择受支持的 Agent。');
  }
  return { provider, cwd: field(cwd, 4096, '工作目录'), prompt: field(prompt, 5000, '注入 Prompt'), speakReplies };
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

function runAgent(agent, signal, build) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const paths = [process.env.PATH, join(homedir(), '.local/bin'), join(homedir(), '.bun/bin'),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    const child = spawn(agent.command, agent.args, {
      cwd: agent.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: paths.filter(Boolean).join(delimiter) },
    });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    let stderr = '';
    let stopped = false;

    function finish(error, result) {
      if (stopped) return;
      stopped = true;
      signal.removeEventListener('abort', abort);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const kill = sig => {
          try { process.kill(-child.pid, sig); } catch {}
        };
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 1000).unref();
      }
      if (error) reject(error);
      else resolve(result);
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
        throw new ControlError('AGENT_FAILED', detail.slice(-600) || `${agent.label} 未返回完整回复（退出码 ${code}）。`);
      } catch (error) { finish(error); }
    });
  });
}

function failure(message) {
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
          startTurn();
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
    });
  }
  return runJsonAgent(agent, input, signal);
}

export function createLocalAgent({ getConfig, updateConfig, getPrompt, parseReply, sessionPath, launchDirectory = process.cwd(), presentReply, onChange = () => {} }) {
  const saveSessions = settingsWriter(sessionPath);
  const history = new Map();
  let active;

  const getSessions = async () => {
    const value = await readConfig(sessionPath, {}, 'AGENT_SESSIONS', 'local-agent-sessions.json');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ControlError('AGENT_SESSIONS', '会话文件需要是一个 JSON 对象。');
    }
    return value;
  };

  async function snapshot(agent, sessions) {
    const config = agent ?? await runtime(await getConfig(), launchDirectory);
    const saved = sessions ?? await getSessions();
    const { provider, label, cwd, prompt, speakReplies, models, key } = config;
    return { provider, label, cwd, workingDirectory: config.cwdSetting, launchDirectory, prompt, speakReplies, models, sessionId: saved[key] ?? null,
      history: history.get(key) ?? [], busy: Boolean(active) };
  }

  function validateSession(agent, id) {
    const pattern = ['codex', 'claude'].includes(agent.provider) ? uuidPattern : sessionPattern;
    return typeof id === 'string' && pattern.test(id);
  }

  function exclusive(job) {
    if (active) throw new ControlError('AGENT_BUSY', 'Agent 正在处理请求，请等待或点击停止。');
    const controller = new AbortController();
    active = controller;
    onChange();
    const timer = setTimeout(() => controller.abort(new ControlError('AGENT_TIMEOUT', 'Agent 超时，请重试。')), timeout);
    return job(controller.signal).finally(() => {
      clearTimeout(timer);
      active = undefined;
      onChange();
    });
  }

  async function screenAgent() {
    const agent = await runtime(await getConfig(), launchDirectory);
    if (!agent.provider) throw new ControlError('AGENT_UNSELECTED', '请在「智能体与模型」选择接收截图的本地 Agent。');
    if (agent.provider === 'deepseekharness') {
      throw new ControlError('AGENT_IMAGE_UNSUPPORTED', 'DeepSeek Harness 的 headless CLI 不接收图片，请选择支持图片输入的 Agent。');
    }
    if (!agent.command) throw new ControlError('AGENT_CONFIG', '请先配置自定义 Agent 的可执行文件。');
    return agent;
  }

  return {
    status: () => snapshot(),
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
    configure(value) {
      return exclusive(async signal => {
        await updateConfig(async previous => {
          const next = preference({ ...previous, ...value });
          const config = { ...previous, ...next };
          if (['codex', 'claude', 'omp'].includes(next.provider) && typeof value?.model === 'string') {
            config[next.provider] = { ...previous?.[next.provider], model: field(value.model, 200, '模型名') };
          }
          await runtime(config, launchDirectory);
          signal.throwIfAborted();
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
        if (id !== null && !validateSession(agent, id)) throw new ControlError('AGENT_SESSION', '会话 ID 格式无效。');
        const sessions = await getSessions();
        signal.throwIfAborted();
        if (id) sessions[agent.key] = ['codex', 'claude'].includes(agent.provider) ? id.toLowerCase() : id;
        else delete sessions[agent.key];
        await saveSessions(sessions);
        history.delete(agent.key);
        const result = await snapshot(agent, sessions);
        return { ...result, busy: false };
      });
    },
    send(value, options = {}) {
      const message = field(value, 2200, '消息');
      if (!message) throw new ControlError('AGENT_INPUT', '请输入消息。');
      return exclusive(async signal => {
        const agent = await runtime(await getConfig(), launchDirectory);
        if (!agent.provider) throw new ControlError('AGENT_UNSELECTED', '请先选择 Agent。');
        if (!agent.command) throw new ControlError('AGENT_CONFIG', '请在 agent.json 的 localAgent.custom.command 填写可执行文件的绝对路径。');
        const sessions = await getSessions();
        const sessionId = sessions[agent.key] ?? null;
        if (sessionId !== null && !validateSession(agent, sessionId)) {
          throw new ControlError('AGENT_SESSION', '已保存的会话 ID 无效，请新建会话。');
        }
        const prompt = await getPrompt(agent.prompt);
        if (prompt.length > 45000) throw new ControlError('AGENT_INPUT', '角色与 Agent 的 Prompt 合计太长。');
        const input = { message, prompt, sessionId };
        const result = await dispatch(agent, input, signal);
        signal.throwIfAborted();
        const raw = typeof result?.reply === 'string' ? result.reply.trim().slice(0, 20000) : '';
        const effect = parseReply(raw);
        const reply = effect.speech;
        if (!reply && !effect.action && !effect.expression) throw failure('Agent 没有返回可显示的回复。');
        if (!validateSession(agent, result?.sessionId) || (sessionId && sessionId !== result.sessionId)) {
          throw failure('Agent 返回了无效或不一致的会话 ID。');
        }
        if (sessionId !== result.sessionId) {
          sessions[agent.key] = result.sessionId;
          await saveSessions(sessions);
        }
        signal.throwIfAborted();
        history.set(agent.key, [...(history.get(agent.key) ?? []), { message, reply }].slice(-20));
        const readAloud = options.speak ?? agent.speakReplies;
        const bubbleQueued = presentReply(reply, readAloud, effect);
        return { provider: agent.provider, reply, sessionId: result.sessionId, bubbleQueued,
          spoken: readAloud && bubbleQueued };
      });
    },
  };
}
