import { integrationMode } from './integration.js';
import { patchLocalAgentConfig } from './local-agent.js';

export function legacyAgentPrompt(config) {
  if (typeof config?.prompt === 'string') return config.prompt;
  const selected = Array.isArray(config?.apiProfiles) ? config.apiProfiles.find(profile => profile?.id === config.apiProfileId) : undefined;
  const candidates = config?.mode === 'doubao' ? [config.doubao?.prompt, config.localAgent?.prompt]
    : config?.mode === 'api' ? [selected?.language?.prompt, config.language?.prompt, config.localAgent?.prompt]
      : [config?.localAgent?.prompt, config?.doubao?.prompt];
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 5000) ?? '';
}

function withoutPrompt(value) {
  if (!value || !Object.hasOwn(value, 'prompt')) return value;
  const { prompt, ...settings } = value;
  return settings;
}

export function removeLegacyAgentPrompts(config) {
  let next = withoutPrompt(config);
  for (const key of ['localAgent', 'language', 'doubao']) {
    const profile = withoutPrompt(next?.[key]);
    if (profile !== next?.[key]) next = { ...next, [key]: profile };
  }
  if (Array.isArray(next?.apiProfiles)) {
    const profiles = next.apiProfiles.map(profile => {
      const language = withoutPrompt(profile?.language);
      return language !== profile?.language ? { ...profile, language } : profile;
    });
    if (profiles.some((profile, index) => profile !== next.apiProfiles[index])) next = { ...next, apiProfiles: profiles };
  }
  return next;
}

export function normalizeAgentConfig(config) {
  const { apiProfiles, apiProfileId, language, vision, doubao, localAgent, prompt, ...rest } = config ?? {};
  const { prompt: _oldPrompt, ...local } = localAgent ?? {};
  return { ...rest, mode: integrationMode(config), localAgent: local };
}

export async function patchAgentConfig(current, change, launchDirectory) {
  const next = normalizeAgentConfig(current);
  if (change.localAgent) next.localAgent = await patchLocalAgentConfig(next.localAgent, change.localAgent, launchDirectory);
  if (change.channels) {
    next.channels = { ...current.channels };
    for (const [provider, route] of Object.entries(change.channels)) {
      next.channels[provider] = { ...current.channels?.[provider],
        ...Object.fromEntries(Object.entries(route).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])) };
    }
  }
  if (change.doubaoClient) next.doubaoClient = { ...current.doubaoClient, ...change.doubaoClient };
  if (change.mode) next.mode = change.mode;
  return next;
}

export function agentConfigSnapshot(config, mode = integrationMode(config), prompt = '') {
  const { provider = '', cwd = '', speakReplies = false, ...profiles } = config.localAgent ?? {};
  const localAgent = { provider, cwd, speakReplies };
  for (const key of ['codex', 'claude', 'deepseekharness', 'omp', 'custom']) {
    const profile = profiles[key];
    if (profile) localAgent[key] = { command: profile.command, model: profile.model, argumentCount: profile.args?.length };
  }
  const captions = config.doubaoClient;
  const channels = Object.fromEntries(['astrbot', 'openclaw'].map(key => {
    const { target, channel, accountId, sessionKey, speakReplies } = config.channels?.[key] ?? {};
    return [key, { target, channel, accountId, sessionKey, speakReplies }];
  }));
  return {
    mode, prompt, localAgent, channels,
    doubaoClient: { autoActions: (captions?.autoActions ?? captions?.autoDance) !== false,
      listenForActions: (captions?.listenForActions ?? captions?.listenForDance) === true },
  };
}
