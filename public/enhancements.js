const previewExtensions = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'raw', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', 'm2v', 'mts', 'm2ts', 'ts', '3gp', '3g2', 'vob']),
  audio: new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']),
  pdf: new Set(['pdf']),
  text: new Set(['txt', 'log', 'md', 'json', 'csv', 'xml', 'yaml', 'yml', 'ini', 'conf', 'sh', 'js', 'mjs', 'css', 'html'])
};

const permissionLabels = {
  'files.read': ['Read files', 'Browse, preview and download files.'],
  'files.write': ['Write files', 'Upload, create folders and delete file entries.'],
  'media.convert': ['Convert media', 'Run FFmpeg conversions from Files.'],
  'storage.view': ['View storage', 'See attached volumes, host disks and storage inventory.'],
  'storage.manage': ['Manage storage', 'Create file spaces and manage Proxmox/ZFS storage.'],
  'shares.manage': ['Manage shares', 'Create and remove share configurations.'],
  'apps.manage': ['Manage apps', 'Install, start, stop and remove catalog applications.'],
  'containers.manage': ['Manage containers', 'Create, edit, control and open LightNAS containers.'],
  'vms.manage': ['Manage VMs', 'Create, edit, control and open VM consoles.'],
  'network.view': ['View networking', 'View network interfaces, routes and firewall inventory.'],
  'system.view': ['View system health', 'View monitoring, CPU, memory and system details.']
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let number = value;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  const decimals = unit >= 4 ? 2 : number >= 100 ? 0 : number >= 10 ? 1 : unit === 0 ? 0 : 2;
  const rendered = number.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0+$/g, '');
  return `${rendered} ${units[unit]}`;
}

function percent(used, total) {
  return total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
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
      <div class="dialog-head"><div><span class="eyebrow">NEW FOLDER</span><h2>Create folder</h2></div><button class="dialog-close" type="button" data-close-folder aria-label="Close">×</button></div>
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
      await apiRequest(`/api/files?path=${encodeURIComponent(joinPath(dialog.dataset.folder || '', name))}`, { method: 'POST', body: '{}' });
      dialog.close();
      form.reset();
      document.querySelector('#content [data-action="refresh-files"]')?.click();
    } catch (problem) { error.textContent = problem.message; }
  });
  return dialog;
}

function previewItems() {
  return [...document.querySelectorAll('#content .file-name[data-directory="false"]')]
    .map(button => ({
      name: button.dataset.open || '',
      path: button.dataset.path || joinPath(currentFolder(), button.dataset.open || ''),
      modifiedAt: button.dataset.modified || '',
      sizeBytes: Number(button.dataset.size || 0)
    }))
    .filter(item => item.name && item.path && previewKind(item.name));
}

function updateViewerNavigation(dialog, name) {
  const items = previewItems();
  const index = items.findIndex(item => item.path === name || item.name === name);
  dialog.dataset.currentName = index >= 0 ? items[index].path : name;
  const previous = dialog.querySelector('[data-viewer-previous]');
  const next = dialog.querySelector('[data-viewer-next]');
  const multiple = items.length > 1;
  previous.hidden = !multiple;
  next.hidden = !multiple;
  previous.disabled = index <= 0;
  next.disabled = index < 0 || index >= items.length - 1;
  dialog.querySelector('[data-viewer-position]').textContent = index >= 0 ? `${index + 1} of ${items.length}` : '';
  const filmstrip = dialog.querySelector('[data-viewer-filmstrip]');
  if (filmstrip) {
    filmstrip.innerHTML = items.map((item, itemIndex) => {
      const url = `/api/files/thumbnail?path=${encodeURIComponent(item.path)}`;
      return `<button type="button" class="${itemIndex === index ? 'active' : ''}" data-filmstrip-index="${itemIndex}" aria-label="Open ${escapeHtml(item.name)}"><img src="${url}" alt=""></button>`;
    }).join('');
    filmstrip.querySelector('.active')?.scrollIntoView({ inline:'center', block:'nearest', behavior:'instant' });
  }
}

async function navigatePreview(offset) {
  const dialog = document.querySelector('#lightnas-viewer');
  if (!dialog?.open) return;
  const items = previewItems();
  const current = items.findIndex(item => item.path === (dialog.dataset.currentName || ''));
  const target = items[current + offset];
  if (target) await openPreview(target.name, target.path);
}

