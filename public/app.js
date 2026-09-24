const state = { overview: null, view: 'home', folder: '', files: null, fileError: null, fileLayout: localStorage.getItem('lightnas-file-layout') === 'grid' ? 'grid' : 'list', runtimes: null, runtimeError: null, containerError: null, spaces: null, users: null, groups: null, smtp: undefined, media: null, network: null };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const themeChoices = ['system', 'light', 'dark'];
let theme = themeChoices.includes(localStorage.getItem('lightnas-theme')) ? localStorage.getItem('lightnas-theme') : 'system';
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
  const button = $('#theme-toggle');
  if (button) { button.title = `Appearance: ${theme}. Click to change.`; button.setAttribute('aria-label', `Appearance: ${theme}. Click to change.`); button.textContent = theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'; }
}
systemTheme.addEventListener('change', applyTheme);
applyTheme();

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed.'), { status: response.status });
  return body;
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

function canView(view, appliance = state.overview?.appliance) {
  if (!appliance) return false;
  if (appliance.role === 'administrator') return true;
  const allowed = new Set(appliance.permissions || []);
  const required = {
    home: ['overview.view'], files: ['files.read'], media: ['files.read'], storage: ['storage.view'], pools: ['pools.view', 'storage.manage'], shares: ['shares.view', 'shares.manage'],
    apps: ['apps.view', 'apps.manage'], containers: ['containers.view', 'containers.manage', 'containers.console'], vms: ['vms.view', 'vms.manage', 'vms.console'],
    network: ['network.view'], firewall: ['firewall.view', 'firewall.manage', 'network.manage'], monitoring: ['monitoring.view', 'system.view'], capabilities: ['capabilities.view', 'system.view'],
    integrations: ['integrations.view', 'integrations.manage'], users: ['users.manage'], smtp: ['smtp.manage'], settings: ['settings.manage'], admin: ['admin.view']
  }[view];
  return Array.isArray(required) && (!required.length || required.some(permission => allowed.has(permission)));
}

