if (window.LIGHTNAS_PRODUCT_MODE === 'hypervisor') document.body.classList.add('product-hypervisor');
const state = { overview: null, view: 'home', uiMode: window.LIGHTNAS_PRODUCT_MODE === 'hypervisor' ? 'hypervisor' : 'nas', folder: '', files: null, fileError: null, filesSettingsOpen: false, fileLibraryTab: 'all', filesNavExpanded: localStorage.getItem('lightnas-files-nav-expanded') !== '0', mobileFilesPeriod: localStorage.getItem('lightnas-mobile-files-period') || 'all', aiMessages: [], logs: null, fileView: ['list','grid','gallery'].includes(localStorage.getItem('lightnas-file-view')) ? localStorage.getItem('lightnas-file-view') : 'grid', fileTruncated: false, fileQuota: null, fileSectionCache: new Map(), fileSectionCheckedAt: new Map(), filesLoadingKeys: new Set(), communityCatalogCheckedAt: 0, overviewMetric: localStorage.getItem('lightnas-overview-metric') || 'cpu', lastNetworkSample: null, runtimes: null, runtimeError: null, containerError: null, spaces: null, users: null, groups: null, userAccess: null, smtp: undefined, media: null, network: null, software: null, license: null, builtinCatalog: null, communityCatalog: null, communityCatalogLoading: false, communityCatalogError: null, appSearch: '', appCategory: '', appVisibleLimit: 72, backupJobs: null, selectedBackupJobId: null, adminSection: localStorage.getItem('lightnas-admin-section') || 'general', metricHistory: { cpu: [], load: [], memory: [], storage: [], networkIn: [], networkOut: [] } };
function filesSectionCacheKey(tab = state.fileLibraryTab, folder = state.folder) {
  if (folder) return 'path:' + folder;
  return tab === 'folders' ? 'folders' : tab || 'all';
}

function rememberFilesSection(entries, truncated = false, key = filesSectionCacheKey()) {
  state.fileSectionCache.set(key, {
    entries: Array.isArray(entries) ? entries : [],
    truncated:Boolean(truncated),
    savedAt:Date.now()
  });
}

function restoreFilesSection(key = filesSectionCacheKey()) {
  const cached = state.fileSectionCache.get(key);
  if (!cached || !Array.isArray(cached.entries)) return false;
  state.files = cached.entries;
  state.fileTruncated = Boolean(cached.truncated);
  return true;
}

function communityCatalogStorageKey(username = state.overview?.appliance?.username || '') {
  return username ? 'lightnas-community-catalog:' + username : 'lightnas-community-catalog';
}

function restoreCommunityCatalogCache(username) {
  try {
    const cached = JSON.parse(localStorage.getItem(communityCatalogStorageKey(username)) || 'null');
    if (!cached || !Array.isArray(cached.apps) || !cached.apps.length) return false;
    state.communityCatalog = cached;
    state.communityCatalogCheckedAt = Number(cached.savedAt || 0);
    return true;
  } catch { return false; }
}

function saveCommunityCatalogCache() {
  if (!state.communityCatalog || !Array.isArray(state.communityCatalog.apps) || !state.communityCatalog.apps.length) return;
  try {
    localStorage.setItem(communityCatalogStorageKey(), JSON.stringify({
      ...state.communityCatalog,
      refreshing:false,
      stale:true,
      savedAt:Date.now()
    }));
  } catch {}
}

function mobileFilesCacheKey(username = state.overview?.appliance?.username || '') {
  return username ? `lightnas-mobile-files-cache:${username}` : '';
}

function restoreMobileFilesCache(username) {
  const key = mobileFilesCacheKey(username);
  if (!key) return;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!cached || Date.now() - Number(cached.savedAt || 0) > 120000 || !Array.isArray(cached.files)) return;
    state.files = cached.files;
    state.fileTruncated = Boolean(cached.truncated);
    state.fileSectionCache.set('all', {
      entries: cached.files,
      truncated:Boolean(cached.truncated),
      savedAt:Number(cached.savedAt || Date.now())
    });
  } catch {}
}

function saveMobileFilesCache() {
  if (state.folder !== '' || state.fileLibraryTab !== 'all' || !Array.isArray(state.files)) return;
  const key = mobileFilesCacheKey();
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify({
      savedAt: Date.now(),
      files: state.files,
      truncated: state.fileTruncated
    }));
  } catch {}
}

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
  const started = performance.now();
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  const elapsed = performance.now() - started;
  if (elapsed > 1200) console.warn(`[LightNAS slow API] ${Math.round(elapsed)}ms ${options.method || 'GET'} ${path}`);
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
  if (allowed.has(`nav.${view}`)) return true;
  const required = {
    home: ['overview.view'], hypervisor: ['overview.view', 'vms.view', 'containers.view'], files: ['files.view.own', 'files.own', 'files.read'], media: ['files.view.own', 'files.own', 'files.read'], storage: ['storage.view'], pools: ['pools.view', 'storage.manage'], shares: ['shares.view', 'shares.manage'], backups: ['backup.manage', 'storage.view'],
    apps: ['apps.view', 'apps.manage'], ai: ['apps.view', 'apps.manage', 'system.view'], containers: ['containers.view', 'containers.manage', 'containers.console'], vms: ['vms.view', 'vms.manage', 'vms.console'],
    network: ['network.view'], firewall: ['firewall.view', 'firewall.manage', 'network.manage'], monitoring: ['monitoring.view', 'system.view'], analytics: ['monitoring.view', 'system.view'], logs: ['audit.view'], capabilities: ['capabilities.view', 'system.view'],
    integrations: ['integrations.view', 'integrations.manage'], assistant: ['admin.view', 'system.view'], users: ['users.manage'], permissions: ['users.manage'], shell: ['system.shell'], smtp: ['smtp.manage'], settings: ['settings.manage'], admin: ['admin.view']
  }[view];
  return Array.isArray(required) && (!required.length || required.some(permission => allowed.has(permission)));
}


function hexRgb(hex) {
  const value = /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? String(hex) : '#000000';
  return [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
}

function colorLuminance(hex) {
  const channels = hexRgb(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function colorContrast(first, second) {
  const high = Math.max(colorLuminance(first), colorLuminance(second));
  const low = Math.min(colorLuminance(first), colorLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

function readableBrandText(preferred, background) {
  if (colorContrast(preferred, background) >= 4.5) return preferred;
  const dark = '#12283b';
  const light = '#f7fbff';
  return colorContrast(dark, background) >= colorContrast(light, background) ? dark : light;
}

function applyApplianceBranding(appliance = state.overview?.appliance) {
  if (!appliance) return;
  const brandName = String(appliance.brandName || 'LightNAS').trim() || 'LightNAS';
  const logoMode = appliance.logoMode === 'picture' && appliance.logo ? 'picture' : 'text';
  const logoUrl = logoMode === 'picture' ? `url("/api/branding/logo?v=${Date.now()}")` : '';
  const accent = /^#[0-9a-f]{6}$/i.test(String(appliance.accentColor || '')) ? appliance.accentColor : '#087b70';
  const sidebarColor = /^#[0-9a-f]{6}$/i.test(String(appliance.sidebarColor || '')) ? appliance.sidebarColor : '#ffffff';
  const contentColor = /^#[0-9a-f]{6}$/i.test(String(appliance.contentColor || '')) ? appliance.contentColor : '#f2f6fa';
  const requestedSidebarTextColor = /^#[0-9a-f]{6}$/i.test(String(appliance.sidebarTextColor || '')) ? appliance.sidebarTextColor : '#12283b';
  const requestedContentTextColor = /^#[0-9a-f]{6}$/i.test(String(appliance.contentTextColor || '')) ? appliance.contentTextColor : '#12283b';
  const sidebarTextColor = readableBrandText(requestedSidebarTextColor, sidebarColor);
  const contentTextColor = readableBrandText(requestedContentTextColor, contentColor);
  const primaryButtonColor = /^#[0-9a-f]{6}$/i.test(String(appliance.primaryButtonColor || '')) ? appliance.primaryButtonColor : accent;
  const loginButtonColor = /^#[0-9a-f]{6}$/i.test(String(appliance.loginButtonColor || '')) ? appliance.loginButtonColor : primaryButtonColor;
  const topbarColor = /^#[0-9a-f]{6}$/i.test(String(appliance.topbarColor || '')) ? appliance.topbarColor : contentColor;
  const panelColor = /^#[0-9a-f]{6}$/i.test(String(appliance.panelColor || '')) ? appliance.panelColor : contentColor;
  const inputColor = /^#[0-9a-f]{6}$/i.test(String(appliance.inputColor || '')) ? appliance.inputColor : `color-mix(in srgb, ${contentColor} 94%, ${contentTextColor})`;
  const performanceTabsColor = /^#[0-9a-f]{6}$/i.test(String(appliance.performanceTabsColor || '')) ? appliance.performanceTabsColor : panelColor;
  const performanceTabsActiveColor = /^#[0-9a-f]{6}$/i.test(String(appliance.performanceTabsActiveColor || '')) ? appliance.performanceTabsActiveColor : accent;
  const performanceTabsTextColor = /^#[0-9a-f]{6}$/i.test(String(appliance.performanceTabsTextColor || '')) ? appliance.performanceTabsTextColor : contentTextColor;
  const rgb = [1,3,5].map(index => Number.parseInt(accent.slice(index,index+2),16));
  const luminance = (0.2126*rgb[0] + 0.7152*rgb[1] + 0.0722*rgb[2]) / 255;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-2', `color-mix(in srgb, ${accent} 72%, white)`);
  document.documentElement.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 12%, var(--panel))`);
  document.documentElement.style.setProperty('--accent-strong', `color-mix(in srgb, ${accent} 82%, black)`);
  document.documentElement.style.setProperty('--accent-contrast', luminance > .58 ? '#06201c' : '#ffffff');
  document.documentElement.style.setProperty('--sidebar', sidebarColor);
  document.documentElement.style.setProperty('--brand-content-bg', contentColor);
  document.documentElement.style.setProperty('--bg', contentColor);
  document.documentElement.style.setProperty('--sidebar-text', sidebarTextColor);
  document.documentElement.style.setProperty('--sidebar-muted', `color-mix(in srgb, ${sidebarTextColor} 68%, transparent)`);
  document.documentElement.style.setProperty('--text', contentTextColor);
  document.documentElement.style.setProperty('--muted', `color-mix(in srgb, ${contentTextColor} 68%, transparent)`);
  document.documentElement.style.setProperty('--panel', panelColor);
  document.documentElement.style.setProperty('--panel-2', `color-mix(in srgb, ${panelColor} 92%, ${contentTextColor})`);
  document.documentElement.style.setProperty('--topbar', topbarColor);
  document.documentElement.style.setProperty('--input', inputColor);
  document.documentElement.style.setProperty('--primary-button', primaryButtonColor);
  document.documentElement.style.setProperty('--primary-button-contrast', readableBrandText('#ffffff', primaryButtonColor));
  document.documentElement.style.setProperty('--login-button', loginButtonColor);
  document.documentElement.style.setProperty('--login-button-contrast', readableBrandText('#ffffff', loginButtonColor));
  document.documentElement.style.setProperty('--performance-tabs', performanceTabsColor);
  document.documentElement.style.setProperty('--performance-tabs-active', performanceTabsActiveColor);
  document.documentElement.style.setProperty('--performance-tabs-text', performanceTabsTextColor);
  document.documentElement.style.setProperty('--performance-tabs-active-text', readableBrandText('#ffffff', performanceTabsActiveColor));
  document.documentElement.style.setProperty('--button', `color-mix(in srgb, ${contentColor} 88%, ${contentTextColor})`);
  document.documentElement.style.setProperty('--line', `color-mix(in srgb, ${contentTextColor} 14%, transparent)`);
  document.documentElement.style.setProperty('--line-strong', `color-mix(in srgb, ${contentTextColor} 24%, transparent)`);
  document.documentElement.style.setProperty('--auth-brand-bg', sidebarColor);
  document.documentElement.style.setProperty('--auth-panel-bg', contentColor);
  document.documentElement.style.setProperty('--auth-brand-text', sidebarTextColor);
  document.documentElement.style.setProperty('--auth-panel-text', contentTextColor);
  $$('.brand-mark').forEach(mark => {
    mark.classList.toggle('custom-logo', logoMode === 'picture');
    mark.classList.toggle('text-logo-mode', logoMode === 'text');
    mark.style.backgroundImage = logoUrl;
    mark.hidden = logoMode === 'text';
  });
  $$('[data-brand-name]').forEach(node => {
    node.textContent = brandName;
    node.hidden = logoMode === 'picture';
  });
}

async function showConsole() {
  $('#boot').classList.add('hidden');
  $('#auth').classList.add('hidden');
  $('#console').classList.remove('hidden');
  state.overview = await request('/api/overview');
  window.LightNASOverview = state.overview;
  captureOverviewMetrics();
  const { appliance } = state.overview;
  restoreMobileFilesCache(appliance.username);
  restoreCommunityCatalogCache(appliance.username);
  $('#mini-name').textContent = appliance.deviceNameVisible && appliance.deviceName ? appliance.deviceName : 'Online';
  $('#mini-name').classList.toggle('online-only', !appliance.deviceNameVisible);
  applyApplianceBranding(appliance);
  const filesSubtabs = $('[data-files-nav-subtabs]', $('#nav'));
  const filesToggle = $('[data-files-nav-toggle]', $('#nav'));
  if (filesSubtabs) filesSubtabs.hidden = !state.filesNavExpanded;
  if (filesToggle) {
    filesToggle.setAttribute('aria-expanded', state.filesNavExpanded ? 'true' : 'false');
    filesToggle.setAttribute('aria-label', state.filesNavExpanded ? 'Collapse Files & media' : 'Expand Files & media');
    filesToggle.title = state.filesNavExpanded ? 'Collapse Files & media' : 'Expand Files & media';
    filesToggle.textContent = state.filesNavExpanded ? '⌄' : '›';
  }
  const avatar = $('#avatar');
  avatar.textContent = appliance.avatar ? '' : appliance.username[0].toUpperCase();
  avatar.style.backgroundImage = appliance.avatar ? `url("/api/profile/avatar?v=${Date.now()}")` : '';
  avatar.classList.toggle('has-photo', Boolean(appliance.avatar));
  $$('[data-view]').forEach(link => link.classList.toggle('hidden', !canView(link.dataset.view, appliance)));
  $('#node-shell-top')?.classList.toggle('hidden', !canView('shell', appliance));
  $$('.nav-group').forEach(group => group.classList.toggle('hidden', !group.querySelector('[data-view]:not(.hidden)')));
  render(location.hash.slice(1) || 'home');
  // Paint first, then prewarm the data people open most often. This keeps
  // navigation responsive and means App Store is normally populated before
  // the first click instead of requiring a manual refresh on fresh installs.
  queueMicrotask(() => {
    loadBuiltinCatalog();
    loadCommunityCatalog(false);
    setTimeout(() => loadRuntimes(false), 250);
    setTimeout(() => { if (!state.network) loadNetwork(); }, 700);
    setTimeout(() => { if (state.spaces === null) loadSpaces(); }, 900);
    setTimeout(() => {
      if (!state.fileSectionCache.has('all')) loadFiles(false, { tab:'all', folder:'' }).catch(() => null);
    }, 120);
  });
  document.querySelectorAll('#nav a[data-view], .foot-admin[data-view]').forEach(link => {
    const label = link.textContent.replace(/\s+/g, ' ').trim();
    if (label) link.title = label;
  });
  rememberStorageSignature();
  clearInterval(overviewTimer);
  overviewTimer = setInterval(async () => {
    if (state.view !== 'home' || $('#console').classList.contains('hidden')) return;
    try {
      state.overview = await request('/api/overview');
      window.LightNASOverview = state.overview;
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
  return `<article class="overview-chart panel"><div class="overview-chart-head"><div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}${escapeHtml(suffix)}</strong></div><div class="overview-chart-context">${detail ? `<b>${escapeHtml(detail)}</b>` : ''}<small>Live · last ${points.length} sample${points.length === 1 ? '' : 's'}</small></div></div>${detail ? `<div class="overview-chart-detail-strip">${escapeHtml(detail)}</div>` : ''}<svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)} history"><defs><linearGradient id="chart-${escapeHtml(label.replace(/\W/g, ''))}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".52"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".04"/></linearGradient></defs><polygon points="0,40 ${coordinates} 100,40" fill="url(#chart-${escapeHtml(label.replace(/\W/g, ''))})"/><polyline points="${coordinates}" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg></article>`;
}

function overviewNetworkChart(system) {
  const received = state.metricHistory.networkIn.length > 1 ? state.metricHistory.networkIn : [0, 0];
  const transmitted = state.metricHistory.networkOut.length > 1 ? state.metricHistory.networkOut : [0, 0];
  const ceiling = Math.max(...received, ...transmitted, 1024);
  const points = values => values.map((item, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${38 - (Math.min(ceiling, item) / ceiling) * 34}`).join(' ');
  return `<article class="overview-chart panel"><div class="overview-chart-head"><div><span>Network throughput</span><strong>↓ ${bytes(received.at(-1) || 0)}/s · ↑ ${bytes(transmitted.at(-1) || 0)}/s</strong></div><div class="overview-chart-context"><b>${system.network?.interfaces || 0} active interface${system.network?.interfaces === 1 ? '' : 's'}</b><small>RX ${bytes(system.network?.receivedBytes || 0)} · TX ${bytes(system.network?.transmittedBytes || 0)}</small></div></div><svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Network receive and transmit history"><polyline points="${points(received)}" fill="none" stroke="var(--accent)" stroke-width="1.4" vector-effect="non-scaling-stroke"/><polyline points="${points(transmitted)}" fill="none" stroke="#6f7cff" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg><div class="chart-legend"><span><i></i>Received</span><span><i class="sent"></i>Sent</span></div></article>`;
}

function overviewComputeInventory() {
  const runtimes = state.runtimes || {};
  const nativeContainers = runtimes.containers?.containers || [];
  const appContainers = (runtimes.docker?.containers || []).filter(item => item.managed && String(item.name || '').startsWith('lightnas-app-'));
  const machines = runtimes.virtualization?.machineDetails || [];
  const catalog = runtimes.catalog || [];
  const entries = [
    ...machines.map(item => ({
      type:'VM', name:item.name || item.id, status:item.status || 'unknown',
      detail:`${item.cpus || '—'} vCPU · ${item.memory ? bytes(item.memory) : 'RAM unknown'}`, view:'vms'
    })),
    ...nativeContainers.map(item => ({
      type:'LXC', name:item.name || item.id, status:item.status || 'unknown',
      detail:`${item.cpus || '—'} vCPU · ${item.memory ? bytes(item.memory) : 'RAM unknown'} · ${item.ipv4 || 'No IP'}`, view:'containers'
    })),
    ...appContainers.map(item => {
      const appId = String(item.name || '').replace(/^lightnas-app-/, '');
      const catalogApp = catalog.find(entry => entry.id === appId);
      const live = item.liveStats ? `${Number(item.cpuPercent || 0).toFixed(1)}% CPU · ${item.memoryUsage || 'RAM —'}` : 'usage unavailable';
      return {
        type:'APP', name:catalogApp?.name || appId || item.name, status:item.status || item.state || 'unknown',
        detail:`${live} · ${item.ip || 'No IP'}`, view:'containers'
      };
    })
  ];
  if (!state.runtimes) return '<div class="empty compact-empty"><p>Loading virtual machines, containers, and installed apps…</p></div>';
  if (!entries.length) return '<div class="empty compact-empty"><p>No virtual machines, containers, or App Store applications are installed yet.</p></div>';
  return `<div class="overview-compute-list">${entries.map(item => `<button class="overview-compute-row" type="button" data-view-link="${item.view}"><span class="overview-compute-type">${escapeHtml(item.type)}</span><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></div><span class="compute-status"><i class="${/running|active|up/i.test(String(item.status)) ? 'online' : 'offline'}"></i>${escapeHtml(item.status)}</span></button>`).join('')}</div>`;
}

