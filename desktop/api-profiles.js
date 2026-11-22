import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ControlError } from '../lib/control.js';
import { apiProtocols, getModelSettings } from './vision-agent.js';

const legacyId = 'legacy';
const profileError = message => new ControlError('API_PROFILE', message);

async function loadFile(path, parse) {
  try { return parse(await readFile(path, 'utf8')); }
  catch { return undefined; }
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function basicUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/+$/, '') : '';
  } catch { return ''; }
}

async function codexProfile(home, env) {
  const folder = env.CODEX_HOME || join(home, '.codex');
  const initial = await loadFile(join(folder, 'config.toml'), parseToml);
  if (!initial && !env.OPENAI_API_KEY) return null;
  const profile = text(initial?.profile);
  let overlay;
  if (/^[\w.-]+$/.test(profile) && profile !== '.' && profile !== '..') {
    overlay = await loadFile(join(folder, profile + '.config.toml'), parseToml) ?? initial.profiles?.[profile];
  }
  const config = { ...initial, ...overlay };
  const providerName = text(config.model_provider) || 'openai';
  const provider = overlay?.model_providers?.[providerName] ?? initial?.model_providers?.[providerName] ?? {};
  const builtin = providerName === 'openai';
  const baseUrl = basicUrl(text(provider.base_url) || (builtin ? env.OPENAI_BASE_URL || 'https://api.openai.com/v1' : ''));
  const apiKeyEnv = text(provider.env_key);
  let apiKey = text(apiKeyEnv ? env[apiKeyEnv] : provider.experimental_bearer_token);
  if (!apiKey && builtin && /^https:\/\/api\.openai\.com(?:\/|$)/.test(baseUrl)) {
    const auth = env.OPENAI_API_KEY ? undefined : await loadFile(join(folder, 'auth.json'), JSON.parse);
    apiKey = text(env.OPENAI_API_KEY || auth?.OPENAI_API_KEY);
  }
  const protocol = provider.wire_api === 'chat' ? 'chat' : 'responses';
  const model = text(config.model);
  const reason = !baseUrl ? 'CLI 未配置可直连的 API 地址' : !model ? 'CLI 未指定模型名'
    : !apiKey && (builtin || apiKeyEnv || provider.requires_openai_auth)
      ? '缺少 API Key。可通过本地 Agent 使用 CLI 登录' : '';
  return { id: 'cli-codex', name: 'Codex CLI', source: 'cli',
    language: { baseUrl, protocol, model, apiKey, apiKeyEnv: '' }, reason };
}

async function claudeProfile(home, env) {
  const file = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
  const settings = await loadFile(file, JSON.parse);
  const configured = settings || await access(join(home, '.claude.json')).then(() => true, () => false);
  if (!configured && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_BASE_URL) return null;
  const effective = { ...env, ...settings?.env };
  const apiKey = text(effective.ANTHROPIC_API_KEY) || text(effective.ANTHROPIC_AUTH_TOKEN);
  const baseUrl = basicUrl(effective.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const selected = text(effective.ANTHROPIC_MODEL) || text(settings?.model);
  const alias = /^(sonnet|opus|haiku|fable)(?:\[1m\])?$/i.exec(selected)?.[1]?.toUpperCase();
  const model = (alias ? text(effective['ANTHROPIC_DEFAULT_' + alias + '_MODEL']) : '') || selected;
  const reason = !baseUrl ? 'CLI 未配置可直连的 API 地址' : !apiKey ? '缺少 API Key。可通过本地 Agent 使用 CLI 登录'
    : !model || /^(?:default|(?:opus|sonnet|haiku|fable)(?:\[1m\])?)$/i.test(model)
      ? 'CLI 未指定直连 API 的完整模型名' : '';
  return { id: 'cli-claude', name: 'Claude Code CLI', source: 'cli',
    language: { baseUrl, protocol: 'anthropic', model, apiKey, bearerAuth: !effective.ANTHROPIC_API_KEY }, reason };
}

export async function readCliProfiles(home = homedir(), env = process.env) {
  const entries = await Promise.all([codexProfile(home, env), claudeProfile(home, env)]);
  return entries.filter(Boolean);
}

function savedProfiles(config) {
  if (Array.isArray(config.apiProfiles)) return config.apiProfiles;
  if (!text(config.language?.model) && !text(config.vision?.model)) return [];
  return [{ id: legacyId, name: '现有模型 API', language: config.language ?? {}, vision: config.vision ?? {} }];
}

export function selectedApiId(config) {
  if (typeof config.apiProfileId === 'string') return config.apiProfileId;
  return savedProfiles(config).find(profile => profile.id === legacyId)?.id ?? '';
}

function summarizeModel(model = {}) {
  return { baseUrl: basicUrl(model.baseUrl), model: text(model.model), protocol: model.protocol ?? 'chat',
    hasKey: Boolean(model.apiKey || (model.apiKeyEnv && process.env[model.apiKeyEnv])),
    allowRemoteScreenshots: model.allowRemoteScreenshots === true };
}

function profileReason(profile) {
  if (profile.reason) return profile.reason;
  try { getModelSettings(profile, 'language'); }
  catch (error) { return error.message; }
}

export async function apiProfileSnapshot(config) {
  const profiles = [...await readCliProfiles(), ...savedProfiles(config)];
  return { selected: selectedApiId(config), profiles: profiles.map(profile => ({
    id: profile.id, name: profile.name, source: profile.source ?? 'custom', reason: profileReason(profile),
    language: summarizeModel(profile.language), vision: summarizeModel(profile.vision),
    prompt: text(profile.language?.prompt),
    speakReplies: profile.language?.speakReplies === true,
  })) };
}

async function selectedProfile(config) {
  const id = selectedApiId(config);
  if (id.startsWith('cli-')) return (await readCliProfiles()).find(profile => profile.id === id);
  return savedProfiles(config).find(profile => profile.id === id);
}

export async function resolveApiConfig(config, kind = 'language') {
  const active = await selectedProfile(config);
  if (!active) throw profileError('请在「模型 API」选择或添加配置。');
  if (kind === 'language') {
    const reason = profileReason(active);
    if (reason) throw profileError(reason);
  }
  return { ...config, language: active.language, vision: active.vision };
}

function bounded(value, max) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw profileError('请检查配置字段和长度。');
  }
  return value.trim();
}

