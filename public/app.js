const state = { overview: null, view: 'home', folder: '', files: null, fileError: null, filesSettingsOpen: false, aiMessages: [], fileView: ['list','grid','gallery'].includes(localStorage.getItem('lightnas-file-view')) ? localStorage.getItem('lightnas-file-view') : 'grid', fileTruncated: false, overviewMetric: localStorage.getItem('lightnas-overview-metric') || 'cpu', lastNetworkSample: null, runtimes: null, runtimeError: null, containerError: null, spaces: null, users: null, groups: null, smtp: undefined, media: null, network: null, metricHistory: { cpu: [], load: [], memory: [], storage: [], networkIn: [], networkOut: [] } };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const themeChoices = ['system', 'light', 'dark'];
let theme = themeChoices.includes(localStorage.getItem('lightnas-theme')) ? localStorage.getItem('lightnas-theme') : 'system';
let overviewTimer = null;
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
  if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed.'), { status: response.status, payload: body });
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

function b64urlBytes(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function bytesB64url(value) {
  const bytes = new Uint8Array(value);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function serializePasskeyAssertion(credential) {
  const response = credential?.response;
  if (!credential?.id || !response?.clientDataJSON || !response?.authenticatorData || !response?.signature) {
    throw new Error('The passkey response was incomplete.');
  }
  return {
    id: credential.id,
    clientDataJSON: bytesB64url(response.clientDataJSON),
    authenticatorData: bytesB64url(response.authenticatorData),
    signature: bytesB64url(response.signature),
    userHandle: response.userHandle ? bytesB64url(response.userHandle) : null
  };
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

function selectLoginMethod(method) {
  const box = $('#login-mfa');
  if (!box || box.classList.contains('hidden')) return;
  $$('[data-login-method]', box).forEach(button => {
    const active = button.dataset.loginMethod === method;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('[data-login-panel]', box).forEach(panel => panel.classList.toggle('hidden', panel.dataset.loginPanel !== method));
  box.dataset.method = method || '';
}

function setLoginMethods(methods = []) {
  const box = $('#login-mfa');
  if (!box) return;
  const enabled = new Set(methods);
  $$('[data-login-method]', box).forEach(button => button.classList.toggle('hidden', !enabled.has(button.dataset.loginMethod)));
  box.classList.toggle('hidden', enabled.size === 0);
  const current = box.dataset.method;
  selectLoginMethod(enabled.has(current) ? current : (methods[0] || ''));
}

let loginOptionsTimer = null;
async function refreshLoginMethods() {
  clearTimeout(loginOptionsTimer);
  const username = $('#login-form input[name="username"]')?.value.trim() || '';
  if (!username) return setLoginMethods([]);
  try {
    const options = await request(`/api/login/options?username=${encodeURIComponent(username)}`);
    setLoginMethods(Array.isArray(options.methods) ? options.methods : []);
    const smsStatus = $('#login-sms-status');
    if (smsStatus) smsStatus.textContent = options.smsDestination ? `Codes will be sent to ${options.smsDestination}.` : '';
  } catch {
    setLoginMethods([]);
  }
}

function featureEnabled(view, appliance = state.overview?.appliance) {
  const features = appliance?.features || {};
  const mapping = { apps:'appStore', containers:'containers', vms:'virtualMachines', ai:'ai', integrations:'integrations' };
  const key = mapping[view];
  return !key || features[key] !== false;
}

function canView(view, appliance = state.overview?.appliance) {
  if (!appliance || !featureEnabled(view, appliance)) return false;
  if (appliance.role === 'administrator') return true;
  const allowed = new Set(appliance.permissions || []);
  const required = {
    home: ['overview.view'], files: ['files.read'], media: ['files.read'], storage: ['storage.view'], pools: ['pools.view', 'storage.manage'], shares: ['shares.view', 'shares.manage'],
    apps: ['apps.view', 'apps.manage'], ai: ['apps.view', 'apps.manage', 'system.view'], containers: ['containers.view', 'containers.manage', 'containers.console'], vms: ['vms.view', 'vms.manage', 'vms.console'],
    network: ['network.view'], firewall: ['firewall.view', 'firewall.manage', 'network.manage'], monitoring: ['monitoring.view', 'system.view'], capabilities: ['capabilities.view', 'system.view'],
    integrations: ['integrations.view', 'integrations.manage'], assistant: ['admin.view', 'system.view'], users: ['users.manage'], permissions: ['users.manage'], shell: ['system.shell'], smtp: ['smtp.manage'], settings: ['settings.manage'], admin: ['admin.view']
  }[view];
  return Array.isArray(required) && (!required.length || required.some(permission => allowed.has(permission)));
}

function applyApplianceBranding(appliance = state.overview?.appliance) {
  if (!appliance) return;
  const brandName = String(appliance.brandName || 'LightNAS').trim() || 'LightNAS';
  const logoUrl = appliance.logo ? `url("/api/branding/logo?v=${Date.now()}")` : '';
  $$('.brand-mark').forEach(mark => {
    mark.classList.toggle('custom-logo', Boolean(appliance.logo));
    mark.style.backgroundImage = logoUrl;
  });
  $$('[data-brand-name]').forEach(node => { node.textContent = brandName; });
}

async function showConsole() {
  $('#boot').classList.add('hidden');
  $('#auth').classList.add('hidden');
  $('#console').classList.remove('hidden');
  state.overview = await request('/api/overview');
  captureOverviewMetrics();
  const { appliance } = state.overview;
  $('#mini-name').textContent = appliance.deviceName;
  applyApplianceBranding(appliance);
  const avatar = $('#avatar');
  avatar.textContent = appliance.avatar ? '' : appliance.username[0].toUpperCase();
  avatar.style.backgroundImage = appliance.avatar ? `url("/api/profile/avatar?v=${Date.now()}")` : '';
  avatar.classList.toggle('has-photo', Boolean(appliance.avatar));
  $$('[data-view]').forEach(link => link.classList.toggle('hidden', !canView(link.dataset.view, appliance)));
  $('#node-shell-top')?.classList.toggle('hidden', !canView('shell', appliance));
  $$('.nav-group').forEach(group => group.classList.toggle('hidden', !group.querySelector('[data-view]:not(.hidden)')));
  render(location.hash.slice(1) || 'home');
  $$('#nav a[data-view], .foot-admin[data-view]').forEach(link => {
    const label = link.textContent.replace(/\s+/g, ' ').trim();
    if (label) link.title = label;
  });
  rememberStorageSignature();
  clearInterval(overviewTimer);
  overviewTimer = setInterval(async () => {
    if (!['home', 'monitoring'].includes(state.view) || $('#console').classList.contains('hidden')) return;
    try {
      state.overview = await request('/api/overview');
      captureOverviewMetrics();
      render(state.view);
    } catch {}
  }, 5000);
}

function storageInventorySignature(source = state.overview) {
  const storage = source?.storage || source || {};
  const disks = (storage.disks || []).map(item => [item.path, item.sizeBytes, item.system, item.blank].join(':')).sort();
  const volumes = (storage.attachedVolumes || []).map(item => [item.device, item.mountPoint, item.totalBytes].join(':')).sort();
  return JSON.stringify({ disks, volumes });
}

let lastStorageSignature = '';
function rememberStorageSignature() {
  lastStorageSignature = storageInventorySignature();
}

async function autoDetectStorage() {
  if (!state.overview || document.hidden || $('#console')?.classList.contains('hidden')) return;
  try {
    const scan = await request('/api/storage/scan');
    const signature = storageInventorySignature(scan);
    const changed = Boolean(lastStorageSignature && signature !== lastStorageSignature);
    if (!lastStorageSignature) lastStorageSignature = signature;
    if (changed) {
      // Only pay for a full overview refresh when the lightweight disk scan
      // actually sees a topology/capacity change.
      state.overview = await request('/api/overview');
      lastStorageSignature = storageInventorySignature();
      if (['home', 'storage', 'pools'].includes(state.view)) render(state.view);
      toast('New or changed storage detected.');
    }
  } catch {}
}

setInterval(autoDetectStorage, 12000);
addEventListener('focus', () => { if (['home', 'storage', 'pools'].includes(state.view)) autoDetectStorage(); });

function pageHead(title, description, action = '') {
  return `<div class="page-head"><div><span class="eyebrow">LIGHTNAS CONTROL CENTER</span><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}

function metric(label, value, percent, detail) {
  return `<article class="metric"><div class="metric-head"><span>${label}</span><span>${percent}%</span></div><strong>${value}</strong><div class="track"><span style="width:${Math.min(100, percent)}%"></span></div><small>${detail}</small></article>`;
}

function captureOverviewMetrics() {
  if (!state.overview) return;
  const system = state.overview.system || {};
  const storage = state.overview.storage?.usableStorage || state.overview.storage?.virtualStorage || state.overview.storage?.local || {};
  const currentNetwork = system.network || {};
  const now = Date.now();
  const elapsed = state.lastNetworkSample ? Math.max(.001, (now - state.lastNetworkSample.time) / 1000) : 0;
  const receivedRate = elapsed ? Math.max(0, (Number(currentNetwork.receivedBytes || 0) - state.lastNetworkSample.receivedBytes) / elapsed) : 0;
  const transmittedRate = elapsed ? Math.max(0, (Number(currentNetwork.transmittedBytes || 0) - state.lastNetworkSample.transmittedBytes) / elapsed) : 0;
  state.lastNetworkSample = { time: now, receivedBytes: Number(currentNetwork.receivedBytes || 0), transmittedBytes: Number(currentNetwork.transmittedBytes || 0) };
  const sample = {
    cpu: Number(system.cpu?.loadPercent) || 0,
    load: Number(system.cpu?.loadAverage?.[0]) || 0,
    memory: Number(system.memory?.usedPercent) || 0,
    storage: Number(storage.usedPercent) || 0,
    networkIn: receivedRate,
    networkOut: transmittedRate
  };
  for (const [key, value] of Object.entries(sample)) {
    state.metricHistory[key].push(value);
    if (state.metricHistory[key].length > 60) state.metricHistory[key].shift();
  }
}

function overviewChart(label, value, suffix, history, maximum = 100, detail = '') {
  const points = history.length > 1 ? history : [history[0] || 0, history[0] || 0];
  const ceiling = Math.max(maximum, ...points, 1);
  const coordinates = points.map((item, index) => `${(index / Math.max(points.length - 1, 1)) * 100},${38 - (Math.min(ceiling, item) / ceiling) * 34}`).join(' ');
  return `<article class="overview-chart panel"><div class="overview-chart-head"><div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}${escapeHtml(suffix)}</strong></div><div class="overview-chart-context">${detail ? `<b>${escapeHtml(detail)}</b>` : ''}<small>Live · last ${points.length} sample${points.length === 1 ? '' : 's'}</small></div></div><svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)} history"><defs><linearGradient id="chart-${escapeHtml(label.replace(/\W/g, ''))}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".52"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".04"/></linearGradient></defs><polygon points="0,40 ${coordinates} 100,40" fill="url(#chart-${escapeHtml(label.replace(/\W/g, ''))})"/><polyline points="${coordinates}" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg></article>`;
}

function overviewNetworkChart(system) {
  const received = state.metricHistory.networkIn.length > 1 ? state.metricHistory.networkIn : [0, 0];
  const transmitted = state.metricHistory.networkOut.length > 1 ? state.metricHistory.networkOut : [0, 0];
  const ceiling = Math.max(...received, ...transmitted, 1024);
  const points = values => values.map((item, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${38 - (Math.min(ceiling, item) / ceiling) * 34}`).join(' ');
  return `<article class="overview-chart panel"><div class="overview-chart-head"><div><span>Network throughput</span><strong>↓ ${bytes(received.at(-1) || 0)}/s · ↑ ${bytes(transmitted.at(-1) || 0)}/s</strong></div><div class="overview-chart-context"><b>${system.network?.interfaces || 0} active interface${system.network?.interfaces === 1 ? '' : 's'}</b><small>RX ${bytes(system.network?.receivedBytes || 0)} · TX ${bytes(system.network?.transmittedBytes || 0)}</small></div></div><svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Network receive and transmit history"><polyline points="${points(received)}" fill="none" stroke="var(--accent)" stroke-width="1.4" vector-effect="non-scaling-stroke"/><polyline points="${points(transmitted)}" fill="none" stroke="#6f7cff" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg><div class="chart-legend"><span><i></i>Received</span><span><i class="sent"></i>Sent</span></div></article>`;
}

function homeView() {
  const { system, filesystems, storage, shares, activity, appliance } = state.overview;
  const visibleStorage = storage.usableStorage || storage.virtualStorage || storage.local || { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0, count: 0 };
  const total = visibleStorage.totalBytes || 0;
  const used = visibleStorage.usedBytes || 0;
  const available = visibleStorage.availableBytes ?? Math.max(0, total - used);
  const storagePercent = visibleStorage.usedPercent ?? (total ? Math.round((used / total) * 100) : 0);
  const loadAverage = system.cpu.loadAverage || [0, 0, 0];
  const graphButtons = [['cpu','CPU'],['load','Load'],['memory','Memory'],['storage','Storage'],['network','Network']].map(([id, label]) => `<button type="button" class="${state.overviewMetric === id ? 'active' : ''}" data-overview-metric="${id}" aria-pressed="${state.overviewMetric === id}">${label}</button>`).join('');
  const graph = state.overviewMetric === 'network' ? overviewNetworkChart(system)
    : state.overviewMetric === 'load' ? overviewChart('System load', `${loadAverage[0]}`, '', state.metricHistory.load, Math.max(2, system.cpu.cores), `1m ${loadAverage[0]} · 5m ${loadAverage[1]} · 15m ${loadAverage[2]} · ${system.cpu.cores} CPUs`)
    : state.overviewMetric === 'memory' ? overviewChart('Memory usage', `${system.memory.usedPercent}`, '%', state.metricHistory.memory, 100, `${bytes(system.memory.usedBytes)} used · ${bytes(system.memory.totalBytes)} total · ${bytes(system.memory.freeBytes)} free`)
    : state.overviewMetric === 'storage' ? overviewChart('Storage usage', `${storagePercent}`, '%', state.metricHistory.storage, 100, `${bytes(used)} used · ${bytes(total)} total · ${bytes(available)} free`)
    : overviewChart('CPU usage', `${system.cpu.loadPercent}`, '%', state.metricHistory.cpu, 100, `${system.cpu.cores} logical CPUs · ${system.cpu.model || 'CPU model unavailable'}`);
  return `${pageHead('Overview', 'Live system health and storage at a glance.', '<button class="secondary" data-action="refresh">Refresh</button>')}
    <section class="node-overview-grid">
      <article class="panel node-summary-card"><div class="panel-head"><div><span class="eyebrow">${escapeHtml(appliance.deviceName)}</span><h2>System status</h2></div><span class="volume-state writable">ONLINE</span></div>
        <div class="node-usage-row"><span>CPU usage</span><div class="track"><span style="width:${system.cpu.loadPercent}%"></span></div><b>${system.cpu.loadPercent}% of ${system.cpu.cores} CPU(s)</b></div>
        <div class="node-usage-row"><span>Load average</span><div class="track"><span style="width:${Math.min(100, (loadAverage[0] / Math.max(system.cpu.cores, 1)) * 100)}%"></span></div><b>${loadAverage.join(', ')}</b></div>
        <div class="node-usage-row"><span>RAM usage</span><div class="track"><span style="width:${system.memory.usedPercent}%"></span></div><b>${system.memory.usedPercent}% · ${bytes(system.memory.usedBytes)} of ${bytes(system.memory.totalBytes)}</b></div>
        <div class="node-usage-row"><span>Storage</span><div class="track"><span style="width:${storagePercent}%"></span></div><b>${storagePercent}% · ${bytes(used)} of ${bytes(total)}</b></div>
        <dl class="node-facts"><div><dt>CPU</dt><dd>${escapeHtml(system.cpu.model)}</dd></div><div><dt>Kernel</dt><dd>${escapeHtml(system.kernel)}</dd></div><div><dt>Architecture</dt><dd>${escapeHtml(system.architecture)}</dd></div><div><dt>Mounted filesystems</dt><dd>${filesystems.length}</dd></div><div><dt>Available storage</dt><dd>${bytes(available)}</dd></div></dl>
      </article>
      <section class="overview-graph-panel"><nav class="overview-graph-tabs" aria-label="Performance graph">${graphButtons}</nav>${graph}</section>
    </section>
    <section class="dashboard-grid overview-bottom-grid">
      <article class="panel"><div class="panel-head"><h2>Shares</h2><button class="panel-link" data-view-link="shares">Open shares</button></div>${shares.length ? `<div class="share-list">${shares.slice(0, 4).map(share => `<div class="share-row"><div><h3>${escapeHtml(share.name)}</h3><p>${escapeHtml(share.protocol)} · ${escapeHtml(share.description || 'No description')}</p></div></div>`).join('')}</div>` : '<p class="muted">No shares configured.</p>'}</article>
      <article class="panel"><div class="panel-head"><h2>Recent activity</h2><button class="panel-link" data-view-link="monitoring">View all</button></div><div class="activity-list">${activity.length ? activity.slice(0, 5).map(item => `<div class="activity"><span class="activity-icon">${item.type === 'setup' ? '✓' : '↗'}</span><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No recent activity.</p>'}</div></article>
    </section>`;
}

function storageView() {
  const spaces = Array.isArray(state.spaces) ? state.spaces : [];
  return `${pageHead('Storage', 'LightNAS storage pools, capacity and content libraries.', '<div class="head-actions"><button class="secondary" data-action="refresh-storage">Rescan drives</button><button class="primary" data-view-link="pools">Manage storage</button></div>')}
    <div id="storage-manager"></div>
    ${spaces.length ? `<section class="storage-spaces-section"><div class="section-heading"><div><span class="eyebrow">FILE STORAGE</span><h2>LightNAS storage spaces</h2></div></div><div class="storage-list">${spaces.map(space => `<article class="storage-row"><div><h3>${escapeHtml(space.label)}</h3><p>Spaces/${escapeHtml(space.name)}</p></div><button class="secondary" data-open-space="${escapeHtml(space.name)}">Open</button></article>`).join('')}</div></section>` : ''}`;
}

function poolsView() {
  const storage = state.overview.storage || {};
  const zfs = storage.zfs || { available: false, canManageDatasets: false, pools: [], datasets: [] };
  const disks = storage.disks || storage.detectedDisks || [];
  const configuredPools = storage.configuredPools || [];
  const availableSources = storage.availableSources || [];
  const poolOptions = [...(zfs.pools || []), ...(zfs.datasets || []).filter(item => !(zfs.pools || []).some(pool => pool.name === item.name))];
  const deviceCount = disks.length + availableSources.length;
  return `${pageHead('Pools & datasets', 'Manage LightNAS storage pools, volumes and ZFS datasets from one place.', '<div class="head-actions"><button class="secondary" data-action="refresh-storage">Rescan drives</button><button class="secondary" data-view-link="storage">Storage inventory</button><button class="primary" type="button" data-create-storage>+ Add storage</button></div>')}
    <section class="pool-summary-grid">
      <article class="panel pool-summary"><span class="eyebrow">STORAGE POOLS</span><strong>${configuredPools.length}</strong><p>${configuredPools.length ? 'available to LightNAS' : 'inventory is still empty'}</p></article>
      <article class="panel pool-summary"><span class="eyebrow">DEVICES & VOLUMES</span><strong>${deviceCount}</strong><p>${deviceCount ? 'detected by the appliance' : 'none exposed by this host'}</p></article>
      <article class="panel pool-summary"><span class="eyebrow">DATASETS</span><strong>${zfs.datasets?.length || 0}</strong><p>${zfs.available ? 'ZFS storage objects' : 'Not configured'}</p></article>
    </section>
    <section class="storage-workspace">
      <div class="section-heading"><div><span class="eyebrow">POOL INVENTORY</span><h2>Storage pools</h2></div></div>
      <div class="storage-list compact-empty-list">${configuredPools.map(pool => `<article class="storage-row pool-inventory-row"><div><h3>${escapeHtml(pool.name)}</h3><p>${escapeHtml(pool.provider || pool.type || 'directory').toUpperCase()} · ${escapeHtml(pool.mountPoint || 'not mounted')} · ${(pool.contentLabels || []).map(escapeHtml).join(', ') || 'general storage'}</p></div><div><div class="track"><span style="width:${pool.usedPercent || 0}%"></span></div><p>${bytes(pool.availableBytes || 0)} free · ${pool.online ? 'online' : 'offline'}</p></div><div class="storage-size"><b>${bytes(pool.usedBytes || 0)}</b><br>of ${bytes(pool.totalBytes || 0)}</div></article>`).join('') || '<div class="empty compact-empty"><h3>No storage pool inventory yet</h3><p>Use Rescan drives. If LightNAS is running inside an LXC or VM, expose a host volume or disk to the guest first.</p></div>'}</div>
    </section>
    ${zfs.available ? `<section class="storage-workspace dataset-workspace">
      <div class="section-heading"><div><span class="eyebrow">DATASETS</span><h2>ZFS datasets</h2></div>${zfs.canManageDatasets ? '<button class="primary" type="button" data-show-dataset-form>+ Create dataset</button>' : ''}</div>
      ${zfs.canManageDatasets ? `<form id="dataset-form" class="panel creation-form dataset-create-form" hidden>
        <label>Parent pool or dataset<select name="parent" required>${poolOptions.map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join('')}</select></label>
        <label>Dataset name<input name="name" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}" required placeholder="media"></label>
        <label>Compression<select name="compression"><option value="lz4">LZ4</option><option value="zstd">Zstandard</option><option value="gzip">Gzip</option><option value="off">Off</option></select></label>
        <label>Quota (GiB)<input name="quotaGiB" type="number" min="0" max="1048576" value="0"><small>Zero means unlimited.</small></label>
        <button class="primary" type="submit">Create dataset</button><div class="form-error" role="alert"></div>
      </form>` : ''}
      <div class="dataset-grid">${zfs.datasets?.map(dataset => `<article class="panel dataset-card"><div><span class="eyebrow">DATASET</span><h3>${escapeHtml(dataset.name)}</h3><p>${escapeHtml(dataset.mountPoint || 'not mounted')}</p></div><div class="dataset-stats"><span><b>${bytes(dataset.usedBytes)}</b><small>Used</small></span><span><b>${bytes(dataset.availableBytes)}</b><small>Available</small></span><span><b>${escapeHtml(dataset.compression || 'unknown')}</b><small>Compression</small></span></div>${(zfs.pools || []).some(pool => pool.name === dataset.name) ? '' : `<button class="secondary" type="button" data-dataset="${escapeHtml(dataset.name)}">Edit</button>`}</article>`).join('') || ''}</div>
    </section>` : ''}
    <section class="storage-workspace">
      <div class="section-heading"><div><span class="eyebrow">HARDWARE INVENTORY</span><h2>Physical disks & exposed volumes</h2></div></div>
      <div class="storage-list compact-empty-list">${[...disks.map(disk => ({ name: disk.name || disk.path, detail: `${disk.model || 'Block device'} · ${disk.transport || 'local'}`, size: disk.sizeBytes || disk.size })), ...availableSources.map(source => ({ name: source.device || source.mountPoint, detail: `${source.type || 'volume'} · mounted at ${source.mountPoint}${source.configured ? ' · assigned to a pool' : ' · available'}`, size: source.totalBytes }))].map(item => `<article class="storage-row"><div><h3>${escapeHtml(item.name || 'Storage device')}</h3><p>${escapeHtml(item.detail)}</p></div><div class="storage-size"><b>${bytes(item.size || 0)}</b></div></article>`).join('') || `<div class="empty compact-empty"><h3>No additional disks are exposed</h3><p>${storage.environment?.container ? 'This LightNAS instance is running in a container. Pass a host mount or block device into it to make additional storage visible.' : 'The OS has not reported an additional data disk.'}</p></div>`}</div>
    </section>`;
}
async function loadSpaces() {
  try { state.spaces = (await request('/api/spaces')).spaces; if (['pools', 'storage'].includes(state.view)) render(state.view); } catch (error) { toast(error.message); }
}

async function loadUsers() {
  try { state.users = (await request('/api/users')).users; if (['users', 'permissions'].includes(state.view)) render(state.view); } catch (error) { toast(error.message); }
}

function usersView() {
  const owner = state.overview.appliance.username;
  const users = state.users || [];
  const activeCount = users.filter(user => !user.disabled).length + 1;
  return `${pageHead('Users', 'Create and manage local LightNAS accounts.', '<button class="primary" type="button" data-toggle-user-create>+ Add user</button>')}
    <section class="user-summary-grid">
      <article class="panel user-summary"><span class="eyebrow">OWNER</span><strong>${escapeHtml(owner)}</strong><p>Appliance administrator</p></article>
      <article class="panel user-summary"><span class="eyebrow">ACCOUNTS</span><strong>${users.length + 1}</strong><p>${activeCount} active</p></article>
      <article class="panel user-summary"><span class="eyebrow">LOCAL ACCESS</span><strong>LightNAS</strong><p>Separate from Linux and SMB identities</p></article>
    </section>
    <form id="user-form" class="panel user-create-card" hidden>
      <div class="section-heading"><div><span class="eyebrow">NEW ACCOUNT</span><h2>Create local user</h2><p class="muted">Add a browser account, then use Permissions to choose what it can access.</p></div><button class="secondary" type="button" data-toggle-user-create>Cancel</button></div>
      <div class="user-form-grid"><label>Username<input name="username" pattern="[a-zA-Z0-9._-]{3,32}" required placeholder="username"></label><label>Temporary password<input name="password" type="password" minlength="10" autocomplete="new-password" required placeholder="At least 10 characters"></label></div>
      <div class="head-actions"><button class="primary" type="submit">Create user</button><button class="secondary" type="button" data-view-link="permissions">Configure permissions</button></div>
      <div class="form-error" role="alert"></div>
    </form>
    <section class="user-list-section">
      <div class="section-heading"><div><span class="eyebrow">ACCOUNTS</span><h2>Local users</h2></div><small>${users.length + 1} total</small></div>
      <div class="user-card-grid">
        <article class="panel user-card owner-card"><div class="user-card-avatar">${escapeHtml(owner[0]?.toUpperCase() || 'A')}</div><div class="user-card-copy"><div class="user-card-title"><h3>${escapeHtml(owner)}</h3><span class="user-status active">OWNER</span></div><p>Full appliance administration and security control.</p></div><button class="secondary" type="button" data-view-link="settings">Account settings</button></article>
        ${users.map(user => `<article class="panel user-card ${user.disabled ? 'disabled' : ''}">
          <div class="user-card-avatar">${escapeHtml(user.username[0]?.toUpperCase() || 'U')}</div>
          <div class="user-card-copy"><div class="user-card-title"><h3>${escapeHtml(user.username)}</h3><span class="user-status ${user.disabled ? 'disabled' : 'active'}">${user.disabled ? 'DISABLED' : 'ACTIVE'}</span></div><p>${user.groups?.length ? `Groups: ${user.groups.map(group => escapeHtml(group.name)).join(', ')}` : 'No groups assigned'} · ${user.effectivePermissions?.length || 0} effective permissions</p></div>
          <details class="user-manager"><summary>Manage</summary><form data-manage-user="${escapeHtml(user.username)}"><label>Administrator password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New user password<input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="Only for password reset"></label><div class="head-actions"><button class="secondary" type="submit" value="password">Reset password</button><button class="secondary" type="submit" value="${user.disabled ? 'enable' : 'disable'}">${user.disabled ? 'Enable' : 'Disable'}</button><button class="secondary" type="button" data-view-link="permissions">Permissions</button><button class="secondary danger-button" type="button" data-remove-user="${escapeHtml(user.username)}">Remove</button></div><div class="form-error" role="alert"></div></form></details>
        </article>`).join('') || ''}
      </div>
    </section>`;
}
function permissionsView() {
  return `${pageHead('Permissions', 'Manage direct access scopes, groups, and inherited policy separately from account lifecycle.')}
    <section class="panel permission-intro">
      <span class="eyebrow">ACCESS CONTROL</span>
      <h2>Fine-grained LightNAS permissions</h2>
      <p class="muted">Delegated policy covers file read/write/download/delete, media conversion, storage, shares, apps, containers, virtual machines, networking, firewall and monitoring. Owner-only security settings and the root node shell remain restricted to the appliance owner.</p>
    </section>
    <div data-permissions-root><div class="empty"><p>Loading permission policies…</p></div></div>`;
}

function shellView() {
  return `${pageHead('Bash Shell', 'Open an interactive Bash terminal for the LightNAS operating system.')}
    <section class="panel node-shell-launch">
      <span class="eyebrow">SYSTEM SHELL</span>
      <h2>LightNAS Bash shell</h2>
      <p class="muted">This opens the appliance Bash terminal in a separate window. Commands can change networking, storage, services, packages, and the operating system.</p>
      <div class="module-note"><b>Use with care.</b> Shell commands can disconnect the web interface or modify system data.</div>
      <div class="head-actions"><button class="primary" type="button" data-open-node-shell>Open Bash shell</button></div>
    </section>`;
}

async function loadSmtp() {
  try { state.smtp = (await request('/api/smtp')).config; if (['smtp','integrations'].includes(state.view)) render(state.view); } catch (error) { toast(error.message); }
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

function runtimeResourceSummary(items = [], label = 'guests') {
  const host = state.overview?.system || {};
  const running = items.filter(item => /running|active|up/i.test(String(item.status || item.state || '')));
  const allocatedMemory = items.reduce((total, item) => total + (Number(item.memory) || 0), 0);
  const allocatedCpus = items.reduce((total, item) => total + (Number(item.cpus) || 0), 0);
  const uncappedCpu = items.filter(item => item.cpuUnlimited).length;
  const hostMemory = Number(host.memory?.totalBytes || 0);
  const allocationPercent = hostMemory ? Math.min(100, Math.round((allocatedMemory / hostMemory) * 100)) : 0;
  const hostCores = Number(host.cpu?.cores || 0);
  return `<section class="host-monitor-grid runtime-resource-summary">
    <article class="monitor-card"><span>Total ${label}</span><strong>${items.length}</strong><small>${running.length} running · ${items.length-running.length} stopped</small></article>
    <article class="monitor-card"><span>${label === 'containers' ? 'Container memory limits' : label === 'virtual machines' ? 'VM memory allocation' : 'Allocated RAM'}</span><strong>${bytes(allocatedMemory)}</strong><div class="track"><span style="width:${allocationPercent}%"></span></div><small>${hostMemory ? `${allocationPercent}% of ${bytes(hostMemory)} host RAM · ${bytes(host.memory?.usedBytes || 0)} host used` : 'Host total unavailable'}</small></article>
    <article class="monitor-card"><span>Container CPU limits</span><strong>${allocatedCpus || 0} vCPU</strong><small>${hostCores || '—'} host logical CPUs${uncappedCpu ? ` · ${uncappedCpu} container${uncappedCpu===1?'':'s'} uncapped` : ''}</small></article>
    <article class="monitor-card"><span>Host resources</span><strong>${host.cpu?.loadPercent ?? '—'}% CPU</strong><small>${hostCores || '—'} CPUs · ${host.memory?.usedPercent ?? '—'}% RAM · load ${host.cpu?.loadAverage?.[0] ?? '—'}</small></article>
  </section>`;
}

function containersView() {
  const runtime = state.runtimes?.containers;
  const containers = runtime?.containers || [];
  const docker = state.runtimes?.docker;
  const appContainers = (docker?.containers || []).filter(item => item.managed && String(item.name || '').startsWith('lightnas-app-'));
  const ready = runtime?.available && runtime?.enabled && runtime.images?.length && runtime.networks?.length;
  const containerList = !runtime
    ? '<div class="empty compact-empty"><p>Loading existing system containers…</p></div>'
    : containers.length
      ? `<div class="compute-table"><div class="compute-table-head"><span>Status</span><span>Name / ID</span><span>CPU</span><span>Memory</span><span>Network</span><span></span></div>${containers.map(item => `<article class="compute-row"><span class="compute-status"><i class="${/running|active/i.test(String(item.status || '')) ? 'online' : 'offline'}"></i>${escapeHtml(item.status || 'unknown')}</span><div><h3>${escapeHtml(item.name || item.id)}</h3><small>LXC · ID ${escapeHtml(item.id || item.name)}</small></div><span>${item.cpus || '—'} vCPU</span><span>${bytes(item.memory || 0)}</span><span>${escapeHtml(item.ipv4 || 'No IP')}</span><div class="runtime-actions compute-actions">
  <button class="primary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-console="${escapeHtml(item.id || item.name)}" data-container-name="${escapeHtml(item.name || item.id)}">Terminal</button>
  <button class="primary ${/running|active/i.test(String(item.status || '')) ? 'hidden' : ''}" type="button" data-container-action="start" data-container-id="${escapeHtml(item.id || item.name)}">Start</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-action="shutdown" data-container-id="${escapeHtml(item.id || item.name)}">Shutdown</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-action="reboot" data-container-id="${escapeHtml(item.id || item.name)}">Reboot</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-action="stop" data-container-id="${escapeHtml(item.id || item.name)}">Stop</button>
  ${!/\d+\.\d+\.\d+\.\d+/.test(String(item.ipv4 || '')) && /running|active/i.test(String(item.status || '')) ? `<button class="secondary" type="button" data-container-action="repair-network" data-container-id="${escapeHtml(item.id || item.name)}">Repair network</button>` : ''}
  <button class="secondary" type="button" data-container-edit="${escapeHtml(item.id || item.name)}" data-container-name="${escapeHtml(item.name || item.id)}" data-container-memory="${Math.max(256, Math.round((Number(item.memory) || 0) / 1048576) || 2048)}" data-container-cpus="${item.cpus || 2}">Edit</button>
  <button class="secondary danger-button" type="button" data-container-action="delete" data-container-id="${escapeHtml(item.id || item.name)}">Delete</button>
</div></article>`).join('')}</div>`
      : '<div class="empty compact-empty"><p>No native system containers are visible.</p></div>';

  const appContainerList = !docker
    ? '<div class="empty compact-empty"><p>Loading App Store containers…</p></div>'
    : appContainers.length
      ? `<div class="compute-table app-container-table"><div class="compute-table-head"><span>Status</span><span>App / Container</span><span>Access</span><span>Resources</span><span>Image</span><span></span></div>${appContainers.map(item => {
          const appId = String(item.name || '').replace(/^lightnas-app-/, '');
          const app = state.runtimes?.catalog?.find(entry => entry.id === appId);
          const running = /running|up/i.test(String(item.state || item.status || ''));
          const hostAddress = state.overview?.system?.network?.primaryIpv4 || location.hostname;
          const appUrl = app?.port ? `http://${hostAddress}:${app.port}/` : '';
          const cpuText = item.cpuUnlimited ? `Unlimited · host ${state.overview?.system?.cpu?.cores || '—'} CPUs` : `${item.cpus || 0} CPU`;
          const memoryText = item.memory ? bytes(item.memory) : 'No memory cap';
          return `<article class="compute-row app-container-row"><span class="compute-status"><i class="${running ? 'online' : 'offline'}"></i>${escapeHtml(item.status || item.state || 'unknown')}</span><div><h3>${escapeHtml(app?.name || appId || item.name)}</h3><small>${escapeHtml(item.name)} · App Store managed</small></div><div class="app-access-cell">${appUrl ? `<a href="${escapeHtml(appUrl)}" target="_blank" rel="noopener">Open: ${escapeHtml(hostAddress)}:${escapeHtml(app.port)}</a>` : '<span>No web port</span>'}<small>Container IP: ${escapeHtml(item.ip || 'not assigned')} ${item.ports ? `· ${escapeHtml(item.ports)}` : ''}</small></div><div class="app-resource-cell"><b>${escapeHtml(cpuText)}</b><small>${escapeHtml(memoryText)} · restart ${escapeHtml(item.restartPolicy || 'no')}</small></div><span class="compute-truncate" title="${escapeHtml(item.image || '')}">${escapeHtml(item.image || '—')}</span><div class="runtime-actions compute-actions">
            ${running ? `<button class="primary" type="button" data-app-open="${escapeHtml(appUrl)}">Open</button><button class="secondary" type="button" data-app-terminal="${escapeHtml(item.name)}" data-app-name="${escapeHtml(app?.name || appId || item.name)}">Terminal</button>` : ''}
            <button class="primary ${running ? 'hidden' : ''}" type="button" data-app-action="start" data-app-id="${escapeHtml(appId)}">Start</button>
            <button class="secondary ${running ? '' : 'hidden'}" type="button" data-app-action="stop" data-app-id="${escapeHtml(appId)}">Stop</button>
            <button class="secondary" type="button" data-app-edit="${escapeHtml(appId)}" data-app-container="${escapeHtml(item.name)}">Edit</button>
            <button class="secondary" type="button" data-app-action="restart" data-app-id="${escapeHtml(appId)}">Restart</button>
            <button class="secondary danger-button" type="button" data-app-action="remove" data-app-id="${escapeHtml(appId)}">Remove</button>
          </div></article>`;
        }).join('')}</div>`
      : '<div class="empty compact-empty"><p>No App Store containers are installed.</p></div>';

  return `${pageHead('Containers', 'Create and manage native system containers and App Store application containers.', '<div class="head-actions"><button class="secondary" data-action="refresh-runtime">Refresh</button><button class="primary" data-action="create-container">+ Create system container</button></div>')}
    ${runtimeBanner('containers')}
    ${runtimeResourceSummary([...containers, ...appContainers], 'containers')}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>Container resources needed</h2><p>LightNAS needs a usable container image and network before a new system container can be created.</p></div>' : ''}
    <div class="compute-section-head"><div><span class="eyebrow">SYSTEM CONTAINERS</span><h2>Native LXC inventory</h2></div><small>${containers.length} total</small></div>
    <div class="compute-table-wrap">${containerList}</div>
    <div class="compute-section-head app-managed-heading"><div><span class="eyebrow">APP STORE CONTAINERS</span><h2>Managed applications</h2><p class="muted">Applications installed from App Store run as Docker/OCI containers and are managed separately from native LXC containers.</p></div><small>${appContainers.length} total</small></div>
    <div class="compute-table-wrap">${appContainerList}</div>`;
}
function vmsView() {
  const runtime = state.runtimes?.virtualization;
  const machines = runtime?.machineDetails || [];
  const ready = runtime?.available && runtime?.enabled && runtime.pools?.length && runtime.networks?.length;
  const rows = machines.length
    ? `<div class="compute-table"><div class="compute-table-head"><span>Status</span><span>Name</span><span>CPU</span><span>Memory</span><span>Provider</span><span></span></div>${machines.map(item => `<article class="compute-row"><span class="compute-status"><i class="${/running|active/i.test(String(item.status || '')) ? 'online' : 'offline'}"></i>${escapeHtml(item.status || 'unknown')}</span><div><h3>${escapeHtml(item.name)}</h3><small>${item.disk ? `${bytes(item.disk)} disk` : 'Virtual machine'}</small></div><span>${item.cpus || '—'} vCPU</span><span>${bytes(item.memory || 0)}</span><span>${escapeHtml(runtime?.provider || 'libvirt')}</span><div class="runtime-actions compute-actions">
  <button class="primary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-vm-console="${escapeHtml(item.id || item.name)}" data-vm-name="${escapeHtml(item.name)}">noVNC Console</button>
  <button class="primary ${/running|active/i.test(String(item.status || '')) ? 'hidden' : ''}" type="button" data-vm-action="start" data-vm-id="${escapeHtml(item.id || item.name)}">Start</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-vm-action="shutdown" data-vm-id="${escapeHtml(item.id || item.name)}">Shutdown</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-vm-action="reboot" data-vm-id="${escapeHtml(item.id || item.name)}">Reboot</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-vm-action="stop" data-vm-id="${escapeHtml(item.id || item.name)}">Stop</button>
  <button class="secondary" type="button" data-vm-edit="${escapeHtml(item.id || item.name)}" data-vm-name="${escapeHtml(item.name)}" data-vm-memory="${Math.max(512, Math.round((Number(item.memory) || 0) / 1048576) || 2048)}" data-vm-cpus="${item.cpus || 2}">Edit</button>
  <button class="secondary" type="button" data-vm-action="reset" data-vm-id="${escapeHtml(item.id || item.name)}">Reset</button>
  <button class="secondary danger-button" type="button" data-vm-action="delete" data-vm-id="${escapeHtml(item.id || item.name)}">Delete</button>
</div></article>`).join('')}</div>`
    : '<div class="empty compact-empty"><p>No local virtual machines are visible.</p></div>';
  return `${pageHead('Virtual machines', 'Create, monitor and manage QEMU/libvirt virtual machines.', '<div class="head-actions"><button class="secondary" data-action="refresh-runtime">Refresh</button><button class="primary" data-action="create-vm">+ Create VM</button></div>')}
    ${runtimeBanner('virtualization')}
    ${runtimeResourceSummary(machines, 'virtual machines')}
    ${runtime?.warning ? `<div class="module-note"><b>Virtualization note:</b> ${escapeHtml(runtime.warning)}</div>` : ''}
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>VM resources needed</h2><p>LightNAS needs an active VM storage location and network before a VM can be created.</p></div>' : ''}
    <div class="compute-section-head"><div><span class="eyebrow">VIRTUAL MACHINES</span><h2>Inventory</h2></div><small>${machines.length} total</small></div>
    <div class="compute-table-wrap">${rows}</div>`;
}
function sharesView() {
  const { shares } = state.overview;
  return `${pageHead('Network shares', 'Connect directly from Windows, Linux, or macOS over SMB and SFTP.', '<button class="primary" data-action="new-share">+ Create share</button>')}
    <section class="module-note share-help"><b>Quick connect:</b> Windows File Explorer uses <code>\\\\LIGHTNAS-IP\\share</code>. Linux/macOS can use <code>smb://LIGHTNAS-IP/share</code> or <code>sftp user@LIGHTNAS-IP</code>.</section>
    <div class="share-list">${shares.map(share => `<article class="share-row network-share-row"><div><div class="volume-title"><h3>${escapeHtml(share.name)}</h3><span class="volume-state writable">ACTIVE</span></div><p>${escapeHtml(share.protocol)} · user ${escapeHtml(share.username || '—')} · ${escapeHtml(share.description || 'No description')}</p><div class="share-addresses">${share.smb ? `<code>${escapeHtml(share.smb)}</code>` : ''}${share.smbUrl ? `<code>${escapeHtml(share.smbUrl)}</code>` : ''}${share.sftp ? `<code>${escapeHtml(share.sftp)}</code>` : ''}</div></div><button class="secondary danger-button" data-delete-share="${escapeHtml(share.id)}" data-name="${escapeHtml(share.name)}">Remove share</button></article>`).join('') || '<div class="empty"><p>No network shares configured yet.</p></div>'}</div>`;
}

const librarySections = [
  ['', 'All files'],
  ['Documents', 'Documents'],
  ['Photos', 'Photos'],
  ['Videos', 'Videos'],
  ['Audio', 'Audio']
];

const libraryExtensions = {
  Photos: new Set(['jpg','jpeg','png','gif','webp','bmp','svg','avif','heic','heif','dng','cr2','cr3','nef','nrw','arw','srf','sr2','raf','orf','rw2','pef','srw','x3f']),
  Videos: new Set(['mp4','webm','mov','m4v','ogv','mkv','avi','wmv','flv','mpeg','mpg','m2v','mts','m2ts','ts','3gp','3g2','vob']),
  Audio: new Set(['mp3','wav','ogg','m4a','aac','flac','opus','wma','aiff','aif']),
  Documents: new Set(['pdf','txt','md','rtf','doc','docx','odt','xls','xlsx','ods','ppt','pptx','odp','csv','json','xml','yaml','yml','ini','conf','log','zip','7z','rar','epub','mobi','html','css','js','mjs','py','sh'])
};
const systemImageExtensions = ['iso','img','qcow','qcow2','vmdk','vhd','vhdx','ova','ovf','vma','vma.zst','vma.gz','tar.zst','tar.xz','tgz'];

function fileExtension(name) {
  const lower = String(name || '').toLowerCase();
  const special = systemImageExtensions.find(ext => lower.endsWith('.' + ext));
  if (special) return special;
  const part = lower.split('.').pop();
  return part === lower ? '' : part;
}

function isSystemImageFile(name) {
  return systemImageExtensions.includes(fileExtension(name));
}

function libraryCategoryForName(name) {
  const ext = fileExtension(name);
  for (const [category, values] of Object.entries(libraryExtensions)) {
    if (values.has(ext)) return category;
  }
  return 'Documents';
}

function libraryKindForName(name) {
  const category = libraryCategoryForName(name);
  return category === 'Photos' ? 'Photo' : category === 'Videos' ? 'Video' : category === 'Audio' ? 'Audio' : 'Document';
}

const previewableFileExtensions = new Set([
  'jpg','jpeg','png','gif','webp','bmp','svg','avif','heic','heif','raw','dng','cr2','cr3','nef','nrw','arw','srf','sr2','raf','orf','rw2','pef','srw','x3f',
  'mp4','webm','mov','m4v','ogv','mkv','avi','wmv','flv','mpeg','mpg','m2v','mts','m2ts','ts','3gp','3g2','vob',
  'mp3','wav','ogg','m4a','aac','flac','pdf','txt','log','md','json','csv','xml','yaml','yml','ini','conf','sh','js','mjs','css','html'
]);
function isPreviewableFileName(name) {
  return previewableFileExtensions.has(fileExtension(name));
}

function fileEntryPath(entry) {
  return entry.path || [state.folder, entry.name].filter(Boolean).join('/');
}

function filesView() {
  const mobileFiles = matchMedia('(max-width: 760px)').matches;
  if (mobileFiles && state.fileView === 'list') state.fileView = 'grid';
  const segments = state.folder.split('/').filter(Boolean);
  const section = librarySections.some(([folder]) => folder === (segments[0] || '')) ? (segments[0] || '') : '';
  const allFiles = state.folder === '';
  const crumbs = [`<button class="panel-link" data-folder="">Files & media</button>`, ...segments.map((segment, index) => `<span> / </span><button class="panel-link" data-folder="${escapeHtml(segments.slice(0, index + 1).join('/'))}">${escapeHtml(segment)}</button>`)].join('');
  const entries = Array.isArray(state.files) ? (allFiles ? state.files.filter(entry => !entry.directory && !isSystemImageFile(entry.name)) : state.files.filter(entry => entry.directory || !isSystemImageFile(entry.name))) : state.files;
  const tabs = librarySections.map(([folder, label]) => `<button type="button" class="library-tab ${!state.filesSettingsOpen && section === folder ? 'active' : ''}" data-library-tab="${escapeHtml(folder)}" aria-pressed="${!state.filesSettingsOpen && section === folder}">${escapeHtml(label)}</button>`).join('') +
    `<button type="button" class="library-tab desktop-files-settings-tab ${state.filesSettingsOpen ? 'active' : ''}" data-files-settings-tab aria-pressed="${state.filesSettingsOpen}">⚙ Settings</button>`;

  const item = entry => {
    const path = fileEntryPath(entry);
    const location = !entry.directory && (entry.folder || path.includes('/')) ? (entry.folder || path.split('/').slice(0, -1).join('/') || 'Root') : '';
    const kind = entry.directory ? 'Folder' : libraryKindForName(entry.name);
    const meta = entry.directory ? 'Folder' : `${kind} · ${bytes(entry.sizeBytes)}${location ? ` · ${escapeHtml(location)}` : ''}`;
    const thumbVersion = encodeURIComponent(entry.modifiedAt || entry.sizeBytes || '1');
    const visual = entry.directory
      ? '<span class="folder-glyph">▣</span>'
      : (kind === 'Photo' || kind === 'Video')
        ? `<img class="file-thumb" loading="${state.fileView === 'gallery' ? 'eager' : 'lazy'}" decoding="async" alt="" src="/api/files/thumbnail?path=${encodeURIComponent(path)}&v=${thumbVersion}">`
        : `<span class="file-glyph file-kind-${kind.toLowerCase()}">${kind === 'Audio' ? '♪' : '▤'}</span>`;

    if (state.fileView === 'gallery') {
      return `<article class="file-gallery-item ${kind.toLowerCase()}">
        <button class="file-name file-gallery-open" data-open="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}" data-directory="${entry.directory}" aria-label="Open ${escapeHtml(entry.name)}">
          <span class="file-card-visual">${visual}</span>
        </button>
      </article>`;
    }

    return state.fileView === 'grid'
      ? `<article class="file-card">
          <button class="file-name file-card-open" data-open="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}" data-directory="${entry.directory}">
            <span class="file-card-visual">${visual}</span>
            <span class="file-card-title">${escapeHtml(entry.name)}</span>
          </button>
          <span class="muted file-location">${meta}</span>
          <div class="file-card-actions">
            ${entry.directory ? `<button class="secondary" data-download-folder="${escapeHtml(path)}">Download folder</button>` : ''}
            ${!entry.directory && state.media?.converterAvailable && state.overview.appliance.role === 'administrator' ? `<button class="secondary" data-convert-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Convert</button>` : ''}
            <button class="secondary" data-delete-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Delete</button>
          </div>
        </article>`
      : `<article class="file-row">
          <button class="file-name" data-open="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}" data-directory="${entry.directory}">${entry.directory ? '▣' : kind === 'Photo' ? '▧' : kind === 'Video' ? '▷' : kind === 'Audio' ? '♪' : '▤'} ${escapeHtml(entry.name)}${location ? `<small>${escapeHtml(location)}</small>` : ''}</button>
          <span class="muted">${entry.directory ? 'Folder' : `${kind} · ${bytes(entry.sizeBytes)}`}</span>
          ${entry.directory ? `<button class="secondary" data-download-folder="${escapeHtml(path)}">Download</button>` : ''}
          ${!entry.directory && state.media?.converterAvailable && state.overview.appliance.role === 'administrator' ? `<button class="secondary" data-convert-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Convert</button>` : ''}
          <button class="secondary" data-delete-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Delete</button>
        </article>`;
  };

  return `<section class="files-page ${state.fileView === 'gallery' ? 'photo-mode' : 'grid-mode'}">${pageHead('Files & media', 'Browse and manage the actual files stored in LightNAS.', '<button class="secondary" data-action="refresh-files">Refresh</button>')}
    <nav class="library-tabs" aria-label="File library sections">${tabs}</nav>
    <section class="desktop-files-settings-panel ${state.filesSettingsOpen ? '' : 'hidden'}">
      <article class="panel files-settings-card">
        <div><span class="eyebrow">FILES & MEDIA SETTINGS</span><h2>Library settings</h2><p class="muted">Manage phone library sync and desktop file display preferences.</p></div>
        <div class="files-settings-grid">
          <div class="files-setting-box"><b>Desktop view</b><p class="muted">Choose List, Grid, or Photos view on desktop.</p><div class="head-actions"><button class="secondary" type="button" data-file-view="list">☷ List</button><button class="secondary" type="button" data-file-view="grid">▦ Grid</button><button class="secondary" type="button" data-file-view="gallery">▦ Photos</button></div></div>
          ${state.overview.appliance.role === 'administrator' && state.overview.appliance.features?.phoneSync !== false ? '<div class="files-setting-box"><b>Phone library sync</b><p class="muted">Automatically route phone photos to Photos and phone videos to Videos.</p><button class="primary phone-sync-button" type="button" data-phone-sync>Configure phone sync</button></div>' : ''}
        </div>
      </article>
    </section>
    <div class="files-library-content ${state.filesSettingsOpen ? 'hidden' : ''}">
    <div class="file-toolbar"><div class="breadcrumbs">${crumbs}</div><div class="file-toolbar-actions">
      <div class="view-toggle" role="group" aria-label="File view">
        <button class="secondary ${state.fileView === 'list' ? 'active' : ''}" type="button" data-file-view="list" aria-pressed="${state.fileView === 'list'}">☷ List</button>
        <button class="secondary ${state.fileView === 'grid' ? 'active' : ''}" type="button" data-file-view="grid" aria-pressed="${state.fileView === 'grid'}">▦ Grid</button>
        <button class="secondary gallery-view-button mobile-photo-view-button ${state.fileView === 'gallery' ? 'active' : ''}" type="button" data-file-view="gallery" aria-pressed="${state.fileView === 'gallery'}">▦ Photos</button>
      </div>
      <button class="secondary" data-action="new-folder">+ Folder</button>
      <label class="primary upload-button">${section === 'Photos' ? 'Upload photos' : section === 'Videos' ? 'Upload videos' : section === 'Audio' ? 'Upload audio' : 'Upload'}<input id="file-upload" type="file" ${section === 'Photos' ? 'accept="image/*"' : section === 'Videos' ? 'accept="video/*"' : section === 'Audio' ? 'accept="audio/*"' : ''} multiple hidden></label>
      <label class="secondary upload-button">Upload folder<input id="folder-upload" type="file" webkitdirectory directory multiple hidden></label>
      <button class="secondary desktop-files-settings-button" type="button" data-files-settings-tab>⚙ Settings</button>
      ${state.overview.appliance.role === 'administrator' && state.overview.appliance.features?.phoneSync !== false ? '<button class="secondary phone-sync-button files-sync-trigger" type="button" data-phone-sync>Phone sync</button>' : ''}
    </div></div>
    <div class="file-drop-zone" data-file-drop tabindex="0"><b>Drop files here</b><span>Multiple files and ZIP archives are supported. Use “Upload folder” to preserve a whole folder tree.</span></div>
    <p class="muted">${allFiles ? 'All files shows only your Documents, Photos, Videos, and Audio libraries.' : 'Open folders normally or switch back to All files to see all four libraries together.'} ZIP and other file types are accepted, uploads have visible progress, and LightNAS does not impose an application-level file-size ceiling.</p>
    ${state.fileTruncated && allFiles ? '<div class="module-note">Showing the newest 10,000 files. Open a category or folder to browse beyond that safety limit.</div>' : ''}
    <div class="${state.fileView === 'gallery' ? 'file-photo-gallery' : state.fileView === 'grid' ? 'file-browser-grid' : 'storage-list'}">${state.fileError ? `<div class="empty error-state"><p><b>Files could not be loaded.</b></p><p>${escapeHtml(state.fileError)}</p><button class="secondary" data-action="refresh-files">Try again</button></div>` : entries === null ? '<div class="empty"><p>Loading files…</p></div>' : entries.length ? entries.map(item).join('') : `<div class="empty"><p>${allFiles ? 'No files have been uploaded yet.' : 'This folder is empty.'}</p></div>`}</div>
    </div>
    <button class="secondary mobile-files-settings-button" type="button" data-mobile-files-settings aria-label="Files & media settings">⚙ Settings</button>
  </section>`;
}

async function loadFiles(forceRefresh = false) {
  state.fileError = null;
  try {
    const endpoint = state.folder === ''
      ? `/api/files?all=1${forceRefresh ? '&refresh=1' : ''}`
      : `/api/files?path=${encodeURIComponent(state.folder)}`;
    const result = await request(endpoint);
    state.files = Array.isArray(result.entries) ? result.entries.filter(entry => entry.supported) : [];
    state.fileTruncated = Boolean(result.truncated);
  } catch (error) {
    state.files = [];
    state.fileTruncated = false;
    state.fileError = error.message || 'The file service did not return a valid response.';
    toast(state.fileError);
  }
  if (state.view === 'files') render('files');
}

function uploadRequest(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/files?path=${encodeURIComponent(path)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-LightNAS-Request', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = 'Upload failed.';
      try { message = JSON.parse(xhr.responseText || '{}').error || message; } catch {}
      reject(new Error(message));
    });
    xhr.addEventListener('error', () => reject(new Error('The upload connection failed.')));
    xhr.addEventListener('abort', () => reject(new Error('The upload was cancelled.')));
    xhr.send(file);
  });
}

async function ensureUploadDirectories(paths) {
  const folders = new Set();
  for (const path of paths) {
    const parts = String(path || '').split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'));
  }
  for (const folder of [...folders].sort((a, b) => a.split('/').length - b.split('/').length)) {
    try { await request(`/api/files?path=${encodeURIComponent(folder)}`, { method: 'POST', body: '{}' }); }
    catch (error) { if (error.status !== 409) throw error; }
  }
}

async function uploadFilesWithProgress(fileList, folderMode = false) {
  const files = [...fileList];
  if (!files.length) return;
  const targets = files.map(file => {
    const relative = folderMode ? (file.webkitRelativePath || file.name) : file.name;
    const clean = relative.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
    if (!folderMode && state.folder === '' && isSystemImageFile(file.name)) {
      throw new Error(file.name + ' is VM/container storage media. Upload it from Storage > Manage storage so it stays on the selected storage pool instead of Files & media.');
    }
    const destination = !folderMode && state.folder === '' ? libraryCategoryForName(file.name) : state.folder;
    return { file, path: [destination, clean].filter(Boolean).join('/') };
  });
  await ensureUploadDirectories(targets.map(item => item.path));

  const totalBytes = targets.reduce((sum, item) => sum + Number(item.file.size || 0), 0);
  const loadedByFile = new Array(targets.length).fill(0);
  let completedCount = 0;
  let nextIndex = 0;
  const progress = window.LightNASProgress?.open(folderMode ? 'Uploading folder' : 'Uploading files', `${targets.length} item${targets.length === 1 ? '' : 's'} · ${bytes(totalBytes)}`, { modal:false });

  const updateProgress = (activeName = '') => {
    const transferred = loadedByFile.reduce((sum, value) => sum + value, 0);
    const percent = totalBytes ? Math.round((transferred / totalBytes) * 100) : Math.round((completedCount / targets.length) * 100);
    progress?.update(percent, `${completedCount} of ${targets.length} complete${activeName ? ` · ${activeName}` : ''} · ${bytes(transferred)} of ${bytes(totalBytes)}`);
  };

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= targets.length) return;
      const { file, path } = targets[index];
      await uploadRequest(path, file, loaded => {
        loadedByFile[index] = loaded;
        updateProgress(file.name);
      });
      loadedByFile[index] = Number(file.size || 0);
      completedCount += 1;
      updateProgress();
    }
  };

  try {
    // Three concurrent streams noticeably improve folders with many small
    // files without creating a large RAM/connection spike on the 2 GiB target.
    const concurrency = Math.min(3, targets.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    progress?.succeed(`${targets.length} item${targets.length === 1 ? '' : 's'} uploaded successfully.`);
    toast(`${targets.length} item${targets.length === 1 ? '' : 's'} uploaded.`);
  } catch (error) {
    progress?.fail(error.message);
    toast(error.message);
  } finally {
    await loadFiles();
  }
}


function seriesStats(values = []) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return { current: 0, average: 0, peak: 0, minimum: 0 };
  return {
    current: clean.at(-1) || 0,
    average: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    peak: Math.max(...clean),
    minimum: Math.min(...clean)
  };
}

function monitoringView() {
  const system = state.overview.system || {};
  const storage = state.overview.storage?.usableStorage || state.overview.storage?.virtualStorage || state.overview.storage?.local || {};
  const cpu = seriesStats(state.metricHistory.cpu);
  const memory = seriesStats(state.metricHistory.memory);
  const load = seriesStats(state.metricHistory.load);
  const networkIn = seriesStats(state.metricHistory.networkIn);
  const networkOut = seriesStats(state.metricHistory.networkOut);
  const analyticsEnabled = state.overview.appliance.features?.monitoringAnalytics !== false;
  const activity = state.overview.activity || [];
  return `${pageHead('Monitoring & analytics', 'Live performance graphs, session analytics, and recent system activity.', '<button class="secondary" data-action="refresh">Refresh now</button>')}
    <section class="monitoring-live-grid">
      ${overviewChart('CPU usage', `${system.cpu?.loadPercent || 0}`, '%', state.metricHistory.cpu)}
      ${overviewChart('Memory usage', `${system.memory?.usedPercent || 0}`, '%', state.metricHistory.memory)}
      ${overviewChart('System load', `${system.cpu?.loadAverage?.[0] || 0}`, '', state.metricHistory.load, Math.max(2, system.cpu?.cores || 1))}
      ${overviewNetworkChart(system)}
    </section>
    ${analyticsEnabled ? `<section class="analytics-section">
      <div class="section-heading"><div><span class="eyebrow">SESSION ANALYTICS</span><h2>Performance summary</h2></div><small>Updates every 5 seconds · ${state.metricHistory.cpu.length} samples</small></div>
      <div class="analytics-grid">
        <article class="panel analytics-card"><span>CPU average</span><strong>${cpu.average.toFixed(1)}%</strong><small>Peak ${cpu.peak.toFixed(1)}% · current ${cpu.current.toFixed(1)}%</small></article>
        <article class="panel analytics-card"><span>Memory average</span><strong>${memory.average.toFixed(1)}%</strong><small>Peak ${memory.peak.toFixed(1)}% · ${bytes(system.memory?.freeBytes || 0)} free now</small></article>
        <article class="panel analytics-card"><span>Load average</span><strong>${load.average.toFixed(2)}</strong><small>Peak ${load.peak.toFixed(2)} · ${system.cpu?.cores || 0} logical CPUs</small></article>
        <article class="panel analytics-card"><span>Network peak</span><strong>↓ ${bytes(networkIn.peak)}/s</strong><small>↑ ${bytes(networkOut.peak)}/s transmitted</small></article>
        <article class="panel analytics-card"><span>Storage used</span><strong>${Number(storage.usedPercent || 0)}%</strong><small>${bytes(storage.usedBytes || 0)} of ${bytes(storage.totalBytes || 0)}</small></article>
        <article class="panel analytics-card"><span>Uptime</span><strong>${duration(system.uptimeSeconds || 0)}</strong><small>${activity.length} recent activity event${activity.length === 1 ? '' : 's'}</small></article>
      </div>
    </section>` : ''}
    <section class="monitoring-activity panel">
      <div class="panel-head"><div><span class="eyebrow">ACTIVITY</span><h2>Recent system events</h2></div><small>Newest first</small></div>
      <div class="activity-list">${activity.length ? activity.map(item => `<div class="activity"><span class="activity-icon">${item.severity === 'warning' ? '!' : item.severity === 'success' ? '✓' : '↗'}</span><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No recent activity.</p>'}</div>
    </section>`;
}

function capabilitiesView() {
  const { system, appliance } = state.overview;
  const hardware = system.capabilities || [];
  const features = appliance.features || {};
  const optional = [
    ['appStore', 'App Store', 'One-click application catalog and managed app hosting.', 'apps'],
    ['containers', 'System containers', 'Native Linux system containers and terminal access.', 'containers'],
    ['virtualMachines', 'Virtual machines', 'KVM/libvirt or supported hypervisor virtual machines.', 'vms'],
    ['ai', 'AI workspace', 'Local and remote AI tools, model runtimes, and AI applications.', 'ai'],
    ['phoneSync', 'Phone library sync', 'Automatic phone photo/video uploads into Files & media.', 'files'],
    ['monitoringAnalytics', 'Monitoring analytics', 'Live charts and session performance analytics.', 'monitoring'],
    ['integrations', 'Integrations', 'Host runtimes, external services, and provider connections.', 'integrations']
  ];
  return `${pageHead('Capabilities', 'Review hardware support and control optional LightNAS features.')}
    <section class="capability-overview-grid">
      <article class="panel capability-overview"><span class="eyebrow">HARDWARE</span><strong>${hardware.filter(item => item.available).length}/${hardware.length}</strong><p>hardware capability checks passed</p></article>
      <article class="panel capability-overview"><span class="eyebrow">FEATURES</span><strong>${optional.filter(([key]) => features[key] !== false).length}/${optional.length}</strong><p>optional LightNAS features enabled</p></article>
      <article class="panel capability-overview"><span class="eyebrow">CPU</span><strong>${system.cpu?.cores || 0}</strong><p>logical cores · ${escapeHtml(system.architecture || '')}</p></article>
      <article class="panel capability-overview"><span class="eyebrow">MEMORY</span><strong>${bytes(system.memory?.totalBytes || 0)}</strong><p>${system.memory?.usedPercent || 0}% currently used</p></article>
    </section>
    <section class="capability-section">
      <div class="section-heading"><div><span class="eyebrow">FEATURE CONTROL</span><h2>Optional services & interface modules</h2><p class="muted">Turn LightNAS features on or off without uninstalling your data or applications.</p></div></div>
      <div class="capability-toggle-grid">${optional.map(([key, name, description, target]) => {
        const enabled = features[key] !== false;
        return `<article class="panel capability-toggle-card"><div><div class="capability-title-row"><h3>${escapeHtml(name)}</h3><span class="user-status ${enabled ? 'active' : 'disabled'}">${enabled ? 'ENABLED' : 'DISABLED'}</span></div><p>${escapeHtml(description)}</p></div><div class="capability-actions"><button class="secondary" type="button" data-view-link="${target}">Open</button>${appliance.role === 'administrator' ? `<button class="${enabled ? 'secondary' : 'primary'}" type="button" data-feature-toggle="${key}" data-feature-enabled="${enabled}">${enabled ? 'Turn off' : 'Turn on'}</button>` : ''}</div></article>`;
      }).join('')}</div>
    </section>
    <section class="capability-section">
      <div class="section-heading"><div><span class="eyebrow">HARDWARE ELIGIBILITY</span><h2>Detected system capabilities</h2></div></div>
      <div class="capability-list">${hardware.map(item => `<article class="capability-row"><div><b>${escapeHtml(item.name)}</b><p>${escapeHtml(item.available ? `Requirement met · ${item.minimum}` : item.reason)}</p></div><span class="badge ${item.available ? 'available' : 'gated'}">${item.available ? 'READY' : 'LIMITED'}</span></article>`).join('')}</div>
    </section>`;
}

function lightnasAgentReply(input) {
  const question = String(input || '').trim();
  const lower = question.toLowerCase();
  const system = state.overview?.system || {};
  const storage = state.overview?.storage?.usableStorage || state.overview?.storage?.virtualStorage || state.overview?.storage?.local || {};
  const containers = state.runtimes?.containers?.containers || [];
  const noIp = containers.filter(item => /running|active/i.test(String(item.status || '')) && !/^\d+\.\d+\.\d+\.\d+$/.test(String(item.ipv4 || '')));
  const apps = state.runtimes?.catalog || [];
  const defaultRoute = (state.network?.routes || []).find(item => item.destination === 'default');

  if (/container|ip|dhcp|network/.test(lower)) {
    if (noIp.length) {
      return {
        text: `${noIp.length} running container${noIp.length === 1 ? '' : 's'} currently ${noIp.length === 1 ? 'has' : 'have'} no IPv4 address: ${noIp.map(item => item.name || item.id).join(', ')}. LightNAS can repair their DHCP identity and restart them on the managed container network.`,
        action: 'repair-noip',
        actionLabel: `Repair ${noIp.length} container network${noIp.length === 1 ? '' : 's'}`
      };
    }
    return { text: `Container networking looks healthy in the current inventory. ${containers.length} container${containers.length === 1 ? '' : 's'} detected. Default gateway: ${defaultRoute?.gateway || 'not loaded yet'}.` };
  }
  if (/storage|disk|space|pool/.test(lower)) {
    return { text: `Storage currently reports ${bytes(storage.usedBytes || 0)} used of ${bytes(storage.totalBytes || 0)}, with ${bytes(storage.availableBytes || 0)} available. Open Storage or Pools & datasets for disk-level controls.` };
  }
  if (/cpu|memory|ram|performance|slow|load/.test(lower)) {
    return { text: `Current host CPU usage is ${system.cpu?.loadPercent || 0}% and memory usage is ${system.memory?.usedPercent || 0}% (${bytes(system.memory?.usedBytes || 0)} used). Monitoring has live graphs if you need to inspect a spike.` };
  }
  if (/app|install|software|catalog/.test(lower)) {
    const aiCount = apps.filter(app => String(app.category || '').toLowerCase() === 'ai').length;
    return { text: `The App Store currently has ${apps.length} one-click entries, including ${aiCount} AI tools. AI runtimes and tools live in App Store; this AI page is the LightNAS operations helper.`, action:'open-apps', actionLabel:'Open App Store' };
  }
  if (/health|status|problem|issue|diagnos/.test(lower)) {
    return { text: `LightNAS is online. CPU is ${system.cpu?.loadPercent || 0}%, memory is ${system.memory?.usedPercent || 0}%, and ${noIp.length ? `${noIp.length} running container(s) need network attention` : 'the current container inventory has no missing IPv4 addresses'}. Use Monitoring for live graphs or ask me about networking, storage, apps, CPU, or memory.` };
  }
  return { text: 'I am the LightNAS operations helper. Ask me about container networking, storage, CPU or memory, system health, or installed/app-store software. I use the live LightNAS inventory to guide actions instead of showing AI application installers here.' };
}

function aiView() {
  const messages = state.aiMessages.length ? state.aiMessages : [
    { role:'agent', text:'I am the LightNAS helper. I can inspect the current NAS state, diagnose container networking, summarize storage and performance, and guide you to the right control.' }
  ];
  return `${pageHead('AI helper', 'A system-aware LightNAS assistant for troubleshooting and administration.', '<button class="secondary" data-ai-prompt="Check system health">Check health</button>')}
    <section class="ai-agent-shell">
      <aside class="panel ai-agent-context">
        <span class="eyebrow">QUICK HELP</span>
        <h2>Ask LightNAS</h2>
        <p class="muted">The helper reads the current LightNAS inventory. AI runtimes such as Ollama, Open WebUI, Flowise and LocalAI are installed from App Store.</p>
        <div class="ai-quick-actions">
          <button class="secondary" type="button" data-ai-prompt="Diagnose container networking">Container networking</button>
          <button class="secondary" type="button" data-ai-prompt="Show storage summary">Storage summary</button>
          <button class="secondary" type="button" data-ai-prompt="Show performance status">Performance</button>
          <button class="secondary" type="button" data-ai-prompt="Tell me about apps">Apps</button>
        </div>
        <button class="primary" type="button" data-ai-action="open-apps">Open AI tools in App Store</button>
      </aside>
      <section class="panel ai-agent-chat">
        <div class="ai-agent-messages">${messages.map(message => `<article class="ai-message ${message.role === 'user' ? 'user' : 'agent'}"><span>${message.role === 'user' ? 'YOU' : 'LIGHTNAS'}</span><p>${escapeHtml(message.text)}</p>${message.action ? `<button class="secondary" type="button" data-ai-action="${escapeHtml(message.action)}">${escapeHtml(message.actionLabel || 'Run action')}</button>` : ''}</article>`).join('')}</div>
        <form class="ai-agent-form" data-ai-form>
          <input name="message" autocomplete="off" maxlength="500" placeholder="Ask: Why does my container have no IP?" required>
          <button class="primary" type="submit">Ask</button>
        </form>
      </section>
    </section>`;
}


function settingsView() {
  const { appliance } = state.overview;
  const zones = [['America/New_York', 'Eastern Time'], ['America/Chicago', 'Central Time'], ['America/Denver', 'Mountain Time'], ['America/Los_Angeles', 'Pacific Time'], ['UTC', 'UTC']];
  return `${pageHead('Settings & security', 'Brand the appliance, manage general settings, and control account security.')}
    <section class="settings-dashboard">
      <form id="settings-form" class="panel settings-general-card">
        <div class="settings-card-head"><div><span class="eyebrow">GENERAL</span><h2>Appliance identity & branding</h2><p class="muted">Set the device name, brand/logo name, time zone, and optional picture logo together.</p></div></div>
        <div class="settings-general-grid">
          <label>Device name<input name="deviceName" value="${escapeHtml(appliance.deviceName)}" required minlength="2" maxlength="32" autocomplete="off"><small>System name shown in administration views.</small></label>
          <label>Brand / logo name<input name="brandName" value="${escapeHtml(appliance.brandName || 'LightNAS')}" required minlength="2" maxlength="32" autocomplete="off" placeholder="LightNAS"><small>Text wordmark shown beside the logo.</small></label>
          <label>Display time zone<select name="timezone">${zones.map(([value, label]) => `<option value="${value}" ${appliance.timezone === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        </div>
        <div class="general-branding-row branding-card">
          <div class="branding-preview compact-branding-preview">
            <div class="brand-logo-preview ${appliance.logo ? 'has-logo' : ''}" style="${appliance.logo ? `background-image:url('/api/branding/logo?v=${Date.now()}')` : ''}">${appliance.logo ? '' : '<span class="brand-mark small"><span></span><span></span><span></span></span>'}</div>
            <div><b>${escapeHtml(appliance.brandName || 'LightNAS')}</b><p class="muted">${appliance.logo ? 'Uploaded picture logo + brand name' : 'Built-in mark + text brand name'}</p></div>
          </div>
          <div class="general-logo-actions">
            <label class="primary upload-button">Upload logo picture<input id="logo-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${appliance.logo ? '<button class="secondary" type="button" data-remove-logo>Remove picture</button>' : ''}
          </div>
        </div>
        <div class="form-error" data-logo-error role="alert"></div>
        <div class="settings-save-row"><button class="primary" type="submit">Save general settings</button></div>
        <div class="form-error" role="alert"></div>
      </form>

      <form id="password-form" class="panel password-card">
        <div class="settings-card-head"><div><span class="eyebrow">PASSWORD</span><h2>Change administrator password</h2><p class="muted">Password verification is required only when changing the password.</p></div></div>
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label>New password<input name="newPassword" type="password" minlength="10" autocomplete="new-password" required placeholder="At least 10 characters"></label>
        <button class="secondary" type="submit">Change password</button><div class="form-error" role="alert"></div>
      </form>
    </section>`;
}
function adminView() {
  const { appliance } = state.overview;
  const userCount = state.users?.length ?? '—';
  const networkName = state.network?.control?.currentUplink?.name || state.network?.routes?.find(item => item.destination === 'default')?.device || '—';
  return `${pageHead('Admin Center', `Operate ${escapeHtml(appliance.deviceName)} from one focused administration workspace.`)}
    <section class="admin-overview-grid">
      <article class="admin-overview-card accent-card">
        <span class="eyebrow">APPLIANCE</span>
        <h2>${escapeHtml(appliance.deviceName)}</h2>
        <p>Owner: ${escapeHtml(appliance.username)} · ${escapeHtml(appliance.timezone || 'UTC')}</p>
        <div class="head-actions"><button class="secondary" data-view-link="settings">Settings</button></div>
      </article>
      <article class="admin-overview-card">
        <span class="eyebrow">ACCESS</span>
        <h2>${userCount} local users</h2>
        <p>Users, groups, inherited scopes, authentication and identity policy.</p>
        <div class="head-actions"><button class="secondary" data-view-link="permissions">Permissions</button><button class="secondary" data-view-link="users">Users</button></div>
      </article>
      <article class="admin-overview-card">
        <span class="eyebrow">NETWORK</span>
        <h2>${escapeHtml(networkName)}</h2>
        <p>Interfaces, bridges, VLANs, bonds, routes, DNS and host firewall.</p>
        <div class="head-actions"><button class="secondary" data-view-link="network">Networking</button><button class="secondary" data-view-link="firewall">Firewall</button></div>
      </article>
      <article class="admin-overview-card">
        <span class="eyebrow">OPERATIONS</span>
        <h2>Health & monitoring</h2>
        <p>Live system pressure, appliance diagnostics and managed-service repair.</p>
        <div class="head-actions"><button class="secondary" data-view-link="monitoring">Monitoring</button><button class="secondary" data-view-link="capabilities">Diagnostics</button></div>
      </article>
    </section>

    <section class="panel" id="appliance-health-panel">
      <div class="admin-section-head">
        <div data-appliance-health-result>
          <span class="eyebrow">APPLIANCE HEALTH</span>
          <h2>Self-management</h2>
          <p class="muted">Validate storage, networking, containers, VMs, application runtime and core LightNAS services.</p>
        </div>
        <div class="head-actions">
          <button class="secondary" type="button" data-appliance-health>Check health</button>
          <button class="primary" type="button" data-appliance-repair>Repair managed services</button>
        </div>
      </div>
    </section>

    <section class="panel admin-service-links">
      <div><span class="eyebrow">SERVICES</span><h2>Notifications & integrations</h2><p class="muted">Configure SMTP, identity providers, API automation and external integrations without duplicating the full navigation tree.</p></div>
      <div class="head-actions"><button class="secondary" data-view-link="smtp">SMTP</button><button class="secondary" data-view-link="integrations">Integrations</button></div>
    </section>`;
}


function moduleView(view) {
  if (view === 'apps') {
    const docker = state.runtimes?.docker;
    const apps = state.runtimes?.catalog || [];
    const categories = [...new Set(apps.map(app => app.category).filter(Boolean))].sort();
    return `${pageHead('App Store', 'Install curated open-source applications directly from LightNAS.', '<button class="secondary" data-action="refresh-runtime">Refresh apps</button>')}
      ${runtimeBanner('docker')}
      <section class="app-catalog-toolbar panel">
        <div><span class="eyebrow">LIGHTNAS APPLICATION CATALOG</span><h2>${apps.length} one-click apps</h2><p class="muted">A broad NAS app catalog sourced from official upstream and community container images, including many apps commonly found in TrueNAS-style catalogs. LightNAS only lists entries its current one-click engine can actually launch; complex multi-service stacks will join as Compose support expands. No Proxmox configuration or manual port forwarding is required for managed catalog apps.</p></div>
        <div class="app-filter-controls">
          <label>Search<input id="app-search" type="search" placeholder="Search apps, categories, or images…"></label>
          <label>Category<select id="app-category"><option value="">All categories</option>${categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')}</select></label>
        </div>
      </section>
      <div class="tool-grid app-catalog-grid">${apps.map(app => {
        const instance = docker?.containers?.find(container => container.name === `lightnas-app-${app.id}`);
        const appUrl = `http://${location.hostname}:${app.port}/`;
        const running = instance?.state === 'running';
        const searchText = `${app.name} ${app.category} ${app.description} ${app.image} ${app.source || ''}`.toLowerCase();
        return `<article class="panel app-card" data-app-card data-category="${escapeHtml(app.category)}" data-search="${escapeHtml(searchText)}"><span class="eyebrow">${escapeHtml(app.category)}</span><h2>${escapeHtml(app.name)}</h2><p class="muted">${escapeHtml(app.description)}</p><p class="muted app-source">${escapeHtml(app.source || 'Open source')} · ${escapeHtml(app.image)} · Port ${app.port}</p>${instance ? `<p class="muted">${escapeHtml(instance.status || instance.state)} · Container IP ${escapeHtml(instance.ip || 'not assigned')}</p><div class="head-actions">${running ? `<a class="primary" href="${escapeHtml(appUrl)}" target="_blank" rel="noopener">Open application</a><button class="secondary" type="button" data-app-terminal="${escapeHtml(instance.name)}" data-app-name="${escapeHtml(app.name)}">Terminal</button>` : ''}<button class="secondary" data-app-action="${running ? 'stop' : 'start'}" data-app-id="${app.id}">${running ? 'Stop' : 'Start'}</button><button class="secondary" data-app-action="restart" data-app-id="${app.id}">Restart</button><button class="secondary" data-app-action="remove" data-app-id="${app.id}">Remove</button></div>` : `<button class="primary" data-install="${app.id}">Install app</button>`}</article>`;
      }).join('') || '<div class="empty"><p>Loading catalog…</p></div>'}</div>
      <section class="module-hero"><h2>Managed app hosting</h2><p>LightNAS downloads each app, creates its persistent storage, publishes its web service on the LightNAS LAN address, starts it after reboot, and verifies that the service is reachable. ${docker?.available && docker?.enabled ? 'The integrated App Store engine is ready.' : 'Rerun the one-click LightNAS installer to provision the integrated App Store engine.'}</p></section>`;
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
  if (!info) return `${pageHead('Networking', 'Manage interfaces, bridges, VLANs, bonds, routes and DNS.', '<button class="secondary" data-action="refresh-network">Refresh</button>')}<div class="empty">Loading network inventory…</div>`;

  const defaultRoute = [...(info.routes || [])].filter(item => item.destination === 'default').sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0] || null;
  const bridge = control?.bridge || null;
  const connections = control?.connections || [];
  const devices = control?.devices || [];
  const interfaces = (info.interfaces || []).filter(item => {
    const name = item.name || '';
    return name !== 'lo' && !/^veth|^tap|^tun|^docker|^br-[A-Fa-f0-9]+$/i.test(name);
  });
  const byName = new Map(interfaces.map(item => [item.name, item]));
  const interfaceRows = devices.map(device => {
    const live = byName.get(device.name);
    const profile = connections.find(item => item.device === device.name || item.name === device.connection);
    const ipv4 = live?.addresses?.filter(item => item.family === 'inet').map(item => `${item.address}/${item.prefix}`).join(', ') || '—';
    const role = device.bridgePortOf ? `Port of ${device.bridgePortOf}`
      : device.name === bridge?.name ? 'LightNAS LAN bridge'
      : defaultRoute?.device === device.name ? 'Default uplink'
      : device.type === 'bond' ? 'Bond'
      : device.type === 'vlan' ? 'VLAN'
      : device.type === 'wifi' ? 'Wi-Fi'
      : 'Interface';
    return { device, live, profile, ipv4, role };
  });

  // Include kernel-visible bridge/VLAN interfaces that NetworkManager did not
  // report as managed devices so the table remains an honest host inventory.
  for (const live of interfaces) {
    if (interfaceRows.some(row => row.device.name === live.name)) continue;
    interfaceRows.push({
      device: { name: live.name, type: 'kernel', state: live.state || 'unknown', connection: null },
      live, profile: null,
      ipv4: live.addresses?.filter(item => item.family === 'inet').map(item => `${item.address}/${item.prefix}`).join(', ') || '—',
      role: live.name === bridge?.name ? 'LightNAS LAN bridge' : 'Kernel interface'
    });
  }

  const routes = (info.routes || []).filter(route => !/^docker|^veth|^tap|^tun/i.test(route.device || ''));
  const wifiDevices = devices.filter(item => item.type === 'wifi' && !['unavailable','unmanaged'].includes(item.state));

  return `${pageHead('Networking', 'Proxmox-style host networking for the LightNAS node. Create configuration first, then explicitly activate changes that could affect management connectivity.', '<div class="head-actions"><button class="secondary" data-action="refresh-network">Refresh</button><button class="primary" data-network-add-bridge>+ Bridge</button><button class="secondary" data-network-add-vlan>+ VLAN</button><button class="secondary" data-network-add-bond>+ Bond</button><button class="secondary" data-network-add-route>+ Route</button></div>')}
    <section class="network-status-strip">
      <div><span>Manager</span><strong>${escapeHtml(control?.manager || 'Kernel')}</strong></div>
      <div><span>Connectivity</span><strong>${escapeHtml(control?.connectivity || 'unknown')}</strong></div>
      <div><span>Default gateway</span><strong>${escapeHtml(defaultRoute?.gateway || '—')}</strong></div>
      <div><span>Default device</span><strong>${escapeHtml(defaultRoute?.device || '—')}</strong></div>
    </section>

    <section class="panel network-table-panel">
      <div class="panel-head"><div><span class="eyebrow">NODE NETWORK</span><h2>Interfaces</h2></div><span class="muted">${interfaceRows.length} visible</span></div>
      <div class="network-table" role="table">
        <div class="network-table-row network-table-head" role="row"><span>Name</span><span>Type / role</span><span>State</span><span>IPv4</span><span>Profile</span><span>Actions</span></div>
        ${interfaceRows.map(({ device, profile, ipv4, role }) => `<div class="network-table-row" role="row">
          <strong>${escapeHtml(device.name)}</strong>
          <span>${escapeHtml(device.type || 'interface')}<small>${escapeHtml(role)}</small></span>
          <span><b class="network-state-badge ${/connected|up/i.test(device.state || '') ? 'online' : 'neutral'}" title="${escapeHtml(String(device.state || 'unknown'))}">${/connected/i.test(String(device.state || '')) ? 'CONNECTED' : escapeHtml(String(device.state || 'unknown').toUpperCase())}</b></span>
          <span class="mono-cell">${escapeHtml(ipv4)}</span>
          <span>${escapeHtml(profile?.name || device.connection || '—')}<small>${profile ? `autostart ${profile.autoconnect ? 'yes' : 'no'}` : ''}</small></span>
          <div class="runtime-actions">
            ${profile ? `<button class="secondary" data-network-edit="${escapeHtml(profile.name)}">Edit</button>` : ''}
            ${device.state === 'connected' ? `<button class="secondary" data-network-device="${escapeHtml(device.name)}" data-network-device-action="disconnect">Down</button>` : device.type !== 'kernel' ? `<button class="secondary" data-network-device="${escapeHtml(device.name)}" data-network-device-action="connect">Up</button>` : ''}
          </div>
        </div>`).join('') || '<div class="empty">No managed network interfaces are visible.</div>'}
      </div>
    </section>

    <div class="dashboard-grid network-secondary-grid">
      <section class="panel">
        <div class="panel-head"><h2>Routes</h2><button class="secondary" data-network-add-route>+ Static route</button></div>
        <div class="route-table">${routes.map(route => {
          const profile = connections.find(item => item.device === route.device);
          const protocol = String(route.protocol || '').toLowerCase();
          const persistentEditable = Boolean(profile && route.gateway && !['kernel','dhcp','ra','redirect'].includes(protocol));
          const runtimeEditable = Boolean(route.device && route.gateway);
          const normalizedDestination = route.destination === 'default' ? '0.0.0.0/0' : route.destination;
          const oldRoute = `${normalizedDestination} ${route.gateway || ''} ${route.metric ?? 100}`.trim();
          return `<div class="route-row">
            <strong>${escapeHtml(route.destination)}</strong>
            <span>via ${escapeHtml(route.gateway || 'on-link')}</span>
            <span>${escapeHtml(route.device || '—')}<small>${escapeHtml(profile?.name || protocol || '')}</small></span>
            <span>metric ${route.metric ?? '—'}</span>
            <div class="runtime-actions">
              ${persistentEditable
                ? `<button class="secondary" data-network-edit-route data-route-connection="${escapeHtml(profile.name)}" data-route-destination="${escapeHtml(route.destination)}" data-route-gateway="${escapeHtml(route.gateway || '')}" data-route-device="${escapeHtml(route.device || '')}" data-route-metric="${route.metric ?? 100}" data-route-old="${escapeHtml(oldRoute)}">Edit</button><button class="secondary danger-button" data-network-delete-route data-route-connection="${escapeHtml(profile.name)}" data-route-old="${escapeHtml(oldRoute)}">Delete</button>`
                : runtimeEditable
                  ? `<button class="secondary" data-network-edit-route data-route-runtime="true" data-route-destination="${escapeHtml(route.destination)}" data-route-gateway="${escapeHtml(route.gateway || '')}" data-route-device="${escapeHtml(route.device || '')}" data-route-metric="${route.metric ?? 100}">Edit</button><span class="muted route-managed-label">runtime</span>`
                  : '<span class="muted route-managed-label">system</span>'}
            </div>
          </div>`;
        }).join('') || '<div class="empty">No routes visible.</div>'}</div>
      </section>
      <section class="panel">
        <h2>DNS</h2>
        <p class="muted">Active resolver servers</p>
        <div class="dns-list">${(info.dns || []).map(item => `<code>${escapeHtml(item)}</code>`).join('') || '<span class="muted">No DNS servers detected.</span>'}</div>
        <p class="muted">Edit DNS and IPv4 settings from an interface connection profile.</p>
      </section>
    </div>

    ${wifiDevices.length ? `<section class="panel"><div class="panel-head"><h2>Wi-Fi</h2><span class="muted">Available wireless networks</span></div><div class="inventory-grid">${(control?.wifi || []).map(item => `<article class="inventory-card"><div class="volume-title"><h3>${escapeHtml(item.ssid)}</h3><span class="network-state-badge ${item.connected ? 'online' : 'neutral'}">${item.connected ? 'CONNECTED' : `${item.signal}%`}</span></div><p>${escapeHtml(item.security || 'Open')}</p><button class="secondary" data-wifi-connect="${escapeHtml(item.ssid)}">${item.connected ? 'Prefer' : 'Connect'}</button></article>`).join('') || '<div class="empty">No Wi-Fi networks currently in range.</div>'}</div></section>` : ''}

    <div class="module-note"><b>Safe apply model:</b> Creating a bridge, VLAN, bond or route writes configuration without intentionally dropping the current management connection. Activating a modified management profile can interrupt this browser session, so LightNAS asks before applying it.</div>`;
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
  const integrations = [
    {
      name:'System containers',
      detail: containers?.available && containers?.enabled ? `${containers.provider || 'provider'} connected` : containers?.reason || 'Checking container provider…',
      online:Boolean(containers?.available && containers?.enabled),
      target:'containers'
    },
    {
      name:'Virtualization',
      detail: vm?.available && vm?.enabled ? `${vm.provider || 'KVM'} connected` : vm?.reason || 'Checking virtualization…',
      online:Boolean(vm?.available && vm?.enabled),
      target:'vms'
    },
    {
      name:'App Store engine',
      detail: apps?.available && apps?.enabled ? 'Docker/OCI engine connected' : apps?.reason || 'Docker/OCI engine disabled',
      online:Boolean(apps?.available && apps?.enabled),
      target:'apps'
    },
    {
      name:'AI workspace',
      detail: state.overview.appliance.features?.ai !== false ? 'AI workspace enabled' : 'AI workspace disabled in Capabilities',
      online:state.overview.appliance.features?.ai !== false,
      target:'ai'
    },
    {
      name:'Email / SMTP',
      detail: state.smtp ? `${state.smtp.host}:${state.smtp.port}` : 'Not configured',
      online:Boolean(state.smtp),
      target:'smtp'
    }
  ];
  return `${pageHead('Integrations', 'Connected runtimes, services, and LightNAS providers.', '<button class="secondary" data-action="refresh-runtime">Refresh</button>')}
    <section class="integration-summary-grid">
      <article class="panel integration-summary"><span class="eyebrow">CONNECTED</span><strong>${integrations.filter(item => item.online).length}</strong><p>services currently ready</p></article>
      <article class="panel integration-summary"><span class="eyebrow">AVAILABLE</span><strong>${integrations.length}</strong><p>managed integration points</p></article>
      <article class="panel integration-summary"><span class="eyebrow">CONTROL</span><strong>Local</strong><p>managed directly by LightNAS</p></article>
    </section>
    <section class="integration-list panel">
      <div class="panel-head"><div><span class="eyebrow">PROVIDERS</span><h2>Integration status</h2></div><small>Live status</small></div>
      ${integrations.map(item => `<div class="integration-row"><span class="integration-dot ${item.online ? 'online' : ''}"></span><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></div><span class="user-status ${item.online ? 'active' : 'disabled'}">${item.online ? 'READY' : 'OFFLINE'}</span><button class="secondary" type="button" data-view-link="${item.target}">Open</button></div>`).join('')}
    </section>`;
}

function render(view) {
  if (view === 'media') view = 'files';
  state.view = ['home', 'storage', 'pools', 'files', 'users', 'permissions', 'shell', 'smtp', 'admin', 'shares', 'capabilities', 'apps', 'ai', 'containers', 'vms', 'monitoring', 'settings', 'network', 'firewall', 'integrations'].includes(view) ? view : 'home';
  if (!canView(state.view)) state.view = canView('home') ? 'home' : 'files';
  const content = $('#content');
  content.innerHTML = state.view === 'home' ? homeView() : state.view === 'storage' ? storageView() : state.view === 'pools' ? poolsView() : state.view === 'files' ? filesView() : state.view === 'media' ? mediaView() : state.view === 'users' ? usersView() : state.view === 'permissions' ? permissionsView() : state.view === 'shell' ? shellView() : state.view === 'smtp' ? smtpView() : state.view === 'admin' ? adminView() : state.view === 'shares' ? sharesView() : state.view === 'containers' ? containersView() : state.view === 'vms' ? vmsView() : state.view === 'settings' ? settingsView() : state.view === 'capabilities' ? capabilitiesView() : state.view === 'monitoring' ? monitoringView() : state.view === 'ai' ? aiView() : state.view === 'network' ? networkView() : state.view === 'firewall' ? firewallView() : state.view === 'integrations' ? integrationsView() : moduleView(state.view);
  $$('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === state.view));
  $(`[data-view="${state.view}"]`, $('#nav'))?.closest('details')?.setAttribute('open', '');
  content.focus({ preventScroll: true });
  bindViewActions();
  if (state.view === 'files' && state.files === null) loadFiles();
  if (['pools', 'storage'].includes(state.view) && state.spaces === null) loadSpaces();
  if (['users', 'permissions'].includes(state.view) && state.users === null) loadUsers();
  if (['smtp','integrations'].includes(state.view) && state.smtp === undefined) loadSmtp();
  if (['files', 'media'].includes(state.view) && state.media === null) loadMedia();
  if (['network', 'firewall'].includes(state.view) && !state.network) loadNetwork();
  if (state.view === 'containers') {
    if (!state.runtimes?.containers && !state.containerError) loadContainers();
    if ((!state.runtimes?.docker || !state.runtimes?.catalog) && !state.runtimeError) loadRuntimes();
  }
  if (['apps', 'ai', 'vms', 'integrations'].includes(state.view) && (!state.runtimes?.docker || !state.runtimes?.virtualization || !state.runtimes?.catalog) && !state.runtimeError) loadRuntimes();
}

function bindViewActions() {
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
  document.querySelectorAll('#content [data-ai-prompt]').forEach(button => button.addEventListener('click', () => {
    const question = button.dataset.aiPrompt || '';
    state.aiMessages.push({ role:'user', text:question });
    state.aiMessages.push({ role:'agent', ...lightnasAgentReply(question) });
    render('ai');
  }));
  $('[data-ai-form]', $('#content'))?.addEventListener('submit', event => {
    event.preventDefault();
    const input = event.currentTarget.elements.message;
    const question = String(input.value || '').trim();
    if (!question) return;
    state.aiMessages.push({ role:'user', text:question });
    state.aiMessages.push({ role:'agent', ...lightnasAgentReply(question) });
    render('ai');
  });
  document.querySelectorAll('#content [data-ai-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.aiAction;
    if (action === 'open-apps') { location.hash = 'apps'; return; }
    if (action === 'repair-noip') {
      const containers = state.runtimes?.containers?.containers || [];
      const targets = containers.filter(item => /running|active/i.test(String(item.status || '')) && !/^\d+\.\d+\.\d+\.\d+$/.test(String(item.ipv4 || '')));
      if (!targets.length) return toast('No running containers currently need IPv4 repair.');
      if (!confirm(`Repair networking for ${targets.length} container${targets.length === 1 ? '' : 's'}? Each affected container will restart.`)) return;
      button.disabled = true;
      for (const item of targets) {
        try { await request('/api/containers', { method:'POST', body:JSON.stringify({ id:item.id || item.name, action:'repair-network' }) }); }
        catch (error) { toast(`${item.name || item.id}: ${error.message}`); }
      }
      await loadContainers();
      state.aiMessages.push({ role:'agent', ...lightnasAgentReply('diagnose container networking') });
      render('ai');
    }
  }));

  document.querySelectorAll('#content [data-feature-toggle]').forEach(button => button.addEventListener('click', async () => {
    const key = button.dataset.featureToggle;
    const enabled = button.dataset.featureEnabled !== 'true';
    button.disabled = true;
    const original = button.textContent;
    button.textContent = enabled ? 'Turning on…' : 'Turning off…';
    try {
      const result = await request('/api/capabilities/config', { method:'PATCH', body:JSON.stringify({ key, enabled }) });
      state.overview.appliance.features = result.features;
      document.querySelectorAll('[data-view]').forEach(link => link.classList.toggle('hidden', !canView(link.dataset.view, state.overview.appliance)));
      render('capabilities');
      toast(`${key} ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      toast(error.message);
    }
  }));
  document.querySelectorAll('#content [data-overview-metric]').forEach(button => button.addEventListener('click', () => {
    state.overviewMetric = button.dataset.overviewMetric;
    localStorage.setItem('lightnas-overview-metric', state.overviewMetric);
    render('home');
  }));
  $('[data-open-node-shell]', $('#content'))?.addEventListener('click', () => {
    window.open(`/node-shell.html?v=${Date.now()}`, '_blank', 'noopener,width=1200,height=800');
  });
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
      await request('/api/media/convert', { method: 'POST', body: JSON.stringify({ path: button.dataset.path || [state.folder, button.dataset.convertFile].filter(Boolean).join('/'), format: format.toLowerCase().trim() }) });
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
  $$('[data-toggle-user-create]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const form = $('#user-form', $('#content'));
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input[name="username"]')?.focus();
  }));
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
  $$('[data-action="refresh-runtime"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Refreshing…';
    if (state.view === 'containers') await Promise.all([loadContainers(), loadRuntimes()]);
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
    const progress = window.LightNASProgress?.open(`Installing ${app.name}`, 'Creating the app container and starting the service…', { modal:false });
    try {
      await request(`/api/catalog/${app.id}/install`, { method: 'POST', body: JSON.stringify(setup) });
      await loadRuntimes();
      progress?.succeed(`${app.name} installed and started successfully.`);
      toast(`${app.name} installed. Use Open application to access it.`);
    }
    catch (error) { progress?.fail(error.message); toast(error.message); button.disabled = false; button.textContent = 'Install'; }
  }));
  $$('[data-app-open]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const url = button.dataset.appOpen;
    if (url) window.open(url, '_blank', 'noopener');
  }));
  $$('[data-app-terminal]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.appTerminal;
    const name = button.dataset.appName || id;
    window.open(`/container-console.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&type=app`, '_blank', 'noopener');
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
      await request('/api/settings', { method: 'PATCH', body: JSON.stringify(input) });
      state.overview = await request('/api/overview');
      $('#mini-name').textContent = state.overview.appliance.deviceName;
      applyApplianceBranding(state.overview.appliance);
      render('settings');
      toast('General settings saved.');
    } catch (problem) { error.textContent = problem.message; }
    finally { button.disabled = false; }
  });
  $('#password-form', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    const error = $('.form-error', form);
    error.textContent = '';
    button.disabled = true;
    try {
      const input = Object.fromEntries(new FormData(form));
      const result = await request('/api/settings', { method:'PATCH', body:JSON.stringify({
        deviceName: state.overview.appliance.deviceName,
        timezone: state.overview.appliance.timezone,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword
      }) });
      if (result.signInRequired) { showAuth('login'); toast('Password changed. Sign in with the new password.'); }
    } catch (problem) { error.textContent = problem.message; }
    finally { button.disabled = false; }
  });
  $('#logo-upload', $('#content'))?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const error = $('[data-logo-error]', $('#content'));
    error.textContent = '';
    try {
      const response = await fetch('/api/branding/logo', { method:'PUT', headers:{ 'Content-Type':file.type, 'X-LightNAS-Request':'1' }, body:file, credentials:'same-origin' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Logo upload failed.');
      state.overview = await request('/api/overview');
      applyApplianceBranding(state.overview.appliance);
      render('settings');
      toast('Logo updated.');
    } catch (problem) { error.textContent = problem.message; }
  });
  $('[data-remove-logo]', $('#content'))?.addEventListener('click', async () => {
    try {
      await request('/api/branding/logo', { method:'DELETE' });
      state.overview = await request('/api/overview');
      applyApplianceBranding(state.overview.appliance);
      render('settings');
      toast('Default LightNAS logo restored.');
    } catch (problem) { toast(problem.message); }
  });
  const filterApps = () => {
    const search = ($('#app-search', $('#content'))?.value || '').trim().toLowerCase();
    const category = $('#app-category', $('#content'))?.value || '';
    $$('[data-app-card]', $('#content')).forEach(card => {
      const matchesText = !search || String(card.dataset.search || '').includes(search);
      const matchesCategory = !category || card.dataset.category === category;
      card.hidden = !(matchesText && matchesCategory);
    });
  };
  $('#app-search', $('#content'))?.addEventListener('input', filterApps);
  $('#app-category', $('#content'))?.addEventListener('change', filterApps);
  $$('[data-action="new-share"]', $('#content')).forEach(button => button.addEventListener('click', () => $('#share-dialog').showModal()));
  $$('[data-view-link]', $('#content')).forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.viewLink; }));
  $$('[data-action="refresh"]', $('#content')).forEach(button => button.addEventListener('click', async () => { try { state.overview = await request('/api/overview'); captureOverviewMetrics(); render(state.view); toast('Readings updated.'); } catch (error) { toast(error.message); } }));
  $$('[data-action="refresh-files"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    if (button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      state.fileError = null;
      await loadFiles(true);
      if (state.fileError) toast(state.fileError);
      else toast('Files refreshed.');
    } catch (error) {
      toast(error.message || 'Unable to refresh files.');
    } finally {
      const liveButton = $('#content [data-action="refresh-files"]');
      if (liveButton) {
        liveButton.disabled = false;
        liveButton.textContent = original || 'Refresh';
      }
    }
  }));
  $$('[data-action="refresh-storage"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Scanning…';
    try {
      await request('/api/storage/scan');
      state.overview = await request('/api/overview');
      rememberStorageSignature();
      render(state.view);
      toast('Storage rescan complete.');
    } catch (error) { toast(error.message); }
  }));
  $$('[data-file-view]', $('#content')).forEach(button => button.addEventListener('click', () => {
    state.fileView = ['list','grid','gallery'].includes(button.dataset.fileView) ? button.dataset.fileView : 'grid';
    localStorage.setItem('lightnas-file-view', state.fileView);
    render('files');
  }));
  $('[data-mobile-files-settings]', $('#content'))?.addEventListener('click', () => {
    let dialog = $('#mobile-files-settings-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'mobile-files-settings-dialog';
      dialog.className = 'lightnas-dialog mobile-files-settings-dialog';
      dialog.innerHTML = `
        <div class="dialog-body">
          <div class="dialog-head"><div><span class="eyebrow">FILES & MEDIA</span><h2>Mobile view settings</h2></div><button class="dialog-close" type="button" data-mobile-files-settings-close aria-label="Close">×</button></div>
          <div class="mobile-files-setting-group">
            <span class="eyebrow">VIEW</span>
            <div class="mobile-files-view-options">
              <button class="secondary" type="button" data-mobile-file-view="grid">▦ Grid</button>
              <button class="secondary" type="button" data-mobile-file-view="gallery">▦ Photos</button>
            </div>
          </div>
          ${state.overview.appliance.role === 'administrator' && state.overview.appliance.features?.phoneSync !== false ? '<div class="mobile-files-setting-group"><span class="eyebrow">PHONE LIBRARY</span><button class="secondary" type="button" data-open-phone-sync-from-settings>Phone sync</button></div>' : ''}
        </div>`;
      document.body.append(dialog);
      dialog.querySelector('[data-mobile-files-settings-close]')?.addEventListener('click', () => dialog.close());
      dialog.querySelectorAll('[data-mobile-file-view]').forEach(button => button.addEventListener('click', () => {
        state.fileView = button.dataset.mobileFileView === 'gallery' ? 'gallery' : 'grid';
        localStorage.setItem('lightnas-file-view', state.fileView);
        dialog.close();
        render('files');
      }));
      dialog.querySelector('[data-open-phone-sync-from-settings]')?.addEventListener('click', () => {
        dialog.close();
        $('#content .phone-sync-button')?.click();
      });
    }
    dialog.querySelectorAll('[data-mobile-file-view]').forEach(button => button.classList.toggle('active', button.dataset.mobileFileView === state.fileView));
    dialog.showModal();
  });

  $('[data-phone-sync]', $('#content'))?.addEventListener('click', async () => {
    let dialog = $('#phone-sync-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'phone-sync-dialog';
      dialog.className = 'lightnas-dialog phone-sync-dialog';
      dialog.innerHTML = `
        <div class="dialog-body">
          <div class="dialog-head"><div><span class="eyebrow">PHONE LIBRARY SYNC</span><h2>Automatically send new photos & videos to LightNAS</h2></div><button class="dialog-close" type="button" data-phone-sync-close aria-label="Close">×</button></div>
          <p class="muted">LightNAS provides a private upload endpoint for iPhone Shortcuts or Android automation. New images are routed to Photos and videos to Videos automatically.</p>
          <div class="phone-sync-steps">
            <div><b>1</b><span>Create a phone sync key.</span></div>
            <div><b>2</b><span>On iPhone, use Shortcuts automation when Camera closes or at a schedule. Send the newest photo/video with an HTTP PUT request.</span></div>
            <div><b>3</b><span>On Android, use Tasker/MacroDroid to watch DCIM and PUT new files to the same endpoint.</span></div>
          </div>
          <div class="phone-sync-secret hidden" data-phone-sync-secret>
            <label>Upload URL<input data-phone-sync-url readonly></label>
            <label>Bearer token<textarea data-phone-sync-token readonly rows="3"></textarea></label>
            <p class="muted">Header: <code>Authorization: Bearer TOKEN</code>. Set <code>Content-Type</code> to the file MIME type. This token is shown only once.</p>
          </div>
          <div class="dialog-actions"><button class="secondary" type="button" data-phone-sync-close>Close</button><button class="primary" type="button" data-create-phone-sync>Create phone sync key</button></div>
          <div class="form-error" data-phone-sync-error role="alert"></div>
        </div>`;
      document.body.append(dialog);
      dialog.querySelectorAll('[data-phone-sync-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
      dialog.querySelector('[data-create-phone-sync]').addEventListener('click', async event => {
        const button = event.currentTarget;
        const error = dialog.querySelector('[data-phone-sync-error]');
        error.textContent = '';
        button.disabled = true;
        try {
          const result = await request('/api/mobile-sync/key', { method:'POST', body:'{}' });
          const secret = dialog.querySelector('[data-phone-sync-secret]');
          secret.classList.remove('hidden');
          dialog.querySelector('[data-phone-sync-url]').value = location.origin + '/api/mobile-sync/upload?filename=FILE_NAME';
          dialog.querySelector('[data-phone-sync-token]').value = result.token;
          button.textContent = 'New key created';
        } catch (problem) { error.textContent = problem.message; }
        finally { button.disabled = false; }
      });
    }
    dialog.showModal();
  });
  $$('[data-download-folder]', $('#content')).forEach(button => button.addEventListener('click', () => {
    const path = button.dataset.downloadFolder || '';
    const link = document.createElement('a');
    link.href = `/api/files/archive?path=${encodeURIComponent(path)}`;
    link.download = `${path.split('/').pop() || 'folder'}.tar.gz`;
    document.body.append(link);
    link.click();
    link.remove();
  }));
  document.querySelectorAll('#content [data-library-tab]').forEach(button => button.addEventListener('click', async () => {
    state.filesSettingsOpen = false;
    const folder = button.dataset.libraryTab || '';
    if (folder && folder !== 'Attached storage') {
      try { await request(`/api/files?path=${encodeURIComponent(folder)}`); }
      catch {
        try { await request(`/api/files?path=${encodeURIComponent(folder)}`, { method: 'POST', body: '{}' }); }
        catch (error) { return toast(error.message); }
      }
    }
    state.folder = folder;
    state.files = null;
    render('files');
  }));
  $('[data-files-settings-tab]', $('#content'))?.addEventListener('click', () => {
    state.filesSettingsOpen = true;
    render('files');
  });
  document.querySelectorAll('#content [data-folder]').forEach(button => button.addEventListener('click', () => { state.folder = button.dataset.folder; state.files = null; render('files'); }));
  document.querySelectorAll('#content [data-open]').forEach(button => button.addEventListener('click', async event => {
    const path = button.dataset.path || [state.folder, button.dataset.open].filter(Boolean).join('/');
    if (button.dataset.directory === 'true') { state.folder = path; state.files = null; render('files'); return; }
    // On mobile Photos view, the preview layer owns the click. Do not also
    // trigger the legacy download handler, which caused the tile image to be
    // replaced/invalidated after opening it once.
    if (isPreviewableFileName(button.dataset.open || '')) {
      event.preventDefault();
      return;
    }
    try { const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`); if (!response.ok) throw new Error((await response.json()).error); const object = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = object; link.download = button.dataset.open; link.click(); setTimeout(() => URL.revokeObjectURL(object), 60000); } catch (error) { toast(error.message); }
  }));
  $$('[data-action="new-folder"]', $('#content')).forEach(button => button.addEventListener('click', async () => { const name = prompt('New folder name'); if (name === null) return; try { await request(`/api/files?path=${encodeURIComponent([state.folder, name].filter(Boolean).join('/'))}`, { method: 'POST', body: '{}' }); await loadFiles(); toast('Folder created.'); } catch (error) { toast(error.message); } }));
  $('#file-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    await uploadFilesWithProgress(files, false);
  });
  $('#folder-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    await uploadFilesWithProgress(files, true);
  });
  const dropZone = $('[data-file-drop]', content);
  if (dropZone) {
    for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, event => {
      event.preventDefault();
      dropZone.classList.add('drag-active');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    for (const type of ['dragleave', 'drop']) dropZone.addEventListener(type, event => {
      event.preventDefault();
      dropZone.classList.remove('drag-active');
    });
    dropZone.addEventListener('drop', async event => {
      const files = [...(event.dataTransfer?.files || [])];
      await uploadFilesWithProgress(files, false);
    });
  }
  $$('[data-delete-file]', content).forEach(button => button.addEventListener('click', async () => {
    if (!confirm(`Delete ${button.dataset.deleteFile}? Folders must be empty.`)) return;
    const path = button.dataset.path || [state.folder, button.dataset.deleteFile].filter(Boolean).join('/');
    try { await request(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); await loadFiles(); toast('Deleted.'); } catch (error) { toast(error.message); }
  }));
  $$('[data-delete-share]', content).forEach(button => button.addEventListener('click', async () => { if (!confirm(`Remove network share ${button.dataset.name}? The shared files will be preserved.`)) return; try { await request(`/api/shares/${button.dataset.deleteShare}`, { method: 'DELETE' }); state.overview = await request('/api/overview'); render(state.view); toast('Share removed. Files were preserved.'); } catch (error) { toast(error.message); } }));
}

async function submitAuth(form, path) {
  const error = $('.form-error', form);
  const button = $('button[type="submit"]', form);
  error.textContent = '';
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    if (path === '/api/login') data.mfaMethod = $('#login-mfa')?.dataset.method || '';
    await request(path, { method: 'POST', body: JSON.stringify(data) });
    await showConsole();
  } catch (problem) {
    if (path === '/api/login' && problem.payload?.mfaRequired) {
      const methods = Array.isArray(problem.payload.methods) ? problem.payload.methods : [];
      setLoginMethods(methods);
      const selected = $('#login-mfa')?.dataset.method || methods[0] || '';
      selectLoginMethod(selected);
      const selector = selected === 'totp' ? 'input[name="totp"]' : selected === 'sms' ? 'input[name="smsCode"]' : null;
      if (selector) $(`#login-form ${selector}`)?.focus();
    }
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

$('#setup-form').addEventListener('submit', event => { event.preventDefault(); submitAuth(event.currentTarget, '/api/setup'); });
$('#login-form').addEventListener('submit', event => { event.preventDefault(); submitAuth(event.currentTarget, '/api/login'); });
$('#login-form input[name="username"]').addEventListener('input', () => {
  setLoginMethods([]);
  clearTimeout(loginOptionsTimer);
  loginOptionsTimer = setTimeout(refreshLoginMethods, 220);
});
$('#login-form input[name="username"]').addEventListener('blur', refreshLoginMethods);
$$('[data-login-method]').forEach(button => button.addEventListener('click', () => selectLoginMethod(button.dataset.loginMethod)));
$('#login-send-sms')?.addEventListener('click', async () => {
  const form = $('#login-form');
  const error = $('.form-error', form);
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  if (!username || !password) {
    error.textContent = 'Enter your username and password before requesting an SMS code.';
    return;
  }
  const button = $('#login-send-sms');
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await request('/api/login/sms/send', { method:'POST', body:JSON.stringify({ username, password }) });
    const status = $('#login-sms-status');
    if (status) status.textContent = `Code sent to ${result.sentTo}. It expires in 5 minutes.`;
    form.elements.smsCode?.focus();
    toast('SMS verification code sent.');
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
});

$('#login-use-passkey')?.addEventListener('click', async () => {
  const form = $('#login-form');
  const error = $('.form-error', form);
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  if (!username || !password) {
    error.textContent = 'Enter your username and password before using your passkey.';
    return;
  }
  if (!window.isSecureContext || !navigator.credentials || !window.PublicKeyCredential) {
    error.textContent = 'Passkeys require HTTPS (or localhost) and a WebAuthn-capable browser.';
    return;
  }
  const button = $('#login-use-passkey');
  button.disabled = true;
  error.textContent = '';
  try {
    const options = await request('/api/login/passkey/options', { method:'POST', body:JSON.stringify({ username, password }) });
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlBytes(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout || 60000,
        userVerification: 'preferred',
        allowCredentials: (options.allowCredentials || []).map(item => ({ ...item, id:b64urlBytes(item.id) }))
      }
    });
    if (!credential) throw new Error('Passkey sign-in was cancelled.');
    await request('/api/login/passkey/verify', {
      method:'POST',
      body:JSON.stringify({ username, response:serializePasskeyAssertion(credential) })
    });
    await showConsole();
  } catch (problem) {
    error.textContent = problem.message || 'Passkey sign-in failed.';
  } finally {
    button.disabled = false;
  }
});
$('#node-shell-top')?.addEventListener('click', () => {
  window.open(`/node-shell.html?v=${Date.now()}`, '_blank', 'noopener,width=1200,height=800');
});
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); setLoginMethods([]); showAuth('login'); });
function setMobileSidebar(open) {
  const sidebar = $('.sidebar');
  const backdrop = $('#sidebar-backdrop');
  if (!sidebar) return;
  sidebar.classList.toggle('open', Boolean(open));
  if (backdrop) backdrop.hidden = !open;
  document.body.classList.toggle('mobile-sidebar-open', Boolean(open));
}

