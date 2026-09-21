const templateState = { library: null, catalog: null, selectedCatalogId: null };

function tEsc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]);
}

function tBytes(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const units = ['B','KiB','MiB','GiB','TiB','PiB'];
  let n = Number(value), u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  const decimals = u >= 4 ? 2 : n >= 100 ? 0 : n >= 10 ? 1 : u === 0 ? 0 : 2;
  const rendered = n.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0+$/g, '');
  return `${rendered} ${units[u]}`;
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
          <button class="primary" type="button" data-template-browse>Browse upstream templates</button>
          <button class="secondary" type="button" data-template-upload>Upload template</button>
          <button class="secondary" type="button" data-template-url>Import URL</button>
        </div>
      </div>
      <p class="muted">LightNAS reads the upstream appliance metadata feeds used by Proxmox pveam and downloads the selected archive from its published source. Templates are stored on the LightNAS storage you choose and become selectable for native LXC creation.</p>
      <div class="inventory-grid">
        <article class="inventory-card"><h3>${templates.length}</h3><p>templates stored locally</p></article>
        <article class="inventory-card"><h3>${virtualTargets.length}</h3><p>assigned virtual storage target${virtualTargets.length === 1 ? '' : 's'}</p></article>
        <article class="inventory-card"><h3>vztmpl</h3><p>container-template content role</p></article>
      </div>
      ${templates.length ? `<div class="storage-list">${templates.map(item => `<article class="storage-row"><div><h3>${tEsc(item.filename)}</h3><p>${tEsc(item.storageLabel)} · ${tBytes(item.sizeBytes)}</p></div><div class="runtime-actions"><button class="secondary danger-button" type="button" data-template-delete="${tEsc(item.id)}">Delete</button></div></article>`).join('')}</div>` : '<div class="empty"><p>No saved container templates yet.</p></div>'}
      <p class="muted">Primary metadata source: ${tEsc(proxmoxSource || 'https://download.proxmox.com/images/aplinfo-pve-9.dat')}</p>
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

async function openUploadDialog(preferredStorageId = '') {
  const library = templateState.library || await loadTemplateLibrary();
  const dialog = ensureTemplateDialog();
  document.querySelector('#lightnas-storage-dialog')?.close();
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
  select.value = preferredStorageId || preferredTarget(library.targets);
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

async function openUrlDialog(preferredStorageId = '') {
  const library = templateState.library || await loadTemplateLibrary();
  const dialog = ensureTemplateDialog();
  document.querySelector('#lightnas-storage-dialog')?.close();
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
  select.value = preferredStorageId || preferredTarget(library.targets);
  dialog.querySelector('[data-template-url-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = dialog.querySelector('[data-template-error]');
    error.textContent = 'Downloading…';
    const progress = window.LightNASProgress?.open('Downloading container image', form.elements.url.value);
    try {
      await tRequest('/api/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageId: form.elements.storageId.value, url: form.elements.url.value })
      });
      dialog.close();
      await refreshTemplateLibrary();
      progress?.succeed('The container image downloaded successfully and is ready in the template library.');
    } catch (problem) {
      error.textContent = problem.message;
      progress?.fail(problem.message);
    }
  }, { once: true });
  dialog.showModal();
}

function renderCatalog(dialog, query = '') {
  const catalog = templateState.catalog || [];
  const normalized = query.trim().toLowerCase();
  const matches = catalog.filter(item => {
    if (!normalized) return true;
    return [item.filename, item.package, item.version, item.description, item.section, item.source]
      .some(value => String(value || '').toLowerCase().includes(normalized));
  }).slice(0, 200);
  const list = dialog.querySelector('[data-template-catalog-list]');
  if (!list) return;
  if (!matches.length) {
    list.innerHTML = '<div class="empty"><p>No matching templates.</p></div>';
    return;
  }
  const sections = [...new Set(matches.map(item => item.section || 'system'))];
  list.innerHTML = `<div class="template-table">
    <div class="template-table-head"><span>Type</span><span>Package</span><span>Version</span><span>Description</span><span>Action</span></div>
    ${sections.map(section => {
      const rows = matches.filter(item => (item.section || 'system') === section);
      return `<div class="template-section-row"><b>Section: ${tEsc(section)}</b><span>${rows.length} item${rows.length === 1 ? '' : 's'}</span></div>
        ${rows.map(item => {
          const id = item.id || item.filename;
          const selected = templateState.selectedCatalogId === id;
          return `<div class="template-table-row ${selected ? 'selected' : ''}" role="button" tabindex="0" data-template-catalog-select="${tEsc(id)}">
            <span>${tEsc(item.type || 'lxc')}</span>
            <span><b>${tEsc(item.package || item.filename)}</b><small>${tEsc(item.source || '')}</small></span>
            <span>${tEsc(item.version || '')}</span>
            <span>${tEsc(item.description || item.filename)}</span>
            <span><button class="secondary" type="button" data-template-catalog-file="${tEsc(id)}">Download</button></span>
          </div>`;
        }).join('')}`;
    }).join('')}
  </div>`;
  const selectedButton = dialog.querySelector('[data-template-download-selected]');
  if (selectedButton) selectedButton.disabled = !templateState.selectedCatalogId;
}