function homeView() {
  const { system, filesystems, storage, activity, appliance } = state.overview;
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
    : overviewChart('CPU usage', `${system.cpu.loadPercent}`, '%', state.metricHistory.cpu, 100, `${system.cpu.cores} logical CPUs · load ${loadAverage[0]} · ${system.cpu.model || 'CPU model unavailable'}`);
  return `${pageHead('Overview', 'Live system health and storage at a glance.', '<button class="secondary refresh-icon-button" data-action="refresh" aria-label="Refresh" title="Refresh">↻</button>')}
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
      <article class="panel overview-compute-panel"><div class="panel-head"><div><h2>Installed compute</h2><p class="muted">Virtual machines, native containers, and App Store applications.</p></div><button class="panel-link" data-view-link="containers">Open compute</button></div>${overviewComputeInventory()}</article>
      <article class="panel"><div class="panel-head"><h2>Recent activity</h2></div><div class="activity-list">${activity.length ? activity.slice(0, 5).map(item => `<div class="activity"><span class="activity-icon">${item.type === 'setup' ? '✓' : '↗'}</span><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No recent activity.</p>'}</div></article>
    </section>`;
}


function applyWorkspaceMode() {
  if (window.LIGHTNAS_PRODUCT_MODE === 'hypervisor') state.uiMode = 'hypervisor';
  const consoleRoot = $('#console');
  if (!consoleRoot) return;
  consoleRoot.dataset.workspaceMode = state.uiMode;
  document.querySelectorAll('[data-workspace-mode]').forEach(button => {
    const active = button.dataset.workspaceMode === state.uiMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-hypervisor-nav]').forEach(link => link.classList.toggle('hidden', state.uiMode !== 'hypervisor'));
}

function hypervisorInventoryRows() {
  const vms = state.runtimes?.virtualization?.machineDetails || [];
  const containers = state.runtimes?.containers?.containers || [];
  const provider = state.runtimes?.virtualization?.provider || 'KVM / libvirt';

  const vmRows = vms.map(item => {
    const running = /running|active/i.test(String(item.status || ''));
    const memory = item.memory || item.memoryBytes || 0;
    const ip = item.ipv4 || item.ip || '—';
    return `<div class="hv-grid-row" role="row">
      <span class="hv-resource-name"><span class="hv-resource-icon vm">VM</span><button class="hv-link" data-view-link="vms">${escapeHtml(item.name || item.id || 'Virtual machine')}</button></span>
      <span><span class="hv-state-dot ${running ? 'ok' : 'off'}"></span>${escapeHtml(item.status || 'unknown')}</span>
      <span>${escapeHtml(item.cpus || item.vcpus || '—')}</span>
      <span>${memory ? bytes(memory) : '—'}</span>
      <span>${escapeHtml(ip)}</span>
      <span>${escapeHtml(provider)}</span>
      <span class="hv-row-actions"><button class="secondary compact" data-view-link="vms">Manage</button></span>
    </div>`;
  });

  const ctRows = containers.map(item => {
    const running = /running|active/i.test(String(item.status || ''));
    const memory = item.memory || item.memoryBytes || 0;
    return `<div class="hv-grid-row" role="row">
      <span class="hv-resource-name"><span class="hv-resource-icon ct">CT</span><button class="hv-link" data-view-link="containers">${escapeHtml(item.name || item.id || 'Container')}</button></span>
      <span><span class="hv-state-dot ${running ? 'ok' : 'off'}"></span>${escapeHtml(item.status || 'unknown')}</span>
      <span>${escapeHtml(item.cpus || item.vcpus || '—')}</span>
      <span>${memory ? bytes(memory) : '—'}</span>
      <span>${escapeHtml(item.ipv4 || item.ip || '—')}</span>
      <span>System container</span>
      <span class="hv-row-actions"><button class="secondary compact" data-view-link="containers">Manage</button></span>
    </div>`;
  });

  return [...vmRows, ...ctRows].join('') || '<div class="hv-empty">No virtual machines or system containers are visible on this host.</div>';
}


function hypervisorResourceTree(nodeName, pools, networks, vms, containers, activeView = 'hypervisor') {
  const active = view => {
    const normalized = ['home','hypervisor'].includes(activeView) ? 'hypervisor' : activeView;
    return normalized === view ? ' active' : '';
  };
  const guestLabel = item => escapeHtml(item.name || item.hostname || item.id || 'Guest');
  const guestId = item => escapeHtml(String(item.vmid || item.ctid || item.id || ''));
  const vmItems = vms.map(item => {
    const running = /running|active/i.test(String(item.status || ''));
    const id = guestId(item);
    return `<button class="hv-tree-resource vm-resource${active('vms')}" data-view-link="vms" title="${guestLabel(item)}">
      <span class="hv-tree-status ${running ? 'online' : 'offline'}"></span>
      <span class="hv-tree-resource-icon vm">▣</span>
      <span class="hv-tree-resource-copy"><b>${id ? id + ' ' : ''}${guestLabel(item)}</b><small>${escapeHtml(item.status || 'unknown')}</small></span>
    </button>`;
  }).join('');
  const ctItems = containers.map(item => {
    const running = /running|active/i.test(String(item.status || ''));
    const id = guestId(item);
    return `<button class="hv-tree-resource ct-resource${active('containers')}" data-view-link="containers" title="${guestLabel(item)}">
      <span class="hv-tree-status ${running ? 'online' : 'offline'}"></span>
      <span class="hv-tree-resource-icon ct">⬡</span>
      <span class="hv-tree-resource-copy"><b>${id ? id + ' ' : ''}${guestLabel(item)}</b><small>${escapeHtml(item.status || 'unknown')}</small></span>
    </button>`;
  }).join('');
  const networkItems = networks.map(net => {
    const name = escapeHtml(net.name || net.bridge || 'Network');
    return `<button class="hv-tree-resource network-resource${active('network')}" data-view-link="network" title="${name}">
      <span class="hv-tree-resource-icon network">⌁</span>
      <span class="hv-tree-resource-copy"><b>${name}</b><small>${escapeHtml(net.type || net.bridge || 'virtual network')}</small></span>
    </button>`;
  }).join('');
  const storageItems = pools.map(pool => {
    const name = escapeHtml(pool.name || 'Storage');
    return `<button class="hv-tree-resource storage-resource${active('storage')}" data-view-link="storage" title="${name}">
      <span class="hv-tree-resource-icon storage">◫</span>
      <span class="hv-tree-resource-copy"><b>${name}</b><small>${escapeHtml(pool.provider || pool.type || 'datastore')}</small></span>
    </button>`;
  }).join('');

  return `<aside class="hv-resource-tree" aria-label="Hypervisor navigation">
    <div class="hv-brand"><span class="hv-brand-mark">◢</span><span>LIGHT<span>VISOR</span></span></div>
    <nav class="hv-primary-nav">
      <button class="hv-nav-item hv-dashboard-link${active('hypervisor')}" data-view-link="hypervisor"><span>⌂</span>Dashboard</button>

      <div class="hv-nav-label">RESOURCE TREE</div>
      <details class="hv-inventory-root" open>
        <summary class="hv-inventory-root-summary">
          <span class="hv-tree-chevron"></span>
          <span class="hv-tree-glyph">▦</span>
          <span class="hv-root-copy"><b>Local Datacenter</b><small>1 host · ${vms.length} VMs · ${containers.length} containers</small></span>
        </summary>

        <div class="hv-tree-branch">
          <details class="hv-inventory-group" open>
            <summary>
              <span class="hv-tree-chevron"></span><span class="hv-tree-resource-icon ct">⬡</span><b>LXC Containers</b><small>${containers.length}</small>
            </summary>
            <div class="hv-tree-children">${ctItems || '<span class="hv-tree-empty">No containers</span>'}</div>
          </details>

          <details class="hv-inventory-group" open>
            <summary>
              <span class="hv-tree-chevron"></span><span class="hv-tree-resource-icon node">▤</span><b>Nodes</b><small>1</small>
            </summary>
            <div class="hv-tree-children">
              <button class="hv-tree-resource node-resource${active('hypervisor')}" data-view-link="hypervisor">
                <span class="hv-tree-status online"></span><span class="hv-tree-resource-icon node">▤</span>
                <span class="hv-tree-resource-copy"><b>${escapeHtml(nodeName)}</b><small>Online</small></span>
              </button>
            </div>
          </details>

          <details class="hv-inventory-group" open>
            <summary>
              <span class="hv-tree-chevron"></span><span class="hv-tree-resource-icon vm">▣</span><b>Virtual Machines</b><small>${vms.length}</small>
            </summary>
            <div class="hv-tree-children">${vmItems || '<span class="hv-tree-empty">No virtual machines</span>'}</div>
          </details>

          <details class="hv-inventory-group">
            <summary>
              <span class="hv-tree-chevron"></span><span class="hv-tree-resource-icon network">⌁</span><b>SDN / Networks</b><small>${networks.length}</small>
            </summary>
            <div class="hv-tree-children">${networkItems || '<span class="hv-tree-empty">No virtual networks</span>'}</div>
          </details>

          <details class="hv-inventory-group">
            <summary>
              <span class="hv-tree-chevron"></span><span class="hv-tree-resource-icon storage">◫</span><b>Storage</b><small>${pools.length}</small>
            </summary>
            <div class="hv-tree-children">${storageItems || '<span class="hv-tree-empty">No storage pools</span>'}</div>
          </details>
        </div>
      </details>

      <div class="hv-nav-label hv-operations-label">OPERATIONS</div>
      <button class="hv-nav-item${active('backups')}" data-view-link="backups"><span>↶</span>Backups</button>
      <button class="hv-nav-item${active('analytics')}" data-view-link="analytics"><span>⌁</span>Monitoring</button>
      <button class="hv-nav-item${active('users')}" data-view-link="users"><span>◎</span>Users & RBAC</button>
      <button class="hv-nav-item${active('settings')}" data-view-link="settings"><span>⚙</span>Settings</button>
    </nav>
  </aside>`;
}

function hypervisorSubViewShell(body, activeView) {
  const storage = state.overview?.storage || {};
  const pools = storage.configuredPools || [];
  const vms = state.runtimes?.virtualization?.machineDetails || [];
  const containers = state.runtimes?.containers?.containers || [];
  const networks = state.runtimes?.virtualization?.networkDetails || [];
  const nodeName = state.overview?.appliance?.deviceName || 'LightNAS';

  return `<section class="hv-console-shell hv-subview-shell">
    <div class="hv-three-pane">
      ${hypervisorResourceTree(nodeName, pools, networks, vms, containers, activeView)}
      <main class="hv-workspace">
        <header class="hv-topbar">
          <button class="hv-back-dashboard" type="button" data-view-link="hypervisor">← Dashboard</button>
          <div class="hv-search">⌕ <span>Search VMs, containers, storage, networks…</span><kbd>Ctrl + K</kbd></div>
          <div class="hv-topbar-actions">
            <span class="hv-environment">▦ Local Datacenter</span>
            <button class="icon-button" data-action="refresh-runtime" title="Refresh">↻</button>
            <button class="icon-button" data-open-node-shell title="Open shell">›_</button>
          </div>
        </header>
        <div class="hv-subview-content">${body}</div>
      </main>
    </div>
  </section>`;
}

function hypervisorRing(label, value, detail) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return `<div class="hv-ring-stat"><div class="hv-ring" style="--pct:${safe}"><span>${Math.round(safe)}%</span></div><div><b>${escapeHtml(label)}</b><small>${escapeHtml(detail || '')}</small></div></div>`;
}

function hypervisorStatusCard(icon, label, value, detail, tone = '') {
  return `<article class="hv-status-card ${tone}"><span class="hv-card-icon">${icon}</span><div><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong><p>${escapeHtml(detail || '')}</p></div></article>`;
}

function hypervisorView() {
  const system = state.overview?.system || {};
  const storage = state.overview?.storage || {};
  const pools = storage.configuredPools || [];
  const vms = state.runtimes?.virtualization?.machineDetails || [];
  const containers = state.runtimes?.containers?.containers || [];
  const networks = state.runtimes?.virtualization?.networkDetails || [];
  const nodeName = state.overview?.appliance?.deviceName || 'LightNAS';
  const visibleStorage = storage.usableStorage || storage.virtualStorage || storage.local || {};
  const runningVms = vms.filter(item => /running|active/i.test(String(item.status || ''))).length;
  const runningContainers = containers.filter(item => /running|active/i.test(String(item.status || ''))).length;
  const cpuUsed = Number(system.cpu?.loadPercent || 0);
  const memoryUsed = Number(system.memory?.usedPercent || 0);
  const storageUsed = Number(visibleStorage.usedPercent || 0);
  const managementIp = system.managementIp || system.ipv4 || state.network?.interfaces?.find?.(item => item.ipv4)?.ipv4 || '—';
  const provider = state.runtimes?.virtualization?.provider || 'KVM / libvirt';
  const totalGuests = vms.length + containers.length;
  const runningGuests = runningVms + runningContainers;
  const alerts = [state.runtimeError, state.containerError, state.fileError].filter(Boolean);
  const recent = Array.isArray(state.logs) ? state.logs.slice(0, 7) : [];
  const hostDetail = `${system.cpu?.cores || 0} CPUs · ${bytes(system.memory?.totalBytes || 0)} RAM`;
  const usedBytes = Number(visibleStorage.usedBytes || 0);
  const totalBytes = Number(visibleStorage.totalBytes || 0);

  return `<section class="hv-console-shell">
    <div class="hv-three-pane">
      ${hypervisorResourceTree(nodeName, pools, networks, vms, containers, 'hypervisor')}

      <main class="hv-workspace">
        <header class="hv-topbar">
          <div class="hv-search">⌕ <span>Search VMs, containers, storage, networks…</span><kbd>Ctrl + K</kbd></div>
          <div class="hv-topbar-actions">
            <span class="hv-environment">▦ Local Datacenter</span>
            <button class="icon-button" data-action="refresh-runtime" title="Refresh">↻</button>
            <button class="icon-button" data-open-node-shell title="Open shell">›_</button>
          </div>
        </header>

        <div class="hv-dashboard">
          <header class="hv-page-title">
            <div><h1>Dashboard</h1><p>Overview of your virtualization infrastructure</p></div>
            <div class="hv-page-actions"><span class="hv-updated">Host: ${escapeHtml(nodeName)} · ${escapeHtml(managementIp)}</span><button class="secondary compact refresh-icon-button" data-action="refresh-runtime" aria-label="Refresh" title="Refresh">↻</button></div>
          </header>

          <section class="hv-status-grid">
            ${hypervisorStatusCard('✓','Host Health','Healthy', `${provider} · online`, 'healthy')}
            ${hypervisorStatusCard('▦','Total Hosts','1', hostDetail)}
            ${hypervisorStatusCard('▣','Virtual Machines',vms.length, `${runningVms} running · ${Math.max(0,vms.length-runningVms)} stopped`)}
            ${hypervisorStatusCard('⬡','Containers',containers.length, `${runningContainers} running · ${Math.max(0,containers.length-runningContainers)} stopped`)}
            ${hypervisorStatusCard('◫','Storage Usage', totalBytes ? bytes(usedBytes) : `${Math.round(storageUsed)}%`, totalBytes ? `${bytes(usedBytes)} / ${bytes(totalBytes)}` : `${pools.length} storage pool${pools.length===1?'':'s'}`)}
            ${hypervisorStatusCard('!','Alerts',alerts.length, alerts.length ? 'Runtime issues need attention' : 'No active runtime errors', alerts.length ? 'alert' : '')}
          </section>

          <section class="hv-overview-grid">
            <article class="hv-panel hv-infrastructure">
              <div class="hv-panel-head"><div><h2>Infrastructure Overview</h2><p>Live local host resources and workload inventory</p></div><nav><button class="active">Datacenter</button><button data-view-link="monitoring">Resource Usage</button></nav></div>
              <div class="hv-infra-body">
                <div class="hv-infra-tree">
                  <div class="hv-infra-row root"><span class="hv-state-dot ok"></span><span class="hv-infra-icon">▦</span><div><b>Local Datacenter</b><small>1 host · ${vms.length} VMs · ${containers.length} containers</small></div></div>
                  <div class="hv-infra-row child"><span class="hv-state-dot ok"></span><span class="hv-infra-icon">▤</span><div><b>${escapeHtml(nodeName)}</b><small>${escapeHtml(provider)} · ${escapeHtml(managementIp)}</small></div></div>
                </div>
                <div class="hv-ring-grid">
                  ${hypervisorRing('CPU', cpuUsed, `${system.cpu?.cores || 0} logical CPUs`)}
                  ${hypervisorRing('Memory', memoryUsed, `${bytes(system.memory?.usedBytes || 0)} / ${bytes(system.memory?.totalBytes || 0)}`)}
                  ${hypervisorRing('Storage', storageUsed, totalBytes ? `${bytes(usedBytes)} / ${bytes(totalBytes)}` : `${pools.length} pools`)}
                  ${hypervisorRing('Guests', totalGuests ? (runningGuests/totalGuests)*100 : 0, `${runningGuests} / ${totalGuests} running`)}
                </div>
              </div>
            </article>

            <article class="hv-panel hv-quick-actions">
              <div class="hv-panel-head"><div><h2>Quick Actions</h2><p>Common infrastructure tasks</p></div></div>
              <div class="hv-action-grid">
                <button class="primary" data-action="create-vm">＋ Create VM</button>
                <button class="secondary" data-action="create-container">⬡ Create Container</button>
                <button class="secondary" data-view-link="storage">◫ Manage Storage</button>
                <button class="secondary" data-view-link="network">⌁ Networking</button>
                <button class="secondary" data-view-link="backups">↶ Backups</button>
                <button class="secondary" data-open-node-shell>›_ Shell</button>
              </div>
            </article>
          </section>

          <section class="hv-main-grid">
            <article class="hv-panel hv-hosts-panel">
              <div class="hv-panel-head"><div><h2>Hosts (1)</h2><p>Hypervisor nodes in this datacenter</p></div><button class="hv-link" data-view-link="monitoring">View metrics</button></div>
              <div class="hv-host-table">
                <div class="hv-table-row head"><span>Name</span><span>State</span><span>CPU</span><span>Memory</span><span>Storage</span><span>IP Address</span><span>Guests</span></div>
                <div class="hv-table-row"><button class="hv-link" data-view-link="hypervisor">${escapeHtml(nodeName)}</button><span><i class="hv-state-dot ok"></i>Online</span><span>${Math.round(cpuUsed)}%</span><span>${Math.round(memoryUsed)}%</span><span>${Math.round(storageUsed)}%</span><span>${escapeHtml(managementIp)}</span><span>${totalGuests}</span></div>
              </div>
            </article>

            <article class="hv-panel hv-events-panel">
              <div class="hv-panel-head"><div><h2>Recent Tasks & Events</h2><p>Latest host activity</p></div><button class="hv-link" data-view-link="logs">View all</button></div>
              <div class="hv-event-list">
                ${recent.length ? recent.map(item => `<div class="hv-event"><span class="hv-event-icon">✓</span><div><b>${escapeHtml(item.message || item.action || item.type || 'System event')}</b><small>${escapeHtml(item.detail || item.category || '')}</small></div><time>${item.timestamp ? relativeTime(item.timestamp) : ''}</time></div>`).join('') : '<div class="hv-empty">No recent events loaded.</div>'}
              </div>
            </article>
          </section>

          <section class="hv-bottom-grid">
            <article class="hv-panel">
              <div class="hv-panel-head"><div><h2>Virtual Machines <span>(${vms.length})</span></h2><p>Guest systems on this host</p></div><button class="hv-link" data-view-link="vms">View all</button></div>
              <div class="hv-mini-table">
                ${vms.slice(0,6).map(item => {
                  const running=/running|active/i.test(String(item.status||''));
                  return `<div><button class="hv-link" data-view-link="vms">${escapeHtml(item.name || item.id || 'VM')}</button><span><i class="hv-state-dot ${running?'ok':'off'}"></i>${escapeHtml(item.status || 'unknown')}</span><span>${escapeHtml(String(item.cpus || item.vcpus || '—'))} CPU</span><span>${item.memory || item.memoryBytes ? bytes(item.memory || item.memoryBytes) : '—'}</span></div>`;
                }).join('') || '<div class="hv-empty">No virtual machines yet.</div>'}
              </div>
            </article>

            <article class="hv-panel">
              <div class="hv-panel-head"><div><h2>Storage Pools</h2><p>Datastores available to workloads</p></div><button class="hv-link" data-view-link="storage">View all</button></div>
              <div class="hv-mini-table storage">
                ${pools.slice(0,6).map(pool => `<div><button class="hv-link" data-view-link="storage">${escapeHtml(pool.name || 'Storage')}</button><span>${escapeHtml(pool.provider || pool.type || 'Storage')}</span><span>${escapeHtml(pool.mountPoint || 'Managed')}</span></div>`).join('') || '<div class="hv-empty">No configured storage pools.</div>'}
              </div>
              <div class="hv-panel-head hv-network-subhead"><div><h2>Virtual Networks</h2></div><button class="hv-link" data-view-link="network">View all</button></div>
              <div class="hv-mini-table storage">
                ${networks.slice(0,5).map(net => `<div><button class="hv-link" data-view-link="network">${escapeHtml(net.name || net.bridge || 'Network')}</button><span>${escapeHtml(net.type || 'bridge')}</span><span>${escapeHtml(net.bridge || '')}</span></div>`).join('') || '<div class="hv-empty">No virtualization networks detected.</div>'}
              </div>
            </article>
          </section>
        </div>
      </main>
    </div>
  </section>`;
}

function storageAddMenuHeader() {
  const items = [['directory','Directory'],['lvm','LVM'],['lvm-thin','LVM-Thin'],['btrfs','BTRFS'],['nfs','NFS'],['smb-cifs','SMB/CIFS'],['glusterfs','GlusterFS'],['iscsi','iSCSI'],['cephfs','CephFS'],['rbd','RBD'],['zfs-over-iscsi','ZFS over iSCSI'],['zfs','ZFS'],['proxmox-backup-server','Proxmox Backup Server'],['esxi','ESXi']];
  return `<div class="storage-add-menu" data-storage-add-menu><button class="secondary storage-add-toggle" type="button" data-storage-add-toggle aria-expanded="false">Add <span>⌄</span></button><div class="storage-add-dropdown" role="menu" hidden>${items.map(([id,label]) => `<button type="button" role="menuitem" data-storage-add-type="${id}"><span class="storage-type-icon">▣</span><span>${label}</span></button>`).join('')}</div></div>`;
}

function storageView() {
  const spaces = Array.isArray(state.spaces) ? state.spaces : [];
  const actions = `<div class="head-actions"><button class="secondary refresh-icon-button" type="button" data-storage-refresh aria-label="Refresh" title="Refresh">↻</button><button class="secondary refresh-icon-button" data-action="refresh-storage" aria-label="Refresh" title="Refresh">↻</button><button class="primary" data-view-link="pools">Manage storage</button>${storageAddMenuHeader()}</div>`;
  return `${pageHead('Storage', 'LightNAS storage pools, capacity and content libraries.', actions)}
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
  return `${pageHead('Pools & datasets', 'Manage LightNAS storage pools, volumes and ZFS datasets from one place.', '<div class="head-actions"><button class="secondary refresh-icon-button" data-action="refresh-storage" aria-label="Refresh" title="Refresh">↻</button><button class="secondary" data-view-link="storage">Storage inventory</button><button class="primary" type="button" data-create-storage>+ Add storage</button></div>')}
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
  try {
    const data = await request('/api/users');
    state.users = data.users || [];
    state.userAccess = { permissionOptions: data.permissionOptions || [], groups: data.groups || [] };
    if (['users', 'permissions', 'admin'].includes(state.view)) render(state.view);
  } catch (error) { toast(error.message); }
}

function permissionLabel(value) {
  const labels = {
    'files.view.own': 'View my own files',
    'files.own': 'Manage only my own files',
    'files.read': 'Read / preview all files',
    'files.write': 'Upload / create files anywhere',
    'files.download': 'Download all files & folders',
    'files.delete': 'Delete files & folders anywhere',
    'media.convert': 'Convert media',
    'settings.general.manage': 'Settings — appliance identity & branding',
    'settings.password.manage': 'Settings — change own password',
    'security.mfa.manage': 'Settings — MFA / 2FA / passkeys',
    'settings.software.view': 'Settings — view software & edition',
    'settings.software.manage': 'Settings — manage updates & license',
    'settings.manage': 'Settings — full settings access'
  };
  return labels[value] || String(value || '').replaceAll('.', ' · ').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function userAccessCheckboxes(options, selected = [], name = 'permissions') {
  const chosen = new Set(selected || []);
  return `<div class="security-check-grid">${(options || []).map(value => `<label><input type="checkbox" name="${name}" value="${escapeHtml(value)}" ${chosen.has(value) ? 'checked' : ''}><span>${escapeHtml(permissionLabel(value))}</span></label>`).join('') || '<p class="muted">No access scopes are available.</p>'}</div>`;
}

function groupMembershipCheckboxes(groups, selected = []) {
  const chosen = new Set((selected || []).map(group => typeof group === 'string' ? group : group.id));
  return `<div class="security-check-grid">${(groups || []).map(group => `<label><input type="checkbox" name="groups" value="${escapeHtml(group.id)}" ${chosen.has(group.id) ? 'checked' : ''}><span>${escapeHtml(group.name)}</span></label>`).join('') || '<p class="muted">No groups have been created yet.</p>'}</div>`;
}

async function openUserManager(username) {
  if (!state.userAccess) await loadUsers();
  const user = (state.users || []).find(item => item.username === username);
  if (!user) return toast('User is no longer available.');
  const permissions = state.userAccess?.permissionOptions || [];
  const groups = state.userAccess?.groups || [];

  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog user-management-dialog';
  dialog.innerHTML = `
    <form class="dialog-body user-management-form">
      <div class="dialog-head">
        <div><span class="eyebrow">USER MANAGEMENT</span><h2>${escapeHtml(user.username)}</h2><p class="muted">Reset the password, change access, assign groups, disable the account, or delete it.</p></div>
        <button class="dialog-close" type="button" data-user-manager-close aria-label="Close">×</button>
      </div>

      <section class="panel">
        <h3>Account status</h3>
        <label class="check-line"><input name="enabled" type="checkbox" ${user.disabled ? '' : 'checked'}> Account enabled</label>
        <label class="check-line"><input name="showDeviceName" type="checkbox" ${user.showDeviceName ? 'checked' : ''}> Show server name to this user</label>
        <p class="muted">When disabled, this account sees only Online in the footer instead of the LightNAS server hostname.</p>
      </section>

      <section class="panel">
        <h3>Reset password</h3>
        <div class="form-grid">
          <label>New password<input name="newPassword" type="password" minlength="4" autocomplete="new-password" placeholder="At least 4 characters"></label>
          <label>Administrator password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
        </div>
        <button class="secondary" type="button" data-user-reset-password>Reset password</button>
      </section>

      <section class="panel">
        <h3>File storage quota</h3>
        <label>Storage quota (GiB)<input name="storageQuotaGiB" type="number" min="0.1" max="1048576" step="0.1" value="${Math.max(0.1, Number(user.storageQuotaBytes || 5368709120) / 1073741824)}"></label>
        <p class="muted">Users with private file access are limited to this amount across their Documents, Photos, Videos, and Audio libraries. Default is 5 GiB.</p>
      </section>

      <section class="panel">
        <h3>Direct permissions</h3>
        <p class="muted">These permissions apply directly to this account. Group permissions are added automatically.</p>
        ${userAccessCheckboxes(permissions, user.permissions || [])}
      </section>

      <section class="panel">
        <h3>Groups</h3>
        <p class="muted">Add this account to one or more permission groups.</p>
        ${groupMembershipCheckboxes(groups, user.groups || [])}
      </section>

      <div class="form-error" role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary danger-button" type="button" data-user-delete>Delete user</button>
        <span class="dialog-action-spacer"></span>
        <button class="secondary" type="button" data-user-manager-close>Cancel</button>
        <button class="primary" type="submit">Save changes</button>
      </div>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.form-error');
  const close = () => dialog.close();
  dialog.querySelectorAll('[data-user-manager-close]').forEach(button => button.addEventListener('click', close));

  dialog.querySelector('[data-user-reset-password]').addEventListener('click', async () => {
    error.textContent = '';
    const password = form.elements.newPassword.value;
    const currentPassword = form.elements.currentPassword.value;
    if (!password || password.length < 4) { error.textContent = 'Enter a new password of at least 4 characters.'; return; }
    try {
      await request(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, password })
      });
      form.elements.newPassword.value = '';
      await loadUsers();
      toast('Password reset and old sessions ended.');
    } catch (problem) { error.textContent = problem.message; }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const currentPassword = form.elements.currentPassword.value;
    const selectedPermissions = [...form.querySelectorAll('input[name="permissions"]:checked')].map(input => input.value);
    const selectedGroups = [...form.querySelectorAll('input[name="groups"]:checked')].map(input => input.value);
    try {
      await request(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          currentPassword,
          disabled: !form.elements.enabled.checked,
          showDeviceName: form.elements.showDeviceName.checked,
          storageQuotaGiB: Number(form.elements.storageQuotaGiB.value),
          permissions: selectedPermissions,
          groups: selectedGroups
        })
      });
      await loadUsers();
      toast('User permissions and groups updated.');
      close();
    } catch (problem) { error.textContent = problem.message; }
  });

  dialog.querySelector('[data-user-delete]').addEventListener('click', async () => {
    if (!confirm(`Delete user ${username}? This ends their sessions and removes their account.`)) return;
    try {
      await request(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      await loadUsers();
      toast('User deleted.');
      close();
    } catch (problem) { error.textContent = problem.message; }
  });

  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

function usersView() {
  const owner = state.overview.appliance.username;
  const users = state.users || [];
  const access = state.userAccess || { permissionOptions: [], groups: [] };
  const activeCount = users.filter(user => !user.disabled).length + 1;
  return `${pageHead('Users', 'Create and fully manage local LightNAS accounts.', '<button class="primary" type="button" data-toggle-user-create>+ Add user</button>')}
    <section class="user-summary-grid">
      <article class="panel user-summary"><span class="eyebrow">OWNER</span><strong>${escapeHtml(owner)}</strong><p>Appliance administrator</p></article>
      <article class="panel user-summary"><span class="eyebrow">ACCOUNTS</span><strong>${users.length + 1}</strong><p>${activeCount} active</p></article>
      <article class="panel user-summary"><span class="eyebrow">GROUPS</span><strong>${access.groups.length}</strong><p>Permission groups</p></article>
    </section>

    <form id="user-form" class="panel user-create-card" hidden>
      <div class="section-heading"><div><span class="eyebrow">NEW ACCOUNT</span><h2>Create local user</h2><p class="muted">Create the account and optionally assign direct permissions and groups now.</p></div><button class="secondary" type="button" data-toggle-user-create>Cancel</button></div>
      <div class="user-form-grid">
        <label>Username<input name="username" pattern="[a-zA-Z0-9._-]{3,32}" required placeholder="username"></label>
        <label>Temporary password<input name="password" type="password" minlength="4" maxlength="1024" autocomplete="new-password" required placeholder="At least 4 characters"><small class="field-hint">Required · minimum 4 characters</small></label>
        <label>File storage quota (GiB)<input name="storageQuotaGiB" type="number" min="0.1" max="1048576" step="0.1" value="5" required></label>
      </div>
      <details class="user-create-access">
        <summary>Permissions and groups</summary>
        <h4>Direct permissions</h4>
        ${userAccessCheckboxes(access.permissionOptions, ['files.view.own', 'files.own'])}
        <h4>Groups</h4>
        ${groupMembershipCheckboxes(access.groups, [])}
      </details>
      <div class="head-actions"><button class="primary" type="submit">Create user</button><button class="secondary" type="button" data-view-link="permissions">Manage groups</button></div>
      <div class="form-error" role="alert"></div>
    </form>

    <section class="panel user-folders-admin">
      <div class="section-heading">
        <div>
          <span class="eyebrow">PRIVATE STORAGE</span>
          <h2>User folders</h2>
          <p class="muted">Open a user's private Documents, Photos, Videos, and Audio library. Administrator password is required.</p>
        </div>
        <button class="secondary" type="button" data-action="private-user-files">Open user folders</button>
      </div>
    </section>

    <section class="user-list-section">
      <div class="section-heading"><div><span class="eyebrow">ACCOUNTS</span><h2>Local users</h2><p class="muted">Use Manage user for password reset, permissions, groups, disable/enable, deletion, and server-name visibility.</p></div><small>${users.length + 1} total</small></div>
      <div class="user-card-grid">
        <article class="panel user-card owner-card"><div class="user-card-avatar">${escapeHtml(owner[0]?.toUpperCase() || 'A')}</div><div class="user-card-copy"><div class="user-card-title"><h3>${escapeHtml(owner)}</h3><span class="user-status active">OWNER</span></div><p>Full appliance administration and security control.</p></div><button class="secondary" type="button" data-view-link="settings">Account settings</button></article>
        ${users.map(user => `<article class="panel user-card ${user.disabled ? 'disabled' : ''}">
          <div class="user-card-avatar">${escapeHtml(user.username[0]?.toUpperCase() || 'U')}</div>
          <div class="user-card-copy">
            <div class="user-card-title"><h3>${escapeHtml(user.username)}</h3><span class="user-status ${user.disabled ? 'disabled' : 'active'}">${user.disabled ? 'DISABLED' : 'ACTIVE'}</span></div>
            <p>${user.groups?.length ? `Groups: ${user.groups.map(group => escapeHtml(group.name)).join(', ')}` : 'No groups assigned'} · ${user.effectivePermissions?.length || 0} effective permissions · ${(Number(user.storageQuotaBytes || 5368709120) / 1073741824).toFixed(1).replace(/\.0$/, '')} GiB file quota</p>
          </div>
          <button class="secondary" type="button" data-open-user-manager="${escapeHtml(user.username)}">Manage user</button>
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

let runtimeLoadPromise = null;

async function loadBuiltinCatalog() {
  if (Array.isArray(state.builtinCatalog)) return state.builtinCatalog;
  try {
    const result = await request('/api/catalog/builtin');
    state.builtinCatalog = result.catalog || [];
    if (state.view === 'apps') render('apps');
    return state.builtinCatalog;
  } catch (error) {
    state.builtinCatalog = state.runtimes?.catalog || [];
    return state.builtinCatalog;
  }
}

let communityCatalogPollTimer = null;

async function loadCommunityCatalog(forceRefresh = false) {
  if (state.communityCatalogLoading && !forceRefresh) return state.communityCatalog;
  state.communityCatalogLoading = true;
  state.communityCatalogError = null;
  try {
    const result = await request(`/api/catalog/community${forceRefresh ? '?refresh=1' : ''}`);
    state.communityCatalog = result;
    state.communityCatalogCheckedAt = Date.now();
    saveCommunityCatalogCache();

    clearTimeout(communityCatalogPollTimer);
    communityCatalogPollTimer = null;
    if (result?.refreshing) {
      communityCatalogPollTimer = setTimeout(() => {
        communityCatalogPollTimer = null;
        loadCommunityCatalog(false).catch(() => null);
      }, result?.apps?.length ? 1500 : 600);
    }
    return result;
  } catch (error) {
    state.communityCatalogError = error.message;
    if (!state.communityCatalog) state.communityCatalog = { apps: [], sources: [], count: 0, refreshing:true };
    clearTimeout(communityCatalogPollTimer);
    communityCatalogPollTimer = setTimeout(() => {
      communityCatalogPollTimer = null;
      loadCommunityCatalog(false).catch(() => null);
    }, 2500);
    return state.communityCatalog;
  } finally {
    state.communityCatalogLoading = false;
    if (state.view === 'apps') render('apps');
  }
}

async function loadRuntimes(forceRefresh = false) {
  if (runtimeLoadPromise && !forceRefresh) return runtimeLoadPromise;
  const work = (async () => {
    try {
      state.runtimes = await request(`/api/runtimes${forceRefresh ? '?refresh=1' : ''}`);
      window.LightNASRuntimeInventory = state.runtimes;
      state.runtimeError = null;
    } catch (error) {
      state.runtimeError = error.message;
    }
    if (['apps', 'containers', 'vms', 'integrations'].includes(state.view)) render(state.view);
  })();
  if (!forceRefresh) runtimeLoadPromise = work.finally(() => { runtimeLoadPromise = null; });
  await work;
  if (state.view === 'apps' && state.builtinCatalog === null) loadBuiltinCatalog();
  if (state.view === 'apps') {
    const catalogStale = !state.communityCatalog || Date.now() - Number(state.communityCatalogCheckedAt || 0) > 15000;
    if (catalogStale && !state.communityCatalogLoading) {
      queueMicrotask(() => loadCommunityCatalog(false).catch(() => null));
    }
  }
}

async function loadBackupJobs() {
  try {
    state.backupJobs = (await request('/api/backups/jobs')).jobs || [];
    if (state.selectedBackupJobId && !state.backupJobs.some(job => job.id === state.selectedBackupJobId)) state.selectedBackupJobId = null;
    if (state.view === 'backups') render('backups');
  } catch (error) {
    state.backupJobs = [];
    if (state.view === 'backups') render('backups');
    toast(error.message);
  }
}

async function loadContainers() {
  try {
    const containers = await request('/api/containers/inventory?summary=1');
    state.runtimes = { ...(state.runtimes || {}), containers };
    window.LightNASContainerInventory = containers;
    window.LightNASRuntimeInventory = state.runtimes;
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
  const liveCpuPercent = items.reduce((total, item) => total + (Number(item.cpuPercent) || 0), 0);
  const liveMemoryBytes = items.reduce((total, item) => total + (Number(item.memoryUsageBytes) || 0), 0);
  const liveStatsCount = items.filter(item => item.liveStats).length;
  const hostMemory = Number(host.memory?.totalBytes || 0);
  const hostCores = Number(host.cpu?.cores || 0);
  const allocationPercent = hostMemory ? Math.min(100, Math.round((allocatedMemory / hostMemory) * 100)) : 0;
  return `<section class="host-monitor-grid runtime-resource-summary">
    <article class="monitor-card"><span>Total ${label}</span><strong>${items.length}</strong><small>${running.length} running · ${items.length-running.length} stopped · ${liveStatsCount} reporting live usage</small></article>
    <article class="monitor-card"><span>${label === 'containers' ? 'Container memory use' : label === 'virtual machines' ? 'VM memory use' : 'Allocated RAM'}</span><strong>${liveStatsCount ? bytes(liveMemoryBytes) : bytes(allocatedMemory)}</strong><div class="track"><span style="width:${hostMemory && (liveMemoryBytes || allocatedMemory) ? Math.min(100, Math.round(((liveMemoryBytes || allocatedMemory) / hostMemory) * 100)) : 0}%"></span></div><small>Allocated RAM ${bytes(allocatedMemory)}${hostMemory ? ` · ${allocationPercent}% of ${bytes(hostMemory)} · host used ${bytes(host.memory?.usedBytes || 0)}` : ''}</small></article>
    <article class="monitor-card"><span>Allocated vCPU</span><strong>${allocatedCpus || 0} vCPU${uncappedCpu ? ' + uncapped' : ''}</strong><small>${liveStatsCount ? `${liveCpuPercent.toFixed(1)}% CPU now · ` : ''}host ${hostCores || '—'} logical CPUs${uncappedCpu ? ` · ${uncappedCpu} container${uncappedCpu===1?'':'s'} uncapped` : ''}</small></article>
    <article class="monitor-card host-capacity-card"><span>Host CPU use</span><strong>${host.cpu?.loadPercent ?? '—'}% CPU</strong><small>Host capacity ${hostCores || '—'} CPU · ${hostMemory ? bytes(hostMemory) : '—'} RAM · ${host.memory?.usedPercent ?? '—'}% RAM now · load ${host.cpu?.loadAverage?.[0] ?? '—'}</small></article>
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
      ? `<div class="compute-table"><div class="compute-table-head"><span>Status</span><span>Name / ID</span><span>CPU</span><span>Memory</span><span>Network</span><span></span></div>${containers.map(item => {
          const publication = item.publication || null;
          const hostAddress = state.overview?.system?.network?.primaryIpv4 || location.hostname;
          const publishedUrl = publication?.mode === 'proxy' && publication?.hostPort
            ? `${publication.scheme === 'https' ? 'https' : 'http'}://${hostAddress}:${publication.hostPort}/`
            : publication?.mode === 'direct' && publication?.targetHost && publication?.targetPort
              ? `${publication.scheme === 'https' ? 'https' : 'http'}://${publication.targetHost}${(publication.scheme === 'https' && Number(publication.targetPort) === 443) || (publication.scheme !== 'https' && Number(publication.targetPort) === 80) ? '' : `:${publication.targetPort}`}/`
              : '';
          return `<article class="compute-row"><span class="compute-status"><i class="${/running|active/i.test(String(item.status || '')) ? 'online' : 'offline'}"></i>${escapeHtml(item.status || 'unknown')}</span><div><h3>${escapeHtml(item.name || item.id)}</h3><small>LXC · ID ${escapeHtml(item.id || item.name)}</small></div><span>${item.cpus || '—'} vCPU</span><span>${bytes(item.memory || 0)}</span><span>${escapeHtml(item.ipv4 || 'No IP')}${publishedUrl ? `<small><a href="${escapeHtml(publishedUrl)}" target="_blank" rel="noopener">Open: ${escapeHtml(publishedUrl.replace(/\/$/, ''))}</a></small>` : ''}</span><div class="runtime-actions compute-actions">
  ${publishedUrl ? `<button class="primary" type="button" data-app-open="${escapeHtml(publishedUrl)}">Open app</button>` : ''}
  <button class="primary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-console="${escapeHtml(item.id || item.name)}" data-container-name="${escapeHtml(item.name || item.id)}">Terminal</button>
  <button class="primary ${/running|active/i.test(String(item.status || '')) ? 'hidden' : ''}" type="button" data-container-action="start" data-container-id="${escapeHtml(item.id || item.name)}">Start</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-action="shutdown" data-container-id="${escapeHtml(item.id || item.name)}">Shutdown</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-action="reboot" data-container-id="${escapeHtml(item.id || item.name)}">Reboot</button>
  <button class="secondary ${/running|active/i.test(String(item.status || '')) ? '' : 'hidden'}" type="button" data-container-action="stop" data-container-id="${escapeHtml(item.id || item.name)}">Stop</button>
  ${(!/\d+\.\d+\.\d+\.\d+/.test(String(item.ipv4 || '')) || /^10\.77\.0\./.test(String(item.ipv4 || ''))) && /running|active/i.test(String(item.status || '')) ? `<button class="secondary" type="button" data-container-action="repair-network" data-container-id="${escapeHtml(item.id || item.name)}">Repair network</button>` : ''}
  <button class="secondary" type="button" data-container-edit="${escapeHtml(item.id || item.name)}" data-container-name="${escapeHtml(item.name || item.id)}" data-container-memory="${Math.max(256, Math.round((Number(item.memory) || 0) / 1048576) || 2048)}" data-container-cpus="${item.cpus || 2}">Edit</button>
  <button class="secondary danger-button" type="button" data-container-action="delete" data-container-id="${escapeHtml(item.id || item.name)}">Delete</button>
</div></article>`;
        }).join('')}</div>`
      : '<div class="empty compact-empty"><p>No native system containers are visible.</p></div>';

  const appContainerList = !docker
    ? '<div class="empty compact-empty"><p>Loading App Store containers…</p></div>'
    : appContainers.length
      ? `<div class="compute-table app-container-table"><div class="compute-table-head"><span>Status</span><span>App / Container</span><span>Access</span><span>Resources</span><span>Image</span><span></span></div>${appContainers.map(item => {
          const appId = String(item.catalogId || String(item.name || '').replace(/^lightnas-app-/, ''));
          const instanceName = String(item.instanceName || 'default');
          const app = state.runtimes?.catalog?.find(entry => entry.id === appId);
          const running = /running|up/i.test(String(item.state || item.status || ''));
          const hostAddress = state.overview?.system?.network?.primaryIpv4 || location.hostname;
          const appPort = Number(item.webPort || (instanceName === 'default' ? app?.port : 0) || 0);
          const appUrl = appPort ? `http://${hostAddress}:${appPort}/` : '';
          const cpuText = item.cpuUnlimited ? `Unlimited · host ${state.overview?.system?.cpu?.cores || '—'} CPUs` : `${item.cpus || 0} CPU`;
          const memoryText = item.memory ? bytes(item.memory) : 'No memory cap';
          const liveCpu = item.liveStats ? `${Number(item.cpuPercent || 0).toFixed(1)}% CPU now` : 'CPU usage unavailable';
          const liveMemory = item.liveStats ? `${item.memoryUsage || '—'} RAM now${item.memoryPercent ? ` · ${Number(item.memoryPercent).toFixed(1)}%` : ''}` : 'RAM usage unavailable';
          return `<article class="compute-row app-container-row"><span class="compute-status"><i class="${running ? 'online' : 'offline'}"></i>${escapeHtml(item.status || item.state || 'unknown')}</span><div><h3>${escapeHtml(app?.name || appId || item.name)}</h3><small>${escapeHtml(item.name)} · App Store managed · Docker / OCI</small></div><div class="app-access-cell">${appUrl ? `<a href="${escapeHtml(appUrl)}" target="_blank" rel="noopener">Open: ${escapeHtml(hostAddress)}:${escapeHtml(appPort)}</a>` : '<span>No web port</span>'}<small>Container IP: ${escapeHtml(item.ip || 'not assigned')} ${item.ports ? `· ${escapeHtml(item.ports)}` : ''}</small></div><div class="app-resource-cell"><b>${escapeHtml(liveCpu)} · ${escapeHtml(liveMemory)}</b><small>Limit: ${escapeHtml(cpuText)} · ${escapeHtml(memoryText)} · restart ${escapeHtml(item.restartPolicy || 'no')}</small></div><span class="compute-truncate" title="${escapeHtml(item.image || '')}">${escapeHtml(item.image || '—')}</span><div class="runtime-actions compute-actions">
            ${running ? `<button class="primary" type="button" data-app-open="${escapeHtml(appUrl)}">Open</button><button class="secondary" type="button" data-app-terminal="${escapeHtml(item.name)}" data-app-name="${escapeHtml(app?.name || appId || item.name)}">Terminal</button>` : ''}
            <button class="primary ${running ? 'hidden' : ''}" type="button" data-app-action="start" data-app-id="${escapeHtml(appId)}" data-app-instance="${escapeHtml(instanceName)}">Start</button>
            <button class="secondary ${running ? '' : 'hidden'}" type="button" data-app-action="stop" data-app-id="${escapeHtml(appId)}" data-app-instance="${escapeHtml(instanceName)}">Stop</button>
            <button class="secondary" type="button" data-app-edit="${escapeHtml(appId)}" data-app-container="${escapeHtml(item.name)}" data-app-instance="${escapeHtml(instanceName)}">Settings</button>
            <button class="secondary" type="button" data-app-action="restart" data-app-id="${escapeHtml(appId)}" data-app-instance="${escapeHtml(instanceName)}">Restart</button>
            <button class="secondary danger-button" type="button" data-app-action="remove" data-app-id="${escapeHtml(appId)}" data-app-instance="${escapeHtml(instanceName)}" data-app-host-port="${escapeHtml(String(appPort || 0))}">Remove</button>
          </div></article>`;
        }).join('')}</div>`
      : '<div class="empty compact-empty"><p>No App Store containers are installed.</p></div>';

  return `${pageHead('Containers', 'Create and manage native system containers and App Store application containers.', '<div class="head-actions"><button class="secondary refresh-icon-button" data-action="refresh-runtime" aria-label="Refresh" title="Refresh">↻</button><button class="primary" data-action="create-container">+ Create system container</button></div>')}
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
  <button class="secondary" type="button" data-vm-guest-drivers="${escapeHtml(item.id || item.name)}">Attach VirtIO Drivers</button>
  <button class="secondary" type="button" data-vm-action="reset" data-vm-id="${escapeHtml(item.id || item.name)}">Reset</button>
  <button class="secondary danger-button" type="button" data-vm-action="delete" data-vm-id="${escapeHtml(item.id || item.name)}">Delete</button>
</div></article>`).join('')}</div>`
    : '<div class="empty compact-empty"><p>No local virtual machines are visible.</p></div>';
  return `${pageHead('Virtual machines', 'Create, monitor and manage QEMU/libvirt virtual machines.', '<div class="head-actions"><button class="secondary refresh-icon-button" data-action="refresh-runtime" aria-label="Refresh" title="Refresh">↻</button><button class="primary" data-action="create-vm">+ Create VM</button></div>')}
    ${runtimeBanner('virtualization')}
    ${runtimeResourceSummary(machines, 'virtual machines')}
    ${runtime?.warning ? `<div class="module-note"><b>Virtualization note:</b> ${escapeHtml(runtime.warning)}</div>` : ''}
    <section class="panel vm-guest-tools-card">
      <div class="panel-head"><div><span class="eyebrow">VM GUEST DRIVERS</span><h2>VirtIO guest support</h2></div>
        <div class="head-actions">${runtime?.guestTools?.windows?.available
          ? '<span class="volume-state writable">WINDOWS DRIVERS READY</span>'
          : '<button class="secondary" type="button" data-vm-prepare-drivers>Prepare Windows drivers</button>'}</div>
      </div>
      <p class="muted">Windows VMs can use the attached VirtIO driver CD for optimized storage, network, balloon, and guest drivers. Linux guests use the VirtIO drivers included with the Linux kernel, so no separate driver ISO is normally required.</p>
      ${runtime?.guestTools?.windows?.available ? `<p class="muted">Driver media: ${escapeHtml(runtime.guestTools.windows.name || 'VirtIO Windows drivers')} · ${escapeHtml(runtime.guestTools.windows.storageName || 'ISO storage')}</p>` : ''}
    </section>
    ${runtime?.available && runtime?.enabled && !ready ? '<div class="module-hero"><h2>VM resources needed</h2><p>LightNAS needs an active VM storage location and network before a VM can be created.</p></div>' : ''}
    <div class="compute-section-head"><div><span class="eyebrow">VIRTUAL MACHINES</span><h2>Inventory</h2></div><small>${machines.length} total</small></div>
    <div class="compute-table-wrap">${rows}</div>`;
}
function sharesView() {
  const { shares } = state.overview;
  return `${pageHead('Network shares', 'Connect directly from Windows, Linux, or macOS over SMB and SFTP.', '<button class="primary" data-action="new-share">+ Create share</button>')}
    <section class="module-note share-help"><b>Quick connect:</b> Windows File Explorer uses <code>\\\\LIGHTNAS-IP\\share</code>. The built-in <code>Files</code> share is the same Documents, Photos, Videos, and Audio library shown in Files & media and requires the LightNAS administrator credentials.</section>
    <div class="share-list">${shares.map(share => `<article class="share-row network-share-row"><div><div class="volume-title"><h3>${escapeHtml(share.name)}</h3><span class="volume-state writable">${share.system ? 'SYSTEM' : 'ACTIVE'}</span></div><p>${escapeHtml(share.protocol)} · user ${escapeHtml(share.username || '—')} · ${escapeHtml(share.description || 'No description')}</p><div class="share-addresses">${share.smb ? `<code>${escapeHtml(share.smb)}</code>` : ''}${share.smbUrl ? `<code>${escapeHtml(share.smbUrl)}</code>` : ''}${share.sftp ? `<code>${escapeHtml(share.sftp)}</code>` : ''}</div></div>${share.system ? '<span class="muted share-managed-label">Managed by LightNAS</span>' : `<button class="secondary danger-button" data-delete-share="${escapeHtml(share.id)}" data-name="${escapeHtml(share.name)}">Remove share</button>`}</article>`).join('') || '<div class="empty"><p>No network shares configured yet.</p></div>'}</div>`;
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
  Videos: new Set(['mp4','m4v','mov','qt','webm','ogv','mkv','avi','wmv','asf','flv','f4v','mpeg','mpg','mpe','m2v','mts','m2ts','m2t','ts','3gp','3g2','vob','mxf','rm','rmvb','divx','mod','tod','dat']),
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
  'mp4','m4v','mov','qt','webm','ogv','mkv','avi','wmv','asf','flv','f4v','mpeg','mpg','mpe','m2v','mts','m2ts','m2t','ts','3gp','3g2','vob','mxf','rm','rmvb','divx','mod','tod','dat',
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
  const filePermissions = new Set(state.overview?.appliance?.permissions || []);
  const isFileAdmin = state.overview?.appliance?.role === 'administrator';
  const canManageOwnFiles = isFileAdmin || filePermissions.has('files.own') || filePermissions.has('files.write');
  const canDeleteFiles = isFileAdmin || filePermissions.has('files.own') || filePermissions.has('files.delete') || filePermissions.has('files.write');
  if (mobileFiles && state.fileView === 'list') state.fileView = 'grid';
  const segments = state.folder.split('/').filter(Boolean);
  const section = librarySections.some(([folder]) => folder === (segments[0] || '')) ? (segments[0] || '') : '';
  const foldersMode = state.fileLibraryTab === 'folders';
  const effectiveFileView = foldersMode ? 'grid' : state.fileView;
  const allFiles = state.folder === '' && !foldersMode;
  const crumbs = [`<button class="panel-link" data-folder="">Files & media</button>`, ...segments.map((segment, index) => `<span> / </span><button class="panel-link" data-folder="${escapeHtml(segments.slice(0, index + 1).join('/'))}">${escapeHtml(segment)}</button>`)].join('');
  const entries = Array.isArray(state.files)
    ? (allFiles
        ? state.files.filter(entry => !entry.directory && !isSystemImageFile(entry.name))
        : foldersMode && state.folder === ''
          ? state.files.filter(entry => entry.directory)
          : state.files.filter(entry => entry.directory || !isSystemImageFile(entry.name)))
    : state.files;
  const libraryOptions = librarySections.map(([folder, label]) => `<option value="${escapeHtml(folder)}" ${!state.filesSettingsOpen && section === folder ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  const item = entry => {
    const path = fileEntryPath(entry);
    const location = !entry.directory && (entry.folder || path.includes('/')) ? (entry.folder || path.split('/').slice(0, -1).join('/') || 'Root') : '';
    const kind = entry.directory ? 'Folder' : libraryKindForName(entry.name);
    const meta = entry.directory ? 'Folder' : `${kind} · ${bytes(entry.sizeBytes)}${location ? ` · ${escapeHtml(location)}` : ''}`;
    const thumbVersion = encodeURIComponent(entry.modifiedAt || entry.sizeBytes || '1');
    const visual = entry.directory
      ? '<span class="folder-glyph">▣</span>'
      : (kind === 'Photo' || kind === 'Video')
        ? `<img class="file-thumb" loading="eager" decoding="async" alt="" src="/api/files/thumbnail?path=${encodeURIComponent(path)}&v=${thumbVersion}">`
        : `<span class="file-glyph file-kind-${kind.toLowerCase()}">${kind === 'Audio' ? '♪' : '▤'}</span>`;

    if (effectiveFileView === 'gallery') {
      return `<article class="file-gallery-item ${kind.toLowerCase()}">
        <button class="file-name file-gallery-open" data-open="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}" data-directory="${entry.directory}" data-modified="${escapeHtml(entry.modifiedAt || '')}" data-size="${Number(entry.sizeBytes || 0)}" aria-label="Open ${escapeHtml(entry.name)}">
          <span class="file-card-visual">${visual}</span>
        </button>
      </article>`;
    }

    return effectiveFileView === 'grid'
      ? `<article class="file-card">
          <button class="file-name file-card-open" data-open="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}" data-directory="${entry.directory}" data-modified="${escapeHtml(entry.modifiedAt || '')}" data-size="${Number(entry.sizeBytes || 0)}">
            <span class="file-card-visual">${visual}</span>
            <span class="file-card-title">${escapeHtml(entry.name)}</span>
          </button>
          <span class="muted file-location">${meta}</span>
          <div class="file-card-actions">
            ${entry.directory ? `<button class="secondary" data-download-folder="${escapeHtml(path)}">Download folder</button>` : ''}
            ${!entry.directory && state.media?.converterAvailable && state.overview.appliance.role === 'administrator' ? `<button class="secondary" data-convert-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Convert</button>` : ''}
            ${canDeleteFiles ? `<button class="secondary" data-delete-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Delete</button>` : ''}
          </div>
        </article>`
      : `<article class="file-row">
          <button class="file-name" data-open="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}" data-directory="${entry.directory}" data-modified="${escapeHtml(entry.modifiedAt || '')}" data-size="${Number(entry.sizeBytes || 0)}">${entry.directory ? '▣' : kind === 'Photo' ? '▧' : kind === 'Video' ? '▷' : kind === 'Audio' ? '♪' : '▤'} ${escapeHtml(entry.name)}${location ? `<small>${escapeHtml(location)}</small>` : ''}</button>
          <span class="muted">${entry.directory ? 'Folder' : `${kind} · ${bytes(entry.sizeBytes)}`}</span>
          ${entry.directory ? `<button class="secondary" data-download-folder="${escapeHtml(path)}">Download</button>` : ''}
          ${!entry.directory && state.media?.converterAvailable && state.overview.appliance.role === 'administrator' ? `<button class="secondary" data-convert-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Convert</button>` : ''}
          ${canDeleteFiles ? `<button class="secondary" data-delete-file="${escapeHtml(entry.name)}" data-path="${escapeHtml(path)}">Delete</button>` : ''}
        </article>`;
  };

  const mobileMediaEntries = Array.isArray(entries)
    ? entries.filter(entry => !entry.directory && ['Photo','Video'].includes(libraryKindForName(entry.name)))
    : [];
  const mobileDate = entry => {
    const date = new Date(entry.modifiedAt || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
  };
  const mobileGallery = () => {
    if (!mobileFiles) return '';
    const period = ['years','months','all'].includes(state.mobileFilesPeriod) ? state.mobileFilesPeriod : 'all';
    const periodTabs = `<div class="mobile-photo-period" role="tablist" aria-label="Photo grouping">
      <button type="button" data-mobile-period="years" class="${period === 'years' ? 'active' : ''}">Years</button>
      <button type="button" data-mobile-period="months" class="${period === 'months' ? 'active' : ''}">Months</button>
      <button type="button" data-mobile-period="all" class="${period === 'all' ? 'active' : ''}">All</button>
    </div>`;
    let body = '';
    if (!mobileMediaEntries.length) {
      body = '<div class="mobile-photo-empty">No photos or videos yet.</div>';
    } else if (period === 'years') {
      const groups = new Map();
      for (const entry of mobileMediaEntries) {
        const key = String(mobileDate(entry).getFullYear());
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      body = `<div class="mobile-photo-years">${[...groups.entries()].sort((a,b) => Number(b[0]) - Number(a[0])).map(([year, group]) => {
        const cover = group.sort((a,b) => mobileDate(b) - mobileDate(a))[0];
        const path = fileEntryPath(cover);
        return `<section class="mobile-year-card"><h2>${year}</h2><button class="file-name" data-open="${escapeHtml(cover.name)}" data-path="${escapeHtml(path)}" data-directory="false"><img loading="lazy" decoding="async" src="/api/files/thumbnail?path=${encodeURIComponent(path)}" alt=""></button><small>${group.length} item${group.length===1?'':'s'}</small></section>`;
      }).join('')}</div>`;
    } else if (period === 'months') {
      const groups = new Map();
      for (const entry of mobileMediaEntries) {
        const date = mobileDate(entry);
        const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      body = `<div class="mobile-photo-months">${[...groups.entries()].sort((a,b) => b[0].localeCompare(a[0])).map(([key, group]) => {
        const [year, month] = key.split('-').map(Number);
        const label = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month:'short', year:'numeric' });
        return `<section class="mobile-month-group"><h2>${label}</h2><div class="mobile-photo-grid">${group.sort((a,b) => mobileDate(b)-mobileDate(a)).map(item).join('')}</div></section>`;
      }).join('')}</div>`;
    } else {
      body = `<div class="mobile-photo-grid">${mobileMediaEntries.sort((a,b) => mobileDate(b)-mobileDate(a)).map(item).join('')}</div>`;
    }
    return `<section class="mobile-photos-experience">
      <div class="mobile-photos-head"><div><span class="eyebrow">LIBRARY</span><h1>Files & media</h1></div><div class="mobile-photos-actions"><label class="mobile-library-picker"><span>Browse</span><select data-library-select aria-label="Library section">${libraryOptions}</select></label>${canManageOwnFiles ? `<label class="mobile-photo-add" aria-label="Upload photos and files"><span>＋</span><input id="mobile-gallery-upload" type="file" multiple></label>` : ''}</div></div>
      ${body}
      ${periodTabs}
    </section>`;
  };

  const quota = state.fileQuota?.scoped ? state.fileQuota : null;
  const quotaPercent = quota?.quotaBytes ? Math.min(100, Math.round((quota.usedBytes / quota.quotaBytes) * 100)) : 0;
  const mobileMediaMode = mobileFiles && ['', 'Photos', 'Videos'].includes(section) && !state.filesSettingsOpen;
  return `<section class="files-page ${effectiveFileView === 'gallery' ? 'photo-mode' : 'grid-mode'} ${mobileMediaMode ? 'mobile-media-mode' : ''}">${pageHead('Files & media', 'Browse and manage the actual files stored in LightNAS.')}
    ${quota ? `<section class="panel file-quota-panel"><div class="panel-head"><div><span class="eyebrow">MY STORAGE</span><h2>${bytes(quota.usedBytes)} of ${bytes(quota.quotaBytes)}</h2></div><strong>${quotaPercent}%</strong></div><div class="track"><span style="width:${quotaPercent}%"></span></div><p class="muted">${bytes(quota.remainingBytes)} remaining in your private file library.</p></section>` : ''}
    <section class="desktop-files-settings-panel ${state.filesSettingsOpen ? '' : 'hidden'}">
      <article class="panel files-settings-card">
        <div class="section-heading"><div><span class="eyebrow">FILES & MEDIA SETTINGS</span><h2>Library settings</h2><p class="muted">Manage phone library sync and desktop file display preferences.</p></div><button class="secondary" type="button" data-files-settings-close>Back to files</button></div>
        <div class="files-settings-grid">
          <div class="files-setting-box"><b>Desktop view</b><p class="muted">Choose List, Grid, or Photos view on desktop.</p><div class="head-actions"><button class="secondary" type="button" data-file-view="list">☷ List</button><button class="secondary" type="button" data-file-view="grid">▦ Grid</button><button class="secondary" type="button" data-file-view="gallery">▦ Photos</button></div></div>
          ${state.overview.appliance.role === 'administrator' && state.overview.appliance.features?.phoneSync !== false ? '<div class="files-setting-box"><b>Phone library sync</b><p class="muted">Automatically route phone photos to Photos and phone videos to Videos.</p><button class="primary phone-sync-button" type="button" data-phone-sync>Configure phone sync</button></div>' : ''}
        </div>
      </article>
    </section>
    ${mobileFiles && ['', 'Photos', 'Videos'].includes(section) ? mobileGallery() : ''}
    <div class="files-library-content desktop-files-library ${state.filesSettingsOpen ? 'hidden' : ''}">
    <div class="file-toolbar"><div class="breadcrumbs">${crumbs}</div><div class="file-toolbar-actions">
      ${foldersMode && state.folder === '' ? '' : `<label class="file-toolbar-select">View
        <select data-file-view-select aria-label="File view">
          <option value="list" ${state.fileView === 'list' ? 'selected' : ''}>☷ List</option>
          <option value="grid" ${state.fileView === 'grid' ? 'selected' : ''}>▦ Grid</option>
          <option value="gallery" ${state.fileView === 'gallery' ? 'selected' : ''}>▦ Photos</option>
        </select>
      </label>`}
      ${canManageOwnFiles ? `<button class="secondary files-icon-action" data-action="new-folder" aria-label="New folder" title="New folder">+</button>
      <label class="file-toolbar-select upload-select-only desktop-upload-select">
        <select data-file-upload-select aria-label="Upload">
          <option value="">Choose…</option>
          <option value="files">Upload files</option>
          <option value="folder">Upload folder</option>
        </select>
      </label>
      <input id="file-upload" type="file" ${section === 'Photos' ? 'accept="image/*"' : section === 'Videos' ? 'accept="video/*"' : section === 'Audio' ? 'accept="audio/*"' : ''} multiple hidden>
      <input id="folder-upload" type="file" webkitdirectory directory multiple hidden>
      <div class="mobile-direct-upload">
        <label class="secondary mobile-upload-button">
          <span>Upload files</span>
          <input id="mobile-native-upload" class="mobile-native-file-input" type="file" multiple>
        </label>
        <label class="secondary mobile-upload-button">
          <span>Upload folder</span>
          <input id="mobile-folder-upload" class="mobile-native-file-input" type="file" webkitdirectory directory multiple>
        </label>
      </div>` : ''}
      <button class="secondary files-icon-action desktop-files-settings-button" type="button" data-files-settings-tab aria-label="Files & media settings" title="Settings">⚙</button>
      <button class="secondary files-icon-action refresh-icon-button" type="button" data-action="refresh-files" aria-label="Refresh" title="Refresh">↻</button>
      ${state.overview.appliance.role === 'administrator' && state.overview.appliance.features?.phoneSync !== false ? '<button class="secondary phone-sync-button files-sync-trigger" type="button" data-phone-sync>Phone sync</button>' : ''}
    </div></div>
    ${canManageOwnFiles ? '<div class="file-drop-zone" data-file-drop tabindex="0"><b>Drop files here</b><span>Multiple files and ZIP archives are supported. Use “Upload folder” to preserve a whole folder tree.</span></div>' : '<div class="module-note"><b>View only.</b> You can browse and preview your private files. Upload, create, and delete actions are disabled for this account.</div>'}
    <p class="muted">${foldersMode && state.folder === '' ? 'Folders shows your library folders in one place.' : allFiles ? 'All files shows files from Documents, Photos, Videos, and Audio.' : 'Open folders normally or use the library tabs to switch sections.'} ZIP and other file types are accepted, uploads have visible progress.${quota ? ` Your account can store up to ${bytes(quota.quotaBytes)}.` : ' Administrators are limited only by available storage unless a host upload limit is configured.'}</p>
    ${state.fileTruncated && allFiles ? '<div class="module-note">Showing the newest 10,000 files. Open a category or folder to browse beyond that safety limit.</div>' : ''}
    <div class="${effectiveFileView === 'gallery' ? 'file-photo-gallery' : effectiveFileView === 'grid' ? 'file-browser-grid' : 'storage-list'}">${state.fileError ? `<div class="empty error-state"><p><b>Files could not be loaded.</b></p><p>${escapeHtml(state.fileError)}</p><button class="secondary refresh-icon-button" data-action="refresh-files" aria-label="Try again" title="Try again">↻</button></div>` : entries === null ? '<div class="empty"><p>Loading files…</p></div>' : entries.length ? entries.map(item).join('') : `<div class="empty"><p>${foldersMode && state.folder === '' ? 'No folders have been created yet.' : allFiles ? 'No files have been uploaded yet.' : 'This folder is empty.'}</p></div>`}</div>
    </div>
    <button class="secondary mobile-files-settings-button" type="button" data-mobile-files-settings aria-label="Files & media settings">⚙ Settings</button>
  </section>`;
}


async function openProtectedUserFiles() {
  if (state.overview?.appliance?.role !== 'administrator') return;
  if (!state.users) await loadUsers();
  const users = state.users || [];
  if (!users.length) return toast('No local user accounts are available.');

  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog protected-user-files-dialog';
  dialog.innerHTML = `
    <form class="protected-user-files-form" method="dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">PRIVATE STORAGE</span><h2>User libraries</h2><p class="muted">User files are excluded from the normal administrator Files & media view.</p></div>
        <button class="icon-button" type="button" data-private-close aria-label="Close">×</button>
      </div>
      <section class="protected-user-files-auth">
        <label>User
          <select name="username">${users.map(user => `<option value="${escapeHtml(user.username)}">${escapeHtml(user.username)}</option>`).join('')}</select>
        </label>
        <label>Administrator password
          <input name="currentPassword" type="password" autocomplete="current-password" required placeholder="Required to unlock">
        </label>
        <button class="primary" type="button" data-private-unlock>Unlock files</button>
      </section>
      <div class="module-note"><b>Private by default.</b> Each account has its own Documents, Photos, Videos, and Audio library. The administrator password is required to inspect a user's library.</div>
      <section class="protected-user-files-browser" data-private-browser hidden>
        <div class="protected-user-files-toolbar">
          <div data-private-breadcrumbs></div>
          <button class="secondary" type="button" data-private-lock>Lock</button>
        </div>
        <div class="protected-user-files-list" data-private-list></div>
      </section>
      <div class="form-error" data-private-error role="alert"></div>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  const browser = dialog.querySelector('[data-private-browser]');
  const list = dialog.querySelector('[data-private-list]');
  const crumbs = dialog.querySelector('[data-private-breadcrumbs]');
  const error = dialog.querySelector('[data-private-error]');
  let unlockedPassword = '';
  let currentPath = '';

  const close = () => dialog.close();
  dialog.querySelectorAll('[data-private-close]').forEach(button => button.addEventListener('click', close));

  async function loadPrivatePath(path = '') {
    error.textContent = '';
    const username = form.elements.username.value;
    const result = await request('/api/admin/user-files/list', {
      method: 'POST',
      body: JSON.stringify({ username, currentPassword: unlockedPassword, path })
    });
    currentPath = result.path || '';
    const segments = currentPath.split('/').filter(Boolean);
    crumbs.innerHTML = [
      '<button class="panel-link" type="button" data-private-path="">User files</button>',
      ...segments.map((segment, index) => `<span> / </span><button class="panel-link" type="button" data-private-path="${escapeHtml(segments.slice(0, index + 1).join('/'))}">${escapeHtml(segment)}</button>`)
    ].join('');
    const entries = Array.isArray(result.entries) ? result.entries : [];
    list.innerHTML = entries.length ? entries.map(entry => {
      const next = [currentPath, entry.name].filter(Boolean).join('/');
      return `<article class="protected-user-file-row">
        <button class="file-name" type="button" ${entry.directory ? `data-private-path="${escapeHtml(next)}"` : 'disabled'}>
          <span>${entry.directory ? '▣' : '▤'}</span>
          <span><b>${escapeHtml(entry.name)}</b><small>${entry.directory ? 'Folder' : bytes(entry.sizeBytes)}</small></span>
        </button>
      </article>`;
    }).join('') : '<div class="empty"><p>This private library is empty.</p></div>';
    browser.hidden = false;
    dialog.querySelectorAll('[data-private-path]').forEach(button => button.addEventListener('click', () => {
      loadPrivatePath(button.dataset.privatePath || '').catch(problem => { error.textContent = problem.message; });
    }));
  }

  dialog.querySelector('[data-private-unlock]').addEventListener('click', async () => {
    unlockedPassword = form.elements.currentPassword.value;
    if (!unlockedPassword) { error.textContent = 'Enter the administrator password.'; return; }
    try { await loadPrivatePath(''); }
    catch (problem) { unlockedPassword = ''; error.textContent = problem.message; }
  });

  form.elements.username.addEventListener('change', () => {
    currentPath = '';
    browser.hidden = true;
    list.innerHTML = '';
    unlockedPassword = '';
    form.elements.currentPassword.value = '';
  });

  dialog.querySelector('[data-private-lock]').addEventListener('click', () => {
    unlockedPassword = '';
    currentPath = '';
    form.elements.currentPassword.value = '';
    list.innerHTML = '';
    browser.hidden = true;
  });

  dialog.addEventListener('close', () => {
    unlockedPassword = '';
    form.elements.currentPassword.value = '';
    dialog.remove();
  }, { once: true });
  dialog.showModal();
}


function queueMobileMediaPrewarm(entries = []) {
  if (!matchMedia('(max-width: 760px)').matches || !Array.isArray(entries) || !entries.length) return;
  const candidates = entries
    .filter(entry => !entry.directory && ['Photo','Video'].includes(libraryKindForName(entry.name)))
    .sort((a,b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0))
    .slice(0, 18)
    .map(entry => entry.path || [entry.folder, entry.name].filter(Boolean).join('/'))
    .filter(Boolean);
  if (!candidates.length) return;
  fetch('/api/files/prewarm', {
    method:'POST',
    credentials:'same-origin',
    headers:{ 'Content-Type':'application/json', 'X-LightNAS-Request':'1' },
    body:JSON.stringify({ paths:candidates })
  }).catch(() => {});
}

async function loadFiles(forceRefresh = false, target = null) {
  const mobile = matchMedia('(max-width: 760px)').matches;
  const requestTab = target?.tab || state.fileLibraryTab;
  const requestFolder = target?.folder ?? state.folder;
  const requestKey = filesSectionCacheKey(requestTab, requestFolder);
  const isCurrentRequest = () => filesSectionCacheKey() === requestKey;

  if (state.filesLoadingKeys.has(requestKey) && !forceRefresh) return [];
  state.filesLoadingKeys.add(requestKey);
  if (isCurrentRequest()) state.fileError = null;

  if (!forceRefresh && restoreFilesSection(requestKey) && isCurrentRequest() && state.view === 'files') {
    render('files');
  }

  try {
    const endpoint = requestFolder === ''
      ? (requestTab === 'folders'
          ? '/api/files?folders=1'
          : `/api/files?all=1${forceRefresh ? '&refresh=1' : ''}`)
      : `/api/files?path=${encodeURIComponent(requestFolder)}`;

    const result = await request(endpoint);
    state.fileSectionCheckedAt.set(requestKey, Date.now());
    const entries = Array.isArray(result.entries) ? result.entries.filter(entry => entry.supported) : [];
    const truncated = Boolean(result.truncated);
    rememberFilesSection(entries, truncated, requestKey);

    if (requestKey === 'all') {
      const previousFiles = state.files;
      const previousTruncated = state.fileTruncated;
      state.files = entries;
      state.fileTruncated = truncated;
      saveMobileFilesCache();
      if (!isCurrentRequest()) {
        state.files = previousFiles;
        state.fileTruncated = previousTruncated;
      }
    }

    if (isCurrentRequest()) {
      state.files = entries;
      state.fileTruncated = truncated;
      if (mobile) queueMobileMediaPrewarm(entries);
      if (state.view === 'files') render('files');
    }

    if (isCurrentRequest()) {
      request('/api/files/quota').then(quota => {
        state.fileQuota = quota;
      }).catch(() => {});
    }
    return entries;
  } catch (error) {
    if (isCurrentRequest()) {
      state.fileError = error.message || 'The file service did not return a valid response.';
      toast(state.fileError);
      if (!state.files) state.files = [];
      if (state.view === 'files') render('files');
      setTimeout(() => {
        if (state.view === 'files' && filesSectionCacheKey() === requestKey && !state.filesLoadingKeys.has(requestKey)) {
          loadFiles(false).catch(() => null);
        }
      }, 2500);
    }
    return [];
  } finally {
    state.filesLoadingKeys.delete(requestKey);
  }
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
      reject(Object.assign(new Error(message), { status: xhr.status }));
    });
    xhr.addEventListener('error', () => reject(Object.assign(new Error('The upload connection failed.'), { status:0, retryable:true })));
    xhr.addEventListener('abort', () => reject(Object.assign(new Error('The upload was cancelled.'), { status:0 })));
    xhr.send(file);
  });
}

