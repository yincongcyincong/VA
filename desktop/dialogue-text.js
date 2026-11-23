const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function dialoguePages(text) {
  const pages = [];
  let page = '';
  let space = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cost = /[\r\n]/u.test(segment) ? 13 : 1;
    if (space + cost > 52) {
      pages.push(page);
      page = '';
      space = 0;
    }
    page += segment;
    space += cost;
  }
  pages.push(page);
  return pages.map(value => value.trim()).filter(Boolean);
}

export function dialogueCut(text, limit) {
  const boundary = graphemes.segment(text).containing(limit)?.index;
  return boundary || text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '').length;
}
