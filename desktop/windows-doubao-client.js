import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlError } from '../lib/control.js';

const chatURL = /^chrome:\/\/doubao-chat\/chat\/(\d+)\/?$/u;
const readLabels = new Set(['朗读', '停止朗读', '暂停朗读']);
const fail = (code, message) => new ControlError(code, message);

export function callWindowsDoubaoHelper(binary, command, { run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = run(binary, [], { windowsHide: true, timeout: 12_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(fail(error.killed ? 'CLIENT_TIMEOUT' : 'CLIENT_HELPER', error.killed
        ? '读取 Windows 豆包窗口超时，请打开绑定的聊天后重试。'
        : '无法启动 Windows 豆包助手，请重新构建 Windows 版 VA。'));
      let result;
      try { result = JSON.parse(stdout); } catch { /* Report an invalid helper response below. */ }
      if (!result?.ok) reject(fail(result?.code ?? 'CLIENT_HELPER', result?.message ?? 'Windows 豆包助手返回了无效数据。'));
      else resolve(result.data);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(command));
  });
}

export function parseWindowsDoubaoSnapshot(snapshot) {
  const nodes = snapshot?.nodes;
  if (!Array.isArray(nodes) || nodes.length > 2200) throw fail('CLIENT_HELPER', 'Windows 豆包窗口数据不完整。');
  const conversation = chatURL.exec(snapshot.url ?? '');
  if (!conversation) {
    if (nodes.some(node => node.kind === 'Button' && node.name === '登录')) {
      throw fail('CLIENT_LOGIN', '请先在豆包客户端完成登录，并打开一条已有聊天后绑定 VA。');
    }
    throw fail('CLIENT_ROUTE', '请先在豆包左侧打开一条已有聊天，等页面加载后再绑定。');
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map();
  for (const node of nodes) {
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }
  function textIn(node, visited = new Set()) {
    if (!node || visited.has(node.id) || visited.size > 500 || node.kind === 'Button' || node.kind === 'Edit') return '';
    visited.add(node.id);
    if (node.kind === 'Text') return (node.name || node.value || '').trim();
    const text = (children.get(node.id) ?? []).map(child => textIn(child, visited)).filter(Boolean).join('\n');
    return text || (['ListItem', 'Hyperlink'].includes(node.kind) ? node.name?.trim() : '') || '';
  }
  const readers = nodes.filter(node => node.kind === 'Button' && readLabels.has(node.name) && node.enabled);
  const reader = readers.at(-1);
  let reply = '';
  for (let prior = reader, level = 0; prior && level < 6; level++) {
    const parent = byId.get(prior.parent);
    if (!parent) break;
    const preceding = (children.get(parent.id) ?? []).slice(0, (children.get(parent.id) ?? []).findIndex(node => node.id === prior.id));
    // Windows Chromium flattens consecutive chat turns into one parent. Walk
    // back only across this answer's content, stopping at the prior controls;
    // collecting all preceding siblings would read prompts and old answers.
    const parts = [];
    for (const node of preceding.toReversed()) {
      const boundary = node.kind === 'Button' || (node.kind === 'Group' && node.invoke);
      if (boundary) {
        if (parts.length) break;
        continue;
      }
      const text = textIn(node);
      if (text) parts.unshift(text);
    }
    reply = parts.join('\n').trim();
    if (reply) break;
    prior = parent;
  }
  if (nodes.some(node => node.kind === 'Button' && node.enabled && ['停止生成', '停止回答'].includes(node.name))) reply = '';
  const editors = nodes.filter(node => node.enabled && !node.offscreen &&
    (node.kind === 'Edit' || (node.kind === 'Group' && node.focusable && node.textPattern)));
  const scopedEditors = editors.filter(node => {
    const visited = new Set();
    for (let parent = byId.get(node.parent); parent && !visited.has(parent.id); parent = byId.get(parent.parent)) {
      visited.add(parent.id);
      if (parent.automationId === 'input-engine-container') return true;
    }
    return false;
  });
  const composer = scopedEditors.length === 1 ? scopedEditors[0]
    : scopedEditors.length === 0 && editors.length === 1 ? editors[0] : undefined;
  const userGroup = nodes.findLast(node => {
    if (!['Group', 'Pane'].includes(node.kind)) return false;
    const parts = children.get(node.id) ?? [];
    const buttons = parts.filter(part => part.kind === 'Button');
    return buttons.length >= 2 && buttons.length <= 3 && buttons.every(part => !part.name) &&
      parts.some(part => part.kind === 'Text') && textIn(node);
  });
  return {
    route: snapshot.route,
    title: nodes.find(node => node.kind === 'Hyperlink' && node.value?.replace(/\/$/u, '') === snapshot.url.replace(/\/$/u, ''))?.name ||
      (snapshot.title && snapshot.title !== '豆包' ? snapshot.title : `豆包 · ${conversation[1]}`),
    reply: reply.slice(0, 2000), replyCount: readers.length,
    ...(userGroup ? { userTurn: { text: textIn(userGroup).slice(0, 2200), id: userGroup.automationId || userGroup.key } } : {}),
    composer, reader,
  };
}

export function createWindowsDoubaoRequest(binary, { request = command => callWindowsDoubaoHelper(binary, command) } = {}) {
  return async command => {
    if (!['inspect', 'read', 'send'].includes(command?.op)) throw fail('CLIENT_INPUT', '无效的 Windows 豆包操作。');
    const snapshot = await request({ op: 'snapshot', ...(command.route && { route: command.route }) });
    const current = parseWindowsDoubaoSnapshot(snapshot);
    if (command.route && command.route !== current.route) throw fail('CLIENT_ROUTE', '请切回绑定的豆包对话。');
    if (command.op === 'inspect') {
      const { composer, reader, ...view } = current;
      return view;
    }
    if (!command.route) throw fail('CLIENT_ROUTE', '请先绑定当前豆包对话。');
    if (command.op === 'read') {
      if (!current.reader || current.reader.name !== '朗读' || current.reader.offscreen) throw fail('CLIENT_VOICE', '请在豆包中显示最近回复，再尝试朗读。');
      return request({ op: 'invoke', route: current.route, key: current.reader.key });
    }
    if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 45000 || command.text.includes('\0')) {
      throw fail('CLIENT_INPUT', '请输入有效的豆包消息，最多 45000 字。');
    }
    if (!current.composer) throw fail('CLIENT_INPUT', '没有找到豆包聊天输入框，请打开绑定的聊天。');
    const draft = current.composer.value?.trim();
    const normalize = text => text.replace(/\s+/gu, ' ').trim();
    if (draft && !draft.startsWith('发消息或按住空格说话') && normalize(draft) !== normalize(command.text)) {
      throw fail('CLIENT_DRAFT', '豆包输入框已有其他草稿，请先处理草稿。');
    }
    return request({ op: 'send', route: current.route, key: current.composer.key, text: command.text });
  };
}

export async function openWindowsDoubao({ openPath, env = process.env } = {}) {
  const candidates = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Doubao', 'Application', 'Doubao.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Doubao', 'Doubao.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Doubao', 'Doubao.exe')].filter(Boolean);
  for (const file of candidates) {
    if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
    const open = openPath ?? (await import('electron')).shell.openPath;
    if (await open(file) === '') return true;
  }
  throw fail('CLIENT_CLOSED', '没有找到 Windows 豆包客户端，请先安装豆包桌面版。');
}
