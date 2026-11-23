import { ControlError } from '../lib/control.js';

export const modes = ['off', 'local', 'doubao-client', 'astrbot', 'openclaw'];
export const externalModes = ['astrbot', 'openclaw'];
export const screenMode = mode => mode === 'local' ? mode : null;

export function integrationMode(config) {
  if (modes.includes(config?.mode)) return config.mode;
  if (config?.mode === 'doubao') return 'doubao-client';
  if (config?.mode === 'api') return 'off';
  const enabled = externalModes.filter(name => config?.channels?.[name]?.enabled === true);
  if (enabled.length > 1) return 'off';
  if (enabled.length) return enabled[0];
  return config?.localAgent?.provider ? 'local' : 'off';
}

export function botRoute(config) {
  const mode = integrationMode(config);
  if (!externalModes.includes(mode)) return null;
  const route = config.channels?.[mode];
  if (!route?.target || (mode === 'openclaw' && !route?.channel)) return null;
  const { target, channel, accountId, sessionKey } = route;
  return { target, channel, accountId, sessionKey, speakReplies: route.speakReplies === true };
}

export function checkBotRoute(config, platform, origin) {
  const route = botRoute(config);
  if (!route || integrationMode(config) !== platform || !origin || typeof origin !== 'object') return null;
  if (platform === 'astrbot') return origin.target === route.target ? route : null;
  return origin.channel === route.channel && (!route.accountId || origin.accountId === route.accountId) &&
    (route.sessionKey && origin.sessionKey ? origin.sessionKey === route.sessionKey : origin.target === route.target)
    ? route : null;
}

export function integrationSnapshot(config, mode = integrationMode(config)) {
  const { target = '', channel = '', accountId = '', sessionKey = '', speakReplies = false } = config?.channels?.[mode] ?? {};
  return { mode,
    ...(externalModes.includes(mode) && { route: { target, channel, accountId, sessionKey, speakReplies } }) };
}

function string(value, max) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new ControlError('INTEGRATION_CONFIG', '接入配置字段格式无效。');
  }
  return value.trim();
}

export function configureIntegration(config, update) {
  if (!modes.includes(update?.mode)) throw new ControlError('INTEGRATION_CONFIG', '请选择一种接入方式。');
  const next = { ...config, mode: update.mode };
  if (externalModes.includes(update.mode) && update.route) {
    const { target, channel, accountId, sessionKey, speakReplies } = update.route;
    next.channels = { ...config.channels, [update.mode]: {
      target: string(target, 240), speakReplies: speakReplies === true,
      ...(update.mode === 'openclaw' && {
        channel: string(channel, 100), accountId: string(accountId, 160), sessionKey: string(sessionKey, 240),
      }),
    } };
    if (!botRoute(next)) throw new ControlError('INTEGRATION_CONFIG', '请填写目标频道路由。');
  }
  return next;
}
