const routines = {
  侧步摇摆: 'dance-side',
  转身亮相: 'dance-spin',
  弹跳挥手: 'dance-bounce',
  经典律动: 'dance',
};
const counts = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 };
const prefix = /^(?:(?:我想让|我想看|我想请|我希望|我要看|能不能|能否|可不可以|可以|麻烦|拜托|快点|现在|马上|开始|继续|给我|给我们|给大家|帮我|请|让|叫|再|你|她|他|它|VA)[,，\s]*)+/iu;
const suffix = /(?:给(?:我|我们|大家)看|让我看看|庆祝(?:一下)?|看看|一下|好不好|好吗|行不行|行吗|[吧吗嘛呀呗啦,，。.!！?？\s])+$/u;
const move = new RegExp(
  '^(?:跳|来|表演)(?:([一二两三四1-4])?[个段支次曲首])?\\s*(' +
  Object.keys(routines).join('|') + '|舞(?:蹈|步)?|\\p{Script=Han}{1,6}舞)$', 'u',
);

export function danceIntent(input, characterName = '') {
  if (typeof input !== 'string' || input.length > 2200) return;
  let text = input.normalize('NFKC').trim().replace(/^@\S+\s+/u, '');
  if (/[“”「」『』"'‘’]/u.test(text) ||
      /(?:不要|别|不用|不想|不必|不许|禁止|没让|没有让).{0,9}(?:跳|舞)/u.test(text)) return;
  const name = characterName.normalize('NFKC');
  text = text.replace(prefix, '');
  if (name && text.toLowerCase().startsWith(name.toLowerCase())) {
    text = text.slice(name.length).replace(/^[,，:：\s]+/u, '');
  }
  const request = text.replace(prefix, '').replace(suffix, '');
  const match = move.exec(request);
  if (match) {
    const [, quantity, name] = match;
    return { action: routines[name], count: counts[quantity] ?? (Number(quantity) || 1) };
  }
  if (/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:do )?(?:a )?dance(?: for (?:me|us))?(?: please)?[.!?]*$/iu.test(text)) {
    return { count: 1 };
  }
}
