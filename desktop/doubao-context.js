import { actions, danceActions } from './actions.js';

const dances = danceActions.map(action => actions[action].label).join('、');

export function doubaoDanceContext(name) {
  const character = JSON.stringify(String(name || 'VA').slice(0, 48));
  return `你为 Mac 上的 VA 3D 桌面角色 ${character} 对话。VA 能让角色在桌面上实际播放舞蹈动画，舞步有${dances}。听到明确的跳舞请求时，VA 会处理本机动作。按角色口吻自然回应，可以邀请用户看桌面上的角色。请区分安排表演和表演完成，只有 VA 确认完成后才说已经跳完。`;
}