function ensureViewer() {
  let dialog = document.querySelector('#lightnas-viewer');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-viewer';
  dialog.className = 'lightnas-dialog lightnas-viewer';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-head">
        <button class="viewer-mobile-back" type="button" data-close-viewer aria-label="Back">‹</button>
        <div class="viewer-title-block"><span class="eyebrow">FILE VIEWER</span><h2 data-viewer-title>Preview</h2><small data-viewer-date></small></div>
        <button class="viewer-mobile-more" type="button" data-viewer-more aria-label="More options">•••</button>
        <button class="dialog-close viewer-desktop-close-button" type="button" data-close-viewer aria-label="Close">×</button>
      </div>
      <div class="viewer-shell">
        <button class="viewer-arrow viewer-previous" type="button" data-viewer-previous aria-label="Previous file">‹</button>
        <div class="viewer-stage" data-viewer-stage></div>
        <button class="viewer-arrow viewer-next" type="button" data-viewer-next aria-label="Next file">›</button>
      </div>
      <div class="viewer-filmstrip" data-viewer-filmstrip aria-label="Media filmstrip"></div>
      <div class="viewer-meta"><span data-viewer-meta></span><span data-viewer-position></span></div>
      <div class="viewer-mobile-hint" aria-hidden="true">Swipe left or right</div>
      <div class="dialog-actions">
        <button class="viewer-mobile-icon-action" type="button" data-viewer-share aria-label="Share"><span>⇧</span><small>Share</small></button>
        <button class="viewer-mobile-icon-action" type="button" data-viewer-favorite aria-label="Favorite"><span>♡</span><small>Favorite</small></button>
        <button class="viewer-mobile-icon-action" type="button" data-viewer-info aria-label="Info"><span>ⓘ</span><small>Info</small></button>
        <button class="secondary viewer-action-edit" type="button" data-viewer-edit>Edit</button>
        <button class="secondary viewer-action-save" type="button" data-viewer-download>Save</button>
        <button class="danger-button viewer-action-delete" type="button" data-viewer-delete>Delete</button>
        <button class="primary viewer-desktop-close" type="button" data-close-viewer>Close</button>
      </div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close-viewer]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('[data-viewer-previous]').addEventListener('click', () => navigatePreview(-1));
  dialog.querySelector('[data-viewer-next]').addEventListener('click', () => navigatePreview(1));
  dialog.querySelector('[data-viewer-filmstrip]').addEventListener('click', event => {
    const button = event.target.closest('[data-filmstrip-index]');
    if (!button) return;
    const item = previewItems()[Number(button.dataset.filmstripIndex)];
    if (item) openPreview(item.name, item.path);
  });
  dialog.querySelector('[data-viewer-more]').addEventListener('click', () => openViewerMoreMenu());

  const stage = dialog.querySelector('[data-viewer-stage]');
  let gesture = null;
  const resetGestureVisual = (snapBack = true) => {
    if (!gesture?.image) return;
    gesture.image.classList.remove('viewer-dragging');
    gesture.image.classList.toggle('viewer-snapping', snapBack);
    gesture.image.style.transform = '';
    gesture.image.style.opacity = '';
    if (snapBack) setTimeout(() => gesture?.image?.classList.remove('viewer-snapping'), 180);
  };
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    const image = stage.querySelector('img');
    gesture = {
      id:event.pointerId,
      x:event.clientX,
      y:event.clientY,
      time:performance.now(),
      image,
      axis:null,
      lastX:event.clientX
    };
    if (image) image.classList.add('viewer-dragging');
    try { stage.setPointerCapture(event.pointerId); } catch {}
  });
  stage.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture.lastX = event.clientX;
    if (!gesture.axis && (Math.abs(dx) > 7 || Math.abs(dy) > 7)) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'x' : 'y';
    }
    if (gesture.axis !== 'x' || !gesture.image) return;
    event.preventDefault();
    const bounded = Math.max(-window.innerWidth * .92, Math.min(window.innerWidth * .92, dx));
    gesture.image.style.transform = `translate3d(${bounded}px,0,0) scale(.99)`;
    gesture.image.style.opacity = String(Math.max(.58, 1 - Math.abs(bounded) / (window.innerWidth * 1.25)));
  }, { passive:false });
  stage.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const active = gesture;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const elapsed = Math.max(1, performance.now() - active.time);
    const velocityX = dx / elapsed;
    const horizontal = active.axis === 'x' && Math.abs(dx) > Math.abs(dy);
    const commitSwipe = horizontal && (Math.abs(dx) >= Math.min(72, window.innerWidth * .14) || Math.abs(velocityX) > .48);
    if (commitSwipe) {
      const direction = dx < 0 ? 1 : -1;
      if (active.image) {
        active.image.classList.remove('viewer-dragging');
        active.image.classList.add('viewer-swipe-out');
        active.image.style.transform = `translate3d(${dx < 0 ? '-105vw' : '105vw'},0,0)`;
        active.image.style.opacity = '0';
      }
      gesture = null;
      requestAnimationFrame(() => navigatePreview(direction));
      return;
    }
    if (active.axis === 'y' && dy > 120 && matchMedia('(max-width: 760px)').matches) {
      resetGestureVisual(false);
      gesture = null;
      dialog.close();
      return;
    }
    const wasTap = !active.axis && Math.abs(dx) < 10 && Math.abs(dy) < 10;
    resetGestureVisual(true);
    gesture = null;
    if (wasTap && matchMedia('(max-width: 760px)').matches) dialog.classList.toggle('viewer-chrome-hidden');
  });
  stage.addEventListener('pointercancel', () => {
    resetGestureVisual(true);
    gesture = null;
  });

  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); navigatePreview(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); navigatePreview(1); }
  });
  dialog.addEventListener('close', () => {
    if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
    delete dialog.dataset.objectUrl;
    delete dialog.dataset.currentName;
    delete dialog.dataset.sourcePath;
    dialog.querySelector('[data-viewer-stage]').replaceChildren();
  });
  return dialog;
}

function previewKind(name) {
  const extension = name.toLowerCase().split('.').pop();
  return Object.entries(previewExtensions).find(([, list]) => list.has(extension))?.[0] || null;
}



const mobilePhotoFavoritesKey = 'lightnas-mobile-photo-favorites';
let mobileCopiedEdits = null;

function mobileFavoriteSet() {
  try { return new Set(JSON.parse(localStorage.getItem(mobilePhotoFavoritesKey) || '[]')); }
  catch { return new Set(); }
}

function setViewerFavorite(path, enabled) {
  const favorites = mobileFavoriteSet();
  enabled ? favorites.add(path) : favorites.delete(path);
  localStorage.setItem(mobilePhotoFavoritesKey, JSON.stringify([...favorites]));
  return enabled;
}

function formatViewerDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? 'Today' : date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:date.getFullYear()===today.getFullYear()?undefined:'numeric'})} · ${date.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`;
}

async function shareCurrentViewerFile() {
  const dialog = document.querySelector('#lightnas-viewer');
  const path = dialog?.dataset.sourcePath || '';
  const name = dialog?.querySelector('[data-viewer-title]')?.textContent || 'LightNAS file';
  if (!path) return;
  const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error('Unable to prepare this file for sharing.');
  const blob = await response.blob();
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files:[file] }))) {
    await navigator.share({ files:[file], title:name });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ensureViewerInfoSheet() {
  let sheet = document.querySelector('#viewer-info-sheet');
  if (sheet) return sheet;
  sheet = document.createElement('dialog');
  sheet.id = 'viewer-info-sheet';
  sheet.className = 'lightnas-dialog viewer-mobile-sheet viewer-info-sheet';
  sheet.innerHTML = `
    <div class="dialog-body">
      <div class="mobile-sheet-handle"></div>
      <div class="dialog-head"><h2>Info</h2><button class="dialog-close" type="button" data-close-info>×</button></div>
      <div class="viewer-info-grid" data-viewer-info-content></div>
    </div>`;
  document.body.append(sheet);
  sheet.querySelector('[data-close-info]').addEventListener('click', () => sheet.close());
  return sheet;
}

function openViewerInfo() {
  const dialog = document.querySelector('#lightnas-viewer');
  const image = dialog?.querySelector('[data-viewer-stage] img');
  const video = dialog?.querySelector('[data-viewer-stage] video');
  const item = previewItems().find(entry => entry.path === dialog?.dataset.sourcePath);
  const sheet = ensureViewerInfoSheet();
  const dimensions = image?.naturalWidth ? `${image.naturalWidth} × ${image.naturalHeight}` :
    video?.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : '—';
  sheet.querySelector('[data-viewer-info-content]').innerHTML = `
    <div><span>Name</span><b>${escapeHtml(item?.name || dialog?.querySelector('[data-viewer-title]')?.textContent || '')}</b></div>
    <div><span>Date</span><b>${escapeHtml(formatViewerDate(item?.modifiedAt) || 'Unknown')}</b></div>
    <div><span>Dimensions</span><b>${escapeHtml(dimensions)}</b></div>
    <div><span>Size</span><b>${item?.sizeBytes ? bytes(item.sizeBytes) : 'Unknown'}</b></div>
    <div class="viewer-info-path"><span>Path</span><b>${escapeHtml(item?.path || dialog?.dataset.sourcePath || '')}</b></div>`;
  sheet.showModal();
}

function ensureViewerMoreMenu() {
  let sheet = document.querySelector('#viewer-more-sheet');
  if (sheet) return sheet;
  sheet = document.createElement('dialog');
  sheet.id = 'viewer-more-sheet';
  sheet.className = 'lightnas-dialog viewer-mobile-sheet viewer-more-sheet';
  sheet.innerHTML = `
    <div class="dialog-body">
      <div class="mobile-sheet-handle"></div>
      <div class="viewer-sheet-list">
        <button type="button" data-more-action="duplicate">Save as duplicate</button>
        <button type="button" data-more-action="copy-edits">Copy edits</button>
        <button type="button" data-more-action="paste-edits">Paste edits</button>
        <button type="button" data-more-action="info">Info</button>
        <button type="button" data-more-action="download">Download</button>
      </div>
    </div>`;
  document.body.append(sheet);
  sheet.addEventListener('click', event => {
    const button = event.target.closest('[data-more-action]');
    if (!button) return;
    const action = button.dataset.moreAction;
    sheet.close();
    if (action === 'info') openViewerInfo();
    if (action === 'download') document.querySelector('#lightnas-viewer [data-viewer-download]')?.click();
    if (action === 'copy-edits') {
      const editor = document.querySelector('#mobile-photo-editor');
      mobileCopiedEdits = editor?._lightnasEdits ? structuredClone(editor._lightnasEdits) : null;
    }
    if (action === 'paste-edits' && mobileCopiedEdits) openMobilePhotoEditor(mobileCopiedEdits);
    if (action === 'duplicate') saveViewerDuplicate().catch(error => window.alert(error.message));
  });
  return sheet;
}

function openViewerMoreMenu() {
  ensureViewerMoreMenu().showModal();
}

async function saveViewerDuplicate() {
  const dialog = document.querySelector('#lightnas-viewer');
  const path = dialog?.dataset.sourcePath || '';
  if (!path) return;
  const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error('Unable to duplicate this file.');
  const blob = await response.blob();
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
  const original = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0,dot) : original;
  const ext = dot > 0 ? original.slice(dot) : '';
  const duplicatePath = `${folder}${stem}-copy-${Date.now()}${ext}`;
  const upload = await fetch(`/api/files?path=${encodeURIComponent(duplicatePath)}`, {
    method:'PUT',
    headers:{ 'Content-Type':blob.type || 'application/octet-stream', 'X-LightNAS-Request':'1' },
    body:blob
  });
  if (!upload.ok) throw new Error('Unable to save duplicate.');
  document.querySelector('#content [data-action="refresh-files"]')?.click();
}

function defaultMobileEdits() {
  return {
    brightness:100, contrast:100, saturation:100, warmth:0,
    highlights:0, shadows:0, vignette:0,
    rotate:0, flipX:1, flipY:1, crop:'original', filter:'none'
  };
}

function filterCss(edits) {
  const warmth = Number(edits.warmth || 0);
  const sepia = Math.max(0, warmth) * .18;
  const hue = warmth < 0 ? warmth * .35 : warmth * .12;
  return `brightness(${edits.brightness || 100}%) contrast(${edits.contrast || 100}%) saturate(${edits.saturation || 100}%) sepia(${sepia}%) hue-rotate(${hue}deg)`;
}

function ensureMobilePhotoEditor() {
  let editor = document.querySelector('#mobile-photo-editor');
  if (editor) return editor;
  editor = document.createElement('dialog');
  editor.id = 'mobile-photo-editor';
  editor.className = 'lightnas-dialog mobile-photo-editor';
  editor.innerHTML = `
    <div class="mobile-editor-shell">
      <div class="mobile-editor-top">
        <button type="button" data-editor-cancel>Cancel</button>
        <div class="mobile-editor-title">ADJUST</div>
        <button type="button" data-editor-save>Done</button>
      </div>
      <div class="mobile-editor-stage"><img data-editor-image alt=""></div>
      <div class="mobile-editor-panel">
        <div class="mobile-editor-tools" data-editor-adjust>
          <label>Brightness <input type="range" min="40" max="160" value="100" data-edit-key="brightness"></label>
          <label>Contrast <input type="range" min="40" max="160" value="100" data-edit-key="contrast"></label>
          <label>Saturation <input type="range" min="0" max="200" value="100" data-edit-key="saturation"></label>
          <label>Warmth <input type="range" min="-100" max="100" value="0" data-edit-key="warmth"></label>
          <label>Highlights <input type="range" min="-100" max="100" value="0" data-edit-key="highlights"></label>
          <label>Shadows <input type="range" min="-100" max="100" value="0" data-edit-key="shadows"></label>
          <label>Vignette <input type="range" min="0" max="100" value="0" data-edit-key="vignette"></label>
        </div>
        <div class="mobile-editor-filters" data-editor-filters hidden>
          <button data-filter="none">Original</button>
          <button data-filter="vivid">Vivid</button>
          <button data-filter="warm">Warm</button>
          <button data-filter="cool">Cool</button>
          <button data-filter="mono">Mono</button>
          <button data-filter="dramatic">Dramatic</button>
        </div>
        <div class="mobile-editor-crop" data-editor-crop hidden>
          <button data-transform="rotate-left">↶ Rotate</button>
          <button data-transform="rotate-right">↷ Rotate</button>
          <button data-transform="flip">↔ Flip</button>
          <button data-crop="original">Original</button>
          <button data-crop="square">Square</button>
          <button data-crop="4:3">4:3</button>
          <button data-crop="16:9">16:9</button>
        </div>
        <div class="mobile-editor-tabs">
          <button class="active" data-editor-tab="adjust">Adjust</button>
          <button data-editor-tab="filters">Filters</button>
          <button data-editor-tab="crop">Crop</button>
        </div>
      </div>
    </div>`;
  document.body.append(editor);

  const syncPreview = () => {
    const edits = editor._lightnasEdits || defaultMobileEdits();
    const image = editor.querySelector('[data-editor-image]');
    image.style.filter = filterCss(edits);
    const extra = edits.filter === 'vivid' ? ' saturate(1.28) contrast(1.06)' :
      edits.filter === 'warm' ? ' sepia(.16) saturate(1.1)' :
      edits.filter === 'cool' ? ' hue-rotate(-10deg) saturate(1.08)' :
      edits.filter === 'mono' ? ' grayscale(1) contrast(1.08)' :
      edits.filter === 'dramatic' ? ' contrast(1.24) saturate(.9)' : '';
    image.style.filter += extra;
    image.style.transform = `rotate(${edits.rotate || 0}deg) scaleX(${edits.flipX || 1}) scaleY(${edits.flipY || 1})`;
    image.dataset.crop = edits.crop || 'original';
  };

  editor.addEventListener('input', event => {
    const key = event.target.dataset.editKey;
    if (!key) return;
    editor._lightnasEdits[key] = Number(event.target.value);
    syncPreview();
  });
  editor.addEventListener('click', event => {
    const cancel = event.target.closest('[data-editor-cancel]');
    if (cancel) { editor.close(); return; }
    const tab = event.target.closest('[data-editor-tab]');
    if (tab) {
      editor.querySelectorAll('[data-editor-tab]').forEach(button => button.classList.toggle('active', button === tab));
      editor.querySelector('[data-editor-adjust]').hidden = tab.dataset.editorTab !== 'adjust';
      editor.querySelector('[data-editor-filters]').hidden = tab.dataset.editorTab !== 'filters';
      editor.querySelector('[data-editor-crop]').hidden = tab.dataset.editorTab !== 'crop';
      editor.querySelector('.mobile-editor-title').textContent = tab.dataset.editorTab.toUpperCase();
      return;
    }
    const filter = event.target.closest('[data-filter]');
    if (filter) { editor._lightnasEdits.filter = filter.dataset.filter; syncPreview(); return; }
    const crop = event.target.closest('[data-crop]');
    if (crop) { editor._lightnasEdits.crop = crop.dataset.crop; syncPreview(); return; }
    const transform = event.target.closest('[data-transform]');
    if (transform) {
      if (transform.dataset.transform === 'rotate-left') editor._lightnasEdits.rotate -= 90;
      if (transform.dataset.transform === 'rotate-right') editor._lightnasEdits.rotate += 90;
      if (transform.dataset.transform === 'flip') editor._lightnasEdits.flipX *= -1;
      syncPreview();
      return;
    }
    if (event.target.closest('[data-editor-save]')) saveMobilePhotoEdit().catch(error => window.alert(error.message));
  });
  editor._syncPreview = syncPreview;
  return editor;
}

async function openMobilePhotoEditor(initialEdits = null) {
  const viewer = document.querySelector('#lightnas-viewer');
  const image = viewer?.querySelector('[data-viewer-stage] img');
  if (!image) return;
  const editor = ensureMobilePhotoEditor();
  editor._lightnasEdits = structuredClone(initialEdits || defaultMobileEdits());
  editor._sourcePath = viewer.dataset.sourcePath || '';
  editor._sourceName = viewer.querySelector('[data-viewer-title]')?.textContent || 'photo.jpg';
  editor.querySelector('[data-editor-image]').src = image.currentSrc || image.src;
  for (const input of editor.querySelectorAll('[data-edit-key]')) {
    input.value = editor._lightnasEdits[input.dataset.editKey];
  }
  editor._syncPreview();
  editor.showModal();
}

async function saveMobilePhotoEdit() {
  const editor = document.querySelector('#mobile-photo-editor');
  const sourceImage = editor?.querySelector('[data-editor-image]');
  const edits = editor?._lightnasEdits;
  if (!editor?.open || !sourceImage || !edits) return;
  const source = new Image();
  source.crossOrigin = 'same-origin';
  source.src = sourceImage.currentSrc || sourceImage.src;
  await source.decode();

  let sx = 0, sy = 0, sw = source.naturalWidth, sh = source.naturalHeight;
  const ratio = edits.crop === 'square' ? 1 : edits.crop === '4:3' ? 4/3 : edits.crop === '16:9' ? 16/9 : null;
  if (ratio) {
    const current = sw / sh;
    if (current > ratio) { const target = sh * ratio; sx = (sw-target)/2; sw = target; }
    else { const target = sw / ratio; sy = (sh-target)/2; sh = target; }
  }
  const quarter = Math.abs(Math.round((edits.rotate || 0) / 90)) % 2 === 1;
  const canvas = document.createElement('canvas');
  canvas.width = quarter ? sh : sw;
  canvas.height = quarter ? sw : sh;
  const ctx = canvas.getContext('2d', { alpha:false });
  ctx.save();
  ctx.translate(canvas.width/2, canvas.height/2);
  ctx.rotate((edits.rotate || 0) * Math.PI / 180);
  ctx.scale(edits.flipX || 1, edits.flipY || 1);
  const extra = edits.filter === 'vivid' ? ' saturate(128%) contrast(106%)' :
    edits.filter === 'warm' ? ' sepia(16%) saturate(110%)' :
    edits.filter === 'cool' ? ' hue-rotate(-10deg) saturate(108%)' :
    edits.filter === 'mono' ? ' grayscale(100%) contrast(108%)' :
    edits.filter === 'dramatic' ? ' contrast(124%) saturate(90%)' : '';
  ctx.filter = filterCss(edits) + extra;
  ctx.drawImage(source, sx, sy, sw, sh, -sw/2, -sh/2, sw, sh);
  ctx.restore();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .94));
  if (!blob) throw new Error('Unable to create edited image.');
  const path = editor._sourcePath;
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash+1) : '';
  const stem = (slash >= 0 ? path.slice(slash+1) : path).replace(/\.[^.]+$/, '');
  const output = `${folder}${stem}-edited-${Date.now()}.jpg`;
  const response = await fetch(`/api/files?path=${encodeURIComponent(output)}`, {
    method:'PUT',
    headers:{'Content-Type':'image/jpeg','X-LightNAS-Request':'1'},
    body:blob
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to save edited image.');
  }
  mobileCopiedEdits = structuredClone(edits);
  editor.close();
  document.querySelector('#lightnas-viewer')?.close();
  document.querySelector('#content [data-action="refresh-files"]')?.click();
}

async function editCurrentImage() {
  if (matchMedia('(max-width: 760px)').matches) {
    await openMobilePhotoEditor();
    return;
  }
  const dialog = document.querySelector('#lightnas-viewer');
  const image = dialog?.querySelector('[data-viewer-stage] img');
  const path = dialog?.dataset.sourcePath || '';
  if (!dialog?.open || !image || !path) return;

  const source = new Image();
  source.crossOrigin = 'same-origin';
  source.src = image.currentSrc || image.src;
  await source.decode();

  const choice = window.prompt('Edit photo: enter L for rotate left, R for rotate right, or C for center square crop.', 'R');
  if (!choice) return;
  const action = choice.trim().toUpperCase();

  let width = source.naturalWidth;
  let height = source.naturalHeight;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha:false });
  if (!ctx) throw new Error('Image editor is unavailable in this browser.');

  if (action === 'L' || action === 'R') {
    canvas.width = height;
    canvas.height = width;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((action === 'R' ? 1 : -1) * Math.PI / 2);
    ctx.drawImage(source, -width / 2, -height / 2);
  } else if (action === 'C') {
    const side = Math.min(width, height);
    canvas.width = side;
    canvas.height = side;
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, side, side);
  } else {
    return;
  }

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  if (!blob) throw new Error('Unable to create the edited photo.');
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
  const original = slash >= 0 ? path.slice(slash + 1) : path;
  const stem = original.replace(/\.[^.]+$/, '');
  const editedPath = `${folder}${stem}-edited-${Date.now()}.jpg`;
  const response = await fetch(`/api/files?path=${encodeURIComponent(editedPath)}`, {
    method:'PUT',
    headers:{ 'Content-Type':'image/jpeg', 'X-LightNAS-Request':'1' },
    body:blob
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to save the edited photo.');
  }
  dialog.close();
  document.querySelector('#content [data-action="refresh-files"]')?.click();
}

const viewerPreloadCache = new Map();

function viewerUrls(item) {
  const extension = item.name.toLowerCase().split('.').pop();
  const native = ['jpg','jpeg','png','gif','webp','avif','bmp','svg'].includes(extension);
  return {
    preview: `/api/files/thumbnail?preview=1&path=${encodeURIComponent(item.path)}`,
    original: native ? `/api/files/download?path=${encodeURIComponent(item.path)}` : ''
  };
}

function warmViewerImage(url) {
  if (!url || viewerPreloadCache.has(url)) return viewerPreloadCache.get(url);
  const image = new Image();
  const promise = new Promise(resolve => {
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
  });
  image.src = url;
  viewerPreloadCache.set(url, promise);
  return promise;
}

function preloadPreviewNeighbors(path) {
  const items = previewItems();
  const index = items.findIndex(item => item.path === path);
  const nearby = [items[index - 2], items[index - 1], items[index + 1], items[index + 2]].filter(Boolean);
  for (const item of nearby) {
    if (previewKind(item.name) !== 'image') continue;
    const urls = viewerUrls(item);
    warmViewerImage(urls.preview);
    if (Math.abs(items.indexOf(item) - index) === 1) warmViewerImage(urls.original);
  }
}

async function openPreview(name, explicitPath = '') {
  const kind = previewKind(name);
  if (!kind) return false;
  const path = explicitPath || joinPath(currentFolder(), name);
  const extension = name.toLowerCase().split('.').pop();
  const raw = ['raw','dng','cr2','cr3','nef','nrw','arw','srf','sr2','raf','orf','rw2','pef','srw','x3f','heic','heif'].includes(extension);
  const dialog = ensureViewer();
  dialog.classList.remove('viewer-chrome-hidden');
  if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
  delete dialog.dataset.objectUrl;
  dialog.dataset.sourcePath = path;
  dialog.querySelector('[data-viewer-title]').textContent = name;
  dialog.querySelector('[data-viewer-meta]').textContent = `${kind.toUpperCase()} preview`;
  const stage = dialog.querySelector('[data-viewer-stage]');
  stage.replaceChildren();
  stage.style.removeProperty('--viewer-bg');
  let viewer;

  if (kind === 'image') {
    viewer = document.createElement('img');
    const urls = viewerUrls({ name, path });
    viewer.src = urls.preview;
    viewer.alt = name;
    viewer.decoding = 'async';
    viewer.fetchPriority = 'high';
    stage.style.setProperty('--viewer-bg', `url("${urls.preview.replaceAll('"', '%22')}")`);
    warmViewerImage(urls.preview);
    if (urls.original) {
      warmViewerImage(urls.original).then(full => {
        if (!full || dialog.dataset.sourcePath !== path || !viewer.isConnected) return;
        viewer.src = urls.original;
        stage.style.setProperty('--viewer-bg', `url("${urls.original.replaceAll('"', '%22')}")`);
      });
    }
  } else if (kind === 'video') {
    // Always use the server preview path. Browser codec support differs across
    // MKV/AVI/WMV/MTS/etc.; LightNAS streams an on-demand H.264/AAC preview.
    viewer = document.createElement('video');
    viewer.src = `/api/files/video-preview?path=${encodeURIComponent(path)}`;
    viewer.controls = true;
    viewer.autoplay = true;
    viewer.playsInline = true;
  } else {
    const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to open file.');
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    dialog.dataset.objectUrl = objectUrl;
    dialog.querySelector('[data-viewer-meta]').textContent = `${bytes(blob.size)} · ${kind.toUpperCase()} preview`;
    if (kind === 'audio') { viewer = document.createElement('audio'); viewer.src = objectUrl; viewer.controls = true; viewer.autoplay = true; }
    else if (kind === 'pdf') { viewer = document.createElement('iframe'); viewer.src = objectUrl; viewer.title = name; }
    else { viewer = document.createElement('pre'); viewer.textContent = await blob.text(); }
  }

  stage.append(viewer);
  dialog.querySelector('[data-viewer-download]').onclick = () => {
    const anchor = document.createElement('a');
    anchor.href = `/api/files/download?path=${encodeURIComponent(path)}`;
    anchor.download = name;
    anchor.click();
  };
  const editButton = dialog.querySelector('[data-viewer-edit]');
  editButton.hidden = kind !== 'image';
  editButton.onclick = () => editCurrentImage().catch(error => window.alert(error.message));
  dialog.querySelector('[data-viewer-delete]').onclick = async () => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
      method:'DELETE',
      headers:{ 'X-LightNAS-Request':'1' }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      window.alert(body.error || 'Unable to delete this file.');
      return;
    }
    dialog.close();
    document.querySelector('#content [data-action="refresh-files"]')?.click();
  };
  updateViewerNavigation(dialog, path);
  if (kind === 'image') preloadPreviewNeighbors(path);
  if (!dialog.open) dialog.showModal();
  return true;
}

