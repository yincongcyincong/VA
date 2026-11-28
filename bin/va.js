#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listActions } from '../lib/catalog.js';
import { ControlError, request } from '../lib/control.js';
import { startDesktop, takeSelfie } from '../lib/start.js';
import { cameraQuestion } from '../lib/camera.js';
import { configCatalog, maxConfigBytes, parseConfigCommand } from '../lib/configuration.js';
import { bindCurrentCodex } from '../lib/current-codex.js';

const usage = `VA · 桌面角色

  va start                              启动或显示角色
  va status [--json]                    查看桌面状态
  va actions [--category <类别>] [--supported] [--reload] [--config-path] [--json]
  va act <动作编号或名称> [--expression <表情>] [--no-wait]
  va <动作编号>                         直接播放动作，内置命令名优先
  va express <表情编号或名称> [--no-wait]
  va say <台词>                          朗读中文台词
  va perform [--action <动作>] [--expression <表情>] [--no-wait]
  va photo [--out <文件.png>] [--clipboard]
  va selfie [--out <文件.png>] [--clipboard]
  va camera [--out <文件.jpg>] [--ask <问题>] [--agent <codex|claude|omp|custom>] [--model <名称>]
  va settings | character               打开设置或读取人设和默认台词
  va config list | get <配置组>           查询配置组、操作或当前配置
  va config <set|run> <目标> [JSON|--file <文件>|--stdin]
  va prompt [--voice]                   输出当前角色和可用动作的完整 Prompt
  va chat [消息] [--speak]                打开接入设置，或向已接入的 Agent 发送消息；本地 Agent 需先绑定会话（va chat-bind）
  va chat-status | chat-new | chat-cancel
  va chat-context                        向已绑定的豆包对话同步 VA 角色能力
  va chat-bind <会话ID|current>           绑定 Agent 会话，或绑定豆包当前对话
  va chat-bind-current                   绑定当前 Codex 会话并设为发送目标
  va chat-use <codex|claude|deepseekharness|omp|custom|none>
  va integration [off|local|doubao-client|astrbot|openclaw]
  va model [文件|default]                查看、选择模型或恢复默认模型
  va model-check <文件>                  检测模型、骨骼、表情和内置动画
  va senses [--json]                    查看屏幕观察和音乐状态
  va sense <screen|music> <on|off>       控制屏幕观察或自动跳舞
  va sense interval <秒>                可选 10、30、60、300、600、1800、3600、21600、86400
  va scale [40-110]                     查看或设置模型大小百分比
  va view <full|portrait>                设置全身或半身视角
  va click-through <on|off>              设置鼠标穿透
  va show | hide | stop | quit
  va mcp                                启动 MCP stdio 适配器
  va bridge                             从 stdin 接收机器人 JSON

动作、语音默认在完成后返回。--no-wait 会立即返回任务 ID。
所有普通命令都支持 --json。`;

const argv = process.argv.slice(2);
const delimiter = argv.indexOf('--');
const global = argv.splice(0, delimiter === -1 ? argv.length : delimiter);
const [command, ...args] = [...global.filter(value => value !== '--json'), ...argv];
const machine = global.includes('--json') || command === 'bridge';

function invalid(message) {
  throw new ControlError('INVALID_ARGUMENTS', message);
}

function options(schema = {}) {
  return parseArgs({ args, allowPositionals: true, options: schema });
}

function count(positionals, length) {
  if (positionals.length !== length) invalid(`va ${command} 需要 ${length} 个位置参数。`);
}

const normalizeName = name => name.normalize('NFKC').trim().toLowerCase();

async function configuration() {
  const { positionals, values } = options({ file: { type: 'string' }, stdin: { type: 'boolean' } });
  const [operation, target, inline, ...extra] = positionals;
  const sources = Number(inline !== undefined) + Number(Boolean(values.file)) + Number(Boolean(values.stdin));
  if (!target && operation === 'list' && !sources) return configCatalog();
  if (!target || extra.length || sources > 1 || (operation === 'get' && sources)) {
    invalid('用法：va config list、get <配置组>、set <配置组> 或 run <操作>。');
  }
  let input = inline;
  if (values.file) {
    const file = await readFile(resolve(values.file));
    if (file.length > maxConfigBytes) invalid('配置 JSON 最多 512 KiB。');
    input = file.toString('utf8');
  } else if (values.stdin) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > maxConfigBytes) invalid('配置 JSON 最多 512 KiB。');
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString('utf8');
  }
  if (input !== undefined && Buffer.byteLength(input) > maxConfigBytes) invalid('配置 JSON 最多 512 KiB。');
  let value;
  if (input !== undefined) {
    try { value = JSON.parse(input); } catch { invalid('配置需要有效的 JSON。'); }
  }
  if (value && typeof value.path === 'string') value.path = resolve(value.path);
  const parsed = parseConfigCommand({ operation, target, value });
  if (operation === 'run' && target === 'chat-bind-current') return bindCurrentCodex(parsed.value);
  return request({ type: 'configuration', ...parsed });
}