function readModel(input, previous, kind) {
  if (!input) throw profileError('缺少模型配置。');
  const { baseUrl, model } = { baseUrl: bounded(input.baseUrl, 2048), model: bounded(input.model, 200) };
  const protocol = input.protocol;
  if (!apiProtocols.includes(protocol)) throw profileError('请选择 API 协议。');
  const token = bounded(input.apiKey, 4096);
  const sameEndpoint = basicUrl(previous?.baseUrl) === basicUrl(baseUrl) && (previous?.protocol ?? 'chat') === protocol;
  const profile = { baseUrl, model, protocol,
    apiKey: input.clearKey ? '' : token || (sameEndpoint ? text(previous?.apiKey) : ''),
    apiKeyEnv: input.clearKey || token || !sameEndpoint ? '' : text(previous?.apiKeyEnv),
    ...(kind === 'vision' && { allowRemoteScreenshots: input.allowRemoteScreenshots === true }),
  };
  if (kind === 'language' || model) getModelSettings({ [kind]: profile }, kind);
  return profile;
}

export async function editApiProfiles(config, action) {
  const profiles = savedProfiles(config);
  let selected = selectedApiId(config);
  if (action?.op === 'select') {
    const candidate = [...profiles, ...await readCliProfiles()].find(item => item.id === action.id);
    if (!candidate) throw profileError('找不到这条模型 API 配置。');
    const reason = profileReason(candidate);
    if (reason) throw profileError(reason);
    selected = candidate.id;
  } else if (action?.op === 'save') {
    const previous = profiles.find(profile => profile.id === action.id);
    if ((!previous && action.id) || (!previous && profiles.length >= 40)) throw profileError('无法新增或编辑此配置。');
    const name = bounded(action.name, 80);
    if (!name) throw profileError('请填写配置名称。');
    const language = readModel(action.language, previous?.language, 'language');
    language.prompt = bounded(action.prompt ?? '', 5000);
    language.speakReplies = action.speakReplies === true;
    const vision = action.vision ? readModel(action.vision, previous?.vision, 'vision') : previous?.vision;
    const profile = { ...previous, id: previous?.id ?? randomUUID(), name, language, vision };
    return { ...config, apiProfiles: previous ? profiles.map(item => item.id === profile.id ? profile : item) : [...profiles, profile],
      apiProfileId: selected || profile.id };
  } else if (action?.op === 'remove') {
    if (!profiles.some(profile => profile.id === action.id)) throw profileError('只能删除已保存的自定义配置。');
    return { ...config, apiProfiles: profiles.filter(profile => profile.id !== action.id),
      apiProfileId: selected === action.id ? '' : selected };
  } else throw profileError('无效的模型 API 操作。');
  return { ...config, apiProfileId: selected };
}
