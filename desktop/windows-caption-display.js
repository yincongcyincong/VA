import { dialoguePages } from './dialogue-text.js';

// Final utterances are displayed from the first page in arrival order.
// Partial hypotheses replace each other; they are never appended as history.
export function createWindowsCaptionDisplay(onPage) {
  let page = '', timer, partial = false;
  const pending = [];
  function show(next) { page = next; onPage(page); }
  function advance() {
    clearTimeout(timer);
    timer = undefined;
    const next = pending.shift();
    show(next ?? '');
    if (next) {
      timer = setTimeout(advance, Math.max(1800, Math.min(6500, [...next].length * 115)));
      timer.unref?.();
    }
  }
  function clear() {
    clearTimeout(timer); timer = undefined; partial = false; pending.length = 0; show('');
  }
  return { page: () => page, clear, push(text, final) {
    if (!text) { clear(); return; }
    const pages = dialoguePages(text);
    if (!final) {
      if (!timer && !pending.length) { partial = true; show(pages[0] ?? ''); }
      return;
    }
    // Bound a pathological recognition backlog without growing memory forever.
    if (pending.length + pages.length > 120) { pending.length = 0; clearTimeout(timer); timer = undefined; }
    pending.push(...pages);
    if (!timer || partial) { partial = false; advance(); }
  } };
}