async function openCatalogDialog(preferredStorageId = '') {
  const library = templateState.library || await loadTemplateLibrary();
  const dialog = ensureTemplateDialog();
  dialog.querySelector('[data-template-title]').textContent = 'Upstream system template catalog';
  dialog.querySelector('[data-template-error]').textContent = 'Loading official catalog…';
  document.querySelector('#lightnas-storage-dialog')?.close();
  templateState.selectedCatalogId = null;
  dialog.querySelector('[data-template-body]').innerHTML = `
    <div class="template-catalog-toolbar">
      <label>Save to storage<select data-template-catalog-storage>${targetOptions(library.targets)}</select></label>
      <label>Search<input data-template-catalog-search type="search" placeholder="Debian, Ubuntu, Alpine, Rocky…"></label>
    </div>
    <p class="muted">Click a template row to select it, then choose Download selected. You can also use the Download button on any row.</p>
    <div class="storage-list template-catalog-scroll" data-template-catalog-list><div class="empty"><p>Loading catalog…</p></div></div>
    <div class="dialog-actions template-catalog-actions">
      <button class="secondary" type="button" data-template-upload data-template-storage="${tEsc(preferredStorageId)}">Upload template file</button>
      <button class="secondary" type="button" data-template-url data-template-storage="${tEsc(preferredStorageId)}">Import URL</button>
      <button class="primary" type="button" data-template-download-selected disabled>Download selected</button>
    </div>`;
  const select = dialog.querySelector('[data-template-catalog-storage]');
  const desired = preferredStorageId || preferredTarget(library.targets);
  if ([...select.options].some(option => option.value === desired && !option.disabled)) select.value = desired;
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
  if (browse) { await openCatalogDialog(browse.dataset.templateStorage || ''); return; }

  const upload = event.target.closest('[data-template-upload]');
  if (upload) { await openUploadDialog(upload.dataset.templateStorage || ''); return; }

  const url = event.target.closest('[data-template-url]');
  if (url) { await openUrlDialog(url.dataset.templateStorage || ''); return; }

  const selectedRow = event.target.closest('[data-template-catalog-select]');
  if (selectedRow && !event.target.closest('button')) {
    templateState.selectedCatalogId = selectedRow.dataset.templateCatalogSelect;
    renderCatalog(ensureTemplateDialog(), ensureTemplateDialog().querySelector('[data-template-catalog-search]')?.value || '');
    return;
  }

  const selectedDownload = event.target.closest('[data-template-download-selected]');
  if (selectedDownload) {
    const id = templateState.selectedCatalogId;
    if (!id) return;
    selectedDownload.setAttribute('data-template-catalog-file', id);
  }

  const catalogFile = event.target.closest('[data-template-catalog-file]') || selectedDownload;
  if (catalogFile) {
    const dialog = ensureTemplateDialog();
    const storageId = dialog.querySelector('[data-template-catalog-storage]')?.value;
    const error = dialog.querySelector('[data-template-error]');
    catalogFile.disabled = true;
    error.textContent = 'Downloading selected upstream template…';
    const selected = templateState.catalog?.find(item => (item.id || item.filename) === catalogFile.dataset.templateCatalogFile);
    const progress = window.LightNASProgress?.open('Downloading container image', selected?.filename || selected?.package || 'Selected system template');
    try {
      await tRequest('/api/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageId, proxmoxTemplate: catalogFile.dataset.templateCatalogFile })
      });
      error.textContent = 'Template downloaded.';
      await refreshTemplateLibrary();
      catalogFile.textContent = 'Downloaded';
      progress?.succeed(`${selected?.package || selected?.filename || 'The container image'} downloaded successfully and is ready to use.`);
    } catch (problem) {
      error.textContent = problem.message;
      catalogFile.disabled = false;
      progress?.fail(problem.message);
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