function applySidebarPreference() {
  const collapsed = localStorage.getItem('lightnas-sidebar-collapsed') === '1';
  $('#console').classList.toggle('sidebar-collapsed', collapsed && innerWidth > 760);
  if (innerWidth > 760) setMobileSidebar(false);
}
applySidebarPreference();
$('#menu').addEventListener('click', () => {
  if (innerWidth <= 760) {
    setMobileSidebar(!$('.sidebar').classList.contains('open'));
    return;
  }
  const collapsed = !$('#console').classList.contains('sidebar-collapsed');
  $('#console').classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('lightnas-sidebar-collapsed', collapsed ? '1' : '0');
});
$('#sidebar-close')?.addEventListener('click', () => setMobileSidebar(false));
$('#sidebar-backdrop')?.addEventListener('click', () => setMobileSidebar(false));
addEventListener('keydown', event => { if (event.key === 'Escape' && innerWidth <= 760) setMobileSidebar(false); });
addEventListener('resize', applySidebarPreference);
$('#theme-toggle').addEventListener('click', () => { theme = themeChoices[(themeChoices.indexOf(theme) + 1) % themeChoices.length]; localStorage.setItem('lightnas-theme', theme); applyTheme(); toast(`Appearance: ${theme}`); });
$('#avatar').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('Profile picture must be 8 MiB or smaller.');
    try {
      const response = await fetch('/api/profile/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'X-LightNAS-Request': '1' },
        body: file
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to upload profile picture.');
      state.overview = await request('/api/overview');
      const appliance = state.overview.appliance;
      const avatar = $('#avatar');
      avatar.textContent = '';
      avatar.style.backgroundImage = `url("/api/profile/avatar?v=${Date.now()}")`;
      avatar.classList.add('has-photo');
      toast('Profile picture updated.');
    } catch (error) { toast(error.message); }
  }, { once: true });
  input.click();
});
$('#mobile-more').addEventListener('click', () => setMobileSidebar(true));
$$('[data-view]').forEach(link => link.addEventListener('click', () => setMobileSidebar(false)));
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
    toast('Network share created. Connection addresses are shown on the Shares page.');
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
