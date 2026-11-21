const byId = id => document.getElementById(id);
const panel = byId('panel-models');
const list = byId('gallery-list');
const stage = byId('gallery-stage');
const status = byId('gallery-status');
const local = byId('gallery-local');
const importPack = byId('gallery-import');
const empty = byId('gallery-empty');
const use = byId('gallery-use');
const call = window.va.modelLibrary;

let viewer;
let selected;
let busy = false;
let revision = 0;

function errorText(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function syncButtons() {
  local.disabled = importPack.disabled = busy;
  use.disabled = busy || !selected;
  for (const button of list.querySelectorAll('[data-preview]')) button.disabled = busy;
}

function clearPreview() {
  viewer?.dispose();
  viewer = selected = undefined;
  byId('gallery-title').textContent = '3D 预览';
  byId('gallery-details').textContent = '';
  byId('gallery-placeholder').hidden = false;
  byId('gallery-controls').hidden = true;
  syncButtons();
}

async function openPage(operation, value) {
  try { await call(operation, value); }
  catch (error) { status.textContent = errorText(error); }
}

function button(text, click) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.addEventListener('click', click);
  return element;
}

async function refreshList() {
  const entries = await call('list');
  empty.hidden = entries.some(model => !model.builtIn);
  list.replaceChildren();
  for (const model of entries) {
    const item = document.createElement('li');
    const title = document.createElement('h3');
    const info = document.createElement('p');
    title.textContent = model.label;
    const size = model.size < 1024 * 1024
      ? Math.ceil(model.size / 1024) + ' KB' : (model.size / 1024 / 1024).toFixed(1) + ' MB';
    const features = model.rigged ? '带骨骼' : '静态模型';
    info.textContent = [model.format, size, features, model.isDefault && '默认角色',
      model.mouthSync && '支持口型'].filter(Boolean).join(' · ');
    const preview = button('预览', () => void showPreview('preview-pack', model.id, '正在加载 ' + model.label + '…'));
    preview.dataset.preview = '';
    item.append(title, info, preview);
    list.append(item);
  }
  syncButtons();
}

async function showPreview(operation, id, note) {
  if (busy) return;
  const current = ++revision;
  busy = true;
  syncButtons();
  status.textContent = note;
  try {
    const model = await call(operation, id);
    if (current !== revision) return;
    if (!model) {
      status.textContent = '';
      return;
    }
    clearPreview();
    status.textContent = '正在检测 ' + model.name + '…';
    const { loadAvatar } = await import('./avatar.js');
    if (current !== revision) return;
    const candidate = await loadAvatar(stage, model);
    if (current !== revision) {
      candidate.dispose();
      return;
    }
    try { candidate.mount(); }
    catch (error) {
      candidate.dispose();
      throw error;
    }
    viewer = candidate;
    selected = model;
    byId('gallery-title').textContent = model.name;
    byId('gallery-details').textContent = [model.format.toUpperCase(),
      candidate.media.animationCount && candidate.media.animationCount + ' 段动画',
      candidate.media.mouthSync && '支持口型'].filter(Boolean).join(' · ');
    byId('gallery-placeholder').hidden = true;
    byId('gallery-controls').hidden = false;
    status.textContent = candidate.textureWarning ? '模型可显示，部分贴图或材质缺失。' : '模型检测通过。';
  } catch (error) {
    if (current === revision) status.textContent = errorText(error) || '模型无法预览。';
  } finally {
    busy = false;
    if (!panel.hidden) await refreshList().catch(error => { status.textContent = errorText(error); });
    syncButtons();
  }
}

local.addEventListener('click', () => void showPreview('preview-file', undefined, '请选择一个模型文件。'));
importPack.addEventListener('click', async () => {
  if (busy) return;
  const current = revision;
  busy = true;
  syncButtons();
  status.textContent = '请选择解压目录。选定后会逐个检测模型…';
  try {
    const result = await call('import-pack');
    if (result && current === revision) {
      clearPreview();
      await call('release');
    }
    if (!panel.hidden) await refreshList();
    if (current === revision) status.textContent = result ? `已导入 ${result.count} 款可预览模型。` : '';
  } catch (error) {
    if (current === revision) status.textContent = errorText(error);
  } finally {
    busy = false;
    syncButtons();
  }
});
use.addEventListener('click', async () => {
  if (!selected || busy) return;
  busy = true;
  syncButtons();
  status.textContent = '正在检测并更换桌面角色…';
  try {
    const model = await call('use', selected.url);
    status.textContent = '已设为桌面角色 · ' + model.name;
  } catch (error) {
    status.textContent = errorText(error);
  } finally {
    busy = false;
    syncButtons();
  }
});

for (const choice of panel.querySelectorAll('[data-gallery-provider]')) {
  choice.addEventListener('click', () => void openPage('provider', choice.dataset.galleryProvider));
}
byId('gallery-link').addEventListener('submit', event => {
  event.preventDefault();
  void openPage('link', event.currentTarget.elements.url.value);
});
function syncPanel() {
  if (panel.hidden) {
    revision++;
    clearPreview();
    status.textContent = '';
    void call('release').catch(() => {});
  } else {
    void refreshList().catch(error => { status.textContent = errorText(error); });
  }
}
new MutationObserver(syncPanel).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
if (!panel.hidden) syncPanel();
