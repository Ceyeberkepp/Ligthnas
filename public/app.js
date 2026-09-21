const state = { overview: null, view: 'home', folder: '', files: null, runtimes: null, runtimeError: null, spaces: null, users: null, smtp: undefined, media: null, network: null };
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

async function showConsole() {
  $('#boot').classList.add('hidden');
  $('#auth').classList.add('hidden');
  $('#console').classList.remove('hidden');
  state.overview = await request('/api/overview');
  const { appliance } = state.overview;
  $('#mini-name').textContent = appliance.deviceName;
  $('#avatar').textContent = appliance.username[0].toUpperCase();
  $$('[data-view]').forEach(link => link.classList.toggle('hidden', appliance.role !== 'administrator' && !['home', 'files', 'media'].includes(link.dataset.view)));
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
  try { state.users = (await request('/api/users')).users; if (state.view === 'users') render('users'); } catch (error) { toast(error.message); }
}

function usersView() {
  return `${pageHead('Administrators & users', 'Local accounts for the LightNAS browser; Linux and SMB accounts are separate.')}
    <article class="panel"><h2>Administrator</h2><p>${escapeHtml(state.overview.appliance.username)} · appliance owner</p></article>
    <form id="user-form" class="panel creation-form"><h2>Create local user</h2><p class="muted">Users can browse, upload and delete files. Only the appliance administrator manages settings and runtimes.</p><label>Username<input name="username" pattern="[a-zA-Z0-9._-]{3,32}" required></label><label>Password<input name="password" type="password" minlength="10" autocomplete="new-password" required></label><button class="primary" type="submit">Create user</button><div class="form-error" role="alert"></div></form>
    <h2>Users</h2><div class="storage-list">${state.users?.map(user => `<article class="storage-row"><div><h3>${escapeHtml(user.username)}</h3><p>${user.disabled ? 'Disabled' : 'Active'}</p></div><details class="user-manager"><summary>Manage account</summary><form data-manage-user="${escapeHtml(user.username)}"><label>Administrator password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New user password<input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="At least 10 characters"></label><div class="head-actions"><button class="secondary" type="submit" value="password">Reset password</button><button class="secondary" type="submit" value="${user.disabled ? 'enable' : 'disable'}">${user.disabled ? 'Enable' : 'Disable'}</button><button class="secondary" type="button" data-remove-user="${escapeHtml(user.username)}">Remove</button></div><div class="form-error" role="alert"></div></form></details></article>`).join('') || '<div class="empty"><p>No local users yet.</p></div>'}</div>`;
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
  return `${pageHead('Media & images', 'Upload documents, photos, video, and VM installer images into persistent storage.')}
    <div class="tool-grid">${[['Documents','Documents'],['Photos','Photos'],['Videos','Videos'],['ISO images','ISO']].map(([label, folder]) => `<article class="panel"><h2>${label}</h2><p class="muted">Keep files together in Files/${folder}.</p><button class="primary" data-media-folder="${folder}">Open ${label}</button></article>`).join('')}</div>
    <div class="module-hero"><h2>Conversion</h2><p>${state.media?.converterAvailable ? 'FFmpeg is ready. Administrators can convert supported media from the Files page to MP4, WebM, MP3, JPEG, PNG or WebP.' : 'FFmpeg is unavailable on this host. Install FFmpeg to enable media conversions.'} Conversion takes CPU and creates a new file beside the original. Document indexing and format conversion need separate services.</p></div>
    <div class="module-hero"><h2>VM image library</h2><p>ISO files uploaded here remain in LightNAS Files. A separate libvirt VM host must be configured to read its ISO directory; copying to that host is not automatic.</p></div>`;
}

async function loadMedia() {
  try { state.media = await request('/api/media'); if (['media', 'files'].includes(state.view)) render(state.view); } catch (error) { toast(error.message); }
}

