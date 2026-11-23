import { integrationMode } from './integration.js';
import { patchLocalAgentConfig } from './local-agent.js';

export function sharedAgentPrompt(config) {
  if (typeof config?.prompt === 'string') return config.prompt;
  const selected = Array.isArray(config?.apiProfiles) ? config.apiProfiles.find(profile => profile?.id === config.apiProfileId) : undefined;
  const candidates = config?.mode === 'doubao' ? [config.doubao?.prompt, config.localAgent?.prompt]
    : config?.mode === 'api' ? [selected?.language?.prompt, config.language?.prompt, config.localAgent?.prompt]
      : [config?.localAgent?.prompt, config?.doubao?.prompt];
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 5000) ?? '';
}

export function normalizeAgentConfig(config) {
  const { apiProfiles, apiProfileId, language, vision, doubao, localAgent, ...rest } = config ?? {};
  const { prompt: _oldPrompt, ...local } = localAgent ?? {};
  return { ...rest, mode: integrationMode(config), prompt: sharedAgentPrompt(config), localAgent: local };
}

export async function patchAgentConfig(current, change, launchDirectory) {
  const next = normalizeAgentConfig(current);
  if (change.prompt !== undefined) next.prompt = change.prompt.trim();
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

export function agentConfigSnapshot(config, mode = integrationMode(config)) {
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
    mode, prompt: sharedAgentPrompt(config), localAgent, channels,
    doubaoClient: { autoActions: (captions?.autoActions ?? captions?.autoDance) !== false,
      listenForActions: (captions?.listenForActions ?? captions?.listenForDance) === true },
  };
}
