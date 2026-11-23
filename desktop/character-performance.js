import { actionCategories, danceActions, performanceId } from './actions.js';
import { danceIntent } from './dance-intent.js';

const actionWords = {
  wave: ['挥挥手', '打个招呼'], nod: ['点点头'], bow: ['鞠个躬'], laugh: ['哈哈大笑', '笑'],
  pose: ['摆个姿势', '摆个造型'], pet: ['摸摸头', '摸头', '被摸摸'],
  happy: ['开心一下', '庆祝一下'], angry: ['生个气', '假装生气'], sad: ['难过一下', '伤心一下'],
  kiss: ['给我一个飞吻', '送个飞吻', '比个飞吻'], idle: ['休息一下'],
  'talk-natural': ['自然聊天'], 'talk-lively': ['活泼说话'], 'talk-thoughtful': ['思考着说', '思考式交谈'],
};
const expressionWords = { smile: ['笑一个', '笑一笑'], surprised: ['露出惊讶表情'], neutral: ['恢复平静'] };
const quotes = /[“”「」『』"'‘’`]/u;
const normalize = value => value.normalize('NFKC').trim().toLowerCase();
const fillName = (text, name) => text?.replaceAll('{{name}}', () => name);

export function requestsSelfie(text, name) {
  if (typeof text !== 'string' || text.length > 2200 || quotes.test(text)) return false;
  let request = normalize(text).replace(/[\s，,]+/gu, '')
    .replace(/^(?:请|麻烦)?(?:让(?:她|他|va)?)?/u, '');
  const person = normalize(name).replace(/\s+/gu, '');
  if (person && request.startsWith(person)) request = request.slice(person.length);
  request = request.replace(/^(?:你)?(?:能不能|可以|能)?(?:给我)?/u, '')
    .replace(/(?:发给我|给我)?(?:看看)?(?:吧|吗|嘛|呗)?[。！？!?]*$/u, '');
  return /^(?:发送|发|来|拍)一?(?:张|个)?(?:你(?:自己)?的)?自拍(?:照片?)?$/u.test(request)
    || /^自拍(?:一张|一下)?$/u.test(request)
    || /^(?:please\s+)?send(?:\s+me)?\s+(?:a|your)\s+selfie[.!?]*$/iu.test(text.trim());
}

export function characterPerformancePrompt(character, catalog, { style = 'text', dance = true } = {}) {
  const actions = Object.entries(catalog.actions).filter(([, action]) => action.supported);
  const actionList = Object.entries(actionCategories).flatMap(([category, label]) => {
    const group = actions.filter(([, action]) => !action.alternate && (action.category ?? 'custom') === category);
    return group.length ? [label, ...group.map(([id, action]) => `- ${id}（${action.label}）`)] : [];
  });
  const alternate = actions.filter(([, action]) => action.alternate);
  if (alternate.length) actionList.push('用户指定时可调用的兼容动作',
    ...alternate.map(([id, action]) => `- ${id}（${action.label}）`));
  const expressions = catalog.supportedExpressions.map(id => `${id}（${catalog.expressions[id]}）`);
  return [
    `你的 VA 桌面角色名是 ${JSON.stringify(character.name)}。本轮使用这个名字自称。历史对话、模型文件名和旧人设里出现过的称呼按历史称呼理解。`,
    character.prompt,
    '根据用户的请求和你即将说出的回复选择动作和表情。问好时挥手，同意时点头，正式感谢时鞠躬，遇到趣事时大笑。可以用喜悦、惊讶或难过回应当下情绪，也可以在合适的庆祝场合主动表演。平常聊天用自然语气即可。',
    '用户明确要求的动作优先。VA 可直接响应明确请求。若本轮已经收到 VA 的动作安排反馈，正常回应即可。一次回复最多主动选择一个动作和一个表情。提到、引用或否定某个动作时保持原状。',
    dance ? '想主动跳舞时，选一种可用舞步。' : '本接入已关闭主动跳舞，用户明确要求时仍可由 VA 处理。',
    '摆拍动作在桌面摆姿势。用户明确要求发送自拍时由有附件能力的频道或自拍工具拍摄和发送。自拍成功后只交付图片，省略附文和完成说明。拍摄或发送失败时说明原因。',
    `当前模型可用动作\n${actionList.join('\n') || '暂无'}`,
    `当前模型可用表情\n${expressions.join('、') || '暂无'}`,
    style === 'text'
      ? '先写用户能看到和听到的台词。决定表演时，在回复最后单独写一行 [[va action=wave expression=smile]]，把示例编号换成上面实际可用的编号。action 或 expression 可以只写一个。需要自然聊天时省略这一行。'
      : '用自然语言表达本轮主动表演的意图。将「我来挥手」「我来侧步摇摆」或「我露出微笑」这类第一人称短句单独说完，名称使用上面列出的动作或表情。正常聊天时直接说话。',
  ].filter(Boolean).join('\n\n');
}

export function chatPerformancePrompt(character, catalog, extra = '', style = 'text') {
  return [fillName(extra, character.name), characterPerformancePrompt(character, catalog, { style })].filter(Boolean).join('\n\n');
}

function findPerformance(text, catalog, expressionOnly = false) {
  if (!expressionOnly) {
    const action = Object.entries(catalog.actions).find(([id, entry]) => entry.supported &&
      [id, entry.label, ...(Object.hasOwn(actionWords, id) ? actionWords[id] : [])].some(word => normalize(word) === text));
    if (action) return { action: action[0] };
  }
  const expression = catalog.supportedExpressions.find(id =>
    [id, catalog.expressions[id], ...(expressionWords[id] ?? [])].some(word => normalize(word) === text));
  if (expression) return { expression };
}

export function requestedPerformance(input, name, catalog) {
  if (typeof input !== 'string' || input.length > 2200 || quotes.test(input)) return;
  const dance = danceIntent(input, name);
  if (dance) return { dance };
  const text = normalize(input);
  const person = normalize(name);
  let request = text.replace(/^(?:(?:请|麻烦|拜托|能不能|可以|能否|现在|我想让|我想看|让)[，,\s]*)+/u, '');
  if (person && request.startsWith(person)) request = request.slice(person.length).replace(/^[,，:：\s]+/u, '');
  request = request.replace(/^(?:(?:你|她|他|请|能不能|可以|能否|给我|帮我|来个|来一段|表演)[,，\s]*)+/u, '')
    .replace(/(?:给我看|让我看看|一下|好不好|好吗|[吧吗嘛,，.!?。！？\s])+$/u, '');
  if (/^(?:露出|做出|做个|切换到?|换成|表情)/u.test(request)) {
    return findPerformance(request.replace(/^(?:露出|做出|做个|切换到?|换成|表情)\s*/u, '').replace(/表情$/u, ''), catalog, true);
  }
  return findPerformance(request, catalog);
}

export function replyPerformance(reply, catalog) {
  const text = reply.trim();
  const marker = /(?:^|\r?\n)\[\[va ([^\r\n]+)\]\][ \t]*$/u.exec(text);
  if (marker) {
    const parts = marker[1].split(/\s+/u).map(part => part.split('='));
    const fields = new Map(parts);
    const speech = text.slice(0, marker.index).trim();
    if (fields.size !== parts.length || parts.some(([key, id, ...extra]) =>
      !['action', 'expression'].includes(key) || !performanceId.test(id ?? '') || extra.length)) return { speech };
    const action = fields.get('action');
    const expression = fields.get('expression');
    return { speech, action: Object.hasOwn(catalog.actions, action) && catalog.actions[action].supported ? action : undefined,
      expression: catalog.supportedExpressions.includes(expression) ? expression : undefined };
  }
  const spoken = text.replace(/```[\s\S]*?```|「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|`[^`]*`/gu, ' ');
  for (const sentence of spoken.split(/[\n。！？!?，,]/u)) {
    if (quotes.test(sentence)) continue;
    const line = normalize(sentence);
    const face = /^(?:我(?:露出|换上|做出)|看我的)\s*(.+?)(?:表情)?$/u.exec(line);
    const act = /^(?:那)?(?:我来|我这就|我给你|让我来|看我)(?:表演)?\s*(.+)$/u.exec(line);
    const actionText = act?.[1].replace(/(?:给你看|吧|啦)$/u, '');
    const dance = actionText && danceIntent(actionText);
    const danceId = dance && (dance.action ?? danceActions.find(id => catalog.actions[id]?.supported) ?? 'dance');
    const effect = face && findPerformance(face[1], catalog, true)
      || actionText && findPerformance(actionText, catalog)
      || danceId && catalog.actions[danceId]?.supported && { action: danceId };
    if (effect) return { speech: text, ...effect };
  }
  if (/^\s*哈哈[哈！!，,。\s]/u.test(spoken) && catalog.actions.laugh?.supported) {
    return { speech: text, action: 'laugh' };
  }
  return { speech: text };
}
