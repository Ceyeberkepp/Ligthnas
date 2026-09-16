const state = { overview: null, view: 'home' };
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
  return `<div class="page-head"><div><span class="eyebrow">LIGHTNAS CONTROL CENTER</span><h1>${title}</h1><p>${description}</p></div>${action || '<span class="health-pill"><i></i>All systems normal</span>'}</div>`;
}

function metric(label, value, percent, detail) {
  return `<article class="metric"><div class="metric-head"><span>${label}</span><span>${percent}%</span></div><strong>${value}</strong><div class="track"><span style="width:${Math.min(100, percent)}%"></span></div><small>${detail}</small></article>`;
}

function homeView() {
  const { system, filesystems, shares, activity, appliance, protection } = state.overview;
  const total = filesystems.reduce((sum, item) => sum + item.totalBytes, 0);
  const used = filesystems.reduce((sum, item) => sum + item.usedBytes, 0);
  const storagePercent = total ? Math.round((used / total) * 100) : 0;
  return `${pageHead(`Good day, ${escapeHtml(appliance.username)}`, `Here’s what is happening on ${escapeHtml(appliance.deviceName)}.`)}
    <section class="hero">
      <div><span class="eyebrow">SYSTEM OVERVIEW</span><h2>Your private cloud is healthy.</h2><p>Core storage services are online. Configure a backup destination next to make your data protection complete.</p><div class="hero-actions"><button class="primary" data-action="new-share">Create shared folder</button><button class="secondary" data-view-link="storage">Review storage</button></div></div>
      <div class="hero-stat"><strong>${filesystems.length}</strong><span>mounted filesystems</span></div>
    </section>
    <section class="metric-grid">
      ${metric('Storage', bytes(used), storagePercent, `${bytes(total - used)} available`)}
      ${metric('Memory', bytes(system.memory.usedBytes), system.memory.usedPercent, `${bytes(system.memory.totalBytes)} installed`)}
      ${metric('CPU load', `${system.cpu.loadPercent}%`, system.cpu.loadPercent, `${system.cpu.cores} logical cores`)}
      ${metric('Protection', protection.backupConfigured ? 'Current' : 'Not set', protection.backupConfigured ? 100 : 0, protection.backupConfigured ? 'Last backup verified' : 'Backup needs attention')}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><h2>Shared folders</h2><button class="panel-link" data-action="new-share">+ New share</button></div>${shares.length ? `<div class="share-list">${shares.slice(0, 4).map(share => `<div class="share-row"><div><h3>${escapeHtml(share.name)}</h3><p>${escapeHtml(share.protocol)} · ${escapeHtml(share.description || 'No description')}</p></div></div>`).join('')}</div>` : `<div class="empty"><div><div class="empty-icon">□</div><h3>No shared folders yet</h3><p>Create a secure space for documents, media, backups, or team files.</p><button class="secondary" data-action="new-share">Create your first share</button></div></div>`}</article>
      <article class="panel"><div class="panel-head"><h2>Recent activity</h2><button class="panel-link" data-view-link="monitoring">View all</button></div><div class="activity-list">${activity.length ? activity.map(item => `<div class="activity"><span class="activity-icon">${item.type === 'setup' ? '✓' : item.type === 'share' ? '□' : '↗'}</span><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No recent activity.</p>'}</div></article>
    </section>`;
}

function storageView() {
  const { filesystems } = state.overview;
  return `${pageHead('Storage', 'Inspect mounted filesystems, capacity, and utilization.', '<button class="primary" data-action="new-share">Create share</button>')}
    <div class="storage-list">${filesystems.map(fs => `<article class="storage-row"><div><h3>${escapeHtml(fs.mountPoint)}</h3><p>${escapeHtml(fs.device)} · ${escapeHtml(fs.type)}${fs.readOnly ? ' · Read only' : ''}</p></div><div><div class="track"><span style="width:${fs.usedPercent}%"></span></div><p>${fs.usedPercent}% used</p></div><div class="storage-size"><b>${bytes(fs.usedBytes)}</b><br>of ${bytes(fs.totalBytes)}</div></article>`).join('') || '<div class="empty"><p>No physical filesystems were detected.</p></div>'}</div>`;
}

function capabilitiesView() {
  const { system } = state.overview;
  return `${pageHead('System capabilities', 'Features are unlocked only when this hardware can run them safely.')}
    <div class="capability-list">${system.capabilities.map(item => `<article class="capability-row"><div><b>${escapeHtml(item.name)}</b><p>${escapeHtml(item.available ? `Hardware requirement met · ${item.minimum}` : item.reason)}</p></div><span class="badge ${item.available ? 'available' : 'gated'}">${item.available ? 'AVAILABLE' : 'HARDWARE GATED'}</span></article>`).join('')}</div>`;
}

const moduleDetails = {
  files: ['Files', 'Browse, upload, share, and restore files from any screen size.', '□', 'The file-browser service will connect to managed shares in the next milestone.'],
  apps: ['App Center', 'Install trusted applications with clear permissions and resource limits.', '✦', 'The signed OCI app manifest and catalog arrive in Phase 2.'],
  containers: ['Containers', 'Run portable services with Compose-compatible projects and safe defaults.', '⬡', 'Requires the Containers capability and the Phase 2 runtime.'],
  vms: ['Virtual machines', 'Create and manage KVM virtual machines, templates, snapshots, and networks.', '▣', 'Requires VT-x or AMD-V, at least 8 GB RAM, and the Phase 3 runtime.'],
  ai: ['AI Center', 'Connect local, network, or remote models to explain health and propose safe actions.', '✣', 'Remote and network-node providers come first; local inference is hardware-gated.'],
  identity: ['Users & Identity', 'Manage local users, LDAP, SSO, and optional Samba directory services.', '♙', 'Local roles are foundational; directory integrations arrive in Phase 5.'],
  protection: ['Data Protection', 'Protect shares, applications, and VMs with verified restore workflows.', '◈', 'Backup jobs and retention policies are the next core NAS milestone.'],
  monitoring: ['Monitoring', 'Understand health, performance, audit events, and system changes.', '⌁', 'Live host metrics are active. Historical metrics and alert routing come next.']
};

function moduleView(view) {
  const [title, description, icon, requirement] = moduleDetails[view];
  return `${pageHead(title, description)}<section class="module-hero"><div class="module-icon">${icon}</div><h2>${title} is designed into the platform.</h2><p>${description} This screen establishes its permanent place in the product while the underlying service is implemented as a separately testable module.</p><div class="requirement"><b>Milestone status</b><br>${requirement}</div></section>${view === 'monitoring' ? `<section class="metric-grid">${metric('CPU load', `${state.overview.system.cpu.loadPercent}%`, state.overview.system.cpu.loadPercent, state.overview.system.cpu.model)}${metric('Memory', bytes(state.overview.system.memory.usedBytes), state.overview.system.memory.usedPercent, `${bytes(state.overview.system.memory.freeBytes)} free`)}${metric('Uptime', duration(state.overview.system.uptimeSeconds), 100, state.overview.system.kernel)}${metric('Filesystems', state.overview.filesystems.length, 100, 'Currently mounted')}</section>` : ''}`;
}

function render(view) {
  state.view = view in moduleDetails || ['home', 'storage', 'capabilities'].includes(view) ? view : 'home';
  const content = $('#content');
  content.innerHTML = state.view === 'home' ? homeView() : state.view === 'storage' ? storageView() : state.view === 'capabilities' ? capabilitiesView() : moduleView(state.view);
  $$('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === state.view));
  content.focus({ preventScroll: true });
  bindViewActions();
}

function bindViewActions() {
  $$('[data-action="new-share"]', $('#content')).forEach(button => button.addEventListener('click', () => $('#share-dialog').showModal()));
  $$('[data-view-link]', $('#content')).forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.viewLink; }));
}

async function submitAuth(form, path) {
  const error = $('.form-error', form);
  const button = $('button[type="submit"]', form);
  error.textContent = '';
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    data.updates = form.elements.updates?.checked;
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
    toast('Shared folder definition created.');
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
