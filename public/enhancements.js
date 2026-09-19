const previewExtensions = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi']),
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
  const path = joinPath(currentFolder(), name);
  const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`);
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
  if (kind === 'image') { viewer = document.createElement('img'); viewer.src = objectUrl; viewer.alt = name; }
  else if (kind === 'video') { viewer = document.createElement('video'); viewer.src = objectUrl; viewer.controls = true; viewer.autoplay = true; }
  else if (kind === 'audio') { viewer = document.createElement('audio'); viewer.src = objectUrl; viewer.controls = true; viewer.autoplay = true; }
  else if (kind === 'pdf') { viewer = document.createElement('iframe'); viewer.src = objectUrl; viewer.title = name; }
  else { viewer = document.createElement('pre'); viewer.textContent = await blob.text(); }
  stage.append(viewer);
  dialog.querySelector('[data-viewer-download]').onclick = () => {
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = name; anchor.click();
  };
  dialog.showModal();
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
    if (location.hash === '#containers') {
      const runtime = runtimes.containers || {};
      for (const item of runtime.containers || []) {
        const id = String(item.id || item.name || '');
        const row = [...content.querySelectorAll('.storage-row')].find(candidate => candidate.querySelector('h3')?.textContent === item.name);
        if (!row || row.querySelector('.runtime-actions')) continue;
        const actions = document.createElement('div');
        actions.className = 'runtime-actions';
        const running = String(item.status || '').toLowerCase() === 'running';
        const memoryMiB = Math.max(256, Math.round((item.memory || 0) / 1048576) || 2048);
        actions.innerHTML = `${running ? `<button class="primary" data-container-console="${escapeHtml(id)}" data-container-name="${escapeHtml(item.name)}">Terminal</button><button class="secondary" data-container-action="shutdown" data-container-id="${escapeHtml(id)}">Shutdown</button><button class="secondary" data-container-action="reboot" data-container-id="${escapeHtml(id)}">Reboot</button><button class="secondary" data-container-action="stop" data-container-id="${escapeHtml(id)}">Stop</button>` : `<button class="primary" data-container-action="start" data-container-id="${escapeHtml(id)}">Start</button>`}
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
  if (location.hash !== '#files') return;
  const folder = currentFolder();
  for (const button of [...document.querySelectorAll('#content .file-name[data-directory="false"]')]) {
    if (button.querySelector('.file-thumb')) continue;
    const name = button.dataset.open || '';
    const kind = previewKind(name);
    if (!['image', 'video'].includes(kind)) continue;
    const path = joinPath(folder, name);
    const media = document.createElement(kind === 'image' ? 'img' : 'video');
    media.className = 'file-thumb';
    media.loading = 'lazy';
    media.src = `/api/files/download?path=${encodeURIComponent(path)}${kind === 'video' ? '#t=0.15' : ''}`;
    if (kind === 'video') { media.muted = true; media.preload = 'metadata'; media.playsInline = true; }
    button.prepend(media);
  }
}

function permissionsMarkup(options, selected = []) {
  return `<fieldset class="policy-grid"><legend>Permissions</legend>${options.map(permission => {
    const [label, description] = permissionLabels[permission] || [permission, permission];
    return `<label class="policy-option"><input type="checkbox" value="${escapeHtml(permission)}" ${selected.includes(permission) ? 'checked' : ''}><span><b>${escapeHtml(label)}</b><small>${escapeHtml(description)}</small></span></label>`;
  }).join('')}</fieldset>`;
}

async function enhancePolicies() {
  if (location.hash !== '#users') return;
  const content = document.querySelector('#content');
  if (!content || content.dataset.policiesLoaded === '1') return;
  try {
    const result = await apiRequest('/api/users');
    content.dataset.policiesLoaded = '1';
    const options = result.permissionOptions || Object.keys(permissionLabels);
    for (const user of result.users || []) {
      const form = content.querySelector(`form[data-manage-user="${CSS.escape(user.username)}"]`);
      if (!form || form.querySelector('.policy-grid')) continue;
      form.insertAdjacentHTML('beforeend', `${permissionsMarkup(options, user.permissions || [])}<button class="primary save-policy" type="button" data-save-policy="${escapeHtml(user.username)}">Save permissions</button>`);
    }
    const create = content.querySelector('#user-form');
    if (create && !create.querySelector('.policy-grid')) create.querySelector('button[type="submit"]')?.insertAdjacentHTML('beforebegin', permissionsMarkup(options, ['files.read', 'files.write']));
  } catch {}
}

function enhanceAdminCenter() {
  if (location.hash !== '#admin') return;
  const content = document.querySelector('#content');
  if (!content || content.querySelector('.admin-tool-groups')) return;
  const groups = [
    ['Identity & access', [['users','Users & policies'],['settings','Appliance settings'],['integrations','Identity integrations']]],
    ['Storage & data', [['storage','Unified storage'],['pools','Pools & datasets'],['files','File manager'],['shares','Shares']]],
    ['Compute & apps', [['apps','App Store'],['containers','Containers'],['vms','Virtual machines']]],
    ['Network & security', [['network','Networking'],['firewall','Firewall'],['smtp','Email / SMTP']]],
    ['System operations', [['monitoring','Monitoring'],['capabilities','Capabilities'],['home','Overview']]]
  ];
  const section = document.createElement('section');
  section.className = 'admin-tool-groups';
  section.innerHTML = groups.map(([title, tools]) => `<div class="admin-group"><h2>${title}</h2><div class="admin-group-grid">${tools.map(([view,label]) => `<button class="admin-tool-card" type="button" data-admin-view="${view}"><b>${label}</b><span>Open ${label.toLowerCase()}</span></button>`).join('')}</div></div>`).join('');
  content.querySelector('.page-head')?.insertAdjacentElement('afterend', section);
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
    try { await openPreview(fileButton.dataset.open); } catch (problem) { alert(problem.message); }
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
    window.open(`/container-console.html?id=${encodeURIComponent(consoleButton.dataset.containerConsole)}&name=${encodeURIComponent(consoleButton.dataset.containerName || '')}`, '_blank', 'noopener,width=1100,height=760');
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
    window.open(`/vm-console.html?id=${encodeURIComponent(vmConsole.dataset.vmConsole)}&name=${encodeURIComponent(vmConsole.dataset.vmName || '')}`, '_blank', 'noopener,width=1280,height=820');
    return;
  }
  const vmEdit = event.target.closest('[data-vm-edit]');
  if (vmEdit) {
    const id = vmEdit.dataset.vmEdit;
    const name = prompt('VM name', vmEdit.dataset.vmName || id);
    if (!name) return;
    const memoryMiB = Number(prompt('Memory (MiB)', vmEdit.dataset.vmMemory || '2048'));
    const cpus = Number(prompt('Virtual CPUs', vmEdit.dataset.vmCpus || '2'));
    if (!Number.isInteger(memoryMiB) || !Number.isInteger(cpus)) return;
    try {
      await apiRequest('/api/vms', { method: 'POST', body: JSON.stringify({ id, action: 'update', name, memoryMiB, cpus }) });
      document.querySelector('#content [data-action="refresh-runtime"]')?.click();
    } catch (error) { alert(error.message); }
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