function presetId(entries, input, label, labelOf) {
  const name = normalizeName(input);
  if (Object.hasOwn(entries, name)) return name;
  const matches = Object.entries(entries).filter(([, item]) => normalizeName(labelOf(item)) === name);
  if (matches.length > 1) invalid(`${label}「${input}」对应多个编号，请选用 ${matches.map(([id]) => id).join('、')}。`);
  if (!matches.length) throw new ControlError('INVALID_REQUEST', `找不到${label}「${input}」。请用 va actions 查看配置。`);
  return matches[0][0];
}

async function performFromCli() {
  const direct = !['act', 'express', 'say', 'perform'].includes(command);
  const { positionals, values } = options({
    ...(command === 'perform' && { action: { type: 'string' } }),
    ...(command !== 'express' && { expression: { type: 'string' } }),
    'no-wait': { type: 'boolean' },
  });
  count(positionals, direct || command === 'perform' ? 0 : 1);
  const actionName = direct ? command : command === 'act' ? positionals[0] : values.action;
  const expressionName = command === 'express' ? positionals[0] : values.expression;
  const speech = command === 'say' ? positionals[0] : undefined;
  if (command === 'say' && !speech.trim()) invalid('请输入要朗读的台词。');
  if (command !== 'say' && !actionName && !expressionName) invalid('请提供动作或表情。');

  let action;
  let expression;
  if (actionName !== undefined || expressionName !== undefined) {
    const catalog = await request({ type: 'actions' });
    if (actionName !== undefined) {
      action = presetId(catalog.actions, actionName, '动作', item => item.label);
      if (catalog.actions[action].supported === false) throw new ControlError('MODEL_ACTION', `当前模型不支持动作「${catalog.actions[action].label}」。`);
    }
    if (expressionName !== undefined) {
      expression = presetId(catalog.expressions, expressionName, '表情', label => label);
      if (catalog.supportedExpressions && !catalog.supportedExpressions.includes(expression)) {
        throw new ControlError('MODEL_ACTION', `当前模型不支持表情「${catalog.expressions[expression]}」。`);
      }
    }
  }
  return await request({ type: 'perform', action, expression, speech, wait: !values['no-wait'] });
}