async function loadRuntimes() {
  try { state.runtimes = await request('/api/runtimes'); state.runtimeError = null; }
  catch (error) { state.runtimeError = error.message; }
  if (['apps', 'containers', 'vms', 'integrations'].includes(state.view)) render(state.view);
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
  const runtime = state.runtimes?.containers;
  const diagnostics = runtime?.diagnostics;
  const networks = (runtime?.networks || []).map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  const images = (runtime?.images || []).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
  const ready = runtime?.available && runtime?.enabled && runtime.images?.length && runtime.networks?.length;
  const diagnosticPanel = diagnostics ? `<div class="inventory-grid">
    <article class="inventory-card"><h3>Nested mode</h3><p>${diagnostics.nested ? (diagnostics.nestedEnabled ? 'Enabled' : 'Detected but not enabled') : 'Not nested'}</p></article>
    <article class="inventory-card"><h3>cgroups</h3><p>${diagnostics.cgroupWritable ? 'Ready' : 'Blocked'}</p></article>
    <article class="inventory-card"><h3>Namespaces / veth</h3><p>${diagnostics.mountNamespace && diagnostics.networkNamespace && diagnostics.veth ? 'Ready' : 'Blocked'}</p></article>
    <article class="inventory-card"><h3>Container bridge</h3><p>${escapeHtml((diagnostics.bridges || []).join(', ') || 'Missing')}</p></article>
  </div>${diagnostics.errors?.length ? `<div class="module-note"><b>Nested self-test:</b> ${diagnostics.errors.map(escapeHtml).join(' · ')}</div>` : ''}` : '';
  return `${pageHead('System containers', 'Native Linux system containers powered by LXC/liblxc inside LightNAS itself.', '<div class="head-actions"><button class="secondary" data-action="refresh-runtime">Refresh</button><button class="primary" data-action="create-container">+ Create container</button></div>')}
    ${runtimeBanner('containers')}
    ${diagnosticPanel}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>Container network unavailable</h2><p>Create or enable a local bridge/network under Connectivity before launching a system container.</p></div>' : ''}
    ${ready ? '<div class="module-note"><b>Ready to create.</b> Use the + Create container button to open the guided setup wizard.</div>' : ''}
    <h2>Existing system containers</h2><div class="storage-list">${runtime?.containers?.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>Native LXC · ${escapeHtml(item.status)}${item.pid ? ` · PID ${item.pid}` : ''}</p></div><div class="storage-size">${escapeHtml(item.id || item.name)}</div></article>`).join('') || '<div class="empty"><p>No native system containers are visible.</p></div>'}</div>`;
}

function vmsView() {
  const runtime = state.runtimes?.virtualization;
  const diagnostics = runtime?.diagnostics;
  const ready = runtime?.available && runtime?.enabled && runtime.pools?.length && runtime.networks?.length;
  const choices = items => (items || []).map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  const acceleration = runtime?.acceleration === 'kvm' ? 'KVM hardware acceleration' : runtime?.acceleration === 'tcg' ? 'QEMU software virtualization (TCG)' : escapeHtml(runtime?.provider || 'QEMU/libvirt');
  const nestedVmPanel = diagnostics?.nested ? `<div class="inventory-grid">
    <article class="inventory-card"><h3>VM engine</h3><p>${escapeHtml(acceleration)}</p></article>
    <article class="inventory-card"><h3>KVM</h3><p>${diagnostics.kvm?.usable ? `Ready · API ${diagnostics.kvm.apiVersion}` : 'Not available · software VM mode will be used'}</p></article>
    <article class="inventory-card"><h3>TUN/TAP</h3><p>${diagnostics.tun ? 'Ready' : 'Missing /dev/net/tun'}</p></article>
  </div>` : '';
  const isoOptions = `<option value="">No ISO — create blank VM</option>${runtime?.isoDetails?.length ? runtime.isoDetails.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.storageName)} · ${bytes(item.sizeBytes)}</option>`).join('') : choices(runtime?.images || [])}`;
  return `${pageHead('Virtual machines', 'QEMU/libvirt virtual machines managed directly by LightNAS.', '<div class="head-actions"><button class="secondary" data-action="refresh-runtime">Refresh</button><button class="primary" data-action="create-vm">+ Create VM</button></div>')}
    ${runtimeBanner('virtualization')}
    ${runtime?.warning ? `<div class="module-note"><b>Software virtualization:</b> ${escapeHtml(runtime.warning)}</div>` : ''}
    ${nestedVmPanel}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>VM resources needed</h2><p>LightNAS needs an active local libvirt storage pool and network. The installer creates default resources automatically.</p></div>' : ''}
    ${ready ? '<div class="module-note"><b>Ready to create.</b> Use the + Create VM button to open the guided setup wizard.</div>' : ''}
    <h2>Existing VMs</h2><div class="storage-list">${runtime?.machineDetails?.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.status)} · ${item.cpus || '—'} vCPU · ${bytes(item.memory || 0)} RAM</p></div><div class="storage-size">${escapeHtml(runtime.provider || 'libvirt')}</div></article>`).join('') || '<div class="empty"><p>No local virtual machines are visible.</p></div>'}</div>`;
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
    <div class="file-toolbar"><div class="breadcrumbs">${crumbs}</div><div><button class="secondary" data-action="new-folder">+ Folder</button> <label class="primary upload-button">Upload files<input id="file-upload" type="file" multiple hidden></label></div></div>
    <p class="muted">Streamed uploads up to 1 GB; files stay on this host. These files are not an SMB or NFS share.</p>
    <div class="storage-list">${entries === null ? '<div class="empty"><p>Loading files…</p></div>' : entries.length ? entries.map(entry => `<article class="file-row"><button class="file-name" data-open="${escapeHtml(entry.name)}" data-directory="${entry.directory}">${entry.directory ? '▣' : '▤'} ${escapeHtml(entry.name)}</button><span class="muted">${entry.directory ? 'Folder' : bytes(entry.sizeBytes)}</span>${!entry.directory && state.media?.converterAvailable && state.overview.appliance.role === 'administrator' ? `<button class="secondary" data-convert-file="${escapeHtml(entry.name)}">Convert</button>` : ''}<button class="secondary" data-delete-file="${escapeHtml(entry.name)}">Delete</button></article>`).join('') : '<div class="empty"><p>This folder is empty. Create a folder or upload a file.</p></div>'}</div>`;
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