async function showConsole() {
  $('#boot').classList.add('hidden');
  $('#auth').classList.add('hidden');
  $('#console').classList.remove('hidden');
  state.overview = await request('/api/overview');
  const { appliance } = state.overview;
  $('#mini-name').textContent = appliance.deviceName;
  $('#avatar-initial').textContent = appliance.username[0].toUpperCase();
  $('#avatar').classList.toggle('has-photo', Boolean(appliance.hasAvatar));
  $('#avatar').style.backgroundImage = appliance.hasAvatar ? `url(/api/profile/avatar?v=${Date.now()})` : '';
  $('#node-shell-button').classList.toggle('hidden', appliance.role !== 'administrator' && !(appliance.permissions || []).includes('system.shell'));
  $$('[data-view]').forEach(link => link.classList.toggle('hidden', !canView(link.dataset.view, appliance)));
  $$('.nav-group').forEach(group => group.classList.toggle('hidden', !group.querySelector('[data-view]:not(.hidden)')));
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
  const visibleStorage = storage.usableStorage || storage.virtualStorage || storage.local || { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0, count: 0 };
  const total = visibleStorage.totalBytes || 0;
  const used = visibleStorage.usedBytes || 0;
  const available = visibleStorage.availableBytes ?? Math.max(0, total - used);
  const storagePercent = visibleStorage.usedPercent ?? (total ? Math.round((used / total) * 100) : 0);
  return `${pageHead(`Good day, ${escapeHtml(appliance.username)}`, `Here’s what is happening on ${escapeHtml(appliance.deviceName)}.`)}
    <section class="hero">
      <div><span class="eyebrow">LIVE HOST INVENTORY</span><h2>Storage visible to this system</h2><p>Showing current host mounts and disks. An LXC may only expose its virtual storage.</p><div class="hero-actions"><button class="secondary" data-view-link="storage">Review storage</button></div></div>
      <div class="hero-stat"><strong>${total ? bytes(total) : '—'}</strong><span>total usable storage · ${bytes(available)} free</span></div>
    </section>
    <section class="metric-grid">
      ${metric('Storage', bytes(used), storagePercent, `${bytes(available)} available of ${bytes(total)}`)}
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
  const { filesystems } = state.overview;
  return `${pageHead('Storage', 'LightNAS storage pools, capacity and content libraries.', '<button class="primary" data-view-link="pools">Manage storage</button>')}
    <div id="storage-manager"></div>
    <h2>LightNAS storage spaces</h2>
    <div class="storage-list">${state.spaces?.map(space => `<article class="storage-row"><div><h3>${escapeHtml(space.label)}</h3><p>Spaces/${escapeHtml(space.name)}</p></div><button class="secondary" data-open-space="${escapeHtml(space.name)}">Open</button></article>`).join('') || '<div class="empty"><p>No file spaces yet.</p></div>'}</div>
    <details class="panel"><summary><b>Advanced mounted filesystems</b></summary>
      <div class="storage-list">${filesystems.map(fs => `<article class="storage-row"><div><h3>${escapeHtml(fs.mountPoint)}</h3><p>${escapeHtml(fs.device)} · ${escapeHtml(fs.type)}${fs.readOnly ? ' · Read only' : ''}</p></div><div><div class="track"><span style="width:${fs.usedPercent}%"></span></div><p>${fs.usedPercent}% used</p></div><div class="storage-size"><b>${bytes(fs.usedBytes)}</b><br>of ${bytes(fs.totalBytes)}</div></article>`).join('') || '<div class="empty"><p>No readable mounted filesystems.</p></div>'}</div>
    </details>`;
}

function poolsView() {
  return `${pageHead('Storage pools', 'Create and manage LightNAS storage from local space and attached virtual volumes.')}
    <div id="storage-manager"></div>
    <div id="container-template-library"></div>
    <h2>Storage spaces</h2>
    <p class="muted">Storage spaces are folders managed by LightNAS. VM ISO images, container templates, VM disks and backups are managed inside the storage pools above.</p>
    <form id="space-form" class="panel creation-form">
      <label>Folder name<input name="name" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}" required placeholder="archive"></label>
      <label>Display label<input name="label" maxlength="80" required placeholder="Team archive"></label>
      <button class="primary" type="submit">Create storage space</button><div class="form-error" role="alert"></div>
    </form>
    <div class="storage-list">${state.spaces?.map(space => `<article class="storage-row"><div><h3>${escapeHtml(space.label)}</h3><p>Spaces/${escapeHtml(space.name)}</p></div><button class="secondary" data-edit-space="${escapeHtml(space.name)}">Edit label</button><button class="secondary" data-open-space="${escapeHtml(space.name)}">Open files</button></article>`).join('') || '<div class="empty"><p>No storage spaces created yet.</p></div>'}</div>`;
}

async function loadSpaces() {
  try { state.spaces = (await request('/api/spaces')).spaces; if (['pools', 'storage'].includes(state.view)) render(state.view); } catch (error) { toast(error.message); }
}

async function loadUsers() {
  try { const data = await request('/api/users'); state.users = data.users; state.groups = data.groups || []; if (state.view === 'users') render(state.view); } catch (error) { toast(error.message); }
}

function usersView() {
  const groupChoices = state.groups?.map(group => `<label><input type="checkbox" name="groups" value="${escapeHtml(group.id)}"> <span><b>${escapeHtml(group.name)}</b><small>${escapeHtml(group.description || 'Group policy')}</small></span></label>`).join('') || '<p class="muted">Create a group below, then assign users to it.</p>';
  return `${pageHead('Users & groups', 'Create local accounts and assign all access through reusable group policies.')}
    <section class="identity-summary"><article class="panel identity-stat"><span class="identity-icon">A</span><div><b>${escapeHtml(state.overview.appliance.username)}</b><small>Appliance owner · full access</small></div></article><article class="panel identity-stat"><strong>${state.users?.length || 0}</strong><div><b>Local users</b><small>${state.groups?.length || 0} permission groups</small></div></article></section>
    <div id="groups-admin-mount"><div class="panel groups-loading">Loading group policies…</div></div>
    <section class="identity-layout">
      <form id="user-form" class="panel user-create-card"><span class="eyebrow">NEW ACCOUNT</span><h2>Create local user</h2><p class="muted">Users receive access from the groups selected here. Permissions are edited on the group, not on individual accounts.</p><div class="identity-form-grid"><label>Username<input name="username" pattern="[a-zA-Z0-9._-]{3,32}" required></label><label>Password<input name="password" type="password" minlength="10" autocomplete="new-password" required></label></div><fieldset class="group-choice-list"><legend>Group membership</legend>${groupChoices}</fieldset><button class="primary" type="submit">Create user</button><div class="form-error" role="alert"></div></form>
      <section class="user-directory"><div class="section-heading"><div><span class="eyebrow">LOCAL ACCOUNTS</span><h2>Users</h2></div><span class="content-badge">${state.users?.length || 0}</span></div><div class="user-card-list">${state.users?.map(user => `<article class="panel user-card"><div class="user-card-head"><span class="user-avatar">${escapeHtml(user.username[0].toUpperCase())}</span><div><h3>${escapeHtml(user.username)}</h3><p>${user.disabled ? 'Disabled' : 'Active'} · ${(user.groups || []).map(group => escapeHtml(group.name)).join(', ') || 'No group'}</p></div><span class="volume-state ${user.disabled ? 'readonly' : 'writable'}">${user.disabled ? 'DISABLED' : 'ACTIVE'}</span></div><details class="user-manager"><summary>Manage account & groups</summary><form data-manage-user="${escapeHtml(user.username)}"><label>Current account password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New user password<input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="At least 10 characters"></label><div class="head-actions"><button class="secondary" type="submit" value="password">Reset password</button><button class="secondary" type="submit" value="${user.disabled ? 'enable' : 'disable'}">${user.disabled ? 'Enable' : 'Disable'}</button><button class="secondary danger-button" type="button" data-remove-user="${escapeHtml(user.username)}">Remove</button></div><div class="form-error" role="alert"></div></form></details></article>`).join('') || '<div class="empty"><p>No local users yet.</p></div>'}</div></section>
    </section>`;
}

async function loadSmtp() {
  try { state.smtp = (await request('/api/smtp')).config; if (state.view === 'smtp') render('smtp'); } catch (error) { toast(error.message); }
}

function smtpView() {
  const smtp = state.smtp;
  return `${pageHead('Email / SMTP', 'Connect an encrypted SMTP relay for appliance notifications.')}
    <form id="smtp-form" class="panel creation-form"><h2>Outgoing mail</h2><p class="muted">TLS certificates are checked. Passwords remain on the NAS in its owner-only state file and are never returned to the browser.</p>
    <label>Server hostname<input name="host" required value="${escapeHtml(smtp?.host || '')}" placeholder="mail.example.com"></label>
    <label>Port<input name="port" type="number" min="1" max="65535" value="${smtp?.port || 587}" required></label>
    <label>Encryption<select name="security"><option value="starttls" ${smtp?.security === 'starttls' ? 'selected' : ''}>STARTTLS (often 587)</option><option value="tls" ${smtp?.security === 'tls' ? 'selected' : ''}>Implicit TLS (often 465)</option></select></label>
    <label>Sender address<input name="from" type="email" required value="${escapeHtml(smtp?.from || '')}"></label>
    <label>SMTP username (optional)<input name="username" value="${escapeHtml(smtp?.username || '')}"></label>
    <label>SMTP password<input name="password" type="password" autocomplete="new-password" placeholder="${smtp?.hasPassword ? 'Leave blank to keep saved password' : 'Optional for internal relay'}"></label>
    <label>Current administrator password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Save SMTP settings</button><div class="form-error" role="alert"></div></form>
    ${smtp ? `<form id="smtp-test" class="panel creation-form"><h2>Send a test</h2><label>Recipient address<input name="recipient" type="email" required></label><button class="secondary" type="submit">Send test message</button><div class="form-error" role="alert"></div></form>` : ''}`;
}

function mediaView() {
  return filesView();
}

async function loadMedia() {
  try { state.media = await request('/api/media'); if (['media', 'files'].includes(state.view)) render(state.view); } catch (error) { toast(error.message); }
}

async function loadRuntimes() {
  try { state.runtimes = await request('/api/runtimes'); state.runtimeError = null; }
  catch (error) { state.runtimeError = error.message; }
  if (['apps', 'containers', 'vms', 'integrations'].includes(state.view)) render(state.view);
}

async function loadContainers() {
  try {
    const containers = await request('/api/containers/inventory?summary=1');
    state.runtimes = { ...(state.runtimes || {}), containers };
    state.containerError = null;
  } catch (error) {
    state.containerError = error.message;
  }
  if (state.view === 'containers') render('containers');
}

function runtimeBanner(kind) {
  const scopedError = kind === 'containers' ? state.containerError : state.runtimeError;
  if (scopedError) return `<div class="empty"><p>${escapeHtml(scopedError)}</p><button class="secondary" data-action="refresh-runtime">Retry</button></div>`;
  if (!state.runtimes || !state.runtimes[kind]) return `<div class="empty"><p>${kind === 'containers' ? 'Checking system containers…' : 'Checking this host’s runtimes…'}</p></div>`;
  const runtime = state.runtimes[kind];
  if (!runtime.available) return `<div class="module-hero"><h2>Runtime unavailable</h2><p>${escapeHtml(runtime.reason)}</p></div>`;
  if (!runtime.enabled) return '<div class="module-hero"><h2>Creation is disabled</h2><p>The host operator must explicitly enable this runtime and grant the LightNAS service account access. Existing resources remain visible below.</p></div>';
  return '';
}

function containersView() {
  const runtime = state.runtimes?.containers;
  const diagnostics = runtime?.diagnostics;
  const networks = (runtime?.networks || []).map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  const images = (runtime?.images || []).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
  const ready = runtime?.available && runtime?.enabled && runtime.images?.length && runtime.networks?.length;
  const containers = runtime?.containers || [];
  const running = containers.filter(item => /running/i.test(String(item.status))).length;
  const assignedMemory = containers.reduce((total, item) => total + (Number(item.memory) || 0), 0);
  const usedMemory = containers.reduce((total, item) => total + (Number(item.memoryUsed) || 0), 0);
  const assignedCpus = containers.reduce((total, item) => total + (Number(item.cpus) || 0), 0);
  const hostMemory = state.overview?.system?.memory?.totalBytes || 0;
  const hostCpus = state.overview?.system?.cpu?.cores || 0;
  const diagnosticPanel = runtime ? `<section class="metric-grid compute-summary">
    ${metric('Containers', `${containers.length}`, containers.length ? Math.round((running / containers.length) * 100) : 0, `${running} running · ${containers.length - running} stopped`)}
    ${metric('Container memory use', bytes(usedMemory), hostMemory ? Math.round((usedMemory / hostMemory) * 100) : 0, `${bytes(assignedMemory)} assigned`)}
    ${metric('Assigned CPU', `${assignedCpus} vCPU`, hostCpus ? Math.round((assignedCpus / hostCpus) * 100) : 0, `${hostCpus} host logical cores`)}
    ${metric('Host CPU use', `${state.overview?.system?.cpu?.loadPercent || 0}%`, state.overview?.system?.cpu?.loadPercent || 0, 'Live LightNAS host utilization')}
  </section>${diagnostics?.errors?.length ? `<div class="module-note"><b>Runtime notice:</b> ${diagnostics.errors.map(escapeHtml).join(' · ')}</div>` : ''}` : '';
  const containerList = !runtime
    ? '<div class="empty"><p>Loading existing system containers…</p></div>'
    : runtime.containers?.length
      ? runtime.containers.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>Native LXC · ${escapeHtml(item.status)}${item.pid ? ` · ${bytes(item.memoryUsed || 0)} RAM in use · PID ${item.pid}` : ''}</p></div><div class="storage-size">${escapeHtml(item.id || item.name)}</div></article>`).join('')
      : '<div class="empty"><p>No native system containers are visible.</p></div>';
  return `${pageHead('System containers', 'Native Linux system containers powered by LXC/liblxc inside LightNAS itself.', '<div class="head-actions"><button class="secondary" data-action="refresh-runtime">Refresh</button><button class="primary" data-action="create-container">+ Create container</button></div>')}
    ${runtimeBanner('containers')}
    ${diagnosticPanel}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>Container network unavailable</h2><p>Create or enable a local bridge/network under Connectivity before launching a system container.</p></div>' : ''}
    ${ready ? '<div class="module-note"><b>Ready to create.</b> Use the + Create container button to open the guided setup wizard.</div>' : ''}
    <h2>Existing system containers</h2><div class="storage-list">${containerList}</div>`;
}