function ensureRuntimeDialog() {
  let dialog = document.querySelector('#lightnas-runtime-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-runtime-dialog';
  dialog.className = 'lightnas-dialog runtime-dialog';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-head"><div><span class="eyebrow">RUNTIME OUTPUT</span><h2 data-runtime-title>Container</h2></div><button class="dialog-close" type="button" data-runtime-close>×</button></div>
      <pre class="runtime-output" data-runtime-output>Ready.</pre>
      <div class="dialog-actions"><button class="primary" type="button" data-runtime-close>Close</button></div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-runtime-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  return dialog;
}

function ensureStoragePolicyDialog() {
  let dialog = document.querySelector('#lightnas-storage-policy-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-storage-policy-dialog';
  dialog.className = 'lightnas-dialog';
  dialog.innerHTML = `
    <form class="dialog-body" data-storage-policy-form>
      <div class="dialog-head"><div><span class="eyebrow">PROXMOX STORAGE</span><h2 data-storage-policy-title>Storage policy</h2></div><button class="dialog-close" type="button" data-storage-policy-close>×</button></div>
      <p class="muted">Choose which Proxmox content types this storage is allowed to hold.</p>
      <div class="content-policy-grid"></div>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-storage-policy-close>Cancel</button><button class="primary" type="submit">Save policy</button></div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-storage-policy-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = event.currentTarget.querySelector('.form-error');
    error.textContent = '';
    const content = [...event.currentTarget.querySelectorAll('input:checked')].map(input => input.value);
    try {
      await apiRequest('/api/proxmox/storage', { method: 'POST', body: JSON.stringify({ storage: dialog.dataset.storage, content }) });
      dialog.close();
      document.querySelector('#content .unified-storage')?.remove();
      enhanceStorage();
    } catch (problem) { error.textContent = problem.message; }
  });
  return dialog;
}

function hideLegacySections(content, labels) {
  for (const heading of [...content.querySelectorAll('h2')]) {
    if (!labels.includes(heading.textContent.trim())) continue;
    const next = heading.nextElementSibling;
    heading.classList.add('legacy-hidden');
    if (next) next.classList.add('legacy-hidden');
  }
}

function storageUsageCard(item) {
  const total = Number(item.totalBytes || item.total || 0);
  const available = Number(item.availableBytes || item.available || 0);
  const used = Number(item.usedBytes || Math.max(0, total - available));
  const usedPercent = percent(used, total);
  const contents = (item.content || []).map(value => `<span class="content-badge">${escapeHtml(value)}</span>`).join('');
  return `<article class="inventory-card">
    <div class="volume-title"><h3>${escapeHtml(item.name)}</h3><span class="volume-state ${item.active === false ? 'readonly' : 'writable'}">${item.active === false ? 'OFFLINE' : 'ACTIVE'}</span></div>
    <p>${escapeHtml(item.type || 'storage')} ${contents ? `· ${contents}` : ''}</p>
    <div class="track"><span style="width:${usedPercent}%"></span></div>
    <p><strong>${bytes(available)} free</strong> of ${bytes(total)} · ${usedPercent}% used</p>
    <button class="secondary" type="button" data-storage-policy="${escapeHtml(item.name)}" data-storage-content="${escapeHtml((item.content || []).join(','))}">Edit allowed content</button>
  </article>`;
}

async function enhanceStorage() {
  // Storage rendering is owned by storage-manager.js now. Keep this legacy
  // hook inert so older enhancement events cannot inject a duplicate inventory.
  if (document.querySelector('#storage-manager')) return;
  const content = document.querySelector('#content');
  if (!content || location.hash !== '#storage' || content.querySelector('.unified-storage') || content.dataset.storageEnhancing === '1') return;
  content.dataset.storageEnhancing = '1';
  try {
    const storage = await apiRequest('/api/storage');
    const volumes = storage.attachedVolumes || [];
    const summary = storage.virtualStorage || { totalBytes: 0, availableBytes: 0, usedBytes: 0, usedPercent: 0, count: volumes.length };
    const section = document.createElement('section');
    section.className = 'unified-storage';
    section.innerHTML = `
      <div class="inventory-heading">
        <div><span class="eyebrow">VIRTUAL STORAGE INVENTORY</span><h2>Storage visible to LightNAS</h2><p class="muted">Only non-OS virtual disks and mount points assigned to this LightNAS appliance are counted here. Duplicate bind mounts are removed.</p></div>
        <button class="secondary" type="button" data-refresh-inventory>Refresh</button>
      </div>
      <div class="host-monitor-grid">
        <article class="monitor-card"><span>Assigned capacity</span><strong>${bytes(summary.totalBytes)}</strong><small>${summary.count || 0} virtual volume${summary.count === 1 ? '' : 's'}</small></article>
        <article class="monitor-card"><span>Used</span><strong>${bytes(summary.usedBytes)}</strong><div class="track"><span style="width:${Math.min(100, summary.usedPercent || 0)}%"></span></div><small>${summary.usedPercent || 0}% of assigned capacity</small></article>
        <article class="monitor-card"><span>Available</span><strong>${bytes(summary.availableBytes)}</strong><small>Logical free capacity visible to LightNAS</small></article>
      </div>
      ${volumes.length ? `<h2>Assigned virtual volumes</h2><div class="inventory-grid">${volumes.map(volume => `<article class="inventory-card"><div class="volume-title"><h3>${escapeHtml(volume.mountPoint)}</h3><span class="volume-state ${volume.writable && !volume.readOnly ? 'writable' : 'readonly'}">${volume.writable && !volume.readOnly ? 'WRITABLE' : 'READ ONLY'}</span></div><p>${escapeHtml(volume.device)} · ${escapeHtml(volume.type)}</p><div class="track"><span style="width:${Math.min(100, volume.usedPercent || 0)}%"></span></div><p><strong>${bytes(volume.availableBytes)} free</strong> of ${bytes(volume.totalBytes)} · ${volume.usedPercent}% used</p></article>`).join('')}</div>` : '<div class="module-note">No non-OS virtual storage is currently assigned to LightNAS.</div>'}
    `;
    content.querySelector('.page-head')?.insertAdjacentElement('afterend', section);
    hideLegacySections(content, ['Disks', 'ZFS pools', 'ZFS datasets', 'Mounted filesystems']);
  } catch {}
  finally { delete content.dataset.storageEnhancing; }
}

let monitorTimer;
async function enhanceHomeMonitor() {
  if (location.hash && location.hash !== '#home') return;
  const content = document.querySelector('#content');
  if (!content) return;
  try {
    const overview = await apiRequest('/api/overview');
    const host = overview.host;
    if (!host) return;
    let section = content.querySelector('.host-live-monitor');
    if (!section) {
      section = document.createElement('section');
      section.className = 'host-live-monitor panel';
      content.querySelector('.metric-grid')?.insertAdjacentElement('afterend', section);
    }
    const memory = host.status?.memory || {};
    const memPercent = percent(memory.usedBytes, memory.totalBytes);
    const storages = host.storages || [];
    section.innerHTML = `<div class="panel-head"><div><span class="eyebrow">PROXMOX HOST MONITOR</span><h2>Live host resources</h2></div><small>Auto refreshes</small></div><div class="host-monitor-grid"><article class="monitor-card"><span>RAM used</span><strong>${bytes(memory.usedBytes || 0)}</strong><div class="track"><span style="width:${memPercent}%"></span></div><small>${bytes(memory.freeBytes || 0)} free / ${bytes(memory.totalBytes || 0)} total</small></article><article class="monitor-card"><span>CPU use</span><strong>${Number(host.status?.cpuPercent || 0).toFixed(1)}%</strong><div class="track"><span style="width:${Math.min(100, Number(host.status?.cpuPercent || 0))}%"></span></div><small>${host.status?.cpuCount || '—'} logical CPUs</small></article>${storages.slice(0, 4).map(item => { const total = item.totalBytes || 0; const used = item.usedBytes || Math.max(0, total - (item.availableBytes || 0)); const p = percent(used,total); return `<article class="monitor-card"><span>${escapeHtml(item.name)}</span><strong>${bytes(used)}</strong><div class="track"><span style="width:${p}%"></span></div><small>${bytes(item.availableBytes || 0)} free / ${bytes(total)} total</small></article>`; }).join('')}</div>`;
  } catch {}
  clearTimeout(monitorTimer);
  if (!location.hash || location.hash === '#home') monitorTimer = setTimeout(enhanceHomeMonitor, 10000);
}

function portFromDocker(ports) {
  const match = String(ports || '').match(/(?:0\.0\.0\.0|\[::\]|:::|127\.0\.0\.1)?:(\d+)->/);
  return match ? Number(match[1]) : null;
}

async function enhanceRuntimeControls() {
  if (!['#containers', '#vms'].includes(location.hash)) return;
  const content = document.querySelector('#content');
  if (!content || content.dataset.runtimeEnhancing === '1') return;
  content.dataset.runtimeEnhancing = '1';
  try {
    const runtimes = await apiRequest('/api/runtimes');
    window.LightNASRuntimeInventory = runtimes;
    if (location.hash === '#containers') {
      const runtime = runtimes.containers || {};
      for (const item of runtime.containers || []) {
        const id = String(item.id || item.name || '');
        const row = [...content.querySelectorAll('.storage-row')].find(candidate => candidate.querySelector('h3')?.textContent === item.name);
        if (!row || row.querySelector('.runtime-actions')) continue;
        const actions = document.createElement('div');
        actions.className = 'runtime-actions';
        const running = String(item.status || '').toLowerCase() === 'running';
        let publication = item.publication;
        const privateNatAddress = /^10\.77\.0\.(?:\d{1,3})$/.test(String(item.ipv4 || publication?.targetHost || ''));
        if (running && (!publication || (privateNatAddress && publication.mode !== 'proxy'))) {
          const detected = await apiRequest('/api/containers', {
            method: 'POST',
            body: JSON.stringify({ id, action: 'auto-publish', attempts: 1 })
          }).catch(() => null);
          publication = detected?.mode ? detected : detected?.publication || publication;
        }
        const applicationUrl = publication
          ? (publication.mode === 'direct'
            ? `${publication.scheme || 'http'}://${publication.targetHost}${((publication.scheme || 'http') === 'https' && Number(publication.targetPort) === 443) || ((publication.scheme || 'http') === 'http' && Number(publication.targetPort) === 80) ? '' : `:${publication.targetPort}`}/`
            : `${publication.scheme || 'http'}://${location.hostname}:${publication.hostPort}/`)
          : '';
        const memoryMiB = Math.max(256, Math.round((item.memory || 0) / 1048576) || 2048);
        actions.innerHTML = `${running ? `${publication ? `<a class="primary" href="${escapeHtml(applicationUrl)}" target="_blank" rel="noopener">Open application</a>` : ''}<button class="primary" data-container-console="${escapeHtml(id)}" data-container-name="${escapeHtml(item.name)}">Terminal</button><button class="secondary" data-container-action="shutdown" data-container-id="${escapeHtml(id)}">Shutdown</button><button class="secondary" data-container-action="reboot" data-container-id="${escapeHtml(id)}">Reboot</button><button class="secondary" data-container-action="stop" data-container-id="${escapeHtml(id)}">Stop</button>` : `<button class="primary" data-container-action="start" data-container-id="${escapeHtml(id)}">Start</button>`}
          <button class="secondary" data-container-edit="${escapeHtml(id)}" data-container-name="${escapeHtml(item.name)}" data-container-memory="${memoryMiB}" data-container-cpus="${item.cpus || 2}">Edit</button>
          <button class="secondary danger-button" data-container-action="delete" data-container-id="${escapeHtml(id)}">Delete</button>`;
        row.append(actions);
      }
    } else {
      const vm = runtimes.virtualization || {};
      const form = content.querySelector('#vm-form');
      if (form && vm.poolDetails?.length) {
        const select = form.querySelector('select[name="pool"]');
        for (const detail of vm.poolDetails) {
          const option = [...select.options].find(item => item.value === detail.name);
          if (option) option.textContent = `${detail.name} · ${detail.type}${detail.available ? ` · ${bytes(detail.available)} free` : ''}`;
        }
      }
      for (const item of vm.machineDetails || []) {
        const id = String(item.id || item.vmid || item.name || '');
        const row = [...content.querySelectorAll('.storage-row')].find(candidate => candidate.querySelector('h3')?.textContent === item.name);
        if (!row || row.querySelector('.runtime-actions')) continue;
        const actions = document.createElement('div');
        actions.className = 'runtime-actions';
        const running = /running/i.test(String(item.status || ''));
        const memoryMiB = Math.max(512, Math.round((item.memory || 0) / 1048576) || 2048);
        actions.innerHTML = `${running ? `<button class="primary" data-vm-console="${escapeHtml(id)}" data-vm-name="${escapeHtml(item.name)}">noVNC Console</button><button class="secondary" data-vm-action="shutdown" data-vm-id="${escapeHtml(id)}">Shutdown</button><button class="secondary" data-vm-action="reboot" data-vm-id="${escapeHtml(id)}">Reboot</button><button class="secondary" data-vm-action="stop" data-vm-id="${escapeHtml(id)}">Stop</button>` : `<button class="primary" data-vm-action="start" data-vm-id="${escapeHtml(id)}">Start</button>`}
          <button class="secondary" data-vm-edit="${escapeHtml(id)}" data-vm-name="${escapeHtml(item.name)}" data-vm-memory="${memoryMiB}" data-vm-cpus="${item.cpus || 2}">Edit</button>
          <button class="secondary" data-vm-action="reset" data-vm-id="${escapeHtml(id)}">Reset</button>
          <button class="secondary danger-button" data-vm-action="delete" data-vm-id="${escapeHtml(id)}">Delete</button>`;
        row.append(actions);
      }
    }
  } catch {} finally { delete content.dataset.runtimeEnhancing; }
}