function adminView() {
  const { appliance } = state.overview;
  return `${pageHead('Admin Center', `Manage ${escapeHtml(appliance.deviceName)} and its connected services.`)}
    <div class="tool-grid">
      ${[['users','Users & access','Create or remove local accounts.'],['smtp','Email & SMTP','Configure encrypted outgoing email and send a test.'],['settings','Appliance','Change name, time zone and administrator password.'],['pools','Storage & datasets','Review disks, file spaces and ZFS datasets.'],['apps','Application catalog','Install reviewed open-source applications on an enabled host.'],['monitoring','System health','Check CPU, memory, mounts and recent activity.'],['network','Networking','View interfaces, addresses, gateways and DNS.'],['firewall','Firewall','Inspect the firewall status and available rules.'],['integrations','Integrations','View app and VM runtime connections.']].map(([view,title,description]) => `<article class="panel"><h2>${title}</h2><p class="muted">${description}</p><button class="secondary" data-view-link="${view}">Open ${title}</button></article>`).join('')}
    </div>`;
}

function moduleView(view) {
  if (view === 'apps') {
    const docker = state.runtimes?.docker;
    return `${pageHead('App Store', 'Choose an app and install it directly from LightNAS.', '<button class="secondary" data-action="refresh-runtime">Refresh apps</button>')}
      ${runtimeBanner('docker')}
      <div class="tool-grid">${state.runtimes?.catalog?.map(app => {
        const instance = docker?.containers?.find(container => container.name === `lightnas-app-${app.id}`);
        return `<article class="panel"><span class="eyebrow">${escapeHtml(app.category)}</span><h2>${escapeHtml(app.name)}</h2><p class="muted">${escapeHtml(app.description)}</p><p class="muted">${escapeHtml(app.image)} · Port ${app.port}</p>${instance ? `<p class="muted">${escapeHtml(instance.status || instance.state)}</p><div class="head-actions"><button class="secondary" data-app-action="${instance.state === 'running' ? 'stop' : 'start'}" data-app-id="${app.id}">${instance.state === 'running' ? 'Stop' : 'Start'}</button><button class="secondary" data-app-action="restart" data-app-id="${app.id}">Restart</button><button class="secondary" data-app-action="remove" data-app-id="${app.id}">Remove</button></div>` : `<button class="primary" data-install="${app.id}">Install app</button>`}</article>`;
      }).join('') || '<div class="empty"><p>Loading catalog…</p></div>'}</div>
      <section class="module-hero"><h2>App hosting</h2><p>The app buttons install reviewed containers through the local Docker engine and keep app data on the host. ${docker?.available && docker?.enabled ? 'Docker is ready.' : 'The local App Store engine is not ready yet. Rerun the LightNAS installer to provision it.'}</p></section>`;
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
  if (!info) return `${pageHead('Networking', 'Manage wired Ethernet, Wi‑Fi, bridges, VLANs, addressing, routes and DNS on the LightNAS host.', '<button class="secondary" data-action="refresh-network">Refresh</button>')}<div class="empty">Loading network inventory…</div>`;

  const defaultRoute = [...(info.routes || [])].filter(item => item.destination === 'default').sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0] || null;
  const routeDevice = defaultRoute?.device || '';
  const routeDeviceInfo = (control?.devices || []).find(item => item.name === routeDevice);
  const current = control?.currentUplink || (routeDevice ? {
    name: routeDevice,
    kind: routeDeviceInfo?.type === 'wifi' ? 'Wi-Fi' : 'Ethernet',
    connection: routeDeviceInfo?.connection || 'Kernel / hypervisor managed',
    gateway: defaultRoute?.gateway || null,
    metric: defaultRoute?.metric ?? null,
    active: true,
    managed: false
  } : null);

  const reportedUplinks = control?.uplinks || [];
  const uplinks = reportedUplinks.length ? reportedUplinks : (current ? [current] : []);
  const selectableUplinks = uplinks.filter(item => !item.active && item.managed !== false);
  const currentInterface = current ? info.interfaces.find(item => item.name === current.name) : null;
  const currentAddresses = currentInterface?.addresses?.filter(item => item.family === 'inet').map(item => `${item.address}/${item.prefix}`).join(', ') || 'No IPv4 address';
  const routeStatus = current?.managed === false ? 'kernel route active' : (control?.connectivity || 'route active');

  const wifiDevices = (control?.devices || []).filter(item => item.type === 'wifi' && !['unavailable','unmanaged'].includes(item.state));
  const isVirtual = item => item.type === 'bridge' || /^(docker\d*|virbr\d*|lightnas\d*|lxcbr\d*)$/i.test(item.name || '');
  const physicalDevices = (control?.devices || []).filter(item => item.name !== 'lo' && !isVirtual(item));
  const virtualDevices = (control?.devices || []).filter(item => item.name !== 'lo' && isVirtual(item));

  const virtualPurpose = name => /^lightnas/i.test(name) ? 'System containers · LightNAS NAT bridge'
    : /^virbr/i.test(name) ? 'Virtual machines · libvirt network'
    : /^docker/i.test(name) ? 'App Store · Docker network'
    : /^lxcbr/i.test(name) ? 'System containers · LXC network'
    : 'Virtual network';

  return `${pageHead('Networking', 'LightNAS detects the real default Internet route separately from VM, container and application virtual networks.', '<div class="head-actions"><button class="secondary" data-action="refresh-network">Refresh</button><button class="primary" data-network-add-bridge>+ Bridge</button><button class="secondary" data-network-add-vlan>+ VLAN</button></div>')}
    <section class="module-hero">
      <span class="eyebrow">CURRENT INTERNET CONNECTION</span>
      <h2>${current ? `${escapeHtml(current.kind)} · ${escapeHtml(current.name)}` : 'No active Internet uplink detected'}</h2>
      <p>${current ? `${escapeHtml(current.connection || 'Active connection')} · ${escapeHtml(currentAddresses)}${current.gateway ? ` · gateway ${escapeHtml(current.gateway)}` : ''} · ${escapeHtml(routeStatus)}` : 'Connect an available Ethernet or Wi-Fi interface below.'}</p>
    </section>

    ${uplinks.length ? `<h2>Internet uplinks</h2><div class="inventory-grid">${uplinks.map(item => `<article class="inventory-card"><div class="volume-title"><h3>${escapeHtml(item.kind || (item.type === 'wifi' ? 'Wi-Fi' : 'Ethernet'))} · ${escapeHtml(item.name)}</h3><span class="volume-state ${item.active ? 'writable' : ''}">${item.active ? 'CURRENT' : escapeHtml(String(item.state || 'AVAILABLE').toUpperCase())}</span></div><p>${escapeHtml(item.connection || (item.managed === false ? 'Kernel / hypervisor managed' : 'No active profile'))}</p>${!item.active && item.managed !== false && selectableUplinks.length ? `<button class="secondary" data-uplink-prefer="${escapeHtml(item.name)}">Use this connection</button>` : `<small>${item.active ? 'Active default Internet route' : item.managed === false ? 'Not controlled by NetworkManager' : 'Available uplink'}</small>`}</article>`).join('')}</div>` : '<div class="module-note">No Ethernet or Wi-Fi Internet route is currently available.</div>'}

    ${wifiDevices.length ? `<h2>Wi-Fi networks</h2><p class="muted">Wi-Fi appears only when LightNAS detects a usable wireless adapter. When both wired and Wi-Fi are available you can choose the preferred uplink.</p><div class="inventory-grid">${(control?.wifi || []).map(item => `<article class="inventory-card"><div class="volume-title"><h3>${escapeHtml(item.ssid)}</h3><span class="volume-state ${item.connected ? 'writable' : ''}">${item.connected ? 'CONNECTED' : `${item.signal}%`}</span></div><p>${escapeHtml(item.security || 'Open')}</p><button class="secondary" data-wifi-connect="${escapeHtml(item.ssid)}">${item.connected ? 'Use as preferred' : 'Connect'}</button></article>`).join('') || '<div class="empty">No Wi-Fi networks are currently in range.</div>'}</div>` : ''}

    <h2>Physical / uplink interfaces</h2><div class="storage-list">${physicalDevices.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.type)} · ${escapeHtml(item.state)} · ${escapeHtml(item.connection || (item.name === routeDevice ? 'Kernel / hypervisor managed' : 'No active profile'))}</p></div><div class="runtime-actions">${item.state === 'unmanaged' ? '<span class="badge">KERNEL MANAGED</span>' : item.state !== 'connected' ? `<button class="secondary" data-network-device="${escapeHtml(item.name)}" data-network-device-action="connect">Connect</button>` : `<button class="secondary" data-network-device="${escapeHtml(item.name)}" data-network-device-action="disconnect">Disconnect</button>`}</div></article>`).join('') || '<div class="empty">No physical Ethernet or Wi-Fi interfaces are visible.</div>'}</div>

    <h2>Virtual networks</h2><div class="storage-list">${virtualDevices.map(item => {
      const live = info.interfaces.find(iface => iface.name === item.name);
      const addresses = live?.addresses?.filter(address => address.family === 'inet').map(address => `${address.address}/${address.prefix}`).join(', ') || 'No IPv4 address';
      return `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(virtualPurpose(item.name))} · ${escapeHtml(live?.state || item.state || 'unknown')} · ${escapeHtml(addresses)}</p></div><span class="badge">${String(live?.state || item.state || '').toUpperCase() === 'UP' ? 'ACTIVE' : 'INACTIVE'}</span></article>`;
    }).join('') || '<div class="empty">No VM/container/application bridges are visible.</div>'}</div>

    <h2>Connection profiles</h2><div class="storage-list">${(control?.connections || []).filter(item => item.name !== 'lightnas0').map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.type)} · ${escapeHtml(item.device || 'not active')} · autoconnect ${item.autoconnect ? 'on' : 'off'}</p></div><div class="runtime-actions"><button class="secondary" data-network-edit="${escapeHtml(item.name)}">Edit IPv4 / DNS</button><button class="secondary danger-button" data-network-delete="${escapeHtml(item.name)}">Delete</button></div></article>`).join('') || '<div class="empty">No NetworkManager connection profiles are visible.</div>'}</div>

    <details class="panel"><summary><b>Advanced network details</b></summary>
      <h2>Live addresses</h2><div class="storage-list">${info.interfaces.map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.state || 'unknown')} · ${escapeHtml(item.mac || 'MAC unavailable')}</p></div><p>${item.addresses.map(address => `${escapeHtml(address.address)}/${address.prefix}`).join('<br>') || 'No addresses'}</p></article>`).join('') || '<div class="empty">No interfaces accessible.</div>'}</div>
      <h2>Routes</h2><div class="storage-list">${info.routes.map(route => `<article class="storage-row"><h3>${escapeHtml(route.destination)}</h3><p>via ${escapeHtml(route.gateway || 'on-link')} · ${escapeHtml(route.device)}${route.metric !== null ? ` · metric ${route.metric}` : ''}</p></article>`).join('') || '<div class="empty">No routes accessible.</div>'}</div>
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
  state.view = ['home', 'storage', 'pools', 'files', 'media', 'users', 'smtp', 'admin', 'shares', 'capabilities', 'apps', 'containers', 'vms', 'monitoring', 'settings', 'network', 'firewall', 'integrations'].includes(view) ? view : 'home';
  if (state.overview.appliance.role !== 'administrator' && !['home', 'files', 'media'].includes(state.view)) state.view = 'home';
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
  if (['apps', 'containers', 'vms', 'integrations'].includes(state.view) && !state.runtimes && !state.runtimeError) loadRuntimes();
}

