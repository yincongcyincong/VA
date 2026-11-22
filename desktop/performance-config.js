import { actionCategories, actions, expressions, facePresets, performanceId } from './actions.js';

const own = Object.hasOwn;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = value => typeof value === 'string' && value.trim() && value.length <= 120 && !/[\r\n\0]/u.test(value);
const invalid = (field, message) => { throw new Error(field + ' ' + message); };

export const performanceDefaults = {
  actions: Object.fromEntries(Object.entries(actions).filter(([id]) => id !== 'idle').map(([id, action]) =>
    [id, { ...action, motion: id, expression: action.expression ?? (action.category === 'dance' || id === 'laugh' ? 'amused' : 'neutral') }])),
  expressions: Object.fromEntries(Object.entries(expressions).map(([id, label]) => [id, { label, ...facePresets[id] }])),
};

function fields(value, allowed, field) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(field, '需要填写支持的配置字段。');
}

function entries(map, field, validKey, limit) {
  if (!isObject(map)) invalid(field, '应为一个 JSON 对象。');
  const result = Object.entries(map);
  if (result.length > limit || result.some(([key]) => !validKey(key))) invalid(field, '条目过多或名称格式有误。');
  return result;
}

function weights(map, field) {
  return Object.fromEntries(entries(map, field, isName, 32).map(([name, value]) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) invalid(field + '.' + name, '权重必须在 0 到 1 之间。');
    return [name, value];
  }));
}

export function compilePerformance(config) {
  fields(config, ['actions', 'expressions'], '动作与表情配置');
  const faceEntries = entries(config.expressions ?? {}, 'expressions', id => performanceId.test(id), 96);
  const faces = Object.fromEntries(Object.entries(performanceDefaults.expressions));
  for (const [id, input] of faceEntries) {
    const field = 'expressions.' + id;
    fields(input, ['label', 'pmx', 'vrm', 'morphs'], field);
    const prior = own(faces, id) ? faces[id] : {};
    const face = { ...prior, ...input };
    if (!isName(face.label)) invalid(field + '.label', '请填写表情名称。');
    for (const platform of ['pmx', 'vrm', 'morphs']) {
      if (own(face, platform)) face[platform] = weights(face[platform], field + '.' + platform);
    }
    faces[id] = face;
  }

  const definitions = { idle: { ...actions.idle, motion: 'idle', expression: 'neutral' }, ...performanceDefaults.actions };
  for (const [id, input] of entries(config.actions ?? {}, 'actions', key => key !== 'idle' && performanceId.test(key), 96)) {
    const field = 'actions.' + id;
    fields(input, ['label', 'category', 'seconds', 'motion', 'clip', 'bones', 'expression', 'dialogue'], field);
    const prior = own(definitions, id) ? definitions[id] : { motion: 'idle', expression: 'neutral', category: 'custom' };
    const action = { ...prior, ...input };
    if (!isName(action.label)) invalid(field + '.label', '请填写动作名称。');
    if (typeof action.category !== 'string' || !own(actionCategories, action.category)) {
      invalid(field + '.category', '请选择已定义的动作类别。');
    }
    if (!Number.isFinite(action.seconds) || action.seconds < .25 || action.seconds > 30) {
      invalid(field + '.seconds', '时长必须在 0.25 到 30 秒之间。');
    }
    if (typeof action.motion !== 'string' || !own(actions, action.motion)) invalid(field + '.motion', '请选择一个内置动作。');
    if (own(action, 'clip') && !isName(action.clip)) invalid(field + '.clip', '请填写模型内置动画的名称。');
    if (own(action, 'bones')) {
      action.bones = Object.fromEntries(entries(action.bones, field + '.bones', isName, 32).map(([bone, angles]) => {
        if (!Array.isArray(angles) || angles.length !== 3 ||
            angles.some(angle => !Number.isFinite(angle) || Math.abs(angle) > 180)) {
          invalid(field + '.bones.' + bone, '请填写 X、Y、Z 三个角度，每项介于 -180 到 180。');
        }
        return [bone, angles];
      }));
    }
    if (own(action, 'dialogue') && (!Array.isArray(action.dialogue) || action.dialogue.length > 12 ||
        action.dialogue.some(line => typeof line !== 'string' || !line.trim() || line.length > 300))) {
      invalid(field + '.dialogue', '最多可填写 12 条台词，每条 1–300 字。');
    }
    definitions[id] = action;
  }
  for (const [id, action] of Object.entries(definitions)) {
    if (typeof action.expression !== 'string' || !own(faces, action.expression)) {
      invalid('actions.' + id + '.expression', '指定的表情不存在。');
    }
  }
  return { actions: definitions, faces };
}

export function actionSupported(action, media) {
  if (!media) return false;
  if (action.clip && !media.clips.includes(action.clip)) return false;
  const bones = Object.keys(action.bones ?? {});
  if (bones.some(bone => !media.bones.includes(bone))) return false;
  return Boolean(action.clip || bones.length || media.motions.includes(action.motion));
}

export function describePerformance(catalog, media) {
  return {
    categories: actionCategories,
    actions: Object.fromEntries(Object.entries(catalog.actions).map(([id, action]) => [
      id, { label: action.label, category: action.category, seconds: action.seconds, expression: action.expression,
        ...(id === 'dance' && action.category === 'dance' && { alternate: true }),
        ...(action.clip && { clip: action.clip }), supported: actionSupported(action, media) },
    ])),
    expressions: Object.fromEntries(Object.entries(catalog.faces).map(([id, face]) => [id, face.label])),
    supportedExpressions: Object.entries(catalog.faces).filter(([id, face]) => id === 'neutral' ||
      Object.keys(face[media?.mode === 'pmx' ? 'pmx' : media?.mode === 'vrm' ? 'vrm' : 'morphs'] ?? {})
        .some(name => media?.morphs.includes(name))).map(([id]) => id),
  };
}
