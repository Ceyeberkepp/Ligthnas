const previewExtensions = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']),
  audio: new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']),
  pdf: new Set(['pdf']),
  text: new Set(['txt', 'log', 'md', 'json', 'csv', 'xml', 'yaml', 'yml', 'ini', 'conf', 'sh', 'js', 'mjs', 'css', 'html'])
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let number = value;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number >= 10 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
}

function currentFolder() {
  const crumbs = [...document.querySelectorAll('#content [data-folder]')];
  return crumbs.length ? (crumbs.at(-1).dataset.folder || '') : '';
}

function joinPath(folder, name) {
  return [folder, name].filter(Boolean).join('/');
}

function ensureFolderDialog() {
  let dialog = document.querySelector('#lightnas-folder-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-folder-dialog';
  dialog.className = 'lightnas-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="dialog-body" id="lightnas-folder-form">
      <div class="dialog-head">
        <div><span class="eyebrow">NEW FOLDER</span><h2>Create folder</h2></div>
        <button class="dialog-close" type="button" data-close-folder aria-label="Close">×</button>
      </div>
      <p class="muted">Create a folder in the current LightNAS location.</p>
      <label>Folder name<input name="name" maxlength="120" required autocomplete="off" placeholder="New folder"></label>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-close-folder>Cancel</button><button class="primary" type="submit">Create folder</button></div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close-folder]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get('name')?.toString().trim();
    const error = form.querySelector('.form-error');
    error.textContent = '';
    if (!name) return;
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(joinPath(dialog.dataset.folder || '', name))}`, {
        method: 'POST', headers: { 'X-LightNAS-Request': '1', 'Content-Type': 'application/json' }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to create folder.');
      dialog.close();
      form.reset();
      document.querySelector('#content [data-action="refresh-files"]')?.click();
    } catch (problem) { error.textContent = problem.message; }
  });
  return dialog;
}

function ensureViewer() {
  let dialog = document.querySelector('#lightnas-viewer');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-viewer';
  dialog.className = 'lightnas-dialog lightnas-viewer';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-head"><div><span class="eyebrow">FILE VIEWER</span><h2 data-viewer-title>Preview</h2></div><button class="dialog-close" type="button" data-close-viewer aria-label="Close">×</button></div>
      <div class="viewer-stage" data-viewer-stage></div>
      <div class="viewer-meta" data-viewer-meta></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-viewer-download>Download</button><button class="primary" type="button" data-close-viewer>Close</button></div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close-viewer]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
    delete dialog.dataset.objectUrl;
    dialog.querySelector('[data-viewer-stage]').replaceChildren();
  });
  return dialog;
}

function previewKind(name) {
  const extension = name.toLowerCase().split('.').pop();
  return Object.entries(previewExtensions).find(([, list]) => list.has(extension))?.[0] || null;
}

async function openPreview(name) {
  const kind = previewKind(name);
  if (!kind) return false;
  const folder = currentFolder();
  const path = joinPath(folder, name);
  const url = `/api/files/download?path=${encodeURIComponent(path)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to open file.');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const dialog = ensureViewer();
  if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
  dialog.dataset.objectUrl = objectUrl;
  dialog.querySelector('[data-viewer-title]').textContent = name;
  dialog.querySelector('[data-viewer-meta]').textContent = `${bytes(blob.size)} · ${kind.toUpperCase()} preview`;
  const stage = dialog.querySelector('[data-viewer-stage]');
  stage.replaceChildren();

  let viewer;
  if (kind === 'image') {
    viewer = document.createElement('img');
    viewer.src = objectUrl;
    viewer.alt = name;
  } else if (kind === 'video') {
    viewer = document.createElement('video');
    viewer.src = objectUrl;
    viewer.controls = true;
    viewer.autoplay = true;
  } else if (kind === 'audio') {
    viewer = document.createElement('audio');
    viewer.src = objectUrl;
    viewer.controls = true;
    viewer.autoplay = true;
  } else if (kind === 'pdf') {
    viewer = document.createElement('iframe');
    viewer.src = objectUrl;
    viewer.title = name;
  } else {
    viewer = document.createElement('pre');
    viewer.textContent = await blob.text();
  }
  stage.append(viewer);
  const download = dialog.querySelector('[data-viewer-download]');
  download.onclick = () => {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.click();
  };
  dialog.showModal();
  return true;
}

async function enhanceStorage() {
  const content = document.querySelector('#content');
  if (!content || !['#storage', '#pools'].includes(location.hash)) return;
  try {
    const response = await fetch('/api/storage');
    if (!response.ok) return;
    const storage = await response.json();
    content.querySelector('.attached-storage')?.remove();
    const volumes = storage.attachedVolumes || [];
    if (!volumes.length) return;

    const section = document.createElement('section');
    section.className = 'attached-storage';
    section.innerHTML = `<h2>Attached NAS storage</h2><p class="muted">Storage mounted into this LightNAS appliance. These volumes are usable by the guest and are kept separate from Proxmox host disks.</p><div class="attached-storage-grid">${volumes.map(volume => `
      <article class="attached-storage-card">
        <h3>${escapeHtml(volume.mountPoint)}</h3>
        <p>${escapeHtml(volume.device)} · ${escapeHtml(volume.type)}${volume.readOnly ? ' · Read only' : ''}</p>
        <div class="track"><span style="width:${Math.min(100, volume.usedPercent || 0)}%"></span></div>
        <p><strong>${bytes(volume.availableBytes)} free</strong> of ${bytes(volume.totalBytes)} · ${volume.usedPercent}% used</p>
      </article>`).join('')}</div>`;
    const hero = content.querySelector('.module-hero');
    if (hero && location.hash === '#pools') {
      hero.innerHTML = `<h2>Attached storage is ready</h2><p>LightNAS is running in a container. Raw Proxmox host disks are intentionally hidden here; use the mounted NAS volumes below. Physical pool creation belongs on bare metal or a VM with directly attached data disks.</p>`;
      hero.insertAdjacentElement('afterend', section);
    } else {
      content.querySelector('.page-head')?.insertAdjacentElement('afterend', section);
    }
  } catch { /* Storage enhancement is optional if inventory is temporarily unavailable. */ }
}

let storageTimer;
const observer = new MutationObserver(() => {
  clearTimeout(storageTimer);
  storageTimer = setTimeout(enhanceStorage, 80);
});
observer.observe(document.body, { subtree: true, childList: true });
window.addEventListener('hashchange', enhanceStorage);
window.addEventListener('load', enhanceStorage);

document.addEventListener('click', async event => {
  const folderButton = event.target.closest('#content [data-action="new-folder"]');
  if (folderButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const dialog = ensureFolderDialog();
    dialog.dataset.folder = currentFolder();
    dialog.querySelector('form').reset();
    dialog.querySelector('.form-error').textContent = '';
    dialog.showModal();
    setTimeout(() => dialog.querySelector('input[name="name"]')?.focus(), 0);
    return;
  }

  const fileButton = event.target.closest('#content .file-name[data-directory="false"]');
  if (fileButton && previewKind(fileButton.dataset.open || '')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try { await openPreview(fileButton.dataset.open); }
    catch (problem) { alert(problem.message); }
    return;
  }

  const createPool = event.target.closest('#content [data-action="create-pool"]');
  if (createPool && document.querySelector('#content .attached-storage')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    alert('This LightNAS instance is running in an LXC. Its mounted storage is already attached and ready to use. Raw Proxmox host disks are intentionally not exposed for pool creation.');
  }
}, true);