function bindViewActions() {
  $$('[data-action="create-pool"]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const storage = state.overview.storage;
    if (!storage.disks.length) return toast('No physical disks are exposed to this NAS. Attach data disks to a VM or install on bare metal.');
    toast('Physical pool creation needs the disk safety agent before it can operate. Existing ZFS datasets can be created below.');
    $('#dataset-form', $('#content'))?.scrollIntoView({ behavior: 'smooth' });
  }));
  $$('[data-action="create-container"]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const containers = state.runtimes?.containers;
    if (!containers?.available || !containers.enabled) return toast(containers?.reason || 'Native LXC is not ready on this LightNAS host.');
    if (!containers.images?.length) return toast('No built-in Linux container images are available.');
    if (!containers.networks?.length) return toast('No local LXC bridge is ready. Open Networking or rerun the LightNAS installer to prepare lxcbr0/lightnas0.');
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
    try { await request('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); await loadUsers(); toast('User created.'); }
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
  $$('[data-action="refresh-runtime"]', $('#content')).forEach(button => button.addEventListener('click', loadRuntimes));
  $$('[data-install]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const docker = state.runtimes?.docker;
    if (!docker?.available || !docker?.enabled) return toast(docker?.reason || 'Docker needs to be installed and enabled on this host before app installation.');
    if (!confirm(`Install ${button.dataset.install} on this NAS? This creates a container and publishes its web port.`)) return;
    button.disabled = true;
    button.textContent = 'Installing…';
    try { await request(`/api/catalog/${button.dataset.install}/install`, { method: 'POST' }); await loadRuntimes(); toast('App installed.'); }
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
$('#menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
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
