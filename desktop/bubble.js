const bubble = document.getElementById('bubble');

window.va.onBubble(({ page, side, theme, revision }) => {
  document.documentElement.dataset.theme = theme;
  document.body.dataset.side = side;
  bubble.textContent = page;
  // Let the hidden window lay out the new text before it becomes visible.
  requestAnimationFrame(() => requestAnimationFrame(() => window.va.bubblePainted(revision)));
});
