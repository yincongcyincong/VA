export const actionCategories = {
  dance: '舞蹈', speech: '说话', greeting: '问候', emotion: '情绪',
  interaction: '互动', pose: '摆拍', idle: '待机', custom: '自定义',
};

export const actions = {
  idle: { label: '待机', category: 'idle', seconds: 0 },
  'idle-look': { label: '左右观察', category: 'idle', seconds: 3.2 },
  'idle-stretch': { label: '伸懒腰', category: 'idle', seconds: 3.6 },
  wave: { label: '挥手', category: 'greeting', seconds: 2.7 },
  nod: { label: '点头', category: 'greeting', seconds: 1.55 },
  bow: { label: '鞠躬', category: 'greeting', seconds: 2.4 },
  laugh: { label: '大笑', category: 'interaction', seconds: 2.35 },
  dance: { label: '经典律动', category: 'dance', seconds: 7.6 },
  'dance-side': { label: '侧步摇摆', category: 'dance', seconds: 6.4 },
  'dance-spin': { label: '转身亮相', category: 'dance', seconds: 6.2 },
  'dance-bounce': { label: '弹跳挥手', category: 'dance', seconds: 5.8 },
  'talk-natural': { label: '自然交谈', category: 'speech', seconds: 3.5 },
  'talk-lively': { label: '活泼讲述', category: 'speech', seconds: 3.5 },
  'talk-thoughtful': { label: '思考式说话', category: 'speech', seconds: 3.5 },
  pose: { label: '摆拍', category: 'pose', seconds: 4 },
  'pose-heart': { label: '双手比心', category: 'pose', seconds: 3.6 },
  'pose-hero': { label: '侧身亮相', category: 'pose', seconds: 3.6 },
  pet: { label: '摸摸', category: 'interaction', seconds: 2.15 },
  happy: { label: '喜悦', category: 'emotion', seconds: 2.3, expression: 'happy' },
  angry: { label: '生气', category: 'emotion', seconds: 2.3, expression: 'angry' },
  sad: { label: '难过', category: 'emotion', seconds: 2.6, expression: 'sad' },
  kiss: { label: '飞吻', category: 'interaction', seconds: 2.6, expression: 'kiss' },
};

export const danceActions = ['dance-side', 'dance-spin', 'dance-bounce'];

export const speechActionStyles = {
  'talk-natural': 'natural', 'talk-lively': 'lively', 'talk-thoughtful': 'thoughtful',
};

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