function vmsView() {
  const runtime = state.runtimes?.virtualization;
  const ready = runtime?.available && runtime?.enabled && runtime.pools?.length && runtime.networks?.length;
  const choices = items => (items || []).map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  const machines = runtime?.machineDetails || [];
  const running = machines.filter(item => /running/i.test(String(item.status))).length;
  const assignedMemory = machines.reduce((total, item) => total + (Number(item.memory) || 0), 0);
  const usedMemory = machines.reduce((total, item) => total + (Number(item.memoryUsed) || 0), 0);
  const assignedCpus = machines.reduce((total, item) => total + (Number(item.cpus) || 0), 0);
  const hostMemory = state.overview?.system?.memory?.totalBytes || 0;
  const hostCpus = state.overview?.system?.cpu?.cores || 0;
  const nestedVmPanel = runtime ? `<section class="metric-grid compute-summary">
    ${metric('Virtual machines', `${machines.length}`, machines.length ? Math.round((running / machines.length) * 100) : 0, `${running} running · ${machines.length - running} stopped`)}
    ${metric('VM memory use', bytes(usedMemory), hostMemory ? Math.round((usedMemory / hostMemory) * 100) : 0, `${bytes(assignedMemory)} assigned`)}
    ${metric('Assigned CPU', `${assignedCpus} vCPU`, hostCpus ? Math.round((assignedCpus / hostCpus) * 100) : 0, `${hostCpus} host logical cores`)}
    ${metric('Host CPU use', `${state.overview?.system?.cpu?.loadPercent || 0}%`, state.overview?.system?.cpu?.loadPercent || 0, 'Live LightNAS host utilization')}
  </section>` : '';
  const isoOptions = `<option value="">No ISO — create blank VM</option>${runtime?.isoDetails?.length ? runtime.isoDetails.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.storageName)} · ${bytes(item.sizeBytes)}</option>`).join('') : choices(runtime?.images || [])}`;
  return `${pageHead('Virtual machines', 'QEMU/libvirt virtual machines managed directly by LightNAS.', '<div class="head-actions"><button class="secondary" data-action="refresh-runtime">Refresh</button><button class="primary" data-action="create-vm">+ Create VM</button></div>')}
    ${runtimeBanner('virtualization')}
    ${runtime?.warning ? `<div class="module-note"><b>Software virtualization:</b> ${escapeHtml(runtime.warning)}</div>` : ''}
    ${nestedVmPanel}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>VM resources needed</h2><p>LightNAS needs an active local libvirt storage pool and network. The installer creates default resources automatically.</p></div>' : ''}
    ${ready ? '<div class="module-note"><b>Ready to create.</b> Use the + Create VM button to open the guided setup wizard.</div>' : ''}
    <h2>Existing VMs</h2><div class="storage-list">${runtime?.machineDetails?.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.status)} · ${item.cpus || '—'} vCPU · ${bytes(item.memoryUsed || 0)} used of ${bytes(item.memory || 0)} RAM</p></div><div class="storage-size">${escapeHtml(runtime.provider || 'libvirt')}</div></article>`).join('') || '<div class="empty"><p>No local virtual machines are visible.</p></div>'}</div>`;
}

function sharesView() {
  const { shares } = state.overview;
  return `${pageHead('Share plans', 'Saved configurations only. No SMB, NFS, or SFTP service is changed.', '<button class="primary" data-action="new-share">+ New plan</button>')}
    <div class="share-list">${shares.map(share => `<article class="share-row"><div><h3>${escapeHtml(share.name)}</h3><p>${escapeHtml(share.protocol)} · ${escapeHtml(share.description || 'No description')} · ${relativeTime(share.createdAt)}</p></div><button class="secondary" data-delete-share="${escapeHtml(share.id)}" data-name="${escapeHtml(share.name)}">Remove plan</button></article>`).join('') || '<div class="empty"><p>No share plans saved.</p></div>'}</div>`;
}

const librarySections = [
  ['', 'All files'],
  ['Documents', 'Documents'],
  ['Photos', 'Photos'],
  ['Videos', 'Videos'],
  ['Audio', 'Audio']
];