function enhanceFileThumbnails() {
  // Thumbnails are rendered directly by app.js. Keeping thumbnail DOM out of
  // the MutationObserver avoids click/open/close races that previously left
  // image elements broken after previewing a file.
  return;
}

function permissionsMarkup(options, selected = []) {
  return `<fieldset class="policy-grid"><legend>Permissions</legend>${options.map(permission => {
    const [label, description] = permissionLabels[permission] || [permission, permission];
    return `<label class="policy-option"><input type="checkbox" value="${escapeHtml(permission)}" ${selected.includes(permission) ? 'checked' : ''}><span><b>${escapeHtml(label)}</b><small>${escapeHtml(description)}</small></span></label>`;
  }).join('')}</fieldset>`;
}

async function enhancePolicies() {
  // Permissions moved to the dedicated #permissions workspace.
  // Keep this compatibility hook intentionally empty so older enhancement
  // scheduling does not inject policy controls back into the Users page.
  return;
}

function enhanceAdminCenter() {
  // Admin Center is rendered directly by app.js. Do not inject a second copy
  // of the navigation/tools here.
  return;
}

function scheduleEnhancements() {
  clearTimeout(scheduleEnhancements.timer);
  scheduleEnhancements.timer = setTimeout(() => {
    enhanceStorage();
    enhanceHomeMonitor();
    enhanceRuntimeControls();
    enhanceFileThumbnails();
    enhancePolicies();
    enhanceAdminCenter();
  }, 100);
}

