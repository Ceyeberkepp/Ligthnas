const templateState = { library: null, catalog: null };

function tEsc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]);
}

function tBytes(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let n = Number(value), u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  return `${n >= 10 || u === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[u]}`;
}

async function tRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'X-LightNAS-Request': '1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Template operation failed.');
  return body;
}

function targetOptions(targets = []) {
  const virtual = targets.filter(item => item.kind === 'virtual');
  const fallback = targets.filter(item => item.kind !== 'virtual');
  const option = item => `<option value="${tEsc(item.id)}" ${item.writable ? '' : 'disabled'}>${tEsc(item.label)} · ${tBytes(item.availableBytes)} free${item.writable ? '' : ' · read only'}</option>`;
  return `${virtual.length ? '<optgroup label="Assigned virtual storage">' + virtual.map(option).join('') + '</optgroup>' : ''}${fallback.length ? '<optgroup label="System fallback">' + fallback.map(option).join('') + '</optgroup>' : ''}`;
}

function preferredTarget(targets = []) {
  return targets.find(item => item.kind === 'virtual' && item.writable)?.id ||
    targets.find(item => item.writable)?.id || '';
}

function ensureTemplateDialog() {
  let dialog = document.querySelector('#lightnas-template-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-template-dialog';
  dialog.className = 'lightnas-dialog';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-head"><div><span class="eyebrow">CONTAINER TEMPLATES</span><h2 data-template-title>Templates</h2></div><button class="dialog-close" type="button" data-template-close>×</button></div>
      <div data-template-body></div>
      <div class="form-error" data-template-error role="alert"></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-template-close>Close</button></div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-template-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  return dialog;
}

async function loadTemplateLibrary() {
  templateState.library = await tRequest('/api/templates');
  return templateState.library;
}

function renderTemplateLibrary() {
  const slot = document.querySelector('#container-template-library');
  if (!slot || !templateState.library) return;
  const { templates = [], targets = [], proxmoxSource } = templateState.library;
  const virtualTargets = targets.filter(item => item.kind === 'virtual');
  slot.innerHTML = `
    <section class="panel">
      <div class="panel-head"><div><span class="eyebrow">CONTAINER TEMPLATE LIBRARY</span><h2>System container templates</h2></div>
        <div class="head-actions">
          <button class="primary" type="button" data-template-browse>Browse Proxmox catalog</button>
          <button class="secondary" type="button" data-template-upload>Upload template</button>
          <button class="secondary" type="button" data-template-url>Import URL</button>
        </div>
      </div>
      <p class="muted">LightNAS stores templates on the virtual storage you choose. Proxmox system templates come from the same public repository used by Proxmox VE. Stored archives become selectable when creating a native LXC container.</p>
      <div class="inventory-grid">
        <article class="inventory-card"><h3>${templates.length}</h3><p>templates stored locally</p></article>
        <article class="inventory-card"><h3>${virtualTargets.length}</h3><p>assigned virtual storage target${virtualTargets.length === 1 ? '' : 's'}</p></article>
        <article class="inventory-card"><h3>vztmpl</h3><p>container-template content role</p></article>
      </div>
      ${templates.length ? `<div class="storage-list">${templates.map(item => `<article class="storage-row"><div><h3>${tEsc(item.filename)}</h3><p>${tEsc(item.storageLabel)} · ${tBytes(item.sizeBytes)}</p></div><div class="runtime-actions"><button class="secondary danger-button" type="button" data-template-delete="${tEsc(item.id)}">Delete</button></div></article>`).join('')}</div>` : '<div class="empty"><p>No saved container templates yet.</p></div>'}
      <p class="muted">Catalog source: ${tEsc(proxmoxSource || 'https://download.proxmox.com/images/system/')}</p>
    </section>`;
}

async function refreshTemplateLibrary() {
  try {
    await loadTemplateLibrary();
    renderTemplateLibrary();
  } catch (error) {
    const slot = document.querySelector('#container-template-library');
    if (slot) slot.innerHTML = `<div class="module-note">Template library unavailable: ${tEsc(error.message)}</div>`;
  }
}

async function openUploadDialog() {
  const library = templateState.library || await loadTemplateLibrary();
  const dialog = ensureTemplateDialog();
  dialog.querySelector('[data-template-title]').textContent = 'Upload container template';
  dialog.querySelector('[data-template-error]').textContent = '';
  dialog.querySelector('[data-template-body]').innerHTML = `
    <form data-template-upload-form>
      <p class="muted">Upload a Proxmox/LXC rootfs template archive into the selected LightNAS storage.</p>
      <label>Storage<select name="storageId" required>${targetOptions(library.targets)}</select></label>
      <label>Template file<input name="file" type="file" accept=".tar.zst,.tar.xz,.tar.gz,.tgz" required></label>
      <div class="dialog-actions"><button class="primary" type="submit">Upload template</button></div>
    </form>`;
  const select = dialog.querySelector('select[name="storageId"]');
  select.value = preferredTarget(library.targets);
  dialog.querySelector('[data-template-upload-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files?.[0];
    const storageId = form.elements.storageId.value;
    const error = dialog.querySelector('[data-template-error]');
    if (!file || !storageId) return;
    error.textContent = 'Uploading…';
    try {
      await tRequest(`/api/templates/upload?storage=${encodeURIComponent(storageId)}&name=${encodeURIComponent(file.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      dialog.close();
      await refreshTemplateLibrary();
    } catch (problem) { error.textContent = problem.message; }
  }, { once: true });
  dialog.showModal();
}

async function openUrlDialog() {
  const library = templateState.library || await loadTemplateLibrary();
  const dialog = ensureTemplateDialog();
  dialog.querySelector('[data-template-title]').textContent = 'Import template from URL';
  dialog.querySelector('[data-template-error]').textContent = '';
  dialog.querySelector('[data-template-body]').innerHTML = `
    <form data-template-url-form>
      <p class="muted">Download an HTTP/HTTPS LXC rootfs archive directly into the selected virtual storage. Private/local URLs are intentionally blocked; upload those files instead.</p>
      <label>Storage<select name="storageId" required>${targetOptions(library.targets)}</select></label>
      <label>Template URL<input name="url" type="url" required placeholder="https://example.org/debian-template.tar.zst"></label>
      <div class="dialog-actions"><button class="primary" type="submit">Import template</button></div>
    </form>`;
  const select = dialog.querySelector('select[name="storageId"]');
  select.value = preferredTarget(library.targets);
  dialog.querySelector('[data-template-url-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = dialog.querySelector('[data-template-error]');
    error.textContent = 'Downloading…';
    try {
      await tRequest('/api/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageId: form.elements.storageId.value, url: form.elements.url.value })
      });
      dialog.close();
      await refreshTemplateLibrary();
    } catch (problem) { error.textContent = problem.message; }
  }, { once: true });
  dialog.showModal();
}

function renderCatalog(dialog, query = '') {
  const catalog = templateState.catalog || [];
  const normalized = query.trim().toLowerCase();
  const matches = catalog.filter(item => !normalized || item.filename.toLowerCase().includes(normalized)).slice(0, 80);
  const list = dialog.querySelector('[data-template-catalog-list]');
  if (!list) return;
  list.innerHTML = matches.length ? matches.map(item => `
    <article class="storage-row"><div><h3>${tEsc(item.filename)}</h3><p>Official Proxmox VE system template</p></div><button class="secondary" type="button" data-template-catalog-file="${tEsc(item.filename)}">Download</button></article>`).join('') : '<div class="empty"><p>No matching templates.</p></div>';
}

async function openCatalogDialog() {
  const library = templateState.library || await loadTemplateLibrary();
  const dialog = ensureTemplateDialog();
  dialog.querySelector('[data-template-title]').textContent = 'Proxmox system template catalog';
  dialog.querySelector('[data-template-error]').textContent = 'Loading official catalog…';
  dialog.querySelector('[data-template-body]').innerHTML = `
    <label>Save to storage<select data-template-catalog-storage>${targetOptions(library.targets)}</select></label>
    <label>Search<input data-template-catalog-search type="search" placeholder="Debian, Ubuntu, Alpine, Rocky…"></label>
    <div class="storage-list" data-template-catalog-list><div class="empty"><p>Loading catalog…</p></div></div>`;
  const select = dialog.querySelector('[data-template-catalog-storage]');
  select.value = preferredTarget(library.targets);
  dialog.showModal();
  try {
    if (!templateState.catalog) templateState.catalog = (await tRequest('/api/templates/catalog')).templates || [];
    dialog.querySelector('[data-template-error]').textContent = '';
    renderCatalog(dialog);
    dialog.querySelector('[data-template-catalog-search]').addEventListener('input', event => renderCatalog(dialog, event.target.value));
  } catch (error) {
    dialog.querySelector('[data-template-error]').textContent = error.message;
  }
}

document.addEventListener('click', async event => {
  const browse = event.target.closest('[data-template-browse]');
  if (browse) { await openCatalogDialog(); return; }

  const upload = event.target.closest('[data-template-upload]');
  if (upload) { await openUploadDialog(); return; }

  const url = event.target.closest('[data-template-url]');
  if (url) { await openUrlDialog(); return; }

  const catalogFile = event.target.closest('[data-template-catalog-file]');
  if (catalogFile) {
    const dialog = ensureTemplateDialog();
    const storageId = dialog.querySelector('[data-template-catalog-storage]')?.value;
    const error = dialog.querySelector('[data-template-error]');
    catalogFile.disabled = true;
    error.textContent = `Downloading ${catalogFile.dataset.templateCatalogFile}…`;
    try {
      await tRequest('/api/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageId, proxmoxTemplate: catalogFile.dataset.templateCatalogFile })
      });
      error.textContent = 'Template downloaded.';
      await refreshTemplateLibrary();
      catalogFile.textContent = 'Downloaded';
    } catch (problem) {
      error.textContent = problem.message;
      catalogFile.disabled = false;
    }
    return;
  }

  const remove = event.target.closest('[data-template-delete]');
  if (remove) {
    if (!confirm('Delete this stored container template? Existing containers are not affected.')) return;
    remove.disabled = true;
    try {
      await tRequest(`/api/templates?id=${encodeURIComponent(remove.dataset.templateDelete)}`, { method: 'DELETE' });
      await refreshTemplateLibrary();
    } catch (problem) {
      alert(problem.message);
      remove.disabled = false;
    }
  }
}, true);

function maybeLoadTemplates() {
  if (location.hash !== '#pools' || !document.querySelector('#container-template-library')) return;
  if (document.querySelector('#container-template-library').dataset.loaded === '1') return;
  document.querySelector('#container-template-library').dataset.loaded = '1';
  refreshTemplateLibrary();
}

new MutationObserver(maybeLoadTemplates).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('hashchange', maybeLoadTemplates);
maybeLoadTemplates();
