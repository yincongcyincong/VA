import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { performanceId } from '../desktop/actions.js';
import { listActions } from './catalog.js';
import { request } from './control.js';
import { startDesktop, takeSelfie } from './start.js';
import { configCatalog, maxConfigBytes, parseConfigCommand } from './configuration.js';

const server = new McpServer({ name: 'va-desktop', version: '0.2.0' });
const readOnly = { readOnlyHint: true };
const presetId = z.string().regex(performanceId);
const text = data => ({ type: 'text', text: JSON.stringify(data) });

function register(name, config, run) {
  server.registerTool(name, config, async args => {
    try {
      return { content: await run(args) };
    } catch (error) {
      return { isError: true, content: [text({ code: error.code || 'ERROR', message: error.message })] };
    }
  });
}

register('va_start', { description: '启动或显示本机桌面角色。' },
  async () => [text(await startDesktop())]);
register('va_status', { description: '查看角色是否已加载、可见或正在表演。', annotations: readOnly },
  async () => [text(await request({ type: 'status' }))]);
register('va_config_list', { description: '查看所有配置组、配置操作和 JSON 示例。', annotations: readOnly },
  async () => [text(configCatalog())]);
register('va_config_get', {
  description: '读取指定 VA 配置组。凭据字段只返回是否已配置。',
  annotations: readOnly,
  inputSchema: { section: z.string().max(100) },
}, async ({ section }) => [text(await request({ type: 'configuration', ...parseConfigCommand({ operation: 'get', target: section }) }))]);
register('va_config_set', {
  description: '合并并立即应用一组 VA 设置。参数 patch 是 JSON 对象，字段见 va_config_list。',
  inputSchema: { section: z.string().max(100), patch: z.record(z.string(), z.unknown()) },
}, async ({ section, patch }) => [text(await sendConfig('set', section, patch))]);
register('va_config_run', {
  description: '执行 VA 配置操作，例如绑定会话、修改 API 配置、查询本机音色或导入模型。参数见 va_config_list。',
  inputSchema: { operation: z.string().max(100), parameters: z.record(z.string(), z.unknown()).optional() },
}, async ({ operation, parameters }) => [text(await sendConfig('run', operation, parameters))]);
function sendConfig(operation, target, value) {
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > maxConfigBytes) throw new Error('配置 JSON 最多 512 KiB。');
  return request({ type: 'configuration', ...parseConfigCommand({ operation, target, value }) });
}
register('va_senses', {
  description: '读取音乐检测、当前屏幕识别方式和观察状态。',
  annotations: readOnly,
}, async () => [text(await request({ type: 'senses' }))]);
register('va_observe', {
  description: '通过 VA 当前选中的接入观察主屏幕，返回活动概述和角色对白。需用户已开启屏幕观察。',
}, async () => [text(await request({ type: 'observe' }))]);
register('va_actions', {
  description: '读取动作类别 categories、各动作的 category 和 supported，以及 supportedExpressions。包含用户自定义条目。VA 关闭时返回内置目录，启动后可检查模型兼容性。',
  annotations: readOnly,
  inputSchema: { includeConfigPath: z.boolean().optional() },
}, async args => [text(await listActions(false, args.includeConfigPath))]);
register('va_reload_actions', {
  description: '保存动作与表情配置后重新加载，返回当前模型的动作和表情。用返回的 supported 和 supportedExpressions 检查新条目。',
}, async () => [text(await listActions(true))]);
register('va_model_check', {
  description: '检测本机 3D 模型是否能渲染并列出骨骼、表情和内置动画。',
  annotations: readOnly,
  inputSchema: { path: z.string().min(1).max(4096).describe('本机模型的绝对路径') },
}, async args => [text(await request({ type: 'model-check', path: args.path }))]);
register('va_character', {
  description: '读取用户配置的人物 Prompt 和默认台词。生成自定义台词前调用此工具。',
  annotations: readOnly,
}, async () => [text(await request({ type: 'character' }))]);
register('va_prompt', {
  description: '生成包含当前显示名、人设和可用动作与表情的完整 Prompt。修改模型或重载动作后可重新读取。',
  annotations: readOnly,
  inputSchema: { style: z.enum(['text', 'voice']).optional().describe('text 用于本地文本 Agent，voice 用于语音或机器人频道') },
}, async args => {
  const { prompt } = await request({ type: 'prompt', style: args.style });
  return [{ type: 'text', text: prompt }];
});
register('va_say', {
  description: '朗读台词，并在桌面角色旁显示同一段文字。',
  inputSchema: {
    speech: z.string().trim().min(1).max(300),
    expression: presetId.optional().describe('va_actions 返回的 supportedExpressions 中的编号'),
    wait: z.boolean().optional(),
  },
}, async args => [text(await request({ type: 'perform', ...args }))]);
register('va_perform', {
  description: '播放动作和对白，台词会显示在角色旁。省略台词时读取动作的默认对白。默认等待表演完成。',
  inputSchema: {
    action: presetId.optional().describe('va_actions 返回的动作编号，例如 dance、kiss 或自定义动作'),
    expression: presetId.optional().describe('va_actions 返回的 supportedExpressions 中的编号'),
    speech: z.string().max(300).optional().describe('台词，通常用中文'),
    wait: z.boolean().optional().describe('false 表示立即返回任务 ID'),
  },
}, async args => {
  if (!args.action && !args.expression && !args.speech?.trim()) {
    throw new Error('请提供动作、表情或台词。');
  }
  return [text(await request({ type: 'perform', ...args }))];
});
register('va_stop', { description: '停止当前动作和语音，返回待机。' },
  async () => [text(await request({ type: 'stop' }))]);
register('va_photo', {
  description: '拍下角色当前的 3D 画面，返回透明背景 PNG。取景范围仅包含角色画布。',
  annotations: readOnly,
}, async () => {
  const { png } = await request({ type: 'photo' });
  return [{ type: 'image', mimeType: 'image/png', data: png }];
});
register('va_selfie', {
  description: '让角色摆自拍姿势并只返回透明 PNG。成功时直接交付图片，台词仅在明确指定时在桌面播放。角色隐藏或 VA 未启动时也能拍。',
  inputSchema: {
    speech: z.string().max(300).optional(),
    expression: presetId.optional().describe('va_actions 返回的 supportedExpressions 中的编号'),
  },
}, async args => {
  const { png } = await takeSelfie({ ...args, quiet: true });
  return [{ type: 'image', mimeType: 'image/png', data: png }];
});

await server.connect(new StdioServerTransport());
