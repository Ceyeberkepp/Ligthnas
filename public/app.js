const state = { overview: null, view: 'home', folder: '', files: null, runtimes: null, runtimeError: null };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed.'), { status: response.status });
  return body;
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let number = value;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number >= 10 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
}

function duration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h`;
}

function relativeTime(iso) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

function showAuth(mode) {
  $('#boot').classList.add('hidden');
  $('#console').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#setup-form').classList.toggle('hidden', mode !== 'setup');
  $('#login-form').classList.toggle('hidden', mode !== 'login');
  setTimeout(() => $(`#${mode}-form input`)?.focus(), 0);
}

async function showConsole() {
  $('#boot').classList.add('hidden');
  $('#auth').classList.add('hidden');
  $('#console').classList.remove('hidden');
  state.overview = await request('/api/overview');
  const { appliance } = state.overview;
  $('#mini-name').textContent = appliance.deviceName;
  $('#avatar').textContent = appliance.username[0].toUpperCase();
  render(location.hash.slice(1) || 'home');
}

function pageHead(title, description, action = '') {
  return `<div class="page-head"><div><span class="eyebrow">LIGHTNAS CONTROL CENTER</span><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}

function metric(label, value, percent, detail) {
  return `<article class="metric"><div class="metric-head"><span>${label}</span><span>${percent}%</span></div><strong>${value}</strong><div class="track"><span style="width:${Math.min(100, percent)}%"></span></div><small>${detail}</small></article>`;
}

function homeView() {
  const { system, filesystems, storage, shares, activity, appliance } = state.overview;
  const total = filesystems.reduce((sum, item) => sum + item.totalBytes, 0);
  const used = filesystems.reduce((sum, item) => sum + item.usedBytes, 0);
  const storagePercent = total ? Math.round((used / total) * 100) : 0;
  return `${pageHead(`Good day, ${escapeHtml(appliance.username)}`, `Here’s what is happening on ${escapeHtml(appliance.deviceName)}.`)}
    <section class="hero">
      <div><span class="eyebrow">LIVE HOST INVENTORY</span><h2>Storage visible to this system</h2><p>Showing current host mounts and disks. An LXC may only expose its virtual storage.</p><div class="hero-actions"><button class="secondary" data-view-link="storage">Review storage</button></div></div>
      <div class="hero-stat"><strong>${storage.disks.length}</strong><span>visible disks</span></div>
    </section>
    <section class="metric-grid">
      ${metric('Storage', bytes(used), storagePercent, `${bytes(total - used)} available`)}
      ${metric('Memory', bytes(system.memory.usedBytes), system.memory.usedPercent, `${bytes(system.memory.totalBytes)} installed`)}
      ${metric('CPU load', `${system.cpu.loadPercent}%`, system.cpu.loadPercent, `${system.cpu.cores} logical cores`)}
      ${metric('Mounts', filesystems.length, 0, 'Readable mounted filesystems')}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><h2>Planned shares</h2><button class="panel-link" data-action="new-share">+ Save plan</button></div>${shares.length ? `<div class="share-list">${shares.slice(0, 4).map(share => `<div class="share-row"><div><h3>${escapeHtml(share.name)}</h3><p>${escapeHtml(share.protocol)} · ${escapeHtml(share.description || 'No description')} · Configuration only</p></div></div>`).join('')}</div>` : `<div class="empty"><div><h3>No share plans saved</h3><p>SMB and NFS provisioning are not available yet.</p></div></div>`}</article>
      <article class="panel"><div class="panel-head"><h2>Recent activity</h2><button class="panel-link" data-view-link="monitoring">View all</button></div><div class="activity-list">${activity.length ? activity.map(item => `<div class="activity"><span class="activity-icon">${item.type === 'setup' ? '✓' : item.type === 'share' ? '□' : '↗'}</span><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No recent activity.</p>'}</div></article>
    </section>`;
}

function storageView() {
  const { filesystems, storage } = state.overview;
  return `${pageHead('Storage', 'Read-only inventory of storage visible to this host.')}
    <h2>Disks</h2><div class="storage-list">${storage.disks.map(disk => `<article class="storage-row"><div><h3>${escapeHtml(disk.path || disk.name)}</h3><p>${escapeHtml(disk.model || 'Model unavailable')} · ${escapeHtml(disk.transport || 'Transport unknown')}</p></div><p>${disk.partitions.length} visible partitions</p><div class="storage-size">${bytes(disk.sizeBytes)}</div></article>`).join('') || '<div class="empty"><p>No physical disks are visible. Containers often cannot see host drives.</p></div>'}</div>
    <h2>ZFS pools</h2><div class="storage-list">${storage.zfs.pools.map(pool => `<article class="storage-row"><div><h3>${escapeHtml(pool.name)}</h3><p>${escapeHtml(pool.health)}</p></div><p>${bytes(pool.allocatedBytes)} allocated · ${bytes(pool.freeBytes)} free</p><div class="storage-size">${bytes(pool.sizeBytes)}</div></article>`).join('') || `<div class="empty"><p>${storage.zfs.available ? 'No ZFS pools found.' : 'ZFS tools are unavailable or inaccessible in this environment.'}</p></div>`}</div>
    <h2>ZFS datasets</h2><div class="storage-list">${storage.zfs.datasets.map(dataset => `<article class="storage-row"><div><h3>${escapeHtml(dataset.name)}</h3><p>${escapeHtml(dataset.mountPoint)} · Compression: ${escapeHtml(dataset.compression)}</p></div><p>${bytes(dataset.usedBytes)} used</p><div class="storage-size">${bytes(dataset.availableBytes)} available</div></article>`).join('') || '<div class="empty"><p>No accessible ZFS datasets.</p></div>'}</div>
    <h2>Mounted filesystems</h2><div class="storage-list">${filesystems.map(fs => `<article class="storage-row"><div><h3>${escapeHtml(fs.mountPoint)}</h3><p>${escapeHtml(fs.device)} · ${escapeHtml(fs.type)}${fs.readOnly ? ' · Read only' : ''}</p></div><div><div class="track"><span style="width:${fs.usedPercent}%"></span></div><p>${fs.usedPercent}% used</p></div><div class="storage-size"><b>${bytes(fs.usedBytes)}</b><br>of ${bytes(fs.totalBytes)}</div></article>`).join('') || '<div class="empty"><p>No readable mounted filesystems.</p></div>'}</div>`;
}

function poolsView() {
  const { zfs, disks } = state.overview.storage;
  return `${pageHead('Storage pools', 'Live ZFS pool inventory and disk visibility.')}
    <div class="module-hero"><h2>Pool creation needs direct disk access</h2><p>This LightNAS service runs without root disk privileges. Creating a ZFS pool can erase selected disks, so the pool creation workflow requires a dedicated host agent and a disk impact preview. On your current LXC, physical drives belong to the Proxmox host.</p></div>
    <h2>Existing ZFS pools</h2><div class="storage-list">${zfs.pools.map(pool => `<article class="storage-row"><div><h3>${escapeHtml(pool.name)}</h3><p>Health: ${escapeHtml(pool.health)}</p></div><p>${bytes(pool.allocatedBytes)} used · ${bytes(pool.freeBytes)} free</p><div class="storage-size">${bytes(pool.sizeBytes)}</div></article>`).join('') || `<div class="empty"><p>${zfs.available ? 'No accessible ZFS pools.' : 'ZFS commands are not available to LightNAS here.'}</p></div>`}</div>
    <p class="muted">${disks.length} disks visible to LightNAS on this host.</p>`;
}

async function loadRuntimes() {
  try { state.runtimes = await request('/api/runtimes'); state.runtimeError = null; }
  catch (error) { state.runtimeError = error.message; }
  if (['apps', 'containers', 'vms'].includes(state.view)) render(state.view);
}

function runtimeBanner(kind) {
  if (state.runtimeError) return `<div class="empty"><p>${escapeHtml(state.runtimeError)}</p><button class="secondary" data-action="refresh-runtime">Retry</button></div>`;
  if (!state.runtimes) return '<div class="empty"><p>Checking this host’s runtimes…</p></div>';
  const runtime = state.runtimes[kind];
  if (!runtime.available) return `<div class="module-hero"><h2>Runtime unavailable</h2><p>${escapeHtml(runtime.reason)}</p></div>`;
  if (!runtime.enabled) return '<div class="module-hero"><h2>Creation is disabled</h2><p>The host operator must explicitly enable this runtime and grant the LightNAS service account access. Existing resources remain visible below.</p></div>';
  return '';
}

function containersView() {
  const runtime = state.runtimes?.docker;
  const ready = runtime?.available && runtime?.enabled;
  return `${pageHead('Containers', 'Existing Docker containers visible to this host.', '<button class="secondary" data-action="refresh-runtime">Refresh</button>')}
    ${runtimeBanner('docker')}
    ${ready ? `<form id="container-form" class="panel creation-form"><h2>Create a container</h2><p class="muted">Runs on the Docker bridge with no host mounts or published ports. Use the Apps catalog for a configured web app.</p><label>Name<input name="name" required pattern="[a-z][a-z0-9-]{1,39}" placeholder="my-container"></label><label>Docker image<input name="image" required placeholder="nginx:stable-alpine"></label><label>Memory limit (MiB)<input type="number" name="memoryMiB" value="512" min="128" max="16384" required></label><button class="primary" type="submit">Create container</button><div class="form-error" role="alert"></div></form>` : ''}
    <h2>Containers</h2><div class="storage-list">${runtime?.containers?.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.image)}</p></div><p>${escapeHtml(item.status || item.state)}</p><div class="storage-size">${escapeHtml(item.ports || 'No ports')}</div></article>`).join('') || '<div class="empty"><p>No Docker containers are visible.</p></div>'}</div>`;
}

function vmsView() {
  const runtime = state.runtimes?.virtualization;
  const ready = runtime?.available && runtime?.enabled && runtime.pools.length && runtime.networks.length && runtime.images.length;
  const choices = items => items.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  return `${pageHead('Virtual machines', 'Libvirt/KVM inventory and ISO-based VM creation.', '<button class="secondary" data-action="refresh-runtime">Refresh</button>')}
    ${runtimeBanner('virtualization')}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><p>Before creating a VM, activate a libvirt storage pool and network, and place a readable ISO in /var/lib/libvirt/images on the VM host.</p></div>' : ''}
    ${ready ? `<form id="vm-form" class="panel creation-form"><h2>Create a VM</h2><p class="muted">Creates a new qcow2 disk in the selected libvirt pool and boots the installer ISO. No existing disk is formatted by LightNAS.</p><label>VM name<input name="name" required pattern="[a-zA-Z][a-zA-Z0-9-]{1,39}"></label><label>Memory (MiB)<input name="memoryMiB" type="number" min="1024" max="65536" value="2048" required></label><label>Virtual CPUs<input name="cpus" type="number" min="1" max="32" value="2" required></label><label>New disk (GiB)<input name="diskGiB" type="number" min="10" max="2048" value="20" required></label><label>Storage pool<select name="pool">${choices(runtime.pools)}</select></label><label>Network<select name="network">${choices(runtime.networks)}</select></label><label>Installer ISO<select name="iso">${choices(runtime.images)}</select></label><button class="primary" type="submit">Create VM</button><div class="form-error" role="alert"></div></form>` : ''}
    <h2>Existing VMs</h2><div class="storage-list">${runtime?.machines?.map(name => `<article class="storage-row"><h3>${escapeHtml(name)}</h3><p>Managed by libvirt on this host</p></article>`).join('') || '<div class="empty"><p>No accessible VMs.</p></div>'}</div>`;
}

function sharesView() {
  const { shares } = state.overview;
  return `${pageHead('Share plans', 'Saved configurations only. No SMB, NFS, or SFTP service is changed.', '<button class="primary" data-action="new-share">+ New plan</button>')}
    <div class="share-list">${shares.map(share => `<article class="share-row"><div><h3>${escapeHtml(share.name)}</h3><p>${escapeHtml(share.protocol)} · ${escapeHtml(share.description || 'No description')} · ${relativeTime(share.createdAt)}</p></div><button class="secondary" data-delete-share="${escapeHtml(share.id)}" data-name="${escapeHtml(share.name)}">Remove plan</button></article>`).join('') || '<div class="empty"><p>No share plans saved.</p></div>'}</div>`;
}

function filesView() {
  const segments = state.folder.split('/').filter(Boolean);
  const crumbs = [`<button class="panel-link" data-folder="">Files</button>`, ...segments.map((segment, index) => `<span> / </span><button class="panel-link" data-folder="${escapeHtml(segments.slice(0, index + 1).join('/'))}">${escapeHtml(segment)}</button>`)].join('');
  const entries = state.files;
  return `${pageHead('Files', 'Files stored in the LightNAS data directory on this host.', '<button class="secondary" data-action="refresh-files">Refresh</button>')}
    <div class="file-toolbar"><div class="breadcrumbs">${crumbs}</div><div><button class="secondary" data-action="new-folder">+ Folder</button> <label class="primary upload-button">Upload file<input id="file-upload" type="file" hidden></label></div></div>
    <p class="muted">Uploads up to 32 MB; files stay on this host. These files are not an SMB or NFS share.</p>
    <div class="storage-list">${entries === null ? '<div class="empty"><p>Loading files…</p></div>' : entries.length ? entries.map(entry => `<article class="file-row"><button class="file-name" data-open="${escapeHtml(entry.name)}" data-directory="${entry.directory}">${entry.directory ? '▣' : '▤'} ${escapeHtml(entry.name)}</button><span class="muted">${entry.directory ? 'Folder' : bytes(entry.sizeBytes)}</span><button class="secondary" data-delete-file="${escapeHtml(entry.name)}">Delete</button></article>`).join('') : '<div class="empty"><p>This folder is empty. Create a folder or upload a file.</p></div>'}</div>`;
}

async function loadFiles() {
  try {
    state.files = (await request(`/api/files?path=${encodeURIComponent(state.folder)}`)).entries.filter(entry => entry.supported);
    if (state.view === 'files') render('files');
  } catch (error) { toast(error.message); }
}

function capabilitiesView() {
  const { system } = state.overview;
  return `${pageHead('System capabilities', 'Hardware eligibility estimates; these services may still need installation.')}
    <div class="capability-list">${system.capabilities.map(item => `<article class="capability-row"><div><b>${escapeHtml(item.name)}</b><p>${escapeHtml(item.available ? `Hardware requirement met · ${item.minimum}` : item.reason)}</p></div><span class="badge ${item.available ? 'available' : 'gated'}">${item.available ? 'ELIGIBLE' : 'HARDWARE GATED'}</span></article>`).join('')}</div>`;
}

function settingsView() {
  const { appliance } = state.overview;
  const zones = [['America/New_York', 'Eastern Time'], ['America/Chicago', 'Central Time'], ['America/Denver', 'Mountain Time'], ['America/Los_Angeles', 'Pacific Time'], ['UTC', 'UTC']];
  return `${pageHead('Appliance settings', 'Update your LightNAS administrator account and display name.')}
    <form id="settings-form" class="panel settings-form">
      <h2>Administrator</h2><p class="muted">Signed in as ${escapeHtml(appliance.username)}. These settings apply to LightNAS only, not the Linux root account.</p>
      <label>Device name<input name="deviceName" value="${escapeHtml(appliance.deviceName)}" required minlength="2" maxlength="32" autocomplete="off"></label>
      <label>Display time zone<select name="timezone">${zones.map(([value, label]) => `<option value="${value}" ${appliance.timezone === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label>
      <label>New password (optional)<input name="newPassword" type="password" minlength="10" autocomplete="new-password" placeholder="Leave blank to keep current password"></label>
      <button class="primary" type="submit">Save settings</button>
      <div class="form-error" role="alert"></div>
    </form>`;
}

function moduleView(view) {
  if (view === 'apps') {
    const docker = state.runtimes?.docker;
    return `${pageHead('App Store', 'Built-in starter recipes for Docker hosts.', '<button class="secondary" data-action="refresh-runtime">Refresh</button>')}
      ${runtimeBanner('docker')}
      <div class="tool-grid">${state.runtimes?.catalog?.map(app => {
        const installed = docker.containers.some(container => container.name === `lightnas-app-${app.id}`);
        return `<article class="panel"><h2>${escapeHtml(app.name)}</h2><p class="muted">${escapeHtml(app.description)}</p><p class="muted">${escapeHtml(app.image)} · Port ${app.port}</p><button class="primary" data-install="${app.id}" ${!docker.available || !docker.enabled || installed ? 'disabled' : ''}>${installed ? 'Installed' : 'Install'}</button></article>`;
      }).join('') || '<div class="empty"><p>Loading catalog…</p></div>'}</div>
      <section class="module-hero"><h2>Other app catalogs</h2><p>TrueNAS custom apps built from compatible OCI images can be adapted as LightNAS recipes. Proxmox Helper Scripts target the Proxmox host and cannot be executed inside this NAS LXC. Direct store sync and Compose import are still being built.</p><p><a href="https://apps.truenas.com/" target="_blank" rel="noopener noreferrer">Browse TrueNAS apps</a> · <a href="https://community-scripts.github.io/ProxmoxVE/" target="_blank" rel="noopener noreferrer">Browse Proxmox Helper Scripts</a></p></section>`;
  }
  return `${pageHead('Monitoring', 'Current readings from this host.', '<button class="secondary" data-action="refresh">Refresh readings</button>')}<section class="metric-grid">${metric('CPU load', `${state.overview.system.cpu.loadPercent}%`, state.overview.system.cpu.loadPercent, state.overview.system.cpu.model)}${metric('Memory', bytes(state.overview.system.memory.usedBytes), state.overview.system.memory.usedPercent, `${bytes(state.overview.system.memory.freeBytes)} free`)}${metric('Uptime', duration(state.overview.system.uptimeSeconds), 0, state.overview.system.kernel)}${metric('Mounts', state.overview.filesystems.length, 0, 'Currently visible')}</section><h2>Activity</h2><div class="activity-list">${state.overview.activity.map(item => `<div class="activity"><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') || '<p>No activity recorded.</p>'}</div>`;
}

function render(view) {
  state.view = ['home', 'storage', 'pools', 'files', 'shares', 'capabilities', 'apps', 'containers', 'vms', 'monitoring', 'settings'].includes(view) ? view : 'home';
  const content = $('#content');
  content.innerHTML = state.view === 'home' ? homeView() : state.view === 'storage' ? storageView() : state.view === 'pools' ? poolsView() : state.view === 'files' ? filesView() : state.view === 'shares' ? sharesView() : state.view === 'containers' ? containersView() : state.view === 'vms' ? vmsView() : state.view === 'settings' ? settingsView() : state.view === 'capabilities' ? capabilitiesView() : moduleView(state.view);
  $$('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === state.view));
  content.focus({ preventScroll: true });
  bindViewActions();
  if (state.view === 'files' && state.files === null) loadFiles();
  if (['apps', 'containers', 'vms'].includes(state.view) && !state.runtimes && !state.runtimeError) loadRuntimes();
}

function bindViewActions() {
  $$('[data-action="refresh-runtime"]', $('#content')).forEach(button => button.addEventListener('click', loadRuntimes));
  $$('[data-install]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    if (!confirm(`Install ${button.dataset.install} as a Docker container? It will publish a web port on this NAS.`)) return;
    button.disabled = true;
    button.textContent = 'Installing…';
    try { await request(`/api/catalog/${button.dataset.install}/install`, { method: 'POST' }); await loadRuntimes(); toast('App installed.'); }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Install'; }
  }));
  for (const [selector, path, message] of [['#container-form', '/api/containers', 'Container created.'], ['#vm-form', '/api/vms', 'VM installer started.']]) {
    $(selector, $('#content'))?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('button[type="submit"]', form);
      const error = $('.form-error', form);
      error.textContent = '';
      button.disabled = true;
      try { await request(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); await loadRuntimes(); toast(message); }
      catch (problem) { error.textContent = problem.message; }
      finally { button.disabled = false; }
    });
  }
  $('#settings-form', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    const error = $('.form-error', form);
    error.textContent = '';
    button.disabled = true;
    try {
      const input = Object.fromEntries(new FormData(form));
      const result = await request('/api/settings', { method: 'PATCH', body: JSON.stringify(input) });
      form.reset();
      if (result.signInRequired) { showAuth('login'); toast('Password changed. Sign in with the new password.'); }
      else { state.overview = await request('/api/overview'); $('#mini-name').textContent = state.overview.appliance.deviceName; render('settings'); toast('Settings saved.'); }
    } catch (problem) { error.textContent = problem.message; }
    finally { button.disabled = false; }
  });
  $$('[data-action="new-share"]', $('#content')).forEach(button => button.addEventListener('click', () => $('#share-dialog').showModal()));
  $$('[data-view-link]', $('#content')).forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.viewLink; }));
  $$('[data-action="refresh"]', $('#content')).forEach(button => button.addEventListener('click', async () => { try { state.overview = await request('/api/overview'); render(state.view); toast('Readings updated.'); } catch (error) { toast(error.message); } }));
  $$('[data-action="refresh-files"]', $('#content')).forEach(button => button.addEventListener('click', loadFiles));
  $$('[data-folder]', $('#content')).forEach(button => button.addEventListener('click', () => { state.folder = button.dataset.folder; state.files = null; render('files'); }));
  $$('[data-open]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const path = [state.folder, button.dataset.open].filter(Boolean).join('/');
    if (button.dataset.directory === 'true') { state.folder = path; state.files = null; render('files'); return; }
    try { const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`); if (!response.ok) throw new Error((await response.json()).error); const object = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = object; link.download = button.dataset.open; link.click(); setTimeout(() => URL.revokeObjectURL(object), 60000); } catch (error) { toast(error.message); }
  }));
  $$('[data-action="new-folder"]', $('#content')).forEach(button => button.addEventListener('click', async () => { const name = prompt('New folder name'); if (name === null) return; try { await request(`/api/files?path=${encodeURIComponent([state.folder, name].filter(Boolean).join('/'))}`, { method: 'POST' }); await loadFiles(); toast('Folder created.'); } catch (error) { toast(error.message); } }));
  $('#file-upload', content)?.addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { const response = await fetch(`/api/files?path=${encodeURIComponent([state.folder, file.name].filter(Boolean).join('/'))}`, { method: 'PUT', body: file }); if (!response.ok) throw new Error((await response.json()).error); await loadFiles(); toast('File uploaded.'); } catch (error) { toast(error.message); } });
  $$('[data-delete-file]', content).forEach(button => button.addEventListener('click', async () => { if (!confirm(`Delete ${button.dataset.deleteFile}? Folders must be empty.`)) return; try { await request(`/api/files?path=${encodeURIComponent([state.folder, button.dataset.deleteFile].filter(Boolean).join('/'))}`, { method: 'DELETE' }); await loadFiles(); toast('Deleted.'); } catch (error) { toast(error.message); } }));
  $$('[data-delete-share]', content).forEach(button => button.addEventListener('click', async () => { if (!confirm(`Remove share plan ${button.dataset.name}?`)) return; try { await request(`/api/shares/${button.dataset.deleteShare}`, { method: 'DELETE' }); state.overview = await request('/api/overview'); render(state.view); toast('Plan removed.'); } catch (error) { toast(error.message); } }));
}

async function submitAuth(form, path) {
  const error = $('.form-error', form);
  const button = $('button[type="submit"]', form);
  error.textContent = '';
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    await request(path, { method: 'POST', body: JSON.stringify(data) });
    await showConsole();
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

$('#setup-form').addEventListener('submit', event => { event.preventDefault(); submitAuth(event.currentTarget, '/api/setup'); });
$('#login-form').addEventListener('submit', event => { event.preventDefault(); submitAuth(event.currentTarget, '/api/login'); });
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); showAuth('login'); });
$('#menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#mobile-more').addEventListener('click', () => $('.sidebar').classList.add('open'));
$$('[data-view]').forEach(link => link.addEventListener('click', () => $('.sidebar').classList.remove('open')));
$$('.close-dialog').forEach(button => button.addEventListener('click', () => $('#share-dialog').close()));
$('#share-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('.form-error', form);
  error.textContent = '';
  try {
    await request('/api/shares', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    $('#share-dialog').close();
    form.reset();
    state.overview = await request('/api/overview');
    render(state.view);
    toast('Share plan saved. No file service was changed.');
  } catch (problem) { error.textContent = problem.message; }
});

window.addEventListener('hashchange', () => render(location.hash.slice(1) || 'home'));

async function boot() {
  try {
    const status = await request('/api/status');
    if (status.setupRequired) return showAuth('setup');
    try { await showConsole(); } catch (error) { if (error.status === 401) showAuth('login'); else throw error; }
  } catch (error) {
    $('#boot').innerHTML = `<p>Unable to start the control center.</p><small>${escapeHtml(error.message)}</small>`;
  }
}

boot();