function chunkUploadRequest(path, file, onProgress) {
  const chunkSize = 2 * 1024 * 1024;
  const uploadId = globalThis.crypto?.randomUUID?.() || `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const sendChunk = (blob, offset, attempt = 0) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const endpoint = `/api/files/chunk?path=${encodeURIComponent(path)}&uploadId=${encodeURIComponent(uploadId)}&offset=${offset}&total=${file.size}`;
    xhr.open('PUT', endpoint);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-LightNAS-Request', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress?.(Math.min(file.size, offset + event.loaded), file.size);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(Math.min(file.size, offset + blob.size), file.size);
        resolve();
        return;
      }
      let message = 'Upload failed.';
      try { message = JSON.parse(xhr.responseText || '{}').error || message; } catch {}
      const error = Object.assign(new Error(message), { status:xhr.status });
      if ((xhr.status === 0 || xhr.status === 408 || xhr.status === 429 || xhr.status >= 500) && attempt < 3) {
        setTimeout(() => sendChunk(blob, offset, attempt + 1).then(resolve, reject), 500 * (attempt + 1));
      } else reject(error);
    });
    xhr.addEventListener('error', () => {
      if (attempt < 3) {
        setTimeout(() => sendChunk(blob, offset, attempt + 1).then(resolve, reject), 500 * (attempt + 1));
      } else reject(Object.assign(new Error('The upload connection failed.'), { status:0, retryable:true }));
    });
    xhr.addEventListener('abort', () => reject(Object.assign(new Error('The upload was cancelled.'), { status:0 })));
    xhr.send(blob);
  });

  return (async () => {
    if (!file.size) throw new Error('The selected file is empty.');
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const blob = file.slice(offset, Math.min(file.size, offset + chunkSize), file.type || 'application/octet-stream');
      await sendChunk(blob, offset);
    }
  })();
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

function uniqueUploadPath(path, attempt = 1) {
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${folder}${stem}-${Date.now()}-${attempt}${ext}`;
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

  const failures = [];
  const mobile = matchMedia('(max-width: 760px)').matches;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= targets.length) return;
      const { file } = targets[index];
      let path = targets[index].path;
      let attempt = 0;
      let uploaded = false;
      while (!uploaded) {
        try {
          const transfer = mobile ? chunkUploadRequest : uploadRequest;
          await transfer(path, file, loaded => {
            loadedByFile[index] = loaded;
            updateProgress(file.name);
          });
          uploaded = true;
        } catch (error) {
          if (error.status === 409 && attempt < 4) {
            attempt += 1;
            path = uniqueUploadPath(targets[index].path, attempt);
            continue;
          }
          const transient = error.retryable || error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
          if (transient && attempt < 2) {
            attempt += 1;
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            continue;
          }
          failures.push({ name:file.name, message:error.message || 'Upload failed.' });
          break;
        }
      }
      if (uploaded) {
        loadedByFile[index] = Number(file.size || 0);
        completedCount += 1;
      }
      updateProgress();
    }
  };

  try {
    // Keep mobile batches conservative so large photos/videos do not overwhelm
    // Safari or a low-memory NAS while still allowing mixed multi-select uploads.
    const concurrency = Math.min(mobile ? 1 : 3, targets.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const failed = failures.length;
    const succeeded = targets.length - failed;
    if (!failed) {
      progress?.succeed(`${targets.length} item${targets.length === 1 ? '' : 's'} uploaded successfully.`);
      toast(`${targets.length} item${targets.length === 1 ? '' : 's'} uploaded.`);
    } else if (succeeded) {
      const message = `${succeeded} uploaded · ${failed} failed`;
      progress?.fail(`${message}. ${failures.slice(0, 2).map(item => `${item.name}: ${item.message}`).join(' · ')}`);
      toast(message);
    } else {
      const message = failures.slice(0, 2).map(item => `${item.name}: ${item.message}`).join(' · ') || 'Upload failed.';
      progress?.fail(message);
      toast(message);
    }
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
  return `${pageHead('Monitoring & analytics', 'Live performance graphs, session analytics, and recent system activity.', '<button class="secondary refresh-icon-button" data-action="refresh" aria-label="Refresh" title="Refresh">↻</button>')}
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
    ['storage', 'NAS storage', 'Pools, datasets, ZFS/BTRFS/LVM, NFS, SMB/CIFS, iSCSI and managed file storage.', 'storage'],
    ['shares', 'File services', 'SMB/SFTP shares, media libraries, file browser and permissions.', 'shares'],
    ['backups', 'Backup & restore', 'Backup-capable storage, snapshots, restore activity and replication foundations.', 'backups'],
    ['virtualMachines', 'Virtual machines', 'KVM/libvirt virtual machines, noVNC, VirtIO drivers, disks, NICs and PCI/GPU passthrough.', 'vms'],
    ['containers', 'System containers', 'Native LXC containers plus OCI application containers and terminal access.', 'containers'],
    ['networking', 'Datacenter networking', 'Physical NICs, Wi-Fi, bridges, VLANs, bonds, routes, DNS and virtual networks.', 'network'],
    ['firewall', 'Firewall & segmentation', 'Host firewall controls for appliance, guest and service isolation.', 'firewall'],
    ['appStore', 'Application platform', 'One-click application catalog and managed app hosting.', 'apps'],
    ['ai', 'AI workspace', 'Local/remote AI runtimes, model tools and system-aware assistance.', 'ai'],
    ['monitoringAnalytics', 'Analytics & audit', 'Operational analytics, audit logs, activity history and task tracking.', 'analytics'],
    ['integrations', 'Infrastructure integrations', 'External runtimes, storage providers, identity and service connections.', 'integrations'],
    ['identity', 'Identity & security', 'Local users, groups, permissions, MFA, passkeys, SSO foundations and audit controls.', 'permissions'],
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
  const builtInApps = state.runtimes?.catalog || [];
    const communityApps = state.communityCatalog?.apps || [];
    const apps = [...builtInApps, ...communityApps];
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
    return { text: `Current host CPU usage is ${system.cpu?.loadPercent || 0}% and memory usage is ${system.memory?.usedPercent || 0}% (${bytes(system.memory?.usedBytes || 0)} used). Overview has live graphs if you need to inspect a spike.` };
  }
  if (/app|install|software|catalog/.test(lower)) {
    const aiCount = apps.filter(app => String(app.category || '').toLowerCase() === 'ai').length;
    return { text: `The App Store currently has ${apps.length} one-click entries, including ${aiCount} AI tools. AI runtimes and tools live in App Store; this AI page is the LightNAS operations helper.`, action:'open-apps', actionLabel:'Open App Store' };
  }
  if (/health|status|problem|issue|diagnos/.test(lower)) {
    return { text: `LightNAS is online. CPU is ${system.cpu?.loadPercent || 0}%, memory is ${system.memory?.usedPercent || 0}%, and ${noIp.length ? `${noIp.length} running container(s) need network attention` : 'the current container inventory has no missing IPv4 addresses'}. Use Overview for live graphs or ask me about networking, storage, apps, CPU, or memory.` };
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


async function loadSoftwareAndLicense(check = false) {
  try {
    const [software, license] = await Promise.all([
      request(`/api/software${check ? '?check=1' : ''}`),
      request('/api/license')
    ]);
    state.software = software;
    state.license = license;
    if (state.view === 'settings') render('settings');
  } catch (error) { toast(error.message); }
}

function settingsSectionCollapsed(id) {
  try {
    const saved = JSON.parse(localStorage.getItem('lightnas-settings-collapsed') || '{}');
    return Boolean(saved[id]);
  } catch { return false; }
}

function settingsCollapseButton(id, label) {
  const collapsed = settingsSectionCollapsed(id);
  return `<button class="settings-collapse-button" type="button" data-settings-collapse="${escapeHtml(id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">${collapsed ? '⌄' : '⌃'}</button>`;
}

function settingsPermission(scope) {
  const appliance = state.overview?.appliance || {};
  if (appliance.role === 'administrator') return true;
  const permissions = appliance.permissions || [];
  return permissions.includes(scope) || permissions.includes('settings.manage');
}

function settingsView() {
  const { appliance } = state.overview;
  const zoneValues = (() => {
    try { return ['UTC', ...Intl.supportedValuesOf('timeZone')]; }
    catch { return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']; }
  })();
  const zones = [...new Set([appliance.timezone || 'UTC', ...zoneValues])].map(value => [value, value.replaceAll('_', ' ')]);
  const canGeneral = settingsPermission('settings.general.manage');
  const canPassword = settingsPermission('settings.password.manage');
  const canSoftwareManage = settingsPermission('settings.software.manage');
  const canSoftware = settingsPermission('settings.software.view') || canSoftwareManage;
  const canMfa = settingsPermission('security.mfa.manage');
  return `${pageHead('Settings & security', 'Only the settings sections assigned to your account are shown.')}
    <section class="settings-dashboard">
      ${!canGeneral && !canPassword && !canSoftware && !canMfa ? '<div class="module-note"><b>No settings sections assigned.</b> Ask an administrator to grant the specific Settings & security sections you need.</div>' : ''}
      ${canGeneral ? `<form id="settings-form" class="panel settings-general-card settings-collapsible ${settingsSectionCollapsed('general') ? 'collapsed' : ''}" data-settings-section="general">
        <div class="settings-card-head"><div><span class="eyebrow">GENERAL</span><h2>Appliance identity & branding</h2><p class="muted">Use either a text logo or a picture logo, then match the interface color to your brand.</p></div>${settingsCollapseButton('general','Appliance identity & branding')}</div>
        <div class="settings-section-body" ${settingsSectionCollapsed('general') ? 'hidden' : ''}>
        <div class="settings-general-grid branding-settings-grid">
          <label>Device name<input name="deviceName" value="${escapeHtml(appliance.deviceName)}" required minlength="2" maxlength="32" autocomplete="off"><small>System name shown in administration views.</small></label>
          <label>Logo type<select name="logoMode"><option value="text" ${appliance.logoMode !== 'picture' ? 'selected' : ''}>Text logo</option><option value="picture" ${appliance.logoMode === 'picture' ? 'selected' : ''}>Picture logo</option></select><small>Only one logo type is displayed at a time.</small></label>
          <label data-text-logo-field>Brand name<input name="brandName" value="${escapeHtml(appliance.brandName || 'LightNAS')}" minlength="2" maxlength="32" autocomplete="off" placeholder="LightNAS"><small>Shown only when Text logo is selected.</small></label>
          <label>Site accent color<div class="accent-color-control"><input name="accentColor" type="color" value="${escapeHtml(appliance.accentColor || '#087b70')}" aria-label="Site accent color"><input name="accentHex" value="${escapeHtml(appliance.accentColor || '#087b70')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}" spellcheck="false"></div><small>Buttons, menus, graphs, badges, and focus colors.</small></label>
          <label>Sidebar color<div class="accent-color-control"><input name="sidebarColor" type="color" value="${escapeHtml(appliance.sidebarColor || '#ffffff')}" aria-label="Sidebar color"><input name="sidebarHex" value="${escapeHtml(appliance.sidebarColor || '#ffffff')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}" spellcheck="false"></div><small>Left navigation background and login brand side.</small></label>
          <label>Main content color<div class="accent-color-control"><input name="contentColor" type="color" value="${escapeHtml(appliance.contentColor || '#f2f6fa')}" aria-label="Main content color"><input name="contentHex" value="${escapeHtml(appliance.contentColor || '#f2f6fa')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}" spellcheck="false"></div><small>Workspace, top bar, cards/boxes, and login form side.</small></label>
          <label>Sidebar font color<div class="accent-color-control"><input name="sidebarTextColor" type="color" value="${escapeHtml(appliance.sidebarTextColor || '#12283b')}" aria-label="Sidebar font color"><input name="sidebarTextHex" value="${escapeHtml(appliance.sidebarTextColor || '#12283b')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}" spellcheck="false"></div><small>Navigation labels, device name, and login brand-side text.</small></label>
          <label>Main font color<div class="accent-color-control"><input name="contentTextColor" type="color" value="${escapeHtml(appliance.contentTextColor || '#12283b')}" aria-label="Main font color"><input name="contentTextHex" value="${escapeHtml(appliance.contentTextColor || '#12283b')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}" spellcheck="false"></div><small>Headings, labels, card text, and login form text.</small></label>
          <label>Primary button color<div class="accent-color-control"><input name="primaryButtonColor" type="color" value="${escapeHtml(appliance.primaryButtonColor || appliance.accentColor || '#087b70')}" aria-label="Primary button color"><input name="primaryButtonHex" value="${escapeHtml(appliance.primaryButtonColor || appliance.accentColor || '#087b70')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Main action buttons throughout the control center.</small></label>
          <label>Login button color<div class="accent-color-control"><input name="loginButtonColor" type="color" value="${escapeHtml(appliance.loginButtonColor || appliance.primaryButtonColor || appliance.accentColor || '#087b70')}" aria-label="Login button color"><input name="loginButtonHex" value="${escapeHtml(appliance.loginButtonColor || appliance.primaryButtonColor || appliance.accentColor || '#087b70')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Sign-in and setup primary button.</small></label>
          <label>Top bar color<div class="accent-color-control"><input name="topbarColor" type="color" value="${escapeHtml(appliance.topbarColor || appliance.contentColor || '#f2f6fa')}"><input name="topbarHex" value="${escapeHtml(appliance.topbarColor || appliance.contentColor || '#f2f6fa')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Header behind Shell, theme and profile controls.</small></label>
          <label>Cards / boxes color<div class="accent-color-control"><input name="panelColor" type="color" value="${escapeHtml(appliance.panelColor || appliance.contentColor || '#ffffff')}"><input name="panelHex" value="${escapeHtml(appliance.panelColor || appliance.contentColor || '#ffffff')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Panels, cards, dialogs, and content boxes.</small></label>
          <label>Input field color<div class="accent-color-control"><input name="inputColor" type="color" value="${escapeHtml(appliance.inputColor || '#f9fbfd')}"><input name="inputHex" value="${escapeHtml(appliance.inputColor || '#f9fbfd')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Text fields, selects, and editable controls.</small></label>
          <label>Performance tabs color<div class="accent-color-control"><input name="performanceTabsColor" type="color" value="${escapeHtml(appliance.performanceTabsColor || appliance.panelColor || '#ffffff')}"><input name="performanceTabsHex" value="${escapeHtml(appliance.performanceTabsColor || appliance.panelColor || '#ffffff')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Background behind CPU, Load, Memory, Storage, and Network tabs.</small></label>
          <label>Active performance tab<div class="accent-color-control"><input name="performanceTabsActiveColor" type="color" value="${escapeHtml(appliance.performanceTabsActiveColor || appliance.accentColor || '#087b70')}"><input name="performanceTabsActiveHex" value="${escapeHtml(appliance.performanceTabsActiveColor || appliance.accentColor || '#087b70')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Selected performance tab background.</small></label>
          <label>Performance tab text<div class="accent-color-control"><input name="performanceTabsTextColor" type="color" value="${escapeHtml(appliance.performanceTabsTextColor || appliance.contentTextColor || '#12283b')}"><input name="performanceTabsTextHex" value="${escapeHtml(appliance.performanceTabsTextColor || appliance.contentTextColor || '#12283b')}" maxlength="7" pattern="#[0-9A-Fa-f]{6}"></div><small>Text on unselected performance tabs.</small></label>
          <label>Display time zone<select name="timezone">${zones.map(([value, label]) => `<option value="${value}" ${appliance.timezone === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        </div>
        <div class="general-branding-row branding-card">
          <div class="branding-preview compact-branding-preview" data-branding-preview>
            <div class="brand-logo-preview ${appliance.logo ? 'has-logo' : ''}" style="${appliance.logo ? `background-image:url('/api/branding/logo?v=${Date.now()}')` : ''}">${appliance.logo ? '' : '<span class="brand-mark small"><span></span><span></span><span></span></span>'}</div>
            <div><b data-brand-preview-name>${escapeHtml(appliance.brandName || 'LightNAS')}</b><p class="muted">${appliance.logoMode === 'picture' ? 'Picture logo only' : 'Text logo only'}</p></div>
          </div>
          <div class="general-logo-actions" data-picture-logo-actions>
            <label class="primary upload-button">Upload logo picture<input id="logo-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${appliance.logo ? '<button class="secondary" type="button" data-remove-logo>Remove picture</button>' : ''}
          </div>
        </div>
        <div class="form-error" data-logo-error role="alert"></div>
        <div class="settings-save-row"><button class="primary" type="submit">Save general settings</button></div>
        <div class="form-error" role="alert"></div>
        </div>
      </form>` : ''}

      ${canPassword ? `<form id="password-form" class="panel password-card settings-collapsible ${settingsSectionCollapsed('password') ? 'collapsed' : ''}" data-settings-section="password">
        <div class="settings-card-head"><div><span class="eyebrow">PASSWORD</span><h2>Change account password</h2><p class="muted">Change your own LightNAS password after confirming your current password.</p></div>${settingsCollapseButton('password','Change account password')}</div>
        <div class="settings-section-body" ${settingsSectionCollapsed('password') ? 'hidden' : ''}>
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label>New password<input name="newPassword" type="password" minlength="4" autocomplete="new-password" required placeholder="At least 4 characters"></label>
        <button class="secondary" type="submit">Change password</button><div class="form-error" role="alert"></div>
        </div>
      </form>` : ''}

      ${canSoftware ? `<section class="panel software-card settings-collapsible ${settingsSectionCollapsed('software') ? 'collapsed' : ''}" data-settings-section="software">
        <div class="settings-card-head"><div><span class="eyebrow">SOFTWARE & EDITION</span><h2>LightNAS version and updates</h2><p class="muted">Check the installed build and verify a paid Pro or Enterprise entitlement for permitted production or organizational use.</p></div>${settingsCollapseButton('software','LightNAS version and updates')}</div>
        <div class="settings-section-body" ${settingsSectionCollapsed('software') ? 'hidden' : ''}>
        <div class="manager-summary software-summary">
          <div><span>Version</span><b>${escapeHtml(state.software?.version || 'Loading…')}</b></div>
          <div><span>Commit</span><b>${escapeHtml(state.software?.commit || '—')}</b></div>
          <div><span>Update</span><b>${state.software?.updateAvailable ? 'Available' : state.software ? 'Current' : 'Checking…'}</b></div>
          <div><span>Edition</span><b>${escapeHtml(state.license?.edition === 'community' ? 'Community development / evaluation' : (state.license?.edition || 'Community development / evaluation'))}</b></div>
          <div><span>License verification</span><b>${state.license?.verified ? 'Verified' : state.license?.serverConfigured ? 'Not verified' : 'Server not configured'}</b></div>
          <div><span>Instance ID</span><b class="mono">${escapeHtml(state.license?.instanceId || '—')}</b></div>
        </div>
        <div class="head-actions software-actions">
          <button class="secondary" type="button" data-software-check>Check for updates</button>
          ${canSoftwareManage ? `<button class="primary" type="button" data-software-update ${state.software?.updateAvailable ? '' : 'disabled'}>Install update</button>` : ''}
        </div>
        ${canSoftwareManage ? `<form data-license-form class="license-verify-form">
          <label>Pro / Enterprise license key<input name="licenseKey" type="password" autocomplete="off" placeholder="Enter license key when your authentication server is ready"></label>
          <button class="secondary" type="submit">Verify edition</button>
          <div class="form-error" role="alert"></div>
        </form>` : ''}
        <p class="module-note"><b>Pre-production license:</b> Community use is free only for development, lab, education, evaluation, and early testing. Production, enterprise, commercial, hosting, managed-service, and organizational operational use require a separate paid license. A verified Pro/Enterprise receipt is accepted only from the configured HTTPS license server and must carry a valid signed receipt for this appliance.</p>
        </div>
      </section>` : ''}
    </section>`;
}
function adminCenterSectionButton(id, label) {
  return `<button class="admin-center-nav-item ${state.adminSection === id ? 'active' : ''}" type="button" data-admin-section="${id}">${escapeHtml(label)}</button>`;
}

function adminCenterRow(title, description, actions = '') {
  return `<div class="admin-center-row">
    <div><b>${escapeHtml(title)}</b><p>${escapeHtml(description)}</p></div>
    <div class="admin-center-row-actions">${actions}</div>
  </div>`;
}

function adminView() {
  const { appliance } = state.overview;
  const userCount = state.users?.length ?? '—';
  const networkName = state.network?.control?.currentUplink?.name || state.network?.routes?.find(item => item.destination === 'default')?.device || '—';
  const section = ['general','users','permissions','security','integrations'].includes(state.adminSection) ? state.adminSection : 'general';

  const action = (view, label, primary = false) =>
    `<button class="${primary ? 'primary' : 'secondary'}" type="button" data-view-link="${view}">${escapeHtml(label)}</button>`;

  const panels = {
    general: `
      <section class="admin-center-panel">
        <div class="admin-center-panel-head">
          <div><h2>General</h2><p>Appliance configuration, network, health, and system services.</p></div>
        </div>
        <div class="admin-center-section">
          <h3>Appliance</h3>
          ${adminCenterRow(appliance.deviceName, `Owner: ${appliance.username} · ${appliance.timezone || 'UTC'}`, action('settings','Open settings'))}
          ${adminCenterRow('Network', `Current management interface: ${networkName}`, action('network','Networking') + action('firewall','Firewall'))}
        </div>
        <div class="admin-center-section">
          <h3>Health & operations</h3>
          ${adminCenterRow('Overview health', 'Live system pressure, storage, memory, CPU and service status.', action('home','Open overview'))}
          ${adminCenterRow('Diagnostics', 'Review LightNAS capabilities and host diagnostics.', action('capabilities','Open diagnostics'))}
          <div class="admin-health-actions">
            <div><b>Self-management</b><p>Validate storage, networking, containers, VMs, application runtime and core LightNAS services.</p></div>
            <div class="admin-center-row-actions">
              <button class="secondary" type="button" data-appliance-health>Check health</button>
              <button class="primary" type="button" data-appliance-repair>Repair managed services</button>
            </div>
          </div>
          <div class="admin-health-result" data-appliance-health-result></div>
        </div>
        <div class="admin-center-section">
          <h3>License & responsibility</h3>
          <div class="admin-center-legal">
            <b>LightNAS · Development & Community Evaluation License</b>
            <p>LightNAS is an independent product from Cyverax LLC. Third-party platform names are used only when describing optional deployment, migration, compatibility, or integration features.</p>
            <p>LightNAS is currently for development and early testing only and is not licensed for production or enterprise use without a separate paid license. The current source is not open source. Community use is free only within the permitted development/evaluation scope. Virtual machines, containers, applications, storage, services, networks, data, backups, security, third-party licenses, and other instances created or managed on your infrastructure remain the operator's responsibility.</p>
          </div>
        </div>
      </section>`,

    users: `
      <section class="admin-center-panel">
        <div class="admin-center-panel-head"><div><h2>Users & groups</h2><p>Manage identities, account status, storage quotas, memberships, and group assignments.</p></div></div>
        <div class="admin-center-section">
          ${adminCenterRow('Local users', `${userCount} local user account${Number(userCount) === 1 ? '' : 's'} configured.`, action('users','Manage users',true))}
          ${adminCenterRow('Permission groups', 'Group users together and inherit access policies across multiple accounts.', action('permissions','Manage groups'))}
          ${adminCenterRow('Private user libraries', 'Administrator access to user libraries remains protected by administrator-password verification.', action('files','Files & media'))}
        </div>
      </section>`,

    permissions: `
      <section class="admin-center-panel">
        <div class="admin-center-panel-head"><div><h2>Permissions</h2><p>Control sidebar visibility, settings sections, resource access, and administrative actions.</p></div></div>
        <div class="admin-center-section">
          ${adminCenterRow('Navigation access', 'Choose which LightNAS tabs a user or group can see.', action('permissions','Manage permissions',true))}
          ${adminCenterRow('Settings section access', 'Grant individual settings areas such as password change, MFA, branding, software viewing, or update management.', action('permissions','Edit settings access'))}
          ${adminCenterRow('Resource actions', 'Control storage, apps, containers, VMs, networking, firewall, backups, audit, and system access independently.', action('permissions','Edit action access'))}
        </div>
      </section>`,

    security: `
      <section class="admin-center-panel">
        <div class="admin-center-panel-head"><div><h2>Security</h2><p>Account password, multi-factor authentication, passkeys, and verification methods.</p></div></div>
        <div class="admin-center-section">
          ${adminCenterRow('Password', 'Change the signed-in account password with current-password verification.', action('settings','Change password'))}
          ${adminCenterRow('Multi-factor authentication', 'Configure authenticator apps, SMS verification, passkeys, and hardware security keys.', action('settings','Configure MFA',true))}
          ${adminCenterRow('Permission policies', 'Limit which security controls each user is allowed to see and change.', action('permissions','Security permissions'))}
        </div>
      </section>`,

    integrations: `
      <section class="admin-center-panel">
        <div class="admin-center-panel-head"><div><h2>Integrations</h2><p>Notifications, identity, API automation, and external service connections.</p></div></div>
        <div class="admin-center-section">
          ${adminCenterRow('Email / SMTP', 'Configure outbound email delivery and test the SMTP relay.', action('smtp','Configure SMTP'))}
          ${adminCenterRow('External integrations', 'Manage identity providers, API tokens, webhooks, and service connections.', action('integrations','Open integrations',true))}
          ${adminCenterRow('Networking & firewall', 'External services depend on the appliance network and firewall configuration.', action('network','Networking') + action('firewall','Firewall'))}
        </div>
      </section>`
  };

  return `${pageHead('Admin Center', 'Manage accounts, access, settings, security, and system services from one workspace.')}
    <div class="admin-center-workspace">
      <aside class="admin-center-nav panel" aria-label="Admin Center sections">
        ${adminCenterSectionButton('general','General')}
        ${adminCenterSectionButton('users','Users & groups')}
        ${adminCenterSectionButton('permissions','Permissions')}
        ${adminCenterSectionButton('security','Security')}
        ${adminCenterSectionButton('integrations','Integrations')}
      </aside>
      <div class="admin-center-content">${panels[section]}</div>
    </div>`;
}

function moduleView(view) {
  if (view === 'apps') {
    const docker = state.runtimes?.docker;
    const builtInApps = state.builtinCatalog || state.runtimes?.catalog || [];
    const communityApps = state.communityCatalog?.apps || [];
    const allApps = [...new Map([...builtInApps, ...communityApps].map(app => [app.id || `${app.source || ''}:${app.name}`, app])).values()];
    const categories = [...new Set(allApps.map(app => app.category).filter(Boolean))].sort();
    const search = String(state.appSearch || '').trim().toLowerCase();
    const category = state.appCategory || '';
    const filteredApps = allApps.filter(app => {
      const searchText = `${app.name || ''} ${app.category || ''} ${app.description || ''} ${app.image || ''} ${app.source || ''}`.toLowerCase();
      return (!search || searchText.includes(search)) && (!category || app.category === category);
    });
    const limit = Math.max(24, Number(state.appVisibleLimit) || 72);
    const visibleApps = filteredApps.slice(0, limit);
    const more = Math.max(0, filteredApps.length - visibleApps.length);
    const catalogRefreshing = Boolean(state.communityCatalogLoading || state.communityCatalog?.refreshing);
    const catalogStatus = state.communityCatalogError
      ? `<p class="muted app-catalog-status">Community catalog retrying automatically: ${escapeHtml(state.communityCatalogError)}</p>`
      : catalogRefreshing
        ? `<p class="muted app-catalog-status">Updating app sources in the background… ${communityApps.length ? `Keeping ${communityApps.length} cached community apps available.` : 'Apps will appear automatically as soon as the local index is ready.'}</p>`
        : '';

    return `${pageHead('App Store', 'Install curated open-source applications directly from LightNAS.', '<button class="secondary refresh-icon-button" data-action="refresh-runtime" aria-label="Refresh" title="Refresh">↻</button>')}
      ${runtimeBanner('docker')}
      <section class="app-catalog-toolbar panel">
        <div><span class="eyebrow">LIGHTNAS APPLICATION CATALOG</span><h2>${allApps.length} one-click apps</h2><p class="muted">Built-in apps appear immediately. Community apps load automatically from the local cache and refresh in the background.</p>${catalogStatus}</div>
        <div class="app-filter-controls">
          <label>Search<input id="app-search" type="search" value="${escapeHtml(state.appSearch || '')}" placeholder="Search apps, categories, or images…"></label>
          <label>Category<select id="app-category"><option value="">All categories</option>${categories.map(item => `<option value="${escapeHtml(item)}" ${item === category ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></label>
        </div>
      </section>
      <div class="tool-grid app-catalog-grid">${visibleApps.map(app => {
        const instances = (docker?.containers || []).filter(container =>
          container.catalogId === app.id || container.name === `lightnas-app-${app.id}`
        );
        const searchText = `${app.name} ${app.category} ${app.description} ${app.image}`.toLowerCase();
        const namedInstances = instances.map(instance => {
          const instanceName = instance.instanceName || (instance.name === `lightnas-app-${app.id}` ? 'default' : instance.name.replace(`lightnas-app-${app.id}-`, ''));
          return instanceName === 'default' ? '' : `<section class="app-instance-row"><div class="app-instance-summary"><b>${escapeHtml(instanceName)}</b></div></section>`;
        }).filter(Boolean);
        const instanceList = namedInstances.length ? `<div class="app-instance-list">${namedInstances.join('')}</div>` : '';
        const installControl = app.community
          ? ((app.installable || app.trueNasCatalog)
              ? `<button class="primary" data-community-install="${app.id}">Install</button>`
              : `<button class="secondary" type="button" disabled title="${escapeHtml(app.installReason || 'This community app is not deployable on this host.')}">Unavailable</button>`)
          : `<button class="primary" data-install="${app.id}" data-instance-count="${instances.length}">Install</button>`;
        return `<article class="panel app-card" data-app-card data-category="${escapeHtml(app.category)}" data-search="${escapeHtml(searchText)}"><span class="eyebrow">${escapeHtml(app.category)}</span><h2>${escapeHtml(app.name)}</h2><p class="muted">${escapeHtml(app.description)}</p>${app.community ? '' : `<p class="muted app-source">${escapeHtml(app.source || 'Open source')}${app.image ? ` · ${escapeHtml(app.image)}` : ''}${app.port ? ` · Default port ${app.port}` : ''}</p>`}${instances.length ? `<p class="muted"><b>${instances.length}</b> installed instance${instances.length === 1 ? '' : 's'}</p>` : ''}${instanceList}<div class="head-actions app-install-actions">${installControl}</div></article>`;
      }).join('') || (state.builtinCatalog === null ? '<div class="empty"><p>Loading built-in catalog…</p></div>' : '<div class="empty"><p>No apps match this filter.</p></div>')}</div>
      ${more ? `<div class="app-catalog-more"><button class="secondary" type="button" data-app-more>Show ${Math.min(72, more)} more</button><span class="muted">Showing ${visibleApps.length} of ${filteredApps.length} matching apps</span></div>` : filteredApps.length ? `<p class="muted app-catalog-count">Showing ${filteredApps.length} matching app${filteredApps.length === 1 ? '' : 's'}.</p>` : ''}
      <section class="module-hero"><h2>Managed app hosting</h2><p>LightNAS downloads each app, creates its persistent storage, publishes its web service on the LightNAS LAN address, starts it after reboot, and verifies that the service is reachable. No external hypervisor configuration or manual port forwarding is required for managed catalog apps. ${docker?.available && docker?.enabled ? 'The integrated App Store engine is ready.' : 'The catalog stays available while the App Store engine finishes starting.'}</p></section>`;
  }
  return `${pageHead('Monitoring', 'Current readings from this host.', '<button class="secondary refresh-icon-button" data-action="refresh" aria-label="Refresh" title="Refresh">↻</button>')}<section class="metric-grid">${metric('CPU load', `${state.overview.system.cpu.loadPercent}%`, state.overview.system.cpu.loadPercent, state.overview.system.cpu.model)}${metric('Memory', bytes(state.overview.system.memory.usedBytes), state.overview.system.memory.usedPercent, `${bytes(state.overview.system.memory.freeBytes)} free`)}${metric('Uptime', duration(state.overview.system.uptimeSeconds), 0, state.overview.system.kernel)}${metric('Mounts', state.overview.filesystems.length, 0, 'Currently visible')}</section><h2>Activity</h2><div class="activity-list">${state.overview.activity.map(item => `<div class="activity"><div><b>${escapeHtml(item.message)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') || '<p>No activity recorded.</p>'}</div>`;
}

async function loadNetwork() {
  try { state.network = await request('/api/network'); if (['network', 'firewall', 'admin'].includes(state.view)) render(state.view); }
  catch (error) { toast(error.message); }
}

function networkView() {
  const info = state.network;
  const control = info?.control;
  if (!info) return `${pageHead('Networking', 'Manage interfaces, bridges, VLANs, bonds, routes and DNS.', '<button class="secondary refresh-icon-button" data-action="refresh-network" aria-label="Refresh" title="Refresh">↻</button>')}<div class="empty">Loading network inventory…</div>`;

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

  return `${pageHead('Networking', 'LightNAS host networking. Create configuration first, then explicitly activate changes that could affect management connectivity.', '<div class="head-actions"><button class="secondary refresh-icon-button" data-action="refresh-network" aria-label="Refresh" title="Refresh">↻</button><button class="primary" data-network-add-bridge>+ Bridge</button><button class="secondary" data-network-add-vlan>+ VLAN</button><button class="secondary" data-network-add-bond>+ Bond</button><button class="secondary" data-network-add-route>+ Route</button></div>')}
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
  const firewall = state.network?.firewall || {};
  const active = /active|enabled/i.test(String(firewall.status || ''));
  return `${pageHead('Firewall', 'Host firewall policy, defaults, and service access in one place.', '<div class="head-actions"><button class="secondary refresh-icon-button" data-action="refresh-network" aria-label="Refresh" title="Refresh">↻</button><button class="primary" data-firewall-add>+ Add rule</button></div>')}
    <section class="metric-grid firewall-summary-grid">
      ${metric('Firewall', active ? 'Enabled' : 'Disabled', active ? 100 : 0, `Backend: ${escapeHtml(firewall.backend || 'detecting')}`)}
      ${metric('Rules', String(firewall.rules?.length || 0), Math.min(100, (firewall.rules?.length || 0) * 8), 'Numbered host rules')}
      ${metric('Incoming default', escapeHtml(firewall.defaultIncoming || 'deny'), 0, 'Traffic with no matching rule')}
      ${metric('Outgoing default', escapeHtml(firewall.defaultOutgoing || 'allow'), 0, 'Traffic initiated by LightNAS')}
    </section>
    <section class="panel firewall-policy-panel">
      <div class="panel-head"><div><span class="eyebrow">HOST POLICY</span><h2>Firewall controls</h2><p class="muted">Safe default is deny incoming / allow outgoing. Existing management access is not silently rewritten.</p></div><div class="head-actions"><button class="secondary" data-firewall-defaults>Default policy</button><button class="secondary" data-firewall-toggle="enable" ${active ? 'disabled' : ''}>Enable</button><button class="secondary danger-button" data-firewall-toggle="disable" ${active ? '' : 'disabled'}>Disable</button><button class="secondary danger-button" data-firewall-reset>Reset rules</button></div></div>
    </section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">RULES</span><h2>Host access rules</h2></div><small>Processed in UFW order</small></div>
      <div class="storage-list">${firewall.rules?.length ? firewall.rules.map(item => `<article class="storage-row firewall-rule-row"><div><h3>#${item.number} · ${escapeHtml(item.action)} ${escapeHtml(item.target)}</h3><p>Source: ${escapeHtml(item.source || 'Anywhere')}</p></div><button class="secondary danger-button" data-firewall-delete="${item.number}">Delete</button></article>`).join('') : '<div class="empty compact-empty"><h3>No custom rules</h3><p>Add only the ports and sources this appliance actually needs.</p></div>'}</div>
    </section>
    ${firewall.tables?.length ? `<details class="panel firewall-advanced"><summary>Advanced nftables visibility</summary><div class="storage-list">${firewall.tables.map(item => `<article class="storage-row">${escapeHtml(item)}</article>`).join('')}</div></details>` : ''}`;
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
  return `${pageHead('Integrations', 'Connected runtimes, services, and LightNAS providers.', '<button class="secondary refresh-icon-button" data-action="refresh-runtime" aria-label="Refresh" title="Refresh">↻</button>')}
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

function backupsView() {
  const pools = state.overview?.storage?.configuredPools || [];
  const eligible = pools.filter(pool => Array.isArray(pool.content) ? pool.content.includes('backups') : /backup/i.test((pool.contentLabels || []).join(' ')));
  const activity = (state.logs || state.overview?.activity || []).filter(item => /backup|restore|snapshot/i.test(`${item.type || ''} ${item.message || ''}`));

  // Keep the LightVisor/hypervisor workspace unchanged. This redesign is NAS-only.
  if (window.LIGHTNAS_PRODUCT_MODE === 'hypervisor') {
    return `${pageHead('Backups', 'Backup storage, restore activity and protection status.', '<div class="head-actions"><button class="secondary refresh-icon-button" data-action="refresh-storage" aria-label="Refresh storage" title="Refresh storage">↻</button><button class="secondary refresh-icon-button" data-action="refresh-logs" aria-label="Refresh activity" title="Refresh activity">↻</button></div>')}
      <section class="metric-grid">
        ${metric('Backup-capable pools', String(eligible.length), eligible.length ? 100 : 0, eligible.length ? 'Ready for backup content' : 'No pool currently advertises backup content')}
        ${metric('Recent backup events', String(activity.length), Math.min(100, activity.length * 10), 'Recorded in the LightNAS activity log')}
        ${metric('Configured storage pools', String(pools.length), pools.length ? 100 : 0, 'Available storage targets')}
        ${metric('Protection status', eligible.length ? 'Ready' : 'Needs target', eligible.length ? 100 : 0, eligible.length ? 'At least one backup target is available' : 'Add or edit storage to allow Backups')}
      </section>
      <section class="panel"><div class="panel-head"><div><span class="eyebrow">BACKUP TARGETS</span><h2>Storage available for backups</h2></div><button class="secondary" data-view-link="storage">Manage storage</button></div>
        <div class="storage-list">${eligible.length ? eligible.map(pool => `<article class="storage-row"><div><h3>${escapeHtml(pool.name)}</h3><p>${escapeHtml(pool.provider || pool.type || 'storage')} · ${escapeHtml(pool.mountPoint || 'managed storage')}</p></div><span class="volume-state writable">READY</span></article>`).join('') : '<div class="empty compact-empty"><h3>No backup target configured</h3><p>Open Storage and add or edit a pool with Backups enabled in its content policy.</p></div>'}</div>
      </section>
      <section class="panel"><div class="panel-head"><div><span class="eyebrow">HISTORY</span><h2>Backup & restore activity</h2></div></div>
        <div class="activity-list">${activity.length ? activity.slice(0,50).map(item => `<div class="activity"><span class="activity-icon">↶</span><div><b>${escapeHtml(item.message || item.type)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No backup or restore activity has been recorded yet.</p>'}</div>
      </section>`;
  }

  const jobs = Array.isArray(state.backupJobs) ? state.backupJobs : [];
  const selected = jobs.find(job => job.id === state.selectedBackupJobId);
  return `${pageHead('Backup', 'Create and manage NAS backup jobs.', '')}
    <section class="panel backup-console">
      <div class="backup-toolbar" role="toolbar" aria-label="Backup jobs">
        <button type="button" class="secondary" data-backup-add>Add</button>
        <button type="button" class="secondary" data-backup-remove ${selected ? '' : 'disabled'}>Remove</button>
        <button type="button" class="secondary" data-backup-edit ${selected ? '' : 'disabled'}>Edit</button>
        <button type="button" class="secondary" data-backup-detail ${selected ? '' : 'disabled'}>Job Detail</button>
        <button type="button" class="secondary" data-backup-run ${selected ? '' : 'disabled'}>Run now</button>
        <span class="backup-toolbar-spacer"></span>
        <label class="backup-filter"><input type="checkbox" data-backup-unprotected> Show: Data Without Backup Job</label>
        <button type="button" class="secondary" data-backup-simulator>Schedule Simulator</button>
      </div>
      <div class="backup-table-wrap">
        <div class="backup-table" role="table">
          <div class="backup-row backup-head" role="row"><span>Enabled</span><span>Node</span><span>Schedule</span><span>Next Run</span><span>Storage</span><span>Comment</span><span>Retention</span><span>Selection</span></div>
          ${state.backupJobs === null
            ? '<div class="backup-empty">Loading backup jobs…</div>'
            : jobs.length
              ? jobs.map(job => `<button type="button" class="backup-row backup-job-row${job.id === state.selectedBackupJobId ? ' selected' : ''}" data-backup-job="${escapeHtml(job.id)}" role="row">
                  <span class="backup-enabled">${job.enabled ? '✓' : '—'}</span>
                  <span>${escapeHtml(job.node || state.overview?.appliance?.deviceName || 'LightNAS')}</span>
                  <span>${escapeHtml(job.schedule || 'On demand')}</span>
                  <span>${escapeHtml(job.nextRun || 'Pending scheduler')}</span>
                  <span>${escapeHtml(job.storage || '—')}</span>
                  <span>${escapeHtml(job.comment || '')}</span>
                  <span>${escapeHtml(job.retention || 'Keep last 7')}</span>
                  <span class="backup-selection">${escapeHtml(job.selection || 'All NAS data')}</span>
                </button>`).join('')
              : '<div class="backup-empty">No backup jobs configured. Select Add to create the first NAS backup job.</div>'}
        </div>
      </div>
      <div class="backup-status-line"><span>${eligible.length} backup-capable storage target${eligible.length === 1 ? '' : 's'} detected</span><span>${activity.length} recent backup/restore event${activity.length === 1 ? '' : 's'}</span></div>
    </section>`;
}

function analyticsView() {
  const system = state.overview?.system || {};
  const storage = state.overview?.storage?.usableStorage || state.overview?.storage?.virtualStorage || state.overview?.storage?.local || {};
  const network = system.network || {};
  const activity = state.logs || state.overview?.activity || [];
  const counts = activity.reduce((map,item) => { const key=String(item.type || 'other'); map[key]=(map[key]||0)+1; return map; }, {});
  const successful = activity.filter(item => !/error|fail|warning/i.test(String(item.severity || ''))).length;
  const warnings = activity.filter(item => /warning/i.test(String(item.severity || ''))).length;
  const errors = activity.filter(item => /error|fail/i.test(String(item.severity || ''))).length;
  return `${pageHead('Analytics', 'Operational analytics, capacity and recorded activity.', '<button class="secondary refresh-icon-button" data-action="refresh-logs" aria-label="Refresh" title="Refresh">↻</button>')}
    <section class="metric-grid">
      ${metric('Recorded operations', String(activity.length), activity.length ? 100 : 0, 'Persisted LightNAS activity events')}
      ${metric('Successful / informational', String(successful), activity.length ? Math.round((successful/activity.length)*100) : 0, 'Operations without warning or error severity')}
      ${metric('Warnings', String(warnings), activity.length ? Math.round((warnings/activity.length)*100) : 0, 'Events marked warning')}
      ${metric('Errors', String(errors), activity.length ? Math.round((errors/activity.length)*100) : 0, 'Events marked error or failure')}
    </section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">OPERATIONS</span><h2>Activity by category</h2></div><small>${activity.length} recorded events</small></div>
      <div class="analytics-bars">${Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([type,count]) => `<div class="analytics-bar-row"><span>${escapeHtml(type)}</span><div class="track"><span style="width:${Math.min(100,(count/Math.max(1,activity.length))*100)}%"></span></div><b>${count}</b></div>`).join('') || '<p class="muted">No activity data yet.</p>'}</div>
    </section>
    <section class="metric-grid">
      ${metric('Storage used', bytes(storage.usedBytes || 0), Number(storage.usedPercent || 0), `${bytes(storage.availableBytes || 0)} available`)}
      ${metric('Configured capacity', bytes(storage.totalBytes || 0), 0, 'Usable LightNAS storage')}
      ${metric('Network interfaces', String(network.interfaces || 0), 0, `RX ${bytes(network.receivedBytes || 0)} · TX ${bytes(network.transmittedBytes || 0)}`)}
      ${metric('System uptime', duration(system.uptimeSeconds || 0), 0, system.kernel || '')}
    </section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">RECENT OPERATIONS</span><h2>Latest activity</h2></div><button class="secondary" data-action="open-logs-modal">View logs</button></div>
      <div class="activity-list">${activity.length ? activity.slice(0,20).map(item => `<div class="activity"><span class="activity-icon">↗</span><div><b>${escapeHtml(item.message || item.type)}</b><time>${relativeTime(item.timestamp)}</time></div></div>`).join('') : '<p class="muted">No activity recorded yet.</p>'}</div>
    </section>`;
}

function openLogsModal() {
  let dialog = document.querySelector('#lightnas-logs-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'lightnas-logs-dialog';
    dialog.className = 'lightnas-dialog runtime-dialog logs-dialog';
    dialog.innerHTML = `<div class="dialog-body"><div class="dialog-head"><div><span class="eyebrow">AUDIT & ACTIVITY</span><h2>LightNAS logs</h2></div><button class="icon-button" type="button" data-logs-close>×</button></div><div data-logs-modal-body></div><div class="dialog-actions"><button class="secondary" type="button" data-logs-refresh>Refresh</button><button class="primary" type="button" data-logs-close>Close</button></div></div>`;
    document.body.append(dialog);
    dialog.addEventListener('click', event => { if (event.target.closest('[data-logs-close]')) dialog.close(); });
    dialog.querySelector('[data-logs-refresh]')?.addEventListener('click', async () => {
      try { state.logs = (await request('/api/logs?limit=500')).logs || []; renderLogsModal(dialog); } catch (error) { toast(error.message); }
    });
  }
  renderLogsModal(dialog);
  if (!dialog.open) dialog.showModal();
}

function renderLogsModal(dialog) {
  const logs = state.logs || [];
  const body = dialog.querySelector('[data-logs-modal-body]');
  body.innerHTML = `<div class="logs-table"><div class="logs-head"><span>Time</span><span>Type</span><span>Severity</span><span>Message</span></div>${logs.length ? logs.map(item => `<div class="logs-row"><time>${escapeHtml(new Date(item.timestamp).toLocaleString())}</time><span>${escapeHtml(item.type || 'event')}</span><span class="log-severity ${escapeHtml(item.severity || 'info')}">${escapeHtml((item.severity || 'info').toUpperCase())}</span><b>${escapeHtml(item.message || '')}</b></div>`).join('') : '<div class="empty compact-empty"><p>No persisted activity has been recorded yet.</p></div>'}</div>`;
}

function logsView() {
  const logs = state.logs || [];
  return `${pageHead('Logs', 'Persisted LightNAS activity and audit events.', '<button class="secondary refresh-icon-button" data-action="refresh-logs" aria-label="Refresh" title="Refresh">↻</button>')}
    <section class="panel logs-panel"><div class="panel-head"><div><span class="eyebrow">AUDIT & ACTIVITY</span><h2>System activity log</h2></div><small>${logs.length} events loaded</small></div>
      <div class="logs-table">
        <div class="logs-head"><span>Time</span><span>Type</span><span>Severity</span><span>Message</span></div>
        ${logs.length ? logs.map(item => `<div class="logs-row"><time>${escapeHtml(new Date(item.timestamp).toLocaleString())}</time><span>${escapeHtml(item.type || 'event')}</span><span class="log-severity ${escapeHtml(item.severity || 'info')}">${escapeHtml((item.severity || 'info').toUpperCase())}</span><b>${escapeHtml(item.message || '')}</b></div>`).join('') : '<div class="empty compact-empty"><p>No persisted activity has been recorded yet.</p></div>'}
      </div>
    </section>`;
}

async function loadLogs() {
  try {
    state.logs = (await request('/api/logs?limit=500')).logs || [];
    if (['logs','backups','analytics'].includes(state.view)) render(state.view);
  } catch (error) { toast(error.message); }
}
function render(view) {
  if (view === 'media') view = 'files';
  if (view === 'monitoring') view = 'home';
  state.view = ['home', 'hypervisor', 'storage', 'pools', 'files', 'users', 'permissions', 'shell', 'smtp', 'admin', 'shares', 'backups', 'analytics', 'logs', 'capabilities', 'apps', 'ai', 'containers', 'vms', 'settings', 'network', 'firewall', 'integrations'].includes(view) ? view : 'home';
  if (!canView(state.view)) state.view = canView('home') ? 'home' : 'files';
  const content = $('#content');
  let rendered = state.view === 'home' ? (state.uiMode === 'hypervisor' ? hypervisorView() : homeView()) : state.view === 'hypervisor' ? hypervisorView() : state.view === 'storage' ? storageView() : state.view === 'pools' ? poolsView() : state.view === 'files' ? filesView() : state.view === 'media' ? mediaView() : state.view === 'users' ? usersView() : state.view === 'permissions' ? permissionsView() : state.view === 'shell' ? shellView() : state.view === 'smtp' ? smtpView() : state.view === 'admin' ? adminView() : state.view === 'shares' ? sharesView() : state.view === 'backups' ? backupsView() : state.view === 'analytics' ? analyticsView() : state.view === 'logs' ? logsView() : state.view === 'containers' ? containersView() : state.view === 'vms' ? vmsView() : state.view === 'settings' ? settingsView() : state.view === 'capabilities' ? capabilitiesView() : state.view === 'monitoring' ? monitoringView() : state.view === 'ai' ? aiView() : state.view === 'network' ? networkView() : state.view === 'firewall' ? firewallView() : state.view === 'integrations' ? integrationsView() : moduleView(state.view);
  if (window.LIGHTNAS_PRODUCT_MODE === 'hypervisor' && !['home','hypervisor'].includes(state.view)) {
    rendered = hypervisorSubViewShell(rendered, state.view);
  }
  content.innerHTML = rendered;
  $$('[data-view]').forEach(link => {
    const library = link.dataset.fileLibrary;
    const filesChild = link.dataset.view === 'files' && library && !link.classList.contains('nav-files-parent');
    const regular = link.dataset.view === state.view && !library;
    const selectedFilesChild = state.view === 'files' && filesChild && library === state.fileLibraryTab;
    link.classList.toggle('active', regular || selectedFilesChild);
  });
  $('.nav-files-parent', $('#nav'))?.classList.toggle('active', state.view === 'files');
  $("[data-view=\"" + state.view + "\"]", $('#nav'))?.closest('details')?.setAttribute('open', '');
  content.focus({ preventScroll: true });
  applyWorkspaceMode();
  bindViewActions();
  if (state.view === 'files') {
    const key = filesSectionCacheKey();
    const checkedAt = Number(state.fileSectionCheckedAt.get(key) || 0);
    const stale = Date.now() - checkedAt > 15000;
    if ((state.files === null || stale || state.fileError) && !state.filesLoadingKeys.has(key)) {
      queueMicrotask(() => loadFiles(false).catch(() => null));
    }
  }
  if (['pools', 'storage'].includes(state.view) && state.spaces === null) loadSpaces();
  if (['users', 'permissions', 'admin'].includes(state.view) && state.users === null) loadUsers();
  if (['smtp','integrations'].includes(state.view) && state.smtp === undefined) loadSmtp();
  if (['files', 'media'].includes(state.view) && state.media === null) loadMedia();
  if (['network', 'firewall', 'admin'].includes(state.view) && !state.network) loadNetwork();
  if (['logs','backups','analytics'].includes(state.view) && state.logs === null) loadLogs();
  if (state.view === 'backups' && state.backupJobs === null && window.LIGHTNAS_PRODUCT_MODE !== 'hypervisor') loadBackupJobs();
  if (state.view === 'apps') {
    const catalogStale = !state.communityCatalog || Date.now() - Number(state.communityCatalogCheckedAt || 0) > 15000;
    if (catalogStale && !state.communityCatalogLoading) {
      queueMicrotask(() => loadCommunityCatalog(false).catch(() => null));
    }
  }
  if (state.view === 'settings' && (settingsPermission('settings.software.view') || settingsPermission('settings.software.manage')) && (!state.software || !state.license)) loadSoftwareAndLicense();

  if (state.view === 'containers') {
    const needContainers = !state.runtimes?.containers && !state.containerError;
    const needApps = (!state.runtimes?.docker || !state.runtimes?.catalog) && !state.runtimeError;
    if (needContainers && needApps) Promise.all([loadContainers(), loadRuntimes()]);
    else if (needContainers) loadContainers();
    else if (needApps) loadRuntimes();
  }
  if (['home', 'hypervisor', 'apps', 'ai', 'vms', 'integrations'].includes(state.view) && (!state.runtimes?.docker || !state.runtimes?.virtualization || !state.runtimes?.catalog) && !state.runtimeError) loadRuntimes();
}

function bindViewActions() {
  document.querySelectorAll('#content [data-admin-section]').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.adminSection;
    if (!['general','users','permissions','security','integrations'].includes(next)) return;
    state.adminSection = next;
    localStorage.setItem('lightnas-admin-section', next);
    render('admin');
  }));
  document.querySelectorAll('#content [data-settings-collapse]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.settingsCollapse;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('lightnas-settings-collapsed') || '{}'); } catch {}
    saved[id] = !saved[id];
    localStorage.setItem('lightnas-settings-collapsed', JSON.stringify(saved));
    render('settings');
  }));
  $('[data-software-check]', $('#content'))?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await loadSoftwareAndLicense(true); toast(state.software?.updateAvailable ? 'A LightNAS update is available.' : 'LightNAS is up to date.'); }
    finally { event.currentTarget.disabled = false; }
  });
  $('[data-software-update]', $('#content'))?.addEventListener('click', async event => {
    if (!confirm('Install the newest LightNAS update now? The web interface will restart briefly.')) return;
    event.currentTarget.disabled = true;
    try {
      await request('/api/software/update', { method:'POST', body:'{}' });
      toast('Update started. LightNAS will restart when installation finishes.');
    } catch (error) { toast(error.message); event.currentTarget.disabled = false; }
  });
  $('[data-license-form]', $('#content'))?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = $('.form-error', form);
    error.textContent = '';
    try {
      state.license = await request('/api/license/verify', { method:'POST', body:JSON.stringify({ licenseKey:form.elements.licenseKey.value }) });
      form.reset();
      render('settings');
      toast(`LightNAS ${state.license.edition} edition verified.`);
    } catch (problem) { error.textContent = problem.message; }
  });
  $('[data-action="open-logs-modal"]', $('#content'))?.addEventListener('click', async () => { if (state.logs === null) { try { state.logs = (await request('/api/logs?limit=500')).logs || []; } catch (error) { toast(error.message); return; } } openLogsModal(); });
  $('[data-action="refresh-logs"]', $('#content'))?.addEventListener('click', async event => { event.currentTarget.disabled = true; try { state.logs = (await request('/api/logs?limit=500')).logs || []; render(state.view); } catch (error) { toast(error.message); } });
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
      const targets = containers.filter(item => /running|active/i.test(String(item.status || '')) && (!/^\d+\.\d+\.\d+\.\d+$/.test(String(item.ipv4 || '')) || /^10\.77\.0\./.test(String(item.ipv4 || ''))));
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
  $('[data-vm-prepare-drivers]', $('#content'))?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Preparing…';
    try {
      await request('/api/vm/guest-tools/windows', { method:'POST', body:'{}' });
      state.runtimes = await request('/api/runtimes');
      render('vms');
      toast('Windows VirtIO guest drivers are ready.');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Prepare Windows drivers';
      toast(error.message);
    }
  });
  $$('[data-vm-guest-drivers]', $('#content')).forEach(button => button.addEventListener('click', async event => {
    const target = event.currentTarget;
    const id = target.dataset.vmGuestDrivers;
    target.disabled = true;
    target.textContent = 'Attaching…';
    try {
      const result = await request('/api/vms', { method:'POST', body:JSON.stringify({ id, vmid:id, action:'guest-drivers' }) });
      state.runtimes = await request('/api/runtimes');
      render('vms');
      toast(result.alreadyAttached
        ? (result.requiresRestart ? 'VirtIO driver CD is saved to this VM. Fully shut down the VM, then start it again to load the new CD/DVD hardware.' : 'VirtIO driver CD is already attached.')
        : (result.requiresRestart ? 'VirtIO driver CD added. Fully shut down the VM, then start it again so Windows can see the new CD/DVD drive.' : 'VirtIO driver CD attached to the running VM.'));
    } catch (error) {
      target.disabled = false;
      target.textContent = 'Attach VirtIO Drivers';
      toast(error.message);
    }
  }));

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
    const data = new FormData(form);
    const password = String(data.get('password') || '');
    if (password.length < 4) {
      $('.form-error', form).textContent = 'Password must contain at least 4 characters.';
      return;
    }
    const payload = {
      username: data.get('username'),
      password,
      storageQuotaGiB: Number(data.get('storageQuotaGiB') || 5),
      permissions: data.getAll('permissions'),
      groups: data.getAll('groups')
    };
    try {
      await request('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      await loadUsers();
      toast('User created.');
    } catch (error) { $('.form-error', form).textContent = error.message; }
  });
  $$('[data-open-user-manager]', $('#content')).forEach(button => button.addEventListener('click', () => {
    openUserManager(button.dataset.openUserManager).catch(error => toast(error.message));
  }));
  $$('[data-media-folder]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const folder = button.dataset.mediaFolder;
    try {
      await request(`/api/files?path=${encodeURIComponent(folder)}`, { method: 'POST' });
    } catch (error) { if (error.status !== 409) return toast(error.message); }
    state.folder = folder; state.files = null; location.hash = 'files';
  }));
  $$('[data-action="refresh-network"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    if (button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '↻'; button.title = 'Refreshing…'; button.setAttribute('aria-label', 'Refreshing');
    try {
      await loadNetwork();
      toast('Network refreshed.');
    } catch (error) {
      toast(error.message || 'Unable to refresh network.');
    } finally {
      const live = $('#content [data-action="refresh-network"]');
      if (live) { live.disabled = false; live.textContent = '↻'; live.title = 'Refresh'; live.setAttribute('aria-label', 'Refresh'); }
    }
  }));
  document.querySelectorAll('#content [data-action="refresh-runtime"]').forEach(button => button.addEventListener('click', async () => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '↻'; button.title = 'Refreshing…'; button.setAttribute('aria-label', 'Refreshing');
    try {
      if (state.view === 'apps') {
        await loadCommunityCatalog(true);
        loadRuntimes(true).catch(() => null);
      } else {
        await loadRuntimes(true);
      }
      render(state.view);
      toast(state.view === 'apps' ? 'App catalog refresh started in the background.' : 'Runtime inventory refreshed.');
    } catch (error) {
      toast(error.message);
    } finally {
      const live = $('#content [data-action="refresh-runtime"]');
      if (live) { live.disabled = false; live.textContent = '↻'; live.title = 'Refresh'; live.setAttribute('aria-label', 'Refresh'); }
    }
  }));
  $$('[data-community-install]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const docker = state.runtimes?.docker;
    if (!docker?.available || !docker?.enabled) return toast(docker?.reason || 'Docker needs to be installed and enabled on this host before app installation.');
    const app = state.communityCatalog?.apps?.find(item => item.id === button.dataset.communityInstall);
    if (!app) return toast('The selected community application is no longer in the catalog.');
    if (!app.installable) return toast(app.installReason || 'This community application cannot be installed on this host.');
    if (!confirm(`Install ${app.name} from ${app.source}? LightNAS will prepare the upstream application package, pull its images, create persistent data, and start the application.`)) return;
    button.disabled = true;
    button.textContent = 'Installing…';
    const progress = window.LightNASProgress?.open(`Installing ${app.name}`, 'Preparing the application package, pulling images, and starting services…', { modal:false });
    try {
      await request(`/api/catalog/community/${encodeURIComponent(app.id)}/install`, { method:'POST', body:'{}' });
      await Promise.all([loadRuntimes(true), loadCommunityCatalog(false)]);
      progress?.succeed(`${app.name} installed and started successfully.`);
      toast(`${app.name} installed.`);
    } catch (error) {
      progress?.fail(error.message); toast(error.message); button.disabled = false; button.textContent = 'Install';
    }
  }));
  $$('[data-install]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const docker = state.runtimes?.docker;
    if (!docker?.available || !docker?.enabled) return toast(docker?.reason || 'Docker needs to be installed and enabled on this host before app installation.');
    const app = state.runtimes?.catalog?.find(item => item.id === button.dataset.install);
    if (!app) return toast('The selected application is no longer in the catalog.');
    const setup = {};
    const instanceCount = Number(button.dataset.instanceCount || 0);
    if (instanceCount > 0) {
      const suggested = `instance-${instanceCount + 1}`;
      const instanceName = prompt(`Name this new ${app.name} instance:`, suggested);
      if (instanceName === null) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,30}$/.test(instanceName.trim())) return toast('Instance name can contain letters, numbers, and dashes.');
      setup.instanceName = instanceName.trim().toLowerCase();
      setup.hostPort = 0;
    }
    if (app.requiresAdminUsername) {
      const username = prompt(`Create the ${app.name} administrator username:`, app.adminUsername || 'admin');
      if (username === null) return;
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(username.trim())) return toast('The application administrator username must contain 3–64 letters, numbers, dots, underscores, or dashes.');
      setup.adminUsername = username.trim();
    }
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
      await loadRuntimes(true);
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
    const url = `/container-console.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&type=app`;
    const width = Math.min(1200, Math.max(760, screen.availWidth - 120));
    const height = Math.min(850, Math.max(560, screen.availHeight - 120));
    const left = Math.max(0, Math.round((screen.availWidth - width) / 2));
    const top = Math.max(0, Math.round((screen.availHeight - height) / 2));
    const terminalWindow = window.open(
      url,
      `lightnas-terminal-${id}`,
      `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );
    if (terminalWindow) terminalWindow.focus();
    else toast('The browser blocked the terminal window. Allow pop-ups for this LightNAS site.');
  }));
  $$('[data-app-action]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    const { appId, appAction, appInstance, appHostPort } = button.dataset;
    const instanceName = appInstance || 'default';
    if (appAction === 'remove' && !confirm(`Remove ${appId} instance "${instanceName}"? Its saved app data will remain on this NAS.`)) return;
    button.disabled = true;
    try {
      await request(`/api/catalog/${appId}/${appAction}`, {
        method: 'POST',
        body: JSON.stringify({ instanceName, hostPort: Number(appHostPort || 0) })
      });
      await loadRuntimes(true);
      toast(`${instanceName}: ${appAction} complete.`);
    }
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
        if (path === '/api/containers') await loadContainers(); else await loadRuntimes(true);
        toast(message);
      }
      catch (problem) { error.textContent = problem.message; }
      finally { button.disabled = false; }
    });
  }
  const settingsForm = $('#settings-form', $('#content'));
  if (settingsForm) {
    const syncBrandingControls = () => {
      const picture = settingsForm.elements.logoMode?.value === 'picture';
      settingsForm.querySelector('[data-text-logo-field]')?.classList.toggle('hidden', picture);
      settingsForm.querySelector('[data-picture-logo-actions]')?.classList.toggle('hidden', !picture);
      const preview = settingsForm.querySelector('[data-branding-preview]');
      const previewName = settingsForm.querySelector('[data-brand-preview-name]');
      if (previewName) previewName.hidden = picture;
      preview?.classList.toggle('picture-only', picture);
    };
    settingsForm.elements.logoMode?.addEventListener('change', syncBrandingControls);
    const color = settingsForm.elements.accentColor;
    const hex = settingsForm.elements.accentHex;
    const sidebarColor = settingsForm.elements.sidebarColor;
    const sidebarHex = settingsForm.elements.sidebarHex;
    const contentColor = settingsForm.elements.contentColor;
    const contentHex = settingsForm.elements.contentHex;
    const sidebarTextColor = settingsForm.elements.sidebarTextColor;
    const sidebarTextHex = settingsForm.elements.sidebarTextHex;
    const contentTextColor = settingsForm.elements.contentTextColor;
    const contentTextHex = settingsForm.elements.contentTextHex;
    const primaryButtonColor = settingsForm.elements.primaryButtonColor;
    const primaryButtonHex = settingsForm.elements.primaryButtonHex;
    const loginButtonColor = settingsForm.elements.loginButtonColor;
    const loginButtonHex = settingsForm.elements.loginButtonHex;
    const topbarColor = settingsForm.elements.topbarColor;
    const topbarHex = settingsForm.elements.topbarHex;
    const panelColor = settingsForm.elements.panelColor;
    const panelHex = settingsForm.elements.panelHex;
    const inputColor = settingsForm.elements.inputColor;
    const inputHex = settingsForm.elements.inputHex;
    const performanceTabsColor = settingsForm.elements.performanceTabsColor;
    const performanceTabsHex = settingsForm.elements.performanceTabsHex;
    const performanceTabsActiveColor = settingsForm.elements.performanceTabsActiveColor;
    const performanceTabsActiveHex = settingsForm.elements.performanceTabsActiveHex;
    const performanceTabsTextColor = settingsForm.elements.performanceTabsTextColor;
    const performanceTabsTextHex = settingsForm.elements.performanceTabsTextHex;
    const previewBrandingFromForm = () => applyApplianceBranding({
      ...state.overview.appliance,
      brandName: settingsForm.elements.brandName?.value || state.overview.appliance.brandName,
      logoMode: settingsForm.elements.logoMode?.value || state.overview.appliance.logoMode,
      accentColor: color?.value || state.overview.appliance.accentColor,
      sidebarColor: sidebarColor?.value || state.overview.appliance.sidebarColor,
      contentColor: contentColor?.value || state.overview.appliance.contentColor,
      sidebarTextColor: sidebarTextColor?.value || state.overview.appliance.sidebarTextColor,
      contentTextColor: contentTextColor?.value || state.overview.appliance.contentTextColor,
      primaryButtonColor: primaryButtonColor?.value || state.overview.appliance.primaryButtonColor,
      loginButtonColor: loginButtonColor?.value || state.overview.appliance.loginButtonColor,
      topbarColor: topbarColor?.value || state.overview.appliance.topbarColor,
      panelColor: panelColor?.value || state.overview.appliance.panelColor,
      inputColor: inputColor?.value || state.overview.appliance.inputColor,
      performanceTabsColor: performanceTabsColor?.value || state.overview.appliance.performanceTabsColor,
      performanceTabsActiveColor: performanceTabsActiveColor?.value || state.overview.appliance.performanceTabsActiveColor,
      performanceTabsTextColor: performanceTabsTextColor?.value || state.overview.appliance.performanceTabsTextColor
    });
    const bindBrandColor = (picker, textInput) => {
      picker?.addEventListener('input', () => {
        if (textInput) textInput.value = picker.value;
        previewBrandingFromForm();
      });
      textInput?.addEventListener('input', () => {
        if (!/^#[0-9a-f]{6}$/i.test(textInput.value)) return;
        if (picker) picker.value = textInput.value;
        previewBrandingFromForm();
      });
    };
    bindBrandColor(color, hex);
    bindBrandColor(sidebarColor, sidebarHex);
    bindBrandColor(contentColor, contentHex);
    bindBrandColor(sidebarTextColor, sidebarTextHex);
    bindBrandColor(contentTextColor, contentTextHex);
    bindBrandColor(primaryButtonColor, primaryButtonHex);
    bindBrandColor(loginButtonColor, loginButtonHex);
    bindBrandColor(topbarColor, topbarHex);
    bindBrandColor(panelColor, panelHex);
    bindBrandColor(inputColor, inputHex);
    bindBrandColor(performanceTabsColor, performanceTabsHex);
    bindBrandColor(performanceTabsActiveColor, performanceTabsActiveHex);
    bindBrandColor(performanceTabsTextColor, performanceTabsTextHex);
    settingsForm.elements.logoMode?.addEventListener('change', previewBrandingFromForm);
    settingsForm.elements.brandName?.addEventListener('input', previewBrandingFromForm);
    syncBrandingControls();
  }

  document.querySelectorAll('#content [data-backup-job]').forEach(row => row.addEventListener('click', () => {
    state.selectedBackupJobId = row.dataset.backupJob;
    render('backups');
  }));
  $('[data-backup-add]', $('#content'))?.addEventListener('click', async () => {
    const targets = (state.overview?.storage?.configuredPools || []).filter(pool => Array.isArray(pool.content) ? pool.content.includes('backups') : /backup/i.test((pool.contentLabels || []).join(' ')));
    const fallbackTarget = targets[0]?.name || '';
    const storage = prompt('Backup storage target', fallbackTarget);
    if (storage === null) return;
    if (!storage.trim()) return toast('Choose a backup storage target.');
    const schedule = prompt('Schedule (example: daily 04:00, weekly Sun 02:00, or on-demand)', 'daily 04:00');
    if (schedule === null) return;
    const selection = prompt('Data selection', 'All NAS data');
    if (selection === null) return;
    const retention = prompt('Retention', 'Keep last 7');
    if (retention === null) return;
    try {
      const job = await request('/api/backups/jobs', { method:'POST', body:JSON.stringify({ storage, schedule, selection, retention }) });
      state.selectedBackupJobId = job.id;
      await loadBackupJobs();
      toast('Backup job added.');
    } catch (error) { toast(error.message); }
  });
  $('[data-backup-edit]', $('#content'))?.addEventListener('click', async () => {
    const job = (state.backupJobs || []).find(item => item.id === state.selectedBackupJobId);
    if (!job) return;
    const schedule = prompt('Schedule', job.schedule || 'daily 04:00'); if (schedule === null) return;
    const storage = prompt('Backup storage target', job.storage || ''); if (storage === null) return;
    const selection = prompt('Data selection', job.selection || 'All NAS data'); if (selection === null) return;
    const retention = prompt('Retention', job.retention || 'Keep last 7'); if (retention === null) return;
    const comment = prompt('Comment', job.comment || ''); if (comment === null) return;
    try {
      await request(`/api/backups/jobs/${encodeURIComponent(job.id)}`, { method:'PATCH', body:JSON.stringify({ schedule, storage, selection, retention, comment }) });
      await loadBackupJobs();
      toast('Backup job updated.');
    } catch (error) { toast(error.message); }
  });
  $('[data-backup-remove]', $('#content'))?.addEventListener('click', async () => {
    const job = (state.backupJobs || []).find(item => item.id === state.selectedBackupJobId);
    if (!job || !confirm('Remove the selected backup job?')) return;
    try {
      await request(`/api/backups/jobs/${encodeURIComponent(job.id)}`, { method:'DELETE' });
      state.selectedBackupJobId = null;
      await loadBackupJobs();
      toast('Backup job removed.');
    } catch (error) { toast(error.message); }
  });
  $('[data-backup-detail]', $('#content'))?.addEventListener('click', () => {
    const job = (state.backupJobs || []).find(item => item.id === state.selectedBackupJobId);
    if (!job) return;
    alert([`Node: ${job.node || 'LightNAS'}`, `Schedule: ${job.schedule || 'On demand'}`, `Storage: ${job.storage || '—'}`, `Retention: ${job.retention || '—'}`, `Selection: ${job.selection || '—'}`, `Comment: ${job.comment || '—'}`].join('\n'));
  });
  $('[data-backup-run]', $('#content'))?.addEventListener('click', async () => {
    const job = (state.backupJobs || []).find(item => item.id === state.selectedBackupJobId);
    if (!job) return;
    try {
      const result = await request(`/api/backups/jobs/${encodeURIComponent(job.id)}/run`, { method:'POST', body:'{}' });
      toast(result.message || 'Backup run requested.');
      state.logs = null;
      loadLogs();
    } catch (error) { toast(error.message); }
  });
  $('[data-backup-simulator]', $('#content'))?.addEventListener('click', () => {
    const lines = (state.backupJobs || []).map(job => `${job.enabled ? '✓' : '—'} ${job.schedule || 'On demand'} — ${job.selection || 'All NAS data'} → ${job.storage || 'No target'}`);
    alert(lines.length ? lines.join('\n') : 'No backup jobs are configured.');
  });

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
      const result = await request('/api/security/password', { method:'POST', body:JSON.stringify({
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
  let appFilterTimer = null;
  $('#app-search', $('#content'))?.addEventListener('input', event => {
    state.appSearch = event.currentTarget.value;
    state.appVisibleLimit = 72;
    clearTimeout(appFilterTimer);
    appFilterTimer = setTimeout(() => {
      if (state.view !== 'apps') return;
      render('apps');
      const input = $('#app-search', $('#content'));
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }, 120);
  });
  $('#app-category', $('#content'))?.addEventListener('change', event => {
    state.appCategory = event.currentTarget.value;
    state.appVisibleLimit = 72;
    render('apps');
  });
  $('[data-app-more]', $('#content'))?.addEventListener('click', () => {
    state.appVisibleLimit = (Number(state.appVisibleLimit) || 72) + 72;
    render('apps');
  });
  $$('[data-action="new-share"]', $('#content')).forEach(button => button.addEventListener('click', () => $('#share-dialog').showModal()));
  $$('[data-view-link]', $('#content')).forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    const target = button.dataset.viewLink;
    if (!target) return;
    if (state.uiMode === 'hypervisor') {
      const hypervisorTargets = new Set(['hypervisor', 'vms', 'containers', 'storage', 'network', 'firewall', 'backups']);
      if (hypervisorTargets.has(target)) {
        state.view = target;
        location.hash = target;
        render(target);
        return;
      }
    }
    location.hash = target;
  }));
  $$('[data-action="refresh"]', $('#content')).forEach(button => button.addEventListener('click', async () => { try { state.overview = await request('/api/overview'); captureOverviewMetrics(); render(state.view); toast('Readings updated.'); } catch (error) { toast(error.message); } }));
  $('#content').querySelectorAll('[data-action="private-user-files"]').forEach(button => button.addEventListener('click', () => {
    openProtectedUserFiles().catch(error => toast(error.message));
  }));
  $('#content').querySelectorAll('[data-action="refresh-files"]').forEach(button => button.addEventListener('click', async () => {
    if (button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '↻'; button.title = 'Refreshing…'; button.setAttribute('aria-label', 'Refreshing');
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
        liveButton.textContent = '↻'; liveButton.title = 'Refresh'; liveButton.setAttribute('aria-label', 'Refresh');
      }
    }
  }));
  $$('[data-action="refresh-storage"]', $('#content')).forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = '↻'; button.title = 'Refreshing…'; button.setAttribute('aria-label', 'Refreshing');
    try {
      await request('/api/storage/scan');
      state.overview = await request('/api/overview');
      rememberStorageSignature();
      render(state.view);
      toast('Storage rescan complete.');
    } catch (error) { toast(error.message); }
    finally {
      const liveButton = $('#content [data-action="refresh-storage"]');
      if (liveButton) { liveButton.disabled = false; liveButton.textContent = '↻'; liveButton.title = 'Refresh'; liveButton.setAttribute('aria-label', 'Refresh'); }
    }
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
  $('[data-library-select]', $('#content'))?.addEventListener('change', async event => {
    state.filesSettingsOpen = false;
    const folder = event.target.value || '';
    if (folder && folder !== 'Attached storage') {
      try { await request(`/api/files?path=${encodeURIComponent(folder)}`); }
      catch {
        try { await request(`/api/files?path=${encodeURIComponent(folder)}`, { method: 'POST', body: '{}' }); }
        catch (error) { return toast(error.message); }
      }
    }
    state.fileLibraryTab = folder || 'all';
    state.folder = folder;
    state.files = null;
    render('files');
  });
  $('[data-files-settings-tab]', $('#content'))?.addEventListener('click', () => {
    state.filesSettingsOpen = !state.filesSettingsOpen;
    render('files');
  });
  $('[data-files-settings-close]', $('#content'))?.addEventListener('click', () => {
    state.filesSettingsOpen = false;
    render('files');
  });
  document.querySelectorAll('#content [data-folder]').forEach(button => button.addEventListener('click', () => {
    state.folder = button.dataset.folder;
    if (!state.folder && state.fileLibraryTab !== 'folders') state.fileLibraryTab = 'all';
    state.files = null;
    render('files');
  }));
  document.querySelectorAll('#content [data-open]').forEach(button => button.addEventListener('click', async event => {
    const path = button.dataset.path || [state.folder, button.dataset.open].filter(Boolean).join('/');
    if (button.dataset.directory === 'true') {
      state.folder = path;
      if (state.fileLibraryTab !== 'folders') state.fileLibraryTab = path.split('/')[0] || 'all';
      state.files = null;
      render('files');
      return;
    }
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
  content.querySelectorAll('[data-mobile-period]').forEach(button => button.addEventListener('click', () => {
    state.mobileFilesPeriod = button.dataset.mobilePeriod || 'all';
    localStorage.setItem('lightnas-mobile-files-period', state.mobileFilesPeriod);
    render('files');
  }));
  $('#mobile-gallery-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    toast(`Preparing ${files.length} item${files.length === 1 ? '' : 's'} for upload…`);
    await uploadFilesWithProgress(files, false);
  });
  $('[data-file-view-select]', content)?.addEventListener('change', event => {
    state.fileView = event.target.value;
    localStorage.setItem('lightnas-file-view', state.fileView);
    render('files');
  });
  $('[data-file-upload-select]', content)?.addEventListener('change', event => {
    const action = event.target.value;
    event.target.value = '';
    const mobile = matchMedia('(max-width: 760px)').matches;
    if (action === 'files') {
      (mobile ? $('#mobile-native-upload', content) : $('#file-upload', content))?.click();
    }
    if (action === 'folder') $('#folder-upload', content)?.click();
  });
  $('#file-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    await uploadFilesWithProgress(files, false);
  });
  $('#mobile-native-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    await uploadFilesWithProgress(files, false);
  });
  $('#mobile-folder-upload', content)?.addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    await uploadFilesWithProgress(files, true);
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
$('#logout').addEventListener('click', async () => {
  const key = mobileFilesCacheKey();
  if (key) sessionStorage.removeItem(key);
  await request('/api/logout', { method: 'POST' });
  state.files = null;
  setLoginMethods([]);
  showAuth('login');
});
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
function ensureProfileDialog() {
  let dialog = document.querySelector('#profile-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'profile-dialog';
  dialog.className = 'lightnas-dialog runtime-dialog profile-dialog';
  dialog.innerHTML = `
    <form class="profile-form" method="dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">ACCOUNT</span><h2>Edit profile</h2><p class="muted">Update your account details and profile picture.</p></div>
        <button class="icon-button" type="button" data-profile-close aria-label="Close">×</button>
      </div>
      <div class="profile-layout">
        <section class="profile-picture-editor">
          <div class="profile-section-head"><span class="eyebrow">PROFILE PHOTO</span><h3>Your picture</h3><p class="muted">Drag to reposition. Zoom only when you want a tighter crop.</p></div>
          <div class="profile-crop-stage" data-profile-crop-stage>
            <img data-profile-preview alt="Profile picture preview">
            <div class="profile-crop-ring" aria-hidden="true"></div>
            <div class="profile-placeholder" data-profile-placeholder>Choose a picture</div>
          </div>
          <input data-profile-file type="file" accept="image/jpeg,image/png,image/webp" hidden>
          <div class="profile-picture-actions">
            <button class="secondary" type="button" data-profile-choose>Choose picture</button>
            <button class="secondary" type="button" data-profile-reset-photo>Reset position</button>
            <button class="secondary danger-button" type="button" data-profile-remove-photo>Remove picture</button>
          </div>
          <label>Zoom<input data-profile-zoom type="range" min="1" max="3" step="0.01" value="1"></label>
          <div class="form-grid profile-position-controls">
            <label>Horizontal<input data-profile-x type="range" min="-100" max="100" step="1" value="0"></label>
            <label>Vertical<input data-profile-y type="range" min="-100" max="100" step="1" value="0"></label>
          </div>
          <p class="muted">Drag the image inside the circle or use the sliders to position it.</p>
        </section>
        <section class="profile-account-fields">
          <div class="profile-section-head"><span class="eyebrow">ACCOUNT DETAILS</span><h3>Profile information</h3><p class="muted">These details are visible only inside this LightNAS appliance.</p></div>
          <label>Username<input name="username" readonly></label>
          <label>Display name<input name="displayName" maxlength="80" placeholder="Your name"></label>
          <label>Email address<input name="email" type="email" maxlength="160" placeholder="you@example.com"></label>
          <div class="manager-summary">
            <div><span>Account type</span><b data-profile-role>Local user</b></div>
            <div><span>Created</span><b data-profile-created>Unknown</b></div>
          </div>
          <p class="module-note">Changing your profile does not change your login username or permissions.</p>
        </section>
      </div>
      <div class="form-error" data-profile-error role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary" type="button" data-profile-close>Cancel</button>
        <button class="primary" type="submit">Save profile</button>
      </div>
    </form>`;
  document.body.append(dialog);
  return dialog;
}

async function refreshHeaderAvatar() {
  state.overview = await request('/api/overview');
  const appliance = state.overview.appliance;
  const avatar = $('#avatar');
  avatar.textContent = appliance.avatar ? '' : appliance.username[0].toUpperCase();
  avatar.style.backgroundImage = appliance.avatar ? `url("/api/profile/avatar?v=${Date.now()}")` : '';
  avatar.classList.toggle('has-photo', Boolean(appliance.avatar));
}

async function openProfileDialog() {
  const dialog = ensureProfileDialog();
  const form = dialog.querySelector('.profile-form');
  const error = dialog.querySelector('[data-profile-error]');
  const preview = dialog.querySelector('[data-profile-preview]');
  const placeholder = dialog.querySelector('[data-profile-placeholder]');
  const fileInput = dialog.querySelector('[data-profile-file]');
  const zoom = dialog.querySelector('[data-profile-zoom]');
  const x = dialog.querySelector('[data-profile-x]');
  const y = dialog.querySelector('[data-profile-y]');
  error.textContent = '';

  const profile = await request('/api/profile');
  form.elements.username.value = profile.username || '';
  form.elements.displayName.value = profile.displayName || '';
  form.elements.email.value = profile.email || '';
  dialog.querySelector('[data-profile-role]').textContent = profile.isAdmin ? 'Appliance owner' : 'Local user';
  dialog.querySelector('[data-profile-created]').textContent = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'Unknown';

  let image = null;
  let selectedFile = null;
  let removePhoto = false;
  let photoDirty = false;
  let drag = null;

  function renderCrop() {
    const scale = Number(zoom.value || 1);
    const px = Number(x.value || 0);
    const py = Number(y.value || 0);
    preview.style.transform = `translate(${px}px,${py}px) scale(${scale})`;
  }
  function setImageSource(src) {
    return new Promise((resolve, reject) => {
      image = new Image();
      image.onload = () => {
        preview.src = src;
        preview.hidden = false;
        placeholder.hidden = true;
        zoom.value = '1';
        x.value = '0';
        y.value = '0';
        renderCrop();
        resolve();
      };
      image.onerror = reject;
      image.src = src;
    });
  }

  preview.hidden = true;
  placeholder.hidden = false;
  zoom.value = '1'; x.value = '0'; y.value = '0';
  if (profile.avatar) {
    try { await setImageSource(`/api/profile/avatar?v=${Date.now()}`); } catch {}
  }

  dialog.querySelector('[data-profile-choose]').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Profile picture must be 8 MiB or smaller.'); return; }
    selectedFile = file;
    removePhoto = false;
    photoDirty = true;
    await setImageSource(URL.createObjectURL(file));
  };
  dialog.querySelector('[data-profile-reset-photo]').onclick = () => {
    zoom.value = '1'; x.value = '0'; y.value = '0'; photoDirty = true; renderCrop();
  };
  dialog.querySelector('[data-profile-remove-photo]').onclick = () => {
    selectedFile = null;
    image = null;
    removePhoto = true;
    preview.removeAttribute('src');
    preview.hidden = true;
    placeholder.hidden = false;
  };
  zoom.oninput = () => { photoDirty = true; renderCrop(); };
  x.oninput = () => { photoDirty = true; renderCrop(); };
  y.oninput = () => { photoDirty = true; renderCrop(); };

  const stage = dialog.querySelector('[data-profile-crop-stage]');
  stage.onpointerdown = event => {
    if (!image) return;
    drag = { x:event.clientX, y:event.clientY, ox:Number(x.value), oy:Number(y.value) };
    stage.setPointerCapture(event.pointerId);
  };
  stage.onpointermove = event => {
    if (!drag) return;
    x.value = String(Math.max(-100, Math.min(100, drag.ox + event.clientX - drag.x)));
    y.value = String(Math.max(-100, Math.min(100, drag.oy + event.clientY - drag.y)));
    photoDirty = true;
    renderCrop();
  };
  stage.onpointerup = stage.onpointercancel = () => { drag = null; };

  dialog.querySelectorAll('[data-profile-close]').forEach(button => button.onclick = () => dialog.close());
  form.onsubmit = async event => {
    event.preventDefault();
    error.textContent = '';
    try {
      await request('/api/profile', {
        method:'PUT',
        body:JSON.stringify({
          displayName:form.elements.displayName.value,
          email:form.elements.email.value
        })
      });

      if (removePhoto) {
        const response = await fetch('/api/profile/avatar', { method:'DELETE', headers:{ 'X-LightNAS-Request':'1' } });
        if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || 'Unable to remove profile picture.');
      } else if (image && photoDirty) {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d');
        const scale = Number(zoom.value || 1);
        const fit = Math.min(512 / image.naturalWidth, 512 / image.naturalHeight) * scale;
        const drawW = image.naturalWidth * fit;
        const drawH = image.naturalHeight * fit;
        const offsetX = Number(x.value || 0) * 2.56;
        const offsetY = Number(y.value || 0) * 2.56;
        ctx.drawImage(image, (512 - drawW) / 2 + offsetX, (512 - drawH) / 2 + offsetY, drawW, drawH);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
        if (!blob) throw new Error('Unable to prepare the cropped profile picture.');
        const response = await fetch('/api/profile/avatar', {
          method:'PUT',
          headers:{ 'Content-Type':'image/webp', 'X-LightNAS-Request':'1' },
          body:blob
        });
        if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || 'Unable to upload profile picture.');
      }
      await refreshHeaderAvatar();
      dialog.close();
      toast('Profile updated.');
    } catch (problem) { error.textContent = problem.message; }
  };

  if (!dialog.open) dialog.showModal();
}

$('#avatar').addEventListener('click', () => {
  openProfileDialog().catch(error => toast(error.message));
});
$('#mobile-more').addEventListener('click', () => setMobileSidebar(true));
$('[data-files-nav-toggle]')?.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  state.filesNavExpanded = !state.filesNavExpanded;
  localStorage.setItem('lightnas-files-nav-expanded', state.filesNavExpanded ? '1' : '0');
  const subtabs = $('[data-files-nav-subtabs]', $('#nav'));
  const button = event.currentTarget;
  if (subtabs) subtabs.hidden = !state.filesNavExpanded;
  button.setAttribute('aria-expanded', state.filesNavExpanded ? 'true' : 'false');
  button.setAttribute('aria-label', state.filesNavExpanded ? 'Collapse Files & media' : 'Expand Files & media');
  button.title = state.filesNavExpanded ? 'Collapse Files & media' : 'Expand Files & media';
  button.textContent = state.filesNavExpanded ? '⌄' : '›';
});
$$('[data-view]').forEach(link => link.addEventListener('click', event => {
  if (link.dataset.view === 'files' && link.dataset.fileLibrary) {
    const target = link.dataset.fileLibrary;
    state.filesSettingsOpen = false;
    state.fileLibraryTab = target;
    state.folder = target === 'all' || target === 'folders' ? '' : target;
    if (!restoreFilesSection()) state.files = null;
    if (location.hash === '#files') {
      event.preventDefault();
      render('files');
      loadFiles(false).catch(() => null);
    }
  }
  setMobileSidebar(false);
}));
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
    const [statusResult, brandingResult] = await Promise.allSettled([
      request('/api/status'),
      request('/api/branding')
    ]);
    if (brandingResult.status === 'fulfilled') applyApplianceBranding(brandingResult.value);
    if (statusResult.status !== 'fulfilled') throw statusResult.reason;
    const status = statusResult.value;
    if (status.setupRequired) return showAuth('setup');
    try { await showConsole(); } catch (error) { if (error.status === 401) showAuth('login'); else throw error; }
  } catch (error) {
    $('#boot').innerHTML = `<p>Unable to start the control center.</p><small>${escapeHtml(error.message)}</small>`;
  }
}

boot();