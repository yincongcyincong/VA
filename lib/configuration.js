import { z } from 'zod/v4';
import { ControlError } from './control.js';
import { modes } from '../desktop/integration.js';
import { screenIntervals, themes } from '../desktop/preferences.js';
import { speakingStyles } from '../desktop/speech-motion.js';
import { performanceId } from '../desktop/actions.js';
import { rolePromptLimit } from '../desktop/config.js';

const text = max => z.string().max(max).regex(/^[^\0]*$/u);
const path = text(4096).refine(value => value.trim().length > 0, '请选择本机文件或目录');
const modelId = text(200).min(1);
const windowPosition = z.object({ x: z.int32(), y: z.int32() }).strict();
const envName = z.string().max(200).regex(/^(?:[A-Za-z_]\w*)?$/u);
const name = text(40).trim().min(1).regex(/^[^\p{Cc}]+$/u);
const line = text(300).trim().min(1);
const entries = z.record(z.string().regex(performanceId), z.record(z.string(), z.unknown()).nullable());
const provider = z.enum(['', 'codex', 'claude', 'deepseekharness', 'omp', 'custom']);
const executable = z.object({ command: text(4096), model: text(200) }).strict().partial();
const localAgent = z.object({
  provider, cwd: text(4096), speakReplies: z.boolean(), allowMultipleSessions: z.boolean(),
  codex: executable, claude: executable, deepseekharness: executable, omp: executable,
  custom: z.object({ command: text(4096), args: z.array(text(4096)).max(50) }).strict().partial(),
}).strict().partial();
const route = z.object({ target: text(240), speakReplies: z.boolean() }).strict().partial();
const section = (description, schema, example) => ({ description, schema, example });
const sections = {
  desktop: section('桌面主题、视角、缩放、窗口位置、鼠标、屏幕和音乐。窗口位置为 null 时恢复主屏幕默认位置', z.object({
    theme: z.enum(themes), speakingStyle: z.enum(Object.keys(speakingStyles)), scale: z.number().int().min(40).max(110),
    view: z.enum(['full', 'portrait']), clickThrough: z.boolean(), screenWatch: z.boolean(),
    screenInterval: z.number().int().refine(value => screenIntervals.some(([seconds]) => seconds === value)),
    musicDance: z.boolean(), windowPosition: windowPosition.nullable(),
  }).strict().partial(), { theme: 'sakura', speakingStyle: 'lively', scale: 58, view: 'portrait',
    clickThrough: false, screenWatch: false, screenInterval: 30, musicDance: false, windowPosition: { x: 100, y: 200 } }),
  character: section('角色名、人设及动作默认对白', z.object({
    name, prompt: text(rolePromptLimit).trim().min(1),
    dialogue: z.record(z.string().regex(performanceId), z.union([line, z.array(line).min(1).max(12), z.null()])),
  }).strict().partial(), { name: '小雪', prompt: '用自然中文回应。', dialogue: { wave: ['你好，我是{{name}}。'] } }),
  actions: section('按编号合并动作和表情。值为 null 时移除覆盖', z.object({
    actions: entries, expressions: entries,
  }).strict().partial(), { actions: { wave: { seconds: 3 }, 'small-bow': { label: '轻轻鞠躬', motion: 'bow', seconds: 2 } } }),
  voice: section('朗读音色、动作发声和火山 TTS', z.object({
    provider: z.enum(['system', 'volc', 'zipvoice']), actionSound: z.boolean(), systemVoice: text(160),
    zipvoice: z.object({
      python: text(4096), modelDirectory: text(4096), referenceAudio: text(4096), referenceText: text(1000),
    }).strict().partial(),
    volc: z.object({
      speaker: text(160), resourceId: z.enum(['seed-tts-2.0', 'seed-icl-2.0']), apiKey: text(1024),
      apiKeyEnv: envName, clearKey: z.boolean(),
    }).strict().partial(),
  }).strict().partial(), { provider: 'system', actionSound: true }),
  agent: section('Agent 接入、机器人频道和字幕选项', z.object({
    mode: z.enum(modes), prompt: text(rolePromptLimit), localAgent,
    doubaoClient: z.object({ autoActions: z.boolean(), listenForActions: z.boolean() }).strict().partial(),
    channels: z.object({
      astrbot: route, openclaw: route.extend({ channel: text(100).optional(), accountId: text(160).optional(), sessionKey: text(240).optional() }),
    }).strict().partial(),
  }).strict().partial(), { mode: 'local', localAgent: { provider: 'codex', allowMultipleSessions: false } }),
  model: section('当前模型路径，null 恢复封面角色', z.object({
    path: path.nullable(), id: modelId,
  }).strict().partial().refine(value => Object.keys(value).length === 1, '请选择一个模型路径或模型库编号'), { path: null }),
};