async function execute() {
  if (command === 'config') return configuration();
  if (command === 'chat-bind-current') {
    count(options().positionals, 0);
    return bindCurrentCodex();
  }
  if (command === 'bridge') {
    count(options().positionals, 0);
    const { runBotBridge } = await import('../lib/bot-bridge.js');
    return await runBotBridge();
  }
  if (command === 'mcp') {
    if (machine || args.length) invalid('va mcp 使用 stdio，直接运行即可。');
    await import('../lib/mcp.js');
    return;
  }
  if (command === 'actions') {
    const { positionals, values } = options({ category: { type: 'string' }, supported: { type: 'boolean' },
      reload: { type: 'boolean' }, 'config-path': { type: 'boolean' } });
    count(positionals, 0);
    const catalog = values.supported ? await request({ type: 'actions', reload: values.reload, includeConfigPath: values['config-path'] })
      : await listActions(values.reload, values['config-path']);
    const category = values.category === undefined ? undefined : presetId(catalog.categories ?? {}, values.category, '动作类别', label => label);
    if (category || values.supported) {
      catalog.actions = Object.fromEntries(Object.entries(catalog.actions).filter(([, item]) =>
        (!category || (item.category === category && !item.alternate)) && (!values.supported || item.supported)));
    }
    if (values.supported) {
      catalog.expressions = Object.fromEntries(catalog.supportedExpressions.map(id => [id, catalog.expressions[id]]));
    }
    return catalog;
  }
  if (command === 'prompt') {
    const { positionals, values } = options({ voice: { type: 'boolean' } });
    count(positionals, 0);
    return await request({ type: 'prompt', style: values.voice ? 'voice' : 'text' });
  }
  if (command === 'model-check') {
    const { positionals } = options();
    count(positionals, 1);
    return request({ type: 'model-check', path: resolve(positionals[0]) });
  }
  if (command === 'start') {
    count(options().positionals, 0);
    return await startDesktop();
  }
  if (command === 'chat') {
    const { positionals, values } = options({ speak: { type: 'boolean' } });
    if (positionals.length > 1 || (values.speak && !positionals.length)) invalid('用法：va chat [消息] [--speak]。');
    return await request({ type: 'chat', message: positionals[0], speak: values.speak });
  }
  if (command === 'chat-bind') {
    const { positionals } = options();
    count(positionals, 1);
    return await request({ type: command, sessionId: positionals[0] });
  }
  if (command === 'chat-use') {
    const { positionals } = options();
    count(positionals, 1);
    return await request({ type: command, provider: positionals[0] === 'none' ? '' : positionals[0] });
  }
  if (command === 'integration') {
    const { positionals } = options();
    if (positionals.length > 1) invalid('请选择一种接入方式。');
    return await request({ type: command, mode: positionals[0] });
  }
  if (command === 'camera') {
    const { positionals, values } = options({
      out: { type: 'string' }, ask: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' },
    });
    count(positionals, 0);
    const question = cameraQuestion({ question: values.ask, agent: values.agent, model: values.model });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const path = values.out !== undefined || !question ? resolve(values.out || `va-camera-${stamp}.jpg`) : undefined;
    if (path && !/\.jpe?g$/iu.test(path)) invalid('摄像头照片文件需要 .jpg 或 .jpeg 扩展名。');
    const { data, ...result } = await request({ type: 'camera', ...question, includeImage: Boolean(path) });
    if (!path) return result;
    await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 });
    return { ...result, path };
  }
  if (command === 'photo' || command === 'selfie') {
    const { positionals, values } = options({
      out: { type: 'string' }, clipboard: { type: 'boolean' },
    });
    count(positionals, 0);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const path = resolve(values.out || `va-${stamp}.png`);
    if (!/\.png$/i.test(path)) invalid('照片文件需要 .png 扩展名。');
    const clipboard = values.clipboard === true;
    const { png } = command === 'selfie'
      ? await takeSelfie({ clipboard })
      : await request({ type: 'photo', clipboard });
    await writeFile(path, Buffer.from(png, 'base64'), { flag: 'wx' });
    return { path, clipboard };
  }
  if (command === 'scale') {
    const { positionals } = options();
    if (positionals.length > 1 || (positionals.length && !/^\d+$/.test(positionals[0]))) {
      invalid('请填写 40–110 的整数百分比。');
    }
    return await request({ type: 'scale', scale: positionals.length ? Number(positionals[0]) : undefined });
  }
  if (command === 'model') {
    const { positionals } = options();
    if (positionals.length > 1) invalid('请提供一个模型文件，或使用 default。');
    const [file] = positionals;
    return await request({ type: 'model', path: file === 'default' ? null : file ? resolve(file) : undefined });
  }
  if (command === 'sense') {
    const { positionals } = options();
    count(positionals, 2);
    const [channel, state] = positionals;
    if (channel === 'interval') return await request({ type: 'screen-interval', seconds: Number(state) });
    if (!['screen', 'music'].includes(channel) || !['on', 'off'].includes(state)) {
      invalid('用法：va sense <screen|music> <on|off>。');
    }
    return await request({ type: 'sense', channel, enabled: state === 'on' });
  }
  if (command === 'view' || command === 'click-through') {
    const { positionals } = options();
    count(positionals, 1);
    const [mode] = positionals;
    if (command === 'view') return await request({ type: 'view', mode });
    if (!['on', 'off'].includes(mode)) invalid('鼠标穿透可选 on 或 off。');
    return await request({ type: 'click-through', enabled: mode === 'on' });
  }
  if (['status', 'senses', 'settings', 'character', 'show', 'hide', 'stop', 'quit',
    'chat-status', 'chat-new', 'chat-cancel', 'chat-context'].includes(command)) {
    count(options().positionals, 0);
    return await request({ type: command });
  }
  return performFromCli();
}

if (!command || ['help', '-h', '--help'].includes(command)) {
  console.log(usage);
} else {
  try {
    const result = await execute();
    if (result) console.log(machine ? JSON.stringify({ ok: true, ...result })
      : result.reply ?? (command === 'prompt' ? result.prompt : result.path) ?? JSON.stringify(result, null, 2));
  } catch (error) {
    const code = error.code || 'ERROR';
    const message = code === 'EEXIST' ? '照片文件已存在，请使用另一个路径。' : error.message;
    if (machine) console.log(JSON.stringify({ ok: false, error: { code, message } }));
    else console.error(`va: ${message}`);
    process.exitCode = 1;
  }
}
