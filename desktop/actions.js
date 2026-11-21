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
};

export const danceActions = ['dance', 'dance-side', 'dance-spin', 'dance-bounce'];

export const expressions = {
  neutral: '平静',
  smile: '微笑',
  amused: '开心',
  surprised: '惊讶',
};