function filesView() {
  const segments = state.folder.split('/').filter(Boolean);
  const section = librarySections.some(([folder]) => folder === (segments[0] || '')) ? (segments[0] || '') : '';
  const crumbs = [`<button class="panel-link" data-folder="">Files & media</button>`, ...segments.map((segment, index) => `<span> / </span><button class="panel-link" data-folder="${escapeHtml(segments.slice(0, index + 1).join('/'))}">${escapeHtml(segment)}</button>`)].join('');
  const entries = state.files;
  const tabs = librarySections.map(([folder, label]) => `<button type="button" class="library-tab ${section === folder ? 'active' : ''}" data-library-tab="${escapeHtml(folder)}" aria-pressed="${section === folder}">${escapeHtml(label)}</button>`).join('');
  const layoutButtons = `<div class="view-switch" role="group" aria-label="File view"><button class="secondary ${state.fileLayout === 'list' ? 'active' : ''}" data-file-layout="list" title="List view">☷</button><button class="secondary ${state.fileLayout === 'grid' ? 'active' : ''}" data-file-layout="grid" title="Grid view">▦</button></div>`;
  return `${pageHead('Files & media', 'Browse documents, photos, audio, video, RAW photos, and other files in one library.', `<div class="head-actions">${layoutButtons}<button class="secondary" data-action="refresh-files">Refresh</button></div>`)}
    <nav class="library-tabs" aria-label="File library sections">${tabs}</nav>
    <div class="file-toolbar"><div class="breadcrumbs">${crumbs}</div><div><button class="secondary" data-action="new-folder">+ Folder</button> <label class="primary upload-button">Upload<input id="file-upload" type="file" multiple hidden></label></div></div>
    <p class="muted">Select a tab to open that library. Previewable items open in the viewer; use its arrows to move through multiple files.</p>
    <div class="storage-list file-browser ${state.fileLayout === 'grid' ? 'file-grid' : 'file-list'}">${state.fileError ? `<div class="empty error-state"><p><b>Files could not be loaded.</b></p><p>${escapeHtml(state.fileError)}</p><button class="secondary" data-action="refresh-files">Try again</button></div>` : entries === null ? '<div class="empty"><p>Loading files…</p></div>' : entries.length ? entries.map(entry => `<article class="file-row"><button class="file-name" data-open="${escapeHtml(entry.name)}" data-directory="${entry.directory}"><span class="file-icon">${entry.directory ? '▣' : '▤'}</span><span class="file-label">${escapeHtml(entry.name)}</span></button><span class="muted">${entry.directory ? 'Folder' : bytes(entry.sizeBytes)}</span><div class="file-actions">${entry.directory ? `<button class="secondary" data-download-folder="${escapeHtml(entry.name)}">Download</button>` : state.media?.converterAvailable && state.overview.appliance.role === 'administrator' ? `<button class="secondary" data-convert-file="${escapeHtml(entry.name)}">Convert</button>` : ''}<button class="secondary" data-delete-file="${escapeHtml(entry.name)}">Delete</button></div></article>`).join('') : '<div class="empty"><p>This section is empty. Create a folder or upload files here.</p></div>'}</div>`;
}

async function loadFiles() {
  state.fileError = null;
  try {
    const result = await request(`/api/files?path=${encodeURIComponent(state.folder)}`);
    state.files = Array.isArray(result.entries)
      ? result.entries.filter(entry => entry.supported && !(state.folder === '' && entry.directory && entry.name === 'ISO'))
      : [];
  } catch (error) {
    state.files = [];
    state.fileError = error.message || 'The file service did not return a valid response.';
    toast(state.fileError);
  }
  if (state.view === 'files') render('files');
}

function capabilitiesView() {
  const { system } = state.overview;
  return `${pageHead('System capabilities', 'Hardware eligibility estimates; these services may still need installation.')}
    <div class="capability-list">${system.capabilities.map(item => `<article class="capability-row"><div><b>${escapeHtml(item.name)}</b><p>${escapeHtml(item.available ? `Hardware requirement met · ${item.minimum}` : item.reason)}</p></div><span class="badge ${item.available ? 'available' : 'gated'}">${item.available ? 'ELIGIBLE' : 'HARDWARE GATED'}</span></article>`).join('')}</div>`;
}