const observer = new MutationObserver(scheduleEnhancements);
observer.observe(document.body, { subtree: true, childList: true });
window.addEventListener('hashchange', scheduleEnhancements);
window.addEventListener('load', scheduleEnhancements);

document.addEventListener('submit', async event => {
  if (event.target.id !== 'user-form' || !event.target.querySelector('.policy-grid')) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const form = event.target;
  const error = form.querySelector('.form-error');
  error.textContent = '';
  const data = new FormData(form);
  const permissions = [...form.querySelectorAll('.policy-grid input:checked')].map(input => input.value);
  try {
    await apiRequest('/api/users', { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password'), permissions }) });
    location.reload();
  } catch (problem) { error.textContent = problem.message; }
}, true);

document.addEventListener('click', async event => {
  const folderButton = event.target.closest('#content [data-action="new-folder"]');
  if (folderButton) {
    event.preventDefault(); event.stopImmediatePropagation();
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
    event.preventDefault(); event.stopImmediatePropagation();
    try { await openPreview(fileButton.dataset.open, fileButton.dataset.path || ''); } catch (problem) { alert(problem.message); }
    return;
  }

  const refresh = event.target.closest('[data-refresh-inventory]');
  if (refresh) { document.querySelector('#content .unified-storage')?.remove(); enhanceStorage(); return; }

  const storagePolicy = event.target.closest('[data-storage-policy]');
  if (storagePolicy) {
    const dialog = ensureStoragePolicyDialog();
    dialog.dataset.storage = storagePolicy.dataset.storagePolicy;
    dialog.querySelector('[data-storage-policy-title]').textContent = storagePolicy.dataset.storagePolicy;
    const selected = (storagePolicy.dataset.storageContent || '').split(',').filter(Boolean);
    const options = [['images','VM disks'],['rootdir','Container disks'],['iso','ISO images'],['vztmpl','Container templates'],['backup','Backups'],['snippets','Snippets'],['import','Import files']];
    dialog.querySelector('.content-policy-grid').innerHTML = options.map(([value,label]) => `<label><input type="checkbox" value="${value}" ${selected.includes(value) ? 'checked' : ''}> ${label}</label>`).join('');
    dialog.querySelector('.form-error').textContent = '';
    dialog.showModal();
    return;
  }

  const cleanDisk = event.target.closest('[data-clean-disk]');
  if (cleanDisk) {
    const path = cleanDisk.dataset.cleanDisk;
    const phrase = `CLEAN ${path}`;
    const confirmation = prompt(`This removes partition/filesystem signatures from ${path}.\n\nLightNAS already verified it is not the OS disk and is not mounted/LVM/ZFS in use.\n\nType exactly:\n${phrase}`);
    if (confirmation !== phrase) return;
    cleanDisk.disabled = true;
    try {
      await apiRequest('/api/proxmox/disk-clean', { method: 'POST', body: JSON.stringify({ path, confirm: confirmation }) });
      document.querySelector('#content .unified-storage')?.remove();
      await enhanceStorage();
    } catch (error) { alert(error.message); }
    finally { cleanDisk.disabled = false; }
    return;
  }

  const consoleButton = event.target.closest('[data-container-console]');
  if (consoleButton) {
    window.open(`/container-console.html?id=${encodeURIComponent(consoleButton.dataset.containerConsole)}&name=${encodeURIComponent(consoleButton.dataset.containerName || '')}&v=${Date.now()}`, '_blank', 'noopener,width=1100,height=760');
    return;
  }
  const containerEdit = event.target.closest('[data-container-edit]');
  if (containerEdit) {
    const id = containerEdit.dataset.containerEdit;
    const name = prompt('Container name', containerEdit.dataset.containerName || id);
    if (!name) return;
    const memoryMiB = Number(prompt('Memory (MiB)', containerEdit.dataset.containerMemory || '2048'));
    const cpus = Number(prompt('Virtual CPUs', containerEdit.dataset.containerCpus || '2'));
    if (!Number.isInteger(memoryMiB) || !Number.isInteger(cpus)) return;
    try {
      await apiRequest('/api/containers', { method: 'POST', body: JSON.stringify({ id, action: 'update', name, memoryMiB, cpus }) });
      document.querySelector('#content [data-action="refresh-runtime"]')?.click();
    } catch (error) { alert(error.message); }
    return;
  }
  const containerAction = event.target.closest('[data-container-action]');
  if (containerAction) {
    const action = containerAction.dataset.containerAction;
    const id = containerAction.dataset.containerId;
    if (action === 'delete' && !confirm(`Delete system container ${id} and its root filesystem? This cannot be undone.`)) return;
    containerAction.disabled = true;
    try {
      await apiRequest('/api/containers', { method: 'POST', body: JSON.stringify({ id, action }) });
      document.querySelector('#content [data-action="refresh-runtime"]')?.click();
    } catch (error) { alert(error.message); }
    finally { containerAction.disabled = false; }
    return;
  }

  const vmConsole = event.target.closest('[data-vm-console]');
  if (vmConsole) {
    window.open(`/vm-console.html?id=${encodeURIComponent(vmConsole.dataset.vmConsole)}&name=${encodeURIComponent(vmConsole.dataset.vmName || '')}&v=${Date.now()}`, '_blank', 'noopener,width=1280,height=820');
    return;
  }
  const vmAction = event.target.closest('[data-vm-action]');
  if (vmAction) {
    const action = vmAction.dataset.vmAction;
    const id = vmAction.dataset.vmId;
    if (action === 'delete' && !confirm(`Delete VM ${id} and its managed disks? This cannot be undone.`)) return;
    vmAction.disabled = true;
    try {
      await apiRequest('/api/vms', { method: 'POST', body: JSON.stringify({ id, action }) });
      document.querySelector('#content [data-action="refresh-runtime"]')?.click();
    } catch (error) { alert(error.message); }
    finally { vmAction.disabled = false; }
    return;
  }

  const policy = event.target.closest('[data-save-policy]');
  if (policy) {
    const form = policy.closest('form');
    const password = form.querySelector('input[name="currentPassword"]')?.value || '';
    const permissions = [...form.querySelectorAll('.policy-grid input:checked')].map(input => input.value);
    policy.disabled = true;
    try {
      await apiRequest(`/api/users/${encodeURIComponent(policy.dataset.savePolicy)}`, { method: 'PATCH', body: JSON.stringify({ currentPassword: password, permissions }) });
      policy.textContent = 'Saved';
      setTimeout(() => { policy.textContent = 'Save permissions'; policy.disabled = false; }, 1200);
    } catch (error) { alert(error.message); policy.disabled = false; }
    return;
  }

  const adminTool = event.target.closest('[data-admin-view]');
  if (adminTool) { location.hash = adminTool.dataset.adminView; }
}, true);
