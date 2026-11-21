const smaller = document.getElementById('smaller');
const larger = document.getElementById('larger');
const size = document.getElementById('scale');
const handle = document.getElementById('handle');

function render(settings) {
  handle.textContent = '⠿ ' + settings.characterName;
  handle.setAttribute('aria-label', '拖动' + settings.characterName);
  size.value = settings.scale + '%';
  smaller.disabled = settings.scale <= settings.minScale;
  larger.disabled = settings.scale >= settings.maxScale;
}

window.va.onSettings(render);
await window.va.settings().then(render);
smaller.addEventListener('click', () => window.va.adjustScale(-5));
larger.addEventListener('click', () => window.va.adjustScale(5));
document.getElementById('settings').addEventListener('click', () => window.va.openSettings());
