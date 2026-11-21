#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { actions, expressions } from '../desktop/actions.js';
import { ControlError, request } from '../lib/control.js';
import { startDesktop, takeSelfie } from '../lib/start.js';

const usage = `VA · 桌面角色

  va start                              启动或显示角色
  va status [--json]                    查看桌面状态
  va actions [--json]                   列出动作和表情
  va act <动作> [--expression <表情>] [--no-wait]
  va say <台词>                          朗读中文台词
  va perform [--action <动作>] [--say <台词>] [--expression <表情>] [--no-wait]
  va photo [--out <文件.png>] [--clipboard]
  va selfie [--out <文件.png>] [--clipboard] [--say <台词>]
  va settings | character               打开设置或读取人设和默认台词
  va chat [消息] [--speak]                打开聊天、发送消息或用自然语言让角色跳舞
  va chat-status | chat-new | chat-cancel
  va chat-context                        向已绑定的豆包对话同步 VA 角色能力
  va chat-bind <会话ID|current>           续接 Agent 会话，或绑定豆包当前对话
  va chat-use <codex|claude|deepseekharness|omp|custom|none>
  va integration [off|local|doubao-client|doubao|api|astrbot|openclaw]
  va model [文件|default]                查看、选择模型或恢复默认模型
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

async function execute() {
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
    count(options().positionals, 0);
    return { actions, expressions };
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
  if (command === 'act' || command === 'say' || command === 'perform') {
    const { positionals, values } = options({
      ...(command === 'perform' ? { action: { type: 'string' }, say: { type: 'string' } } : {}),
      expression: { type: 'string' },
      'no-wait': { type: 'boolean' },
    });
    count(positionals, command === 'perform' ? 0 : 1);
    const action = command === 'act' ? positionals[0] : values.action;
    const speech = command === 'say' ? positionals[0] : values.say;
    if (command === 'say' && !speech.trim()) invalid('请输入要朗读的台词。');
    if (!action && !speech?.trim() && !values.expression) invalid('请提供动作、表情或台词。');
    return await request({
      type: 'perform', action, expression: values.expression, speech, wait: !values['no-wait'],
    });
  }
  if (command === 'photo' || command === 'selfie') {
    const { positionals, values } = options({
      out: { type: 'string' }, clipboard: { type: 'boolean' },
      ...(command === 'selfie' ? { say: { type: 'string' } } : {}),
    });
    count(positionals, 0);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const path = resolve(values.out || `va-${stamp}.png`);
    if (!/\.png$/i.test(path)) invalid('照片文件需要 .png 扩展名。');
    const clipboard = values.clipboard === true;
    const { png, speech, voiceWarning } = command === 'selfie'
      ? await takeSelfie({ clipboard, speech: values.say })
      : await request({ type: 'photo', clipboard });
    await writeFile(path, Buffer.from(png, 'base64'), { flag: 'wx' });
    return { path, clipboard, speech, voiceWarning };
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
  invalid('未知命令。使用 va --help 查看用法。');
}

if (!command || ['help', '-h', '--help'].includes(command)) {
  console.log(usage);
} else {
  try {
    const result = await execute();
    if (result) console.log(machine ? JSON.stringify({ ok: true, ...result })
      : result.reply ?? result.path ?? JSON.stringify(result, null, 2));
  } catch (error) {
    const code = error.code || 'ERROR';
    const message = code === 'EEXIST' ? '照片文件已存在，请使用另一个路径。' : error.message;
    if (machine) console.log(JSON.stringify({ ok: false, error: { code, message } }));
    else console.error(`va: ${message}`);
    process.exitCode = 1;
  }
}
