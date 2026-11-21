export const actions = {
  idle: { label: '待机', seconds: 0 },
  wave: { label: '挥手', seconds: 2.7 },
  nod: { label: '点头', seconds: 1.55 },
  bow: { label: '鞠躬', seconds: 2.4 },
  laugh: { label: '大笑', seconds: 2.35 },
  dance: { label: '经典律动', seconds: 7.6 },
  'dance-side': { label: '侧步摇摆', seconds: 6.4 },
  'dance-spin': { label: '转身亮相', seconds: 6.2 },
  'dance-bounce': { label: '弹跳挥手', seconds: 5.8 },
  pose: { label: '摆拍', seconds: 4 },
  pet: { label: '摸摸', seconds: 2.15 },
  happy: { label: '喜悦', seconds: 2.3, expression: 'happy' },
  angry: { label: '生气', seconds: 2.3, expression: 'angry' },
  sad: { label: '难过', seconds: 2.6, expression: 'sad' },
  kiss: { label: '飞吻', seconds: 2.6, expression: 'kiss' },
};

export const danceActions = ['dance', 'dance-side', 'dance-spin', 'dance-bounce'];

export const expressions = {
  neutral: '平静',
  smile: '微笑',
  amused: '开心',
  surprised: '惊讶',
  happy: '喜悦',
  angry: '生气',
  sad: '难过',
  kiss: '飞吻',
};

export const facePresets = {
  neutral: {},
  smile: { pmx: { にやり: .55 }, vrm: { happy: .5 } },
  amused: { pmx: { にやり: .55, 笑い: .82 }, vrm: { happy: .65 } },
  surprised: { pmx: { びっくり: .68 }, vrm: { surprised: .65 } },
  happy: { pmx: { にやり: .6, 喜び: .48 }, vrm: { happy: .8 } },
  angry: { pmx: { 怒り: .75, ムッ: .55 }, vrm: { angry: .8 } },
  sad: { pmx: { 悲しい: .75, 口角下げ: .45 }, vrm: { sad: .8 } },
  kiss: { pmx: { ウィンク: .8, う: .72 }, vrm: { blinkLeft: .85, ou: .7 } },
};

export const performanceId = /^[a-z][a-z0-9-]{0,39}$/u;