function settingsView() {
  const { appliance } = state.overview;
  const zones = [['America/New_York', 'Eastern Time'], ['America/Chicago', 'Central Time'], ['America/Denver', 'Mountain Time'], ['America/Los_Angeles', 'Pacific Time'], ['UTC', 'UTC']];
  return `${pageHead('Appliance settings', 'Update the LightNAS device name, time zone, and account security.')}
    <form id="settings-form" class="panel settings-form">
      <h2>Appliance identity</h2><p class="muted">Signed in as ${escapeHtml(appliance.username)}. These settings apply to LightNAS only, not the Linux root account.</p>
      <label>Device name<input name="deviceName" value="${escapeHtml(appliance.deviceName)}" required minlength="2" maxlength="32" autocomplete="off"></label>
      <label>Display time zone<select name="timezone">${zones.map(([value, label]) => `<option value="${value}" ${appliance.timezone === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label>
      ${appliance.role === 'administrator' ? '<label>New owner password (optional)<input name="newPassword" type="password" minlength="10" autocomplete="new-password" placeholder="Leave blank to keep current password"></label>' : ''}
      <button class="primary" type="submit">Save settings</button>
      <div class="form-error" role="alert"></div>
    </form>`;
}

function adminView() {
  const { appliance } = state.overview;
  return `${pageHead('Admin Center', `Manage ${escapeHtml(appliance.deviceName)} as a complete LightNAS appliance.`)}
    <section class="panel" id="appliance-health-panel">
      <div data-appliance-health-result>
        <span class="eyebrow">APPLIANCE HEALTH</span>
        <h2>LightNAS self-management</h2>
        <p class="muted">Check storage, container, VM, application and core service readiness, or let LightNAS repair its own managed services.</p>
      </div>
      <div class="head-actions">
        <button class="secondary" type="button" data-appliance-health>Check health</button>
        <button class="primary" type="button" data-appliance-repair>Repair automatically</button>
      </div>
    </section>
    <section class="admin-tool-groups">
      ${[['Identity & access',[['users','Users & groups'],['settings','Security settings']]],['Infrastructure',[['pools','Storage'],['network','Networking'],['firewall','Firewall']]],['Compute & operations',[['apps','Applications'],['containers','Containers'],['vms','Virtual machines'],['monitoring','Monitoring']]]].map(([title, tools]) => `<div class="admin-group"><h2>${title}</h2><div class="admin-group-grid">${tools.map(([view,label]) => `<button class="admin-tool-card" type="button" data-view-link="${view}"><b>${label}</b><span>Open ${label.toLowerCase()}</span></button>`).join('')}</div></div>`).join('')}
    </section>`;
}

function shellView() {
  return `${pageHead('Node shell', 'Open an authenticated root terminal on the LightNAS node.')}
    <section class="module-hero"><span class="eyebrow">PRIVILEGED NODE ACCESS</span><h2>LightNAS host terminal</h2><p>Commands run directly on this LightNAS installation. Access requires the dedicated Node shell permission.</p><button class="primary" data-open-node-shell>Open node shell</button></section>`;
}

function moduleView(view) {
  if (view === 'apps') {
    const docker = state.runtimes?.docker;
    return `${pageHead('App Store', 'Choose an app and install it directly from LightNAS.', '<button class="secondary" data-action="refresh-runtime">Refresh apps</button>')}
      ${runtimeBanner('docker')}
      <div class="tool-grid">${state.runtimes?.catalog?.map(app => {
        const instance = docker?.containers?.find(container => container.name === `lightnas-app-${app.id}`);
        const appUrl = `http://${location.hostname}:${app.port}/`;
        const running = instance?.state === 'running';
        return `<article class="panel"><span class="eyebrow">${escapeHtml(app.category)}</span><h2>${escapeHtml(app.name)}</h2><p class="muted">${escapeHtml(app.description)}</p><p class="muted">${escapeHtml(app.image)} · Port ${app.port}</p>${instance ? `<p class="muted">${escapeHtml(instance.status || instance.state)}</p><div class="head-actions">${running ? `<a class="primary" href="${escapeHtml(appUrl)}" target="_blank" rel="noopener">Open application</a>` : ''}<button class="secondary" data-app-action="${running ? 'stop' : 'start'}" data-app-id="${app.id}">${running ? 'Stop' : 'Start'}</button><button class="secondary" data-app-action="restart" data-app-id="${app.id}">Restart</button><button class="secondary" data-app-action="remove" data-app-id="${app.id}">Remove</button></div>` : `<button class="primary" data-install="${app.id}">Install app</button>`}</article>`;
      }).join('') || '<div class="empty"><p>Loading catalog…</p></div>'}</div>
      <section class="module-hero"><h2>Managed app hosting</h2><p>LightNAS downloads each app, creates its persistent storage, publishes its web service on the LightNAS LAN address, opens the managed firewall port, starts it after reboot, and verifies that the service is reachable. No Proxmox configuration or manual port forwarding is required. ${docker?.available && docker?.enabled ? 'The integrated App Store engine is ready.' : 'Rerun the one-click LightNAS installer to provision the integrated App Store engine.'}</p></section>`;
  }
  return `${pageHead('Monitoring', 'Current readings from this host.', '<button class="secondary" data-action="refresh">Refresh readings</button>')}<section class="metric-grid">${metric('CPU load', `${state.overview.system.cpu.loadPercent}%`, state.overview.system.cpu.loadPercent, state.overview.system.cpu.model)}${metric('Memory', bytes(state.overview.system.memory.usedBytes), state.overview.system.memory.usedPercent, `${bytes(state.overview.system.memory.freeBytes)} free`)}${metric('Uptime', duration(state.overview.system.uptimeSeconds), 0, state.overview.system.kernel)}${metric('Mounts', state.overview.filesystems.length, 0, 'Currently visible')}</section><h2>Activity</h2><div class="activity-list">${state.overview.activity.map(item => `<div class="activity"><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') || '<p>No activity recorded.</p>'}</div>`;
}

async function loadNetwork() {
  try { state.network = await request('/api/network'); if (['network', 'firewall'].includes(state.view)) render(state.view); }
  catch (error) { toast(error.message); }
}

function networkView() {
  const info = state.network;
  const control = info?.control;
  if (!info) return `${pageHead('Networking', 'Manage the LightNAS appliance network.', '<button class="secondary" data-action="refresh-network">Refresh</button>')}<div class="empty">Loading network inventory…</div>`;

  const defaultRoute = [...(info.routes || [])].filter(item => item.destination === 'default').sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0] || null;
  const routeDevice = defaultRoute?.device || '';
  const routeDeviceInfo = (control?.devices || []).find(item => item.name === routeDevice);
  const current = control?.currentUplink || (routeDevice ? {
    name: routeDevice,
    kind: routeDeviceInfo?.type === 'wifi' ? 'Wi-Fi' : routeDeviceInfo?.type === 'bridge' ? 'Ethernet bridge' : 'Ethernet',
    connection: routeDeviceInfo?.connection || 'Kernel / appliance managed',
    gateway: defaultRoute?.gateway || null,
    metric: defaultRoute?.metric ?? null,
    active: true,
    managed: routeDeviceInfo?.type === 'bridge'
  } : null);

  const currentInterface = current ? info.interfaces.find(item => item.name === current.name) : null;
  const currentAddresses = currentInterface?.addresses?.filter(item => item.family === 'inet').map(item => `${item.address}/${item.prefix}`).join(', ') || 'No IPv4 address';
  const uplinks = control?.uplinks || (current ? [current] : []);
  const selectableUplinks = uplinks.filter(item => !item.active && item.managed !== false);
  const wifiDevices = (control?.devices || []).filter(item => item.type === 'wifi' && !['unavailable','unmanaged'].includes(item.state));
  const bridge = control?.bridge || null;

  const applianceNetworks = (control?.devices || []).filter(item => item.type === 'bridge' || /^(virbr\d*|lightnas\d*|lxcbr\d*)$/i.test(item.name || ''));
  const advancedInterfaces = (info.interfaces || []).filter(item => {
    const name = item.name || '';
    if (name === 'lo' || /^veth/i.test(name) || /^tap/i.test(name) || /^tun/i.test(name) || /^docker/i.test(name) || /^br-[A-Fa-f0-9]+$/.test(name)) return false;
    if (bridge?.mode === 'bridge' && name === bridge.port) return false;
    return true;
  });
  const advancedRoutes = (info.routes || []).filter(route => !/^docker|^veth|^tap|^tun/i.test(route.device || ''));

  const purpose = item => {
    if (item.name === bridge?.name && bridge?.mode === 'bridge') return 'Appliance LAN bridge · host + VMs + system containers';
    if (/^lightnas/i.test(item.name || '')) return 'Fallback container NAT network';
    if (/^virbr/i.test(item.name || '')) return 'Virtual machine network';
    return 'Virtual network';
  };

  return `${pageHead('Networking', 'Manage physical interfaces, Linux bridges, bonds, VLANs, addresses, routes, and DNS from LightNAS.', '<div class="head-actions"><button class="secondary" data-action="refresh-network">Refresh</button><button class="primary" data-network-add-bridge>+ Bridge</button><button class="secondary" data-network-add-bond>+ Bond</button><button class="secondary" data-network-add-vlan>+ VLAN</button></div>')}
    <section class="module-hero">
      <span class="eyebrow">CURRENT APPLIANCE NETWORK</span>
      <h2>${current ? `${escapeHtml(current.kind || 'Network')} · ${escapeHtml(current.name)}` : 'No active Internet connection detected'}</h2>
      <p>${current ? `${escapeHtml(currentAddresses)}${current.gateway ? ` · gateway ${escapeHtml(current.gateway)}` : ''}${current.physicalPort ? ` · physical port ${escapeHtml(current.physicalPort)}` : ''}` : 'Connect an Ethernet or Wi-Fi uplink.'}</p>
      ${bridge?.mode === 'bridge' ? `<p class="muted">Wired appliance mode: ${escapeHtml(bridge.port || 'physical NIC')} is a bridge port only. VMs and system containers attach directly to ${escapeHtml(bridge.name || 'virbr0')} and use the real LAN.</p>` : bridge?.mode === 'wifi-nat' ? '<p class="muted">Wi-Fi appliance mode: guests use routed/NAT networking because station-mode Wi-Fi cannot be transparently bridged.</p>' : ''}
    </section>

    ${uplinks.length ? `<h2>Internet connections</h2><div class="inventory-grid">${uplinks.map(item => `<article class="inventory-card"><div class="volume-title"><h3>${escapeHtml(item.kind || 'Network')} · ${escapeHtml(item.name)}</h3><span class="volume-state ${item.active ? 'writable' : ''}">${item.active ? 'CURRENT' : escapeHtml(String(item.state || 'AVAILABLE').toUpperCase())}</span></div><p>${escapeHtml(item.connection || (item.managed === false ? 'Kernel / hypervisor managed' : 'Available connection'))}</p>${item.physicalPort ? `<p class="muted">Physical port: ${escapeHtml(item.physicalPort)}</p>` : ''}${!item.active && item.managed !== false && selectableUplinks.length ? `<button class="secondary" data-uplink-prefer="${escapeHtml(item.name)}">Use this connection</button>` : `<small>${item.active ? 'Active default Internet route' : 'Available uplink'}</small>`}</article>`).join('')}</div>` : '<div class="module-note">No usable Ethernet or Wi-Fi Internet uplink is visible.</div>'}

    ${wifiDevices.length ? `<h2>Wi-Fi</h2><p class="muted">LightNAS shows Wi-Fi only when a wireless adapter is available. Wired Ethernet is preferred for transparent VM/container LAN bridging.</p><div class="inventory-grid">${(control?.wifi || []).map(item => `<article class="inventory-card"><div class="volume-title"><h3>${escapeHtml(item.ssid)}</h3><span class="volume-state ${item.connected ? 'writable' : ''}">${item.connected ? 'CONNECTED' : `${item.signal}%`}</span></div><p>${escapeHtml(item.security || 'Open')}</p><button class="secondary" data-wifi-connect="${escapeHtml(item.ssid)}">${item.connected ? 'Use as preferred' : 'Connect'}</button></article>`).join('') || '<div class="empty">No Wi-Fi networks are currently in range.</div>'}</div>` : ''}

    <h2>Appliance networks</h2>
    <div class="storage-list">${applianceNetworks.map(item => {
      const live = info.interfaces.find(iface => iface.name === item.name);
      const addresses = live?.addresses?.filter(address => address.family === 'inet').map(address => `${address.address}/${address.prefix}`).join(', ') || 'No IPv4 address';
      return `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(purpose(item))} · ${escapeHtml(addresses)}</p></div><span class="badge">${String(live?.state || item.state || '').toUpperCase() === 'UP' ? 'ACTIVE' : 'INACTIVE'}</span></article>`;
    }).join('') || '<div class="empty">No LightNAS bridge is active.</div>'}</div>

    ${(control?.connections || []).length ? `<h2>Connection profiles</h2><div class="storage-list">${control.connections.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.type)} · ${escapeHtml(item.device || 'not active')} · autoconnect ${item.autoconnect ? 'on' : 'off'}</p></div><div class="runtime-actions"><button class="secondary" data-network-edit="${escapeHtml(item.name)}">Edit IPv4 / DNS</button><button class="secondary danger-button" data-network-delete="${escapeHtml(item.name)}">Delete</button></div></article>`).join('')}</div>` : ''}

    <details class="panel"><summary><b>Advanced network details</b></summary>
      <p class="muted">Low-level Docker, veth and tap interfaces are hidden from the normal appliance view.</p>
      <h2>Live appliance interfaces</h2><div class="storage-list">${advancedInterfaces.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.state || 'unknown')} · ${escapeHtml(item.mac || 'MAC unavailable')}</p></div><p>${item.addresses.map(address => `${escapeHtml(address.address)}/${address.prefix}`).join('<br>') || 'No addresses'}</p></article>`).join('') || '<div class="empty">No appliance interfaces visible.</div>'}</div>
      <h2>Routes</h2><div class="storage-list">${advancedRoutes.map(route => `<article class="storage-row"><h3>${escapeHtml(route.destination)}</h3><p>via ${escapeHtml(route.gateway || 'on-link')} · ${escapeHtml(route.device)}${route.metric !== null ? ` · metric ${route.metric}` : ''}</p></article>`).join('') || '<div class="empty">No routes accessible.</div>'}</div>
      <h2>DNS servers</h2><div class="panel">${info.dns.map(escapeHtml).join(', ') || 'No DNS servers found.'}</div>
    </details>`;
}

