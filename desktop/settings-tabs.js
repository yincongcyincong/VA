export function choiceValue(group) {
  return group.querySelector('[aria-selected="true"], [aria-pressed="true"]')?.dataset.choice;
}

export function markChoice(group, value) {
  for (const button of group.querySelectorAll('button[data-choice]')) {
    const selected = button.dataset.choice === String(value);
    if (button.getAttribute('role') === 'tab') {
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    } else button.setAttribute('aria-pressed', String(selected));
  }
}

export function choices(group, entries) {
  for (const [value, label] of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.choice = value;
    button.textContent = label;
    button.setAttribute('aria-pressed', 'false');
    group.append(button);
  }
}

export function onChoice(group, onSelect) {
  group.addEventListener('click', event => {
    const item = event.target.closest('button[data-choice]');
    if (item && !item.disabled) onSelect(item.dataset.choice);
  });
  group.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = [...group.querySelectorAll('button[data-choice]:enabled')];
    const index = items.indexOf(event.target);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
    items[next].focus();
    items[next].click();
  });
}