const operations = {
  'model-library': section('列出内置和已导入的模型及编号', z.undefined()),
  'model-import': section('检测并导入模型包目录', z.object({ path }).strict(), { path: '/path/to/models' }),
  'model-check': section('检测一个模型文件', z.object({ path }).strict(), { path: '/path/to/avatar.vrm' }),
  'model-preview': section('在 VA 设置的模型库打开可旋转的 3D 预览，接受模型编号或本机文件路径',
    z.union([z.object({ id: modelId }).strict(), z.object({ path }).strict()]), { id: 'va-cover' }),
  'voice-preview': section('试听当前选中的朗读音色', z.undefined()),
  'system-voices': section('列出已安装且可用于朗读的本机音色', z.undefined()),
  'actions-reload': section('从配置文件重新加载动作和表情', z.undefined()),
  'chat-bind': section('绑定本地 Agent 会话，或用 current 绑定豆包当前对话', z.object({ id: text(160).nullable() }).strict(), { id: 'current' }),
  'chat-bind-current': section('绑定发起调用的本机 Codex 会话，并设为发送目标。开启多会话后会保留其他绑定',
    z.object({ id: z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i).optional() }).strict().optional(), {}),
  'agent-voice-status': section('查询本地 Agent 麦克风监听状态', z.undefined()),
  'agent-voice-start': section('启动麦克风监听，将识别的文字发给当前绑定的本地 Agent', z.undefined()),
  'agent-voice-stop': section('停止本地 Agent 麦克风监听', z.undefined()),
  'deepseek-install-role': section('为已绑定的 DeepSeek Harness 会话安装 VA 角色能力', z.undefined()),
  'doubao-client-open': section('打开本机豆包客户端', z.undefined()),
  'doubao-client-read': section('从已绑定的豆包对话读取最新回复并展示在 VA', z.undefined()),
  'doubao-unbind': section('解除本机豆包会话绑定', z.undefined()),
  'doubao-context': section('向已绑定的豆包对话发送角色能力说明', z.undefined()),
  'doubao-caption-start': section('开始豆包客户端通话字幕', z.object({ autoActions: z.boolean().optional(), listen: z.boolean().optional() }).strict().optional(), {}),
  'doubao-caption-stop': section('停止豆包客户端通话字幕', z.undefined()),
  'chat-sessions': section('查询本地 Agent 会话记录、监听绑定和当前发送目标', z.undefined()),
  'chat-open-session': section('打开已记录的 Codex、Claude Code、DeepSeek Harness 或 OMP 会话，可同时绑定',
    z.object({ ref: text(240).min(1), bind: z.boolean().optional() }).strict(), { ref: '绑定记录的 ref', bind: true }),
  'chat-restore-session': section('从记录恢复之前绑定的 Agent、目录和会话',
    z.object({ ref: text(240).min(1) }).strict(), { ref: '绑定记录的 ref' }),
  'chat-unbind-session': section('解除某条记录的本地 Agent 会话绑定',
    z.object({ ref: text(240).min(1) }).strict(), { ref: '绑定记录的 ref' }),
  'chat-clear-sessions': section('移除一条或某个本地 Agent 的全部 VA 绑定记录，并解除相关绑定',
    z.union([z.object({ ref: text(240).min(1) }).strict(),
      z.object({ provider: provider.exclude(['']) }).strict()]), { ref: '绑定记录的 ref' }),
  'chat-sync-role': section('把当前角色 Prompt 同步到指定的 Codex 会话',
    z.object({ ref: text(240).min(1) }).strict(), { ref: '绑定记录的 ref' }),
  'chat-create-session': section('打开所选本地 Agent 的新会话。可提供 message 由 VA 发送首条消息并绑定',
    z.object({ message: text(2200).min(1).optional() }).strict().optional(), {}),
  'permissions-status': section('查询 VA 的 macOS 录屏、麦克风和辅助功能权限状态', z.undefined()),
  'permissions-open': section('打开对应的 macOS 隐私设置页面',
    z.object({ kind: z.enum(['screen', 'microphone', 'accessibility']) }).strict(), { kind: 'screen' }),
};

export function configCatalog() {
  const entriesFor = source => Object.fromEntries(Object.entries(source).map(([key, { description, schema, example }]) =>
    [key, { description, ...(example !== undefined && { example, input: z.toJSONSchema(schema, { unrepresentable: 'any' }) }) }]));
  return { sections: entriesFor(sections), operations: entriesFor(operations) };
}

export const maxConfigBytes = 512 * 1024;

export function parseConfigCommand({ operation, target, value }) {
  const catalog = operation === 'run' ? operations : sections;
  if (!['get', 'set', 'run'].includes(operation) || typeof target !== 'string' || !Object.hasOwn(catalog, target)) {
    throw new ControlError('CONFIG_COMMAND', '请用 va config list 查看配置项和操作。');
  }
  const schema = operation === 'get' ? z.undefined() : catalog[target].schema;
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.join('.') || target;
    // Error details can contain received strings, including keys. Return only the field name.
    throw new ControlError('CONFIG_VALUE', '配置字段无效：' + where.slice(0, 200));
  }
  return { operation, target, value: result.data };
}

export function mergeConfigEntries(current = {}, patch = {}) {
  const entries = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) entries.delete(key);
    else entries.set(key, { ...entries.get(key), ...value });
  }
  return Object.fromEntries(entries);
}