function firewallView() {
  const firewall = state.network?.firewall;
  return `${pageHead('Firewall', 'Manage the firewall on this LightNAS host.', '<div class="head-actions"><button class="secondary" data-action="refresh-network">Refresh</button><button class="primary" data-firewall-add>+ Rule</button></div>')}
    <div class="module-hero"><h2>${escapeHtml(firewall?.status || 'Loading…')}</h2><p>Backend: ${escapeHtml(firewall?.backend || 'detecting')}. Rules here protect LightNAS itself and are applied locally.</p><div class="head-actions"><button class="secondary" data-firewall-toggle="enable">Enable</button><button class="secondary danger-button" data-firewall-toggle="disable">Disable</button></div></div>
    <h2>Rules</h2><div class="storage-list">${firewall?.rules?.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.action)} ${escapeHtml(item.target)}</h3><p>Source: ${escapeHtml(item.source)}</p></div><button class="secondary danger-button" data-firewall-delete="${item.number}">Delete</button></article>`).join('') || '<div class="empty">No numbered UFW rules visible.</div>'}</div>
    <h2>Visible nftables tables</h2><div class="storage-list">${firewall?.tables?.map(item => `<article class="storage-row">${escapeHtml(item)}</article>`).join('') || '<div class="empty">No nftables tables visible.</div>'}</div>`;
}

function integrationsView() {
  const apps = state.runtimes?.docker, containers = state.runtimes?.containers, vm = state.runtimes?.virtualization;
  return `${pageHead('Integrations', 'See which host services and compute providers LightNAS can actually reach.', '<button class="secondary" data-action="refresh-runtime">Refresh</button>')}
    <div class="tool-grid">
      <article class="panel"><h2>System containers</h2><p>${containers?.available && containers?.enabled ? `${escapeHtml(containers.provider || 'provider')} connected. System-container creation is enabled.` : escapeHtml(containers?.reason || 'Checking system-container provider…')}</p><button class="secondary" data-view-link="containers">Open containers</button></article>
      <article class="panel"><h2>Virtualization</h2><p>${vm?.available && vm?.enabled ? `${escapeHtml(vm.provider || 'KVM')} connected.` : escapeHtml(vm?.reason || 'Checking virtualization…')}</p><button class="secondary" data-view-link="vms">Open virtual machines</button></article>
      <article class="panel"><h2>Optional App Store engine</h2><p>${apps?.available && apps?.enabled ? 'Docker/OCI app engine connected. This is separate from System Containers.' : escapeHtml(apps?.reason || 'Docker/OCI app engine is optional and currently disabled.')}</p><button class="secondary" data-view-link="apps">Open App Store</button></article>
    </div>`;
}

function render(view) {
  if (view === 'media') view = 'files';
  state.view = ['home', 'storage', 'pools', 'files', 'users', 'smtp', 'admin', 'shares', 'capabilities', 'apps', 'containers', 'vms', 'monitoring', 'settings', 'network', 'firewall', 'integrations'].includes(view) ? view : 'home';
  if (!canView(state.view)) state.view = $$('[data-view]', $('#nav')).find(link => canView(link.dataset.view))?.dataset.view || 'home';
  const content = $('#content');
  content.innerHTML = state.view === 'home' ? homeView() : state.view === 'storage' ? storageView() : state.view === 'pools' ? poolsView() : state.view === 'files' ? filesView() : state.view === 'media' ? mediaView() : state.view === 'users' ? usersView() : state.view === 'smtp' ? smtpView() : state.view === 'admin' ? adminView() : state.view === 'shares' ? sharesView() : state.view === 'containers' ? containersView() : state.view === 'vms' ? vmsView() : state.view === 'settings' ? settingsView() : state.view === 'capabilities' ? capabilitiesView() : state.view === 'network' ? networkView() : state.view === 'firewall' ? firewallView() : state.view === 'integrations' ? integrationsView() : moduleView(state.view);
  $$('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === state.view));
  $(`[data-view="${state.view}"]`, $('#nav'))?.closest('details')?.setAttribute('open', '');
  content.focus({ preventScroll: true });
  bindViewActions();
  if (state.view === 'files' && state.files === null) loadFiles();
  if (['pools', 'storage'].includes(state.view) && state.spaces === null) loadSpaces();
  if (state.view === 'users' && state.users === null) loadUsers();
  if (state.view === 'smtp' && state.smtp === undefined) loadSmtp();
  if (['files', 'media'].includes(state.view) && state.media === null) loadMedia();
  if (['network', 'firewall'].includes(state.view) && !state.network) loadNetwork();
  if (state.view === 'containers' && !state.runtimes?.containers && !state.containerError) loadContainers();
  if (['apps', 'vms', 'integrations'].includes(state.view) && (!state.runtimes?.docker || !state.runtimes?.virtualization) && !state.runtimeError) loadRuntimes();
}

function bindViewActions() {
  $$('[data-file-layout]', $('#content')).forEach(button => button.addEventListener('click', () => {
    state.fileLayout = button.dataset.fileLayout;
    localStorage.setItem('lightnas-file-layout', state.fileLayout);
    render('files');
  }));
  $('[data-open-node-shell]', $('#content'))?.addEventListener('click', () => window.open(`/node-console.html?v=${Date.now()}`, '_blank', 'noopener,width=1280,height=820'));
  const renderHealth = result => {
    const target = $('[data-appliance-health-result]', $('#content'));
    if (!target) return;
    target.innerHTML = '<span class="eyebrow">APPLIANCE HEALTH</span><h2>' +
      (result.healthy ? 'LightNAS is healthy' : 'LightNAS needs attention') +
      '</h2><div class="storage-list">' +
      (result.checks || []).map(item => '<div class="storage-row"><div><h3>' + escapeHtml(item.label) +
      '</h3><p>' + escapeHtml(item.detail || '') + '</p></div><span class="volume-state ' +
      (item.healthy ? 'writable' : 'readonly') + '">' + (item.healthy ? 'HEALTHY' : 'NEEDS ATTENTION') +
      '</span></div>').join('') + '</div>';
  };
  $('[data-appliance-health]', $('#content'))?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Checking…';
    try { const result = await request('/api/appliance/health'); renderHealth(result); toast(result.healthy ? 'LightNAS appliance is healthy.' : 'Some appliance services need attention.'); }
    catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = 'Check health'; }
  });
  $('[data-appliance-repair]', $('#content'))?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Repairing…';
    try { const result = await request('/api/appliance/repair', { method: 'POST', body: '{}' }); state.runtimes = null; state.runtimeError = null; renderHealth(result); toast(result.healthy ? 'Automatic appliance repair completed.' : 'Repair completed; some items still need attention.'); }
    catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = 'Repair automatically'; }
  });
  $$('[data-action="create-pool"]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const storage = state.overview.storage;
    if (!storage.disks.length) return toast('No physical disks are exposed to this NAS. Attach data disks to a VM or install on bare metal.');
    toast('Physical pool creation needs the disk safety agent before it can operate. Existing ZFS datasets can be created below.');
    $('#dataset-form', $('#content'))?.scrollIntoView({ behavior: 'smooth' });
  }));
  $$('[data-action="create-container"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    let containers = state.runtimes?.containers;
    if ((!containers?.networks?.length || !containers?.available || !containers.enabled) && containers?.inventoryAvailable !== false) {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'Preparing container network…';
      try {
        await request('/api/appliance/repair', { method: 'POST', body: '{}' });
        await loadContainers();
        containers = state.runtimes?.containers;
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }
    if (!containers?.available || !containers.enabled) return toast(containers?.reason || 'LightNAS could not prepare the native container runtime.');
    if (!containers.images?.length) return toast('No Linux container images or templates are available.');
    if (!containers.networks?.length) return toast('LightNAS could not start its internal container network.');
    $('#container-form', $('#content'))?.scrollIntoView({ behavior: 'smooth' });
    $('#container-form input', $('#content'))?.focus();
  }));
  $$('[data-action="create-vm"]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const vm = state.runtimes?.virtualization;
    if (!vm?.available || !vm.enabled) return toast(vm?.reason || 'KVM/libvirt must be installed and enabled on a VM-capable host.');
    if (!vm.pools.length || !vm.networks.length) return toast(vm.provider === 'proxmox' ? 'Select VM storage and a network first.' : 'Activate a libvirt storage pool and network first.');
    $('#vm-form', $('#content'))?.scrollIntoView({ behavior: 'smooth' });
    $('#vm-form input', $('#content'))?.focus();
  }));
  $('#dataset-form', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget;
    try { await request('/api/zfs/datasets', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); state.overview = await request('/api/overview'); render('pools'); toast('Dataset created.'); }
    catch (error) { $('.form-error', form).textContent = error.message; }
  });
  $$('[data-dataset]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const property = prompt('Property to change: compression or quota');
    if (property === null) return;
    const value = prompt(property === 'quota' ? 'Quota in GiB, for example 100G, or none:' : 'Compression: off, lz4, zstd, gzip');
    if (value === null) return;
    try { await request('/api/zfs/datasets', { method: 'PATCH', body: JSON.stringify({ name: button.dataset.dataset, property: property.trim(), value: value.trim() }) }); state.overview = await request('/api/overview'); render('pools'); toast('Dataset property updated.'); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-convert-file]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const format = prompt('Output format: mp4, webm, mp3, jpg, png, or webp');
    if (format === null) return;
    button.disabled = true;
    button.textContent = 'Converting…';
    try {
      await request('/api/media/convert', { method: 'POST', body: JSON.stringify({ path: [state.folder, button.dataset.convertFile].filter(Boolean).join('/'), format: format.toLowerCase().trim() }) });
      await loadFiles(); toast('Converted file is ready in this folder.');
    } catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Convert'; }
  }));
  $('#smtp-form', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try { await request('/api/smtp', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); await loadSmtp(); toast('SMTP settings saved.'); }
    catch (error) { $('.form-error', form).textContent = error.message; }
  });
  $('#smtp-test', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try { await request('/api/smtp/test', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); toast('SMTP test message sent.'); }
    catch (error) { $('.form-error', form).textContent = error.message; }
  });
  $('#space-form', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try { await request('/api/spaces', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); await loadSpaces(); toast('Storage space created.'); }
    catch (error) { $('.form-error', form).textContent = error.message; }
  });
  $$('[data-edit-space]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const label = prompt('New display label');
    if (label === null) return;
    try { await request(`/api/spaces/${encodeURIComponent(button.dataset.editSpace)}`, { method: 'PATCH', body: JSON.stringify({ label }) }); await loadSpaces(); toast('Label updated.'); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-open-space]', $('#content')).forEach(button => button.addEventListener('click', () => { state.folder = `Spaces/${button.dataset.openSpace}`; state.files = null; location.hash = 'files'; }));
  $('#user-form', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    data.groups = $$('input[name="groups"]:checked', form).map(input => input.value);
    try { await request('/api/users', { method: 'POST', body: JSON.stringify(data) }); await loadUsers(); toast('User created.'); }
    catch (error) { $('.form-error', form).textContent = error.message; }
  });
  $$('[data-remove-user]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    if (!confirm(`Remove user ${button.dataset.removeUser}?`)) return;
    try { await request(`/api/users/${encodeURIComponent(button.dataset.removeUser)}`, { method: 'DELETE' }); await loadUsers(); toast('User removed.'); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-manage-user]', $('#content')).forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const action = event.submitter.value;
    const input = Object.fromEntries(new FormData(form));
    if (action === 'password' && (!input.password || input.password.length < 10)) { $('.form-error', form).textContent = 'Enter a password of at least 10 characters.'; return; }
    const change = action === 'password' ? { currentPassword: input.currentPassword, password: input.password } : { currentPassword: input.currentPassword, disabled: action === 'disable' };
    try { await request(`/api/users/${encodeURIComponent(form.dataset.manageUser)}`, { method: 'PATCH', body: JSON.stringify(change) }); await loadUsers(); toast('Account updated; old sessions ended.'); }
    catch (error) { $('.form-error', form).textContent = error.message; }
  }));
  $$('[data-media-folder]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const folder = button.dataset.mediaFolder;
    try {
      await request(`/api/files?path=${encodeURIComponent(folder)}`, { method: 'POST' });
    } catch (error) { if (error.status !== 409) return toast(error.message); }
    state.folder = folder; state.files = null; location.hash = 'files';
  }));
  $$('[data-action="refresh-network"]', $('#content')).forEach(button => button.addEventListener('click', loadNetwork));
  $$('[data-action="refresh-runtime"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Refreshing…';
    if (state.view === 'containers') await loadContainers();
    else await loadRuntimes();
  }));
  $$('[data-install]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const docker = state.runtimes?.docker;
    if (!docker?.available || !docker?.enabled) return toast(docker?.reason || 'Docker needs to be installed and enabled on this host before app installation.');
    const app = state.runtimes?.catalog?.find(item => item.id === button.dataset.install);
    if (!app) return toast('The selected application is no longer in the catalog.');
    const setup = {};
    if (app.requiresAdminPassword) {
      const password = prompt(`Create the ${app.name} administrator password (8–128 characters):`);
      if (password === null) return;
      if (password.length < 8 || password.length > 128) return toast('The application administrator password must contain 8–128 characters.');
      setup.adminPassword = password;
    } else if (!confirm(`Install ${app.name} on this NAS? This creates a container and publishes its web port.`)) return;
    button.disabled = true;
    button.textContent = 'Installing…';
    try {
      await request(`/api/catalog/${app.id}/install`, { method: 'POST', body: JSON.stringify(setup) });
      await loadRuntimes();
      toast(`${app.name} installed. Use Open application to access it.`);
    }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Install'; }
  }));
  $$('[data-app-action]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const { appId, appAction } = button.dataset;
    if (appAction === 'remove' && !confirm(`Remove ${appId}? Its saved app data will remain on this NAS.`)) return;
    button.disabled = true;
    try { await request(`/api/catalog/${appId}/${appAction}`, { method: 'POST' }); await loadRuntimes(); toast(`App ${appAction} complete.`); }
    catch (error) { toast(error.message); button.disabled = false; }
  }));
  for (const [selector, path, message] of [['#container-form', '/api/containers', 'Container created.'], ['#vm-form', '/api/vms', 'VM creation submitted. Check the host task status.']]) {
    $(selector, $('#content'))?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('button[type="submit"]', form);
      const error = $('.form-error', form);
      error.textContent = '';
      button.disabled = true;
      try {
        await request(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        if (path === '/api/containers') await loadContainers(); else await loadRuntimes();
        toast(message);
      }
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
  $$('[data-action="refresh-files"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Refreshing…';
    await loadFiles();
  }));
  $$('[data-library-tab]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const folder = button.dataset.libraryTab || '';
    if (folder) {
      try { await request(`/api/files?path=${encodeURIComponent(folder)}`); }
      catch {
        try { await request(`/api/files?path=${encodeURIComponent(folder)}`, { method: 'POST' }); }
        catch (error) { return toast(error.message); }
      }
    }
    state.folder = folder;
    state.files = null;
    render('files');
  }));
  $$('[data-folder]', $('#content')).forEach(button => button.addEventListener('click', () => { state.folder = button.dataset.folder; state.files = null; render('files'); }));
  $$('[data-open]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const path = [state.folder, button.dataset.open].filter(Boolean).join('/');
    if (button.dataset.directory === 'true') { state.folder = path; state.files = null; render('files'); return; }
    try { const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`); if (!response.ok) throw new Error((await response.json()).error); const object = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = object; link.download = button.dataset.open; link.click(); setTimeout(() => URL.revokeObjectURL(object), 60000); } catch (error) { toast(error.message); }
  }));
  $$('[data-download-folder]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const path = [state.folder, button.dataset.downloadFolder].filter(Boolean).join('/');
    const link = document.createElement('a');
    link.href = `/api/files/archive?path=${encodeURIComponent(path)}`;
    link.download = `${button.dataset.downloadFolder}.tar.gz`;
    link.click();
  }));
  $$('[data-action="new-folder"]', $('#content')).forEach(button => button.addEventListener('click', async () => { const name = prompt('New folder name'); if (name === null) return; try { await request(`/api/files?path=${encodeURIComponent([state.folder, name].filter(Boolean).join('/'))}`, { method: 'POST' }); await loadFiles(); toast('Folder created.'); } catch (error) { toast(error.message); } }));
  $('#file-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    let completed = 0;
    for (const file of files) {
      try {
        const response = await fetch(`/api/files?path=${encodeURIComponent([state.folder, file.name].filter(Boolean).join('/'))}`, { method: 'PUT', headers: { 'X-LightNAS-Request': '1' }, body: file });
        if (!response.ok) throw new Error((await response.json()).error);
        completed++;
      } catch (error) { toast(`${file.name}: ${error.message}`); break; }
    }
    await loadFiles();
    if (completed === files.length && completed) toast(`${completed} file${completed === 1 ? '' : 's'} uploaded.`);
  });
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
const consoleShell = $('#console');
function syncCollapsedSidebar() {
  if (!consoleShell.classList.contains('sidebar-collapsed')) return;
  $$('.nav-group', $('.sidebar')).forEach(group => group.setAttribute('open', ''));
}
if (localStorage.getItem('lightnas-sidebar-collapsed') === '1' && matchMedia('(min-width: 901px)').matches) {
  consoleShell.classList.add('sidebar-collapsed');
  syncCollapsedSidebar();
}
$('#menu').addEventListener('click', () => {
  if (matchMedia('(max-width: 900px)').matches) return $('.sidebar').classList.toggle('open');
  consoleShell.classList.toggle('sidebar-collapsed');
  syncCollapsedSidebar();
  localStorage.setItem('lightnas-sidebar-collapsed', consoleShell.classList.contains('sidebar-collapsed') ? '1' : '0');
});
$('#node-shell-button').addEventListener('click', () => window.open(`/node-console.html?v=${Date.now()}`, '_blank', 'noopener,width=1280,height=820'));
$('#avatar-upload').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const response = await fetch('/api/profile/avatar', { method: 'PUT', headers: { 'X-LightNAS-Request': '1', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to save profile picture.');
    state.overview.appliance.hasAvatar = true;
    $('#avatar').classList.add('has-photo');
    $('#avatar').style.backgroundImage = `url(/api/profile/avatar?v=${Date.now()})`;
    toast('Profile picture updated.');
  } catch (error) { toast(error.message); }
  event.target.value = '';
});
$('#theme-toggle').addEventListener('click', () => { theme = themeChoices[(themeChoices.indexOf(theme) + 1) % themeChoices.length]; localStorage.setItem('lightnas-theme', theme); applyTheme(); toast(`Appearance: ${theme}`); });
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
