import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, rmdir, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { JsonStore } from './store.mjs';
import { getFilesystems, getStorageInventory, getSystemSnapshot } from './system.mjs';
import { hashPassword, Sessions, verifyPassword } from './auth.mjs';
import { listFiles, listAllFiles, createFolder, uploadFile, downloadFile, downloadEntry, deleteEntry } from './files.mjs';
import { thumbnailFor } from './thumbnails.mjs';
import { catalog, runtimeInventory, installCatalogApp, manageCatalogApp, createContainer, createVm } from './runtimes-next.mjs';
import { proxmoxConsoleSocket, proxmoxUpdateStorage, proxmoxCleanDisk } from './proxmox.mjs';
import { localContainerSummary, localContainerInventory, localManageContainer, localContainerConsoleSocket, localContainerCommand, localVmConsoleSocket, localNodeConsoleSocket, localNetworkInventory, localNetworkAction, localApplianceHealth, localApplianceRepair } from './local-host.mjs';
import { validateSmtp, sendSmtpTest } from './mailer.mjs';
import { mediaAvailable, convertMedia } from './media.mjs';
import { createDataset, updateDataset } from './zfs.mjs';
import { networkInventory, networkAction } from './network.mjs';
import {
  listContainerTemplates, proxmoxTemplateCatalog, uploadContainerTemplate,
  importContainerTemplate, deleteContainerTemplate, proxmoxTemplateSource
} from './templates.mjs';
import {
  listStoragePools, createStoragePool, updateStoragePool, deleteStoragePool,
  listStorageContent, uploadStorageContent, importStorageContent, deleteStorageContent
} from './storage-pools.mjs';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.mjs';
import {
  normalizePermissions, effectivePermissions, groupsForUser,
  createApiTokenRecord, authenticateApiToken,
  createWebhookRecord, deliverWebhook, deliverEvent
} from './access.mjs';
import {
  normalizeIdentityProvider, publicIdentityProvider, testIdentityProvider
} from './identity-providers.mjs';
import { ContainerPublisher } from './container-publish.mjs';
import { discoverContainerApplication } from './container-app-access.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = join(root, 'public');
const novncRoot = process.env.LIGHTNAS_NOVNC_ROOT || '/usr/share/novnc';
const xtermRoot = join(root, 'node_modules', '@xterm', 'xterm');
const xtermFitRoot = join(root, 'node_modules', '@xterm', 'addon-fit');
const store = new JsonStore();
const sessions = new Sessions();
await store.load();
const containerPublisher = new ContainerPublisher(store);
await containerPublisher.restore();
queueMicrotask(warmOverviewStorage);
store.state.users ||= [];
store.state.groups ||= [];
store.state.spaces ||= [];
store.state.security ||= { apiTokens: [], webhooks: [], identityProviders: [] };
store.state.security.apiTokens ||= [];
store.state.security.webhooks ||= [];
store.state.security.identityProviders ||= [];
const spaceRoot = join(dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json')), 'files', 'Spaces');
const profileRoot = join(dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json')), 'profiles');
const spaceName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}$/;
const groupName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

let overviewStorageCache = null;
let overviewStorageCacheAt = 0;
let overviewStorageRefresh = null;
const OVERVIEW_STORAGE_TTL_MS = 15000;

function quickStorageSummary(filesystems = []) {
  const candidates = filesystems
    .filter(item => Number(item.totalBytes) > 0)
    .filter(item => !['/boot', '/boot/efi'].includes(item.mountPoint))
    .sort((a, b) => Number(b.totalBytes || 0) - Number(a.totalBytes || 0));
  const preferred = candidates.find(item => /^\/(?:mnt|media|srv|data|storage)(?:\/|$)/.test(item.mountPoint))
    || candidates.find(item => item.mountPoint === '/')
    || candidates[0]
    || null;
  const usableStorage = preferred ? {
    totalBytes: Number(preferred.totalBytes) || 0,
    availableBytes: Number(preferred.availableBytes) || 0,
    usedBytes: Number(preferred.usedBytes) || 0,
    usedPercent: Number(preferred.usedPercent) || 0,
    count: preferred ? 1 : 0,
    provisional: true
  } : { totalBytes: 0, availableBytes: 0, usedBytes: 0, usedPercent: 0, count: 0, provisional: true };
  return {
    disks: [],
    attachedVolumes: [],
    zfs: { available: false, canManageDatasets: false, pools: [], datasets: [] },
    virtualStorage: usableStorage,
    usableStorage,
    poolSummary: null,
    provisional: true
  };
}

async function refreshOverviewStorage(force = false) {
  const now = Date.now();
  if (!force && overviewStorageCache && now - overviewStorageCacheAt < OVERVIEW_STORAGE_TTL_MS) return overviewStorageCache;
  if (overviewStorageRefresh) return overviewStorageRefresh;
  overviewStorageRefresh = (async () => {
    try {
      const [storage, storagePools] = await Promise.all([getStorageInventory(), listStoragePools()]);
      storage.usableStorage = storagePools.visibleSummary || storage.usableStorage;
      storage.poolSummary = storagePools.summary;
      storage.provisional = false;
      overviewStorageCache = storage;
      overviewStorageCacheAt = Date.now();
      return storage;
    } finally {
      overviewStorageRefresh = null;
    }
  })();
  return overviewStorageRefresh;
}

function warmOverviewStorage() {
  refreshOverviewStorage().catch(() => null);
}


async function containerReadyForPublication(id) {
  let started = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const inventory = await localContainerInventory();
    const item = (inventory.containers || []).find(entry => String(entry.id || entry.name) === id);
    if (!item) throw Object.assign(new Error('Container was not found.'), { status: 404 });
    const running = String(item.status || '').toLowerCase() === 'running';
    const targetHost = item.ipv4 || (item.addresses || []).find(address => !String(address).includes(':'));
    if (running && targetHost) return { item, targetHost, started };
    if (!running && !started) {
      await localManageContainer(id, 'start');
      started = true;
    }
    await pause(1000);
  }
  throw Object.assign(new Error('The container started but did not receive an IPv4 address. Check its Network settings and try again.'), { status: 409 });
}

function containerUsesPrivateNat(item) {
  const network = String(item?.network || '');
  const ipv4 = String(item?.ipv4 || (item?.addresses || []).find(address => !String(address).includes(':')) || '');
  return /^(?:lightnas0|lxcbr0)$/i.test(network)
    || /^10\.77\.0\.(?:\d{1,3})$/.test(ipv4);
}

async function configureProxyFallback(detected, item, requestedHostPort = 0) {
  const existing = containerPublisher.forContainer(detected.id);
  const preferred = Number(requestedHostPort)
    || (existing?.mode === 'proxy' ? Number(existing.hostPort) : 0)
    || (detected.targetPort >= 1024 && detected.targetPort !== 3080 ? detected.targetPort : (detected.scheme === 'https' ? 8443 : 8080));
  const candidates = [preferred, ...Array.from({ length: 12 }, (_, index) => preferred + index + 1)]
    .filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3080);

  let lastError;
  for (const hostPort of [...new Set(candidates)]) {
    try {
      const publication = await containerPublisher.configure({ ...detected, mode: 'proxy', hostPort });
      try {
        await localNetworkAction({ action: 'firewall-add', decision: 'allow', protocol: 'tcp', port: publication.hostPort, source: '' });
      } catch (error) {
        await containerPublisher.remove(publication.id);
        throw error;
      }
      return publication;
    } catch (error) {
      lastError = error;
      if (!/already (?:published|in use)/i.test(error.message || '')) throw error;
    }
  }
  throw lastError || Object.assign(new Error('No available LightNAS port could be assigned to this application.'), { status: 409 });
}

async function automaticContainerApplication(id, { preferredPort = 0, requestedHostPort = 0, attempts = 1 } = {}) {
  const ready = await containerReadyForPublication(id);
  let detected = null;
  const totalAttempts = Math.max(1, Math.min(20, Number(attempts) || 1));
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    detected = await discoverContainerApplication({
      id,
      targetHost: ready.targetHost,
      preferredPort,
      runCommand: localContainerCommand
    }).catch(() => null);
    if (detected) break;
    if (attempt + 1 < totalAttempts) await pause(1000);
  }
  if (!detected) return { ...ready, publication: null };

  const previous = containerPublisher.forContainer(id);
  let publication;
  if (containerUsesPrivateNat(ready.item)) {
    publication = await configureProxyFallback(detected, ready.item, requestedHostPort);
  } else {
    publication = await containerPublisher.configure(detected);
    if (previous?.mode === 'proxy' && previous.hostPort) {
      await localNetworkAction({ action: 'firewall-remove-port', protocol: 'tcp', port: previous.hostPort }).catch(() => null);
    }
  }
  return { ...ready, publication };
}

export const PERMISSIONS = Object.freeze([
  'overview.view',
  'files.read', 'files.write', 'files.download', 'files.delete', 'media.convert',
  'storage.view', 'storage.manage', 'pools.view', 'shares.view', 'shares.manage',
  'apps.view', 'apps.manage', 'containers.view', 'containers.manage', 'vms.view', 'vms.manage',
  'network.view', 'network.manage', 'firewall.view', 'firewall.manage', 'integrations.view', 'integrations.manage',
  'containers.console', 'vms.console', 'backup.manage', 'audit.view',
  'monitoring.view', 'capabilities.view', 'system.view', 'system.shell',
  'users.manage', 'smtp.manage', 'settings.manage', 'admin.view'
]);
const DEFAULT_USER_PERMISSIONS = Object.freeze(['files.read', 'files.write', 'files.download', 'files.delete']);

store.setActivityListener(async event => {
  await deliverEvent(store.state, event);
  await store.save();
});

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.m2v': 'video/mpeg',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.ts': 'video/mp2t', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.vob': 'video/mpeg',
  '.raw': 'image/x-raw', '.dng': 'image/x-adobe-dng', '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef', '.nrw': 'image/x-nikon-nrw', '.arw': 'image/x-sony-arw', '.raf': 'image/x-fuji-raf',
  '.orf': 'image/x-olympus-orf', '.rw2': 'image/x-panasonic-rw2', '.pef': 'image/x-pentax-pef', '.srw': 'image/x-samsung-srw',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8', '.ini': 'text/plain; charset=utf-8', '.conf': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; font-src 'self' data:";

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': csp, ...headers
  });
  res.end(payload);
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid JSON object.');
    return input;
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

async function bodyBuffer(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Uploaded profile image is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function avatarPath(username, extension) {
  return join(profileRoot, `${username}.${extension}`);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
    const [key, ...value] = item.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function localContext(req) {
  const session = sessions.get(cookies(req).nas_session);
  if (!session || !store.state.config) return null;
  const account = session.username === store.state.config.username ? store.state.config : store.state.users.find(user => user.username === session.username);
  if (!account || account.disabled) return null;
  const isAdmin = session.username === store.state.config.username;
  return {
    session,
    username: session.username,
    account,
    isAdmin,
    apiToken: null,
    permissions: effectivePermissions({ state: store.state, username: session.username, account, isAdmin, allowed: PERMISSIONS, defaults: DEFAULT_USER_PERMISSIONS })
  };
}

function requestContext(req) {
  const local = localContext(req);
  if (local) return local;
  const token = authenticateApiToken(store.state, req.headers.authorization, PERMISSIONS);
  if (!token) return null;
  queueMicrotask(() => store.save().catch(() => {}));
  return { session: null, ...token };
}

function requireSession(req, res) {
  const context = requestContext(req);
  if (!context) {
    send(res, 401, { error: 'Authentication required.' });
    return null;
  }
  return context;
}

function hasPermission(permissionSet, permission) {
  return permissionSet.includes(permission);
}

function requirePermission(res, permissionSet, permission) {
  if (hasPermission(permissionSet, permission)) return true;
  send(res, 403, { error: `Permission required: ${permission}.` });
  return false;
}

function requireAnyPermission(res, permissionSet, choices) {
  if (choices.some(permission => hasPermission(permissionSet, permission))) return true;
  send(res, 403, { error: `Permission required: ${choices.join(' or ')}.` });
  return false;
}

function requireOwner(res, context) {
  if (context.isAdmin && !context.apiToken) return true;
  send(res, 403, { error: 'Appliance owner access required.' });
  return false;
}

function validateSetup(input) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,31}$/.test(input.deviceName || '')) return 'Device name must contain 2–32 letters, numbers, or hyphens.';
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(input.username || '')) return 'Administrator username must contain 3–32 valid characters.';
  if (typeof input.password !== 'string' || input.password.length < 10) return 'Password must contain at least 10 characters.';
  return null;
}

function validMembers(value) {
  if (!Array.isArray(value)) return [];
  const known = new Set(store.state.users.map(user => user.username));
  return [...new Set(value.filter(username => known.has(username)))];
}

function groupPublic(group) {
  return {
    id: group.id,
    name: group.name,
    description: group.description || '',
    permissions: normalizePermissions(group.permissions, PERMISSIONS, []),
    members: validMembers(group.members),
    createdAt: group.createdAt
  };
}

function userPublic(user) {
  const groups = groupsForUser(store.state, user.username);
  return {
    username: user.username,
    createdAt: user.createdAt,
    disabled: Boolean(user.disabled),
    totpEnabled: Boolean(user.totpEnabled),
    permissions: normalizePermissions(user.permissions, PERMISSIONS, []),
    effectivePermissions: effectivePermissions({ state: store.state, username: user.username, account: user, isAdmin: false, allowed: PERMISSIONS, defaults: DEFAULT_USER_PERMISSIONS }),
    groups: groups.map(group => ({ id: group.id, name: group.name }))
  };
}

function applyUserGroups(username, groupIds) {
  if (!Array.isArray(groupIds)) return;
  const selected = new Set(groupIds.filter(id => store.state.groups.some(group => group.id === id)));
  for (const group of store.state.groups) {
    group.members ||= [];
    const has = group.members.includes(username);
    const should = selected.has(group.id);
    if (should && !has) group.members.push(username);
    if (!should && has) group.members = group.members.filter(member => member !== username);
  }
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { version: '0.12.0', setupRequired: !store.state.config });

  if (req.method === 'POST' && url.pathname === '/api/setup') {
    if (store.state.config) return send(res, 409, { error: 'This appliance is already configured.' });
    const input = await bodyJson(req);
    const problem = validateSetup(input);
    if (problem) return send(res, 400, { error: problem });
    store.state.config = {
      deviceName: input.deviceName,
      username: input.username,
      passwordHash: await hashPassword(input.password),
      timezone: input.timezone || 'UTC',
      createdAt: new Date().toISOString(),
      totpEnabled: false
    };
    store.addActivity('setup', `Appliance ${input.deviceName} was configured.`, 'success');
    await store.save();
    let readiness = null;
    try { readiness = await localApplianceRepair(); }
    catch (error) {
      store.addActivity('health', `Initial appliance self-configuration needs attention: ${error.message}`, 'warning');
      await store.save();
    }
    const token = sessions.create(input.username);
    return send(res, 201, { ok: true, readiness }, { 'Set-Cookie': `nas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'GET' && url.pathname === '/api/login/options') {
    if (!store.state.config) return send(res, 200, { configured: false, methods: [] });
    const username = String(url.searchParams.get('username') || '').trim();
    const account = username === store.state.config.username ? store.state.config : store.state.users.find(user => user.username === username);
    if (!account || account.disabled) return send(res, 200, { configured: true, methods: [] });
    const methods = [];
    if (account.totpEnabled) methods.push('totp');
    if (account.smsMfa?.enabled) methods.push('sms');
    if (Array.isArray(account.passkeys) && account.passkeys.length) methods.push('passkey');
    return send(res, 200, { configured: true, methods });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!store.state.config) return send(res, 409, { error: 'Complete setup first.' });
    const input = await bodyJson(req);
    const account = input.username === store.state.config.username ? store.state.config : store.state.users.find(user => user.username === input.username);
    const validPassword = account && !account.disabled && await verifyPassword(input.password, account.passwordHash);
    if (!validPassword) return send(res, 401, { error: 'Username or password is incorrect.' });
    if (account.totpEnabled && (!account.totpSecret || !verifyTotp(account.totpSecret, input.totp))) {
      return send(res, 401, { error: 'Authenticator code is required or invalid.', totpRequired: true });
    }
    const token = sessions.create(input.username);
    store.addActivity('login', `${input.username} signed in.`, 'info');
    await store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `nas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(cookies(req).nas_session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'nas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const context = requireSession(req, res);
  if (!context) return;
  const { username, account, isAdmin, permissions } = context;

  if (req.method === 'GET' && url.pathname === '/api/profile/avatar') {
    if (context.apiToken || !account.avatarExt) return send(res, 404, { error: 'No profile picture is configured.' });
    const path = avatarPath(username, account.avatarExt);
    const type = account.avatarExt === 'png' ? 'image/png' : account.avatarExt === 'webp' ? 'image/webp' : 'image/jpeg';
    try {
      const data = await readFile(path);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp });
      return res.end(data);
    } catch (error) {
      if (error.code === 'ENOENT') return send(res, 404, { error: 'Profile picture is unavailable.' });
      throw error;
    }
  }
  if (req.method === 'PUT' && url.pathname === '/api/profile/avatar') {
    if (context.apiToken) return send(res, 403, { error: 'Profile pictures require an interactive user session.' });
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extension = ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' })[type];
    if (!extension) return send(res, 415, { error: 'Use a JPEG, PNG, or WebP profile picture.' });
    const data = await bodyBuffer(req, 8 * 1024 * 1024);
    if (!data.length) return send(res, 400, { error: 'Choose a profile picture.' });
    await mkdir(profileRoot, { recursive: true, mode: 0o700 });
    for (const old of ['jpg', 'png', 'webp']) {
      if (old !== extension) await rm(avatarPath(username, old), { force: true }).catch(() => {});
    }
    await writeFile(avatarPath(username, extension), data, { mode: 0o600 });
    account.avatarExt = extension;
    await store.save();
    return send(res, 200, { ok: true, avatar: true });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/profile/avatar') {
    if (context.apiToken) return send(res, 403, { error: 'Profile pictures require an interactive user session.' });
    for (const old of ['jpg', 'png', 'webp']) await rm(avatarPath(username, old), { force: true }).catch(() => {});
    delete account.avatarExt;
    await store.save();
    return send(res, 200, { ok: true, avatar: false });
  }

  if (req.method === 'GET' && url.pathname === '/api/security/totp') {
    if (context.apiToken) return send(res, 403, { error: 'TOTP settings require an interactive local account session.' });
    return send(res, 200, { enabled: Boolean(account.totpEnabled), pending: Boolean(account.totpPendingSecret) });
  }
  if (req.method === 'POST' && url.pathname === '/api/security/totp/setup') {
    if (context.apiToken) return send(res, 403, { error: 'TOTP settings require an interactive local account session.' });
    const input = await bodyJson(req);
    if (!(await verifyPassword(input.currentPassword, account.passwordHash))) return send(res, 403, { error: 'Current account password is incorrect.' });
    const secret = generateTotpSecret();
    account.totpPendingSecret = secret;
    await store.save();
    return send(res, 200, { secret, uri: totpUri({ secret, username, issuer: `LightNAS ${store.state.config.deviceName}` }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/security/totp/verify') {
    if (context.apiToken) return send(res, 403, { error: 'TOTP settings require an interactive local account session.' });
    const input = await bodyJson(req);
    if (!account.totpPendingSecret || !verifyTotp(account.totpPendingSecret, input.code)) return send(res, 400, { error: 'Authenticator code did not verify.' });
    account.totpSecret = account.totpPendingSecret;
    delete account.totpPendingSecret;
    account.totpEnabled = true;
    store.addActivity('security', `TOTP authenticator enabled for ${username}.`, 'success');
    await store.save();
    return send(res, 200, { enabled: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/security/totp/disable') {
    if (context.apiToken) return send(res, 403, { error: 'TOTP settings require an interactive local account session.' });
    const input = await bodyJson(req);
    if (!(await verifyPassword(input.currentPassword, account.passwordHash))) return send(res, 403, { error: 'Current account password is incorrect.' });
    if (account.totpEnabled && (!account.totpSecret || !verifyTotp(account.totpSecret, input.code))) return send(res, 403, { error: 'Current authenticator code is required.' });
    delete account.totpSecret;
    delete account.totpPendingSecret;
    account.totpEnabled = false;
    store.addActivity('security', `TOTP authenticator disabled for ${username}.`, 'warning');
    await store.save();
    return send(res, 200, { enabled: false });
  }

  const ownerOnly = url.pathname === '/api/settings' ||
    url.pathname === '/api/smtp' || url.pathname === '/api/smtp/test' ||
    url.pathname.startsWith('/api/security/api-tokens') || url.pathname.startsWith('/api/security/webhooks') ||
    url.pathname.startsWith('/api/security/identity-providers');
  if (ownerOnly && !requireOwner(res, context)) return;

  if (req.method === 'GET' && url.pathname === '/api/smtp') {
    const { password, ...publicConfig } = store.state.smtp || {};
    return send(res, 200, { config: store.state.smtp ? { ...publicConfig, hasPassword: Boolean(password) } : null });
  }
  if (req.method === 'PUT' && url.pathname === '/api/smtp') {
    const input = await bodyJson(req);
    if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, store.state.config.passwordHash))) return send(res, 403, { error: 'Current administrator password is incorrect.' });
    const problem = validateSmtp(input);
    if (problem) return send(res, 400, { error: problem });
    store.state.smtp = { host: input.host, port: Number(input.port), security: input.security, from: input.from, username: input.username, password: input.password || store.state.smtp?.password || '' };
    store.addActivity('smtp', 'SMTP relay settings were updated.');
    await store.save();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/smtp/test') {
    if (!store.state.smtp) return send(res, 409, { error: 'Configure SMTP first.' });
    const { recipient } = await bodyJson(req);
    await sendSmtpTest(store.state.smtp, recipient);
    store.addActivity('smtp', 'SMTP test message sent.');
    await store.save();
    return send(res, 200, { ok: true });
  }

  if ((url.pathname === '/api/users' || url.pathname.startsWith('/api/users/') || url.pathname === '/api/groups' || url.pathname.startsWith('/api/groups/')) &&
      !requirePermission(res, permissions, 'users.manage')) return;

  if (req.method === 'GET' && url.pathname === '/api/users') {
    return send(res, 200, { permissionOptions: PERMISSIONS, users: store.state.users.map(userPublic), groups: store.state.groups.map(groupPublic) });
  }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    const input = await bodyJson(req);
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(input.username || '') || typeof input.password !== 'string' || input.password.length < 10) return send(res, 400, { error: 'Use a 3–32 character username and a password of at least 10 characters.' });
    if (input.username === store.state.config.username || store.state.users.some(user => user.username === input.username)) return send(res, 409, { error: 'Username already exists.' });
    const user = { username: input.username, passwordHash: await hashPassword(input.password), permissions: normalizePermissions(input.permissions, PERMISSIONS, []), createdAt: new Date().toISOString(), totpEnabled: false };
    store.state.users.push(user);
    applyUserGroups(input.username, input.groups);
    store.addActivity('user', `User ${input.username} was created.`);
    await store.save();
    return send(res, 201, userPublic(user));
  }
  if (req.method === 'DELETE' && /^\/api\/users\/[a-zA-Z0-9._-]{3,32}$/.test(url.pathname)) {
    const userName = url.pathname.split('/').pop();
    const index = store.state.users.findIndex(user => user.username === userName);
    if (index < 0) return send(res, 404, { error: 'User not found.' });
    store.state.users.splice(index, 1);
    for (const group of store.state.groups) group.members = (group.members || []).filter(member => member !== userName);
    sessions.clearUser(userName);
    store.addActivity('user', `User ${userName} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'PATCH' && /^\/api\/users\/[a-zA-Z0-9._-]{3,32}$/.test(url.pathname)) {
    const userName = url.pathname.split('/').pop();
    const user = store.state.users.find(item => item.username === userName);
    if (!user) return send(res, 404, { error: 'User not found.' });
    const input = await bodyJson(req);
    if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, store.state.config.passwordHash))) return send(res, 403, { error: 'Current administrator password is incorrect.' });
    let changed = false;
    if (typeof input.disabled === 'boolean') { user.disabled = input.disabled; changed = true; }
    if (typeof input.password === 'string' && input.password) {
      if (input.password.length < 10 || input.password.length > 1024) return send(res, 400, { error: 'New password must contain at least 10 characters.' });
      user.passwordHash = await hashPassword(input.password); changed = true;
    }
    if (Array.isArray(input.permissions)) { user.permissions = normalizePermissions(input.permissions, PERMISSIONS, []); changed = true; }
    if (Array.isArray(input.groups)) { applyUserGroups(userName, input.groups); changed = true; }
    if (!changed) return send(res, 400, { error: 'Choose a password, enable/disable state, groups, or permissions to update.' });
    sessions.clearUser(userName);
    store.addActivity('user', `User ${userName} was updated.`);
    await store.save();
    return send(res, 200, userPublic(user));
  }

  if (req.method === 'GET' && url.pathname === '/api/groups') return send(res, 200, { permissionOptions: PERMISSIONS, groups: store.state.groups.map(groupPublic) });
  if (req.method === 'POST' && url.pathname === '/api/groups') {
    const input = await bodyJson(req);
    const name = String(input.name || '').trim();
    if (!groupName.test(name)) return send(res, 400, { error: 'Group name must contain 2–64 valid characters.' });
    if (store.state.groups.some(group => group.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'A group with this name already exists.' });
    const group = {
      id: crypto.randomUUID(), name, description: String(input.description || '').trim().slice(0, 160),
      permissions: normalizePermissions(input.permissions, PERMISSIONS, []), members: validMembers(input.members), createdAt: new Date().toISOString()
    };
    store.state.groups.push(group);
    for (const member of group.members) sessions.clearUser(member);
    store.addActivity('group', `Group ${group.name} was created.`);
    await store.save();
    return send(res, 201, groupPublic(group));
  }
  if (req.method === 'PATCH' && /^\/api\/groups\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const group = store.state.groups.find(item => item.id === id);
    if (!group) return send(res, 404, { error: 'Group not found.' });
    const input = await bodyJson(req);
    const previousMembers = new Set(group.members || []);
    if (input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!groupName.test(name)) return send(res, 400, { error: 'Group name must contain 2–64 valid characters.' });
      if (store.state.groups.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'A group with this name already exists.' });
      group.name = name;
    }
    if (input.description !== undefined) group.description = String(input.description || '').trim().slice(0, 160);
    if (Array.isArray(input.permissions)) group.permissions = normalizePermissions(input.permissions, PERMISSIONS, []);
    if (Array.isArray(input.members)) group.members = validMembers(input.members);
    const affected = new Set([...previousMembers, ...(group.members || [])]);
    for (const member of affected) sessions.clearUser(member);
    store.addActivity('group', `Group ${group.name} was updated.`);
    await store.save();
    return send(res, 200, groupPublic(group));
  }
  if (req.method === 'DELETE' && /^\/api\/groups\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const index = store.state.groups.findIndex(item => item.id === id);
    if (index < 0) return send(res, 404, { error: 'Group not found.' });
    const [group] = store.state.groups.splice(index, 1);
    for (const member of group.members || []) sessions.clearUser(member);
    store.addActivity('group', `Group ${group.name} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/security/api-tokens') {
    return send(res, 200, { tokens: store.state.security.apiTokens.map(({ tokenHash, ...token }) => token), permissionOptions: PERMISSIONS });
  }
  if (req.method === 'POST' && url.pathname === '/api/security/api-tokens') {
    const input = await bodyJson(req);
    const { record, secret } = createApiTokenRecord({ name: input.name, permissions: input.permissions, allowed: PERMISSIONS });
    store.state.security.apiTokens.push(record);
    store.addActivity('security', `API token ${record.name} was created.`);
    await store.save();
    const { tokenHash, ...publicRecord } = record;
    return send(res, 201, { token: secret, record: publicRecord });
  }
  if (req.method === 'PATCH' && /^\/api\/security\/api-tokens\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const token = store.state.security.apiTokens.find(item => item.id === id);
    if (!token) return send(res, 404, { error: 'API token not found.' });
    const input = await bodyJson(req);
    if (typeof input.disabled === 'boolean') token.disabled = input.disabled;
    if (Array.isArray(input.permissions)) token.permissions = normalizePermissions(input.permissions, PERMISSIONS, []);
    await store.save();
    const { tokenHash, ...publicToken } = token;
    return send(res, 200, publicToken);
  }
  if (req.method === 'DELETE' && /^\/api\/security\/api-tokens\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const index = store.state.security.apiTokens.findIndex(item => item.id === id);
    if (index < 0) return send(res, 404, { error: 'API token not found.' });
    const [token] = store.state.security.apiTokens.splice(index, 1);
    store.addActivity('security', `API token ${token.name} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/security/webhooks') {
    return send(res, 200, { webhooks: store.state.security.webhooks.map(({ secret, ...hook }) => ({ ...hook, hasSecret: Boolean(secret) })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/security/webhooks') {
    const input = await bodyJson(req);
    const hook = createWebhookRecord(input);
    store.state.security.webhooks.push(hook);
    store.addActivity('security', `Webhook ${hook.name} was created.`);
    await store.save();
    const { secret, ...publicHook } = hook;
    return send(res, 201, { secret, webhook: publicHook });
  }
  if (req.method === 'PATCH' && /^\/api\/security\/webhooks\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const hook = store.state.security.webhooks.find(item => item.id === id);
    if (!hook) return send(res, 404, { error: 'Webhook not found.' });
    const input = await bodyJson(req);
    if (input.name !== undefined || input.url !== undefined || input.events !== undefined) {
      const validated = createWebhookRecord({ name: input.name ?? hook.name, url: input.url ?? hook.url, events: input.events ?? hook.events });
      hook.name = validated.name; hook.url = validated.url; hook.events = validated.events;
    }
    if (typeof input.enabled === 'boolean') hook.enabled = input.enabled;
    await store.save();
    const { secret, ...publicHook } = hook;
    return send(res, 200, publicHook);
  }
  if (req.method === 'POST' && /^\/api\/security\/webhooks\/[0-9a-f-]{36}\/test$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const hook = store.state.security.webhooks.find(item => item.id === id);
    if (!hook) return send(res, 404, { error: 'Webhook not found.' });
    const result = await deliverWebhook(hook, { id: crypto.randomUUID(), type: 'test', message: 'LightNAS webhook test', severity: 'info', timestamp: new Date().toISOString() });
    await store.save();
    return send(res, result.ok ? 200 : 409, result);
  }
  if (req.method === 'DELETE' && /^\/api\/security\/webhooks\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const index = store.state.security.webhooks.findIndex(item => item.id === id);
    if (index < 0) return send(res, 404, { error: 'Webhook not found.' });
    const [hook] = store.state.security.webhooks.splice(index, 1);
    store.addActivity('security', `Webhook ${hook.name} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/security/identity-providers') {
    return send(res, 200, {
      providers: store.state.security.identityProviders.map(publicIdentityProvider),
      permissionOptions: PERMISSIONS,
      types: ['ldaps', 'saml', 'oidc']
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/security/identity-providers') {
    const input = await bodyJson(req);
    if (Array.isArray(input.permissions)) input.permissions = normalizePermissions(input.permissions, PERMISSIONS, []);
    const provider = normalizeIdentityProvider(input);
    store.state.security.identityProviders.push(provider);
    store.addActivity('security', `Identity provider ${provider.name} (${provider.type.toUpperCase()}) was created.`);
    await store.save();
    return send(res, 201, publicIdentityProvider(provider));
  }
  if (req.method === 'PATCH' && /^\/api\/security\/identity-providers\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const index = store.state.security.identityProviders.findIndex(item => item.id === id);
    if (index < 0) return send(res, 404, { error: 'Identity provider not found.' });
    const input = await bodyJson(req);
    if (Array.isArray(input.permissions)) input.permissions = normalizePermissions(input.permissions, PERMISSIONS, []);
    const provider = normalizeIdentityProvider(input, store.state.security.identityProviders[index]);
    store.state.security.identityProviders[index] = provider;
    store.addActivity('security', `Identity provider ${provider.name} was updated.`);
    await store.save();
    return send(res, 200, publicIdentityProvider(provider));
  }
  if (req.method === 'POST' && /^\/api\/security\/identity-providers\/[0-9a-f-]{36}\/test$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const provider = store.state.security.identityProviders.find(item => item.id === id);
    if (!provider) return send(res, 404, { error: 'Identity provider not found.' });
    const result = await testIdentityProvider(provider);
    return send(res, 200, result);
  }
  if (req.method === 'DELETE' && /^\/api\/security\/identity-providers\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const index = store.state.security.identityProviders.findIndex(item => item.id === id);
    if (index < 0) return send(res, 404, { error: 'Identity provider not found.' });
    const [provider] = store.state.security.identityProviders.splice(index, 1);
    store.addActivity('security', `Identity provider ${provider.name} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/media') {
    if (!requirePermission(res, permissions, 'files.read')) return;
    return send(res, 200, { converterAvailable: await mediaAvailable(), formats: ['mp4', 'webm', 'mp3', 'jpg', 'png', 'webp'] });
  }
  if (req.method === 'POST' && url.pathname === '/api/media/convert') {
    if (!requirePermission(res, permissions, 'media.convert')) return;
    const input = await bodyJson(req);
    const converted = await convertMedia(input.path, input.format);
    store.addActivity('media', `Converted a media file to ${input.format}.`);
    await store.save();
    return send(res, 201, converted);
  }

  if (req.method === 'GET' && url.pathname === '/api/spaces') {
    if (!requirePermission(res, permissions, 'storage.view')) return;
    return send(res, 200, { spaces: store.state.spaces });
  }
  if (req.method === 'POST' && url.pathname === '/api/zfs/datasets') {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const result = await createDataset(await bodyJson(req));
    store.addActivity('zfs', `ZFS dataset ${result.name} was created.`);
    await store.save();
    return send(res, 201, result);
  }
  if (req.method === 'PATCH' && url.pathname === '/api/zfs/datasets') {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const result = await updateDataset(await bodyJson(req));
    store.addActivity('zfs', `ZFS dataset ${result.name} ${result.property} changed.`);
    await store.save();
    return send(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/spaces') {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const input = await bodyJson(req);
    if (!spaceName.test(input.name || '') || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) return send(res, 400, { error: 'Choose a 2–40 character folder name and a label up to 80 characters.' });
    if (store.state.spaces.some(item => item.name.toLowerCase() === input.name.toLowerCase())) return send(res, 409, { error: 'Storage space already exists.' });
    await mkdir(spaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(spaceRoot, input.name), { mode: 0o700 });
    const space = { name: input.name, label: input.label.trim(), createdAt: new Date().toISOString() };
    store.state.spaces.push(space);
    store.addActivity('storage', `Storage space ${space.name} was created.`);
    await store.save();
    return send(res, 201, { space });
  }
  if (req.method === 'PATCH' && /^\/api\/spaces\/[a-zA-Z0-9_-]{2,40}$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const space = store.state.spaces.find(item => item.name === url.pathname.split('/').pop());
    if (!space) return send(res, 404, { error: 'Storage space not found.' });
    const { label } = await bodyJson(req);
    if (typeof label !== 'string' || !label.trim() || label.length > 80) return send(res, 400, { error: 'Enter a label up to 80 characters.' });
    space.label = label.trim();
    await store.save();
    return send(res, 200, { space });
  }
  if (req.method === 'DELETE' && /^\/api\/spaces\/[a-zA-Z0-9_-]{2,40}$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const name = url.pathname.split('/').pop();
    const index = store.state.spaces.findIndex(item => item.name === name);
    if (index < 0) return send(res, 404, { error: 'Storage space not found.' });
    try { await rmdir(join(spaceRoot, name)); }
    catch (error) { if (error.code === 'ENOTEMPTY') return send(res, 409, { error: 'Storage space must be empty before it can be removed.' }); throw error; }
    store.state.spaces.splice(index, 1);
    store.addActivity('storage', `Storage space ${name} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const { username: owner, deviceName, timezone } = store.state.config;
    return send(res, 200, { username: owner, deviceName, timezone });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    const input = await bodyJson(req);
    if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, store.state.config.passwordHash))) return send(res, 403, { error: 'Current administrator password is incorrect.' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,31}$/.test(input.deviceName || '')) return send(res, 400, { error: 'Device name must contain 2–32 letters, numbers, or hyphens.' });
    if (!['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'].includes(input.timezone)) return send(res, 400, { error: 'Choose a supported time zone.' });
    const changedPassword = Boolean(input.newPassword);
    if (changedPassword && (typeof input.newPassword !== 'string' || input.newPassword.length < 10)) return send(res, 400, { error: 'New password must contain at least 10 characters.' });
    store.state.config.deviceName = input.deviceName;
    store.state.config.timezone = input.timezone;
    if (changedPassword) store.state.config.passwordHash = await hashPassword(input.newPassword);
    store.addActivity('settings', changedPassword ? 'Administrator password was changed.' : 'Appliance settings were updated.');
    await store.save();
    if (changedPassword) sessions.clear();
    return send(res, 200, { ok: true, signInRequired: changedPassword }, changedPassword ? { 'Set-Cookie': 'nas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' } : {});
  }

  if (req.method === 'GET' && url.pathname === '/api/containers/inventory') {
    if (!requireAnyPermission(res, permissions, ['containers.manage', 'storage.view', 'system.view'])) return;
    // The Containers page only needs existing LXC records and capability
    // state. Keep storage/template discovery out of that critical path; the
    // creation wizard requests the full inventory when it is opened.
    if (url.searchParams.get('summary') === '1') {
      return send(res, 200, containerPublisher.decorate(await localContainerSummary()));
    }
    const withDeadline = (promise, fallback, ms = 4000) => Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(fallback), ms))
    ]);
    const [containers, storagePools, templateLibrary] = await Promise.all([
      localContainerSummary(),
      withDeadline(listStoragePools().catch(() => ({ pools: [] })), { pools: [] }),
      withDeadline(listContainerTemplates().catch(() => ({ templates: [] })), { templates: [] })
    ]);
    const writable = (storagePools.pools || []).filter(pool => pool.online && pool.writable && pool.content?.includes('rootdir'));
    containers.pools = writable.map(pool => pool.id);
    containers.storageDetails = writable;
    containers.images = [
      ...(templateLibrary.templates || []).map(item => ({
        id: item.id,
        label: `${item.filename} · ${item.storageLabel}`,
        source: 'template-library',
        filename: item.filename,
        storageLabel: item.storageLabel,
        sizeBytes: item.sizeBytes
      })),
      ...(containers.images || [])
    ];
    containers.templateCount = (templateLibrary.templates || []).length;
    return send(res, 200, containerPublisher.decorate(containers));
  }
  if (req.method === 'GET' && url.pathname === '/api/runtimes') {
    if (!requireAnyPermission(res, permissions, ['apps.manage', 'containers.manage', 'vms.manage', 'storage.view', 'system.view'])) return;
    const runtimes = await runtimeInventory();
    containerPublisher.decorate(runtimes.containers);
    return send(res, 200, { ...runtimes, catalog });
  }
  if (req.method === 'POST' && /^\/api\/catalog\/[a-z0-9-]+\/install$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'apps.manage')) return;
    const id = url.pathname.split('/')[3];
    const input = await bodyJson(req);
    const app = catalog.find(item => item.id === id);
    const installed = await installCatalogApp(id, input);
    let firewall = null;
    if (app?.port) {
      firewall = await localNetworkAction({ action: 'firewall-add', decision: 'allow', protocol: 'tcp', port: app.port, source: '' })
        .catch(error => ({ warning: error.message }));
    }
    store.addActivity('app', `Catalog app ${id} was installed as a Docker container.`);
    await store.save();
    return send(res, 201, { ...installed, firewall });
  }
  if (req.method === 'POST' && /^\/api\/catalog\/[a-z0-9-]+\/(start|stop|restart|remove)$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'apps.manage')) return;
    const [, , , id, action] = url.pathname.split('/');
    const result = await manageCatalogApp(id, action);
    if (action === 'remove') {
      const app = catalog.find(item => item.id === id);
      if (app?.port) await localNetworkAction({ action: 'firewall-remove-port', protocol: 'tcp', port: app.port }).catch(() => null);
    }
    store.addActivity('app', `App ${id}: ${action}.`);
    await store.save();
    return send(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/containers') {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    const input = await bodyJson(req);
    if (input.action === 'publish' || input.action === 'auto-publish') {
      const id = String(input.id || '');
      const automatic = await automaticContainerApplication(id, {
        preferredPort: Number(input.targetPort) || 0,
        requestedHostPort: Number(input.hostPort) || 0,
        attempts: input.action === 'auto-publish' ? Math.max(1, Math.min(3, Number(input.attempts) || 3)) : 1
      });
      const publication = automatic.publication;
      if (!publication && input.action === 'publish' && Number(input.targetPort)) {
        // Preserve the advanced manual proxy as a compatibility fallback when
        // an application cannot answer the automatic HTTP/HTTPS probe.
        const direct = {
          id,
          mode: 'proxy',
          targetHost: automatic.targetHost,
          targetPort: Number(input.targetPort),
          hostPort: Number(input.hostPort),
          scheme: input.scheme === 'https' ? 'https' : 'http'
        };
        const fallback = await containerPublisher.configure(direct);
        try {
          await localNetworkAction({ action: 'firewall-add', decision: 'allow', protocol: 'tcp', port: fallback.hostPort, source: '' });
        } catch (error) {
          await containerPublisher.remove(fallback.id);
          throw error;
        }
        store.addActivity('container', `Container ${automatic.item.name} application published through LightNAS port ${fallback.hostPort}.`);
        await store.save();
        return send(res, 200, fallback);
      }
      if (!publication) {
        return send(res, 200, {
          id,
          publication: null,
          targetHost: automatic.targetHost,
          message: 'No HTTP or HTTPS application is listening yet. Direct LAN access will be detected automatically after the application starts.'
        });
      }
      const access = publication.mode === 'direct'
        ? `${publication.scheme}://${publication.targetHost}${(publication.scheme === 'https' && publication.targetPort === 443) || (publication.scheme === 'http' && publication.targetPort === 80) ? '' : `:${publication.targetPort}`}/`
        : `${publication.scheme}://${req.headers.host?.split(':')[0] || 'lightnas'}:${publication.hostPort}/`;
      store.addActivity('container', publication.mode === 'direct'
        ? `Container ${automatic.item.name} application detected for direct LAN access at ${access}.`
        : `Container ${automatic.item.name} application published through LightNAS port ${publication.hostPort}.`);
      await store.save();
      return send(res, 200, { ...publication, accessUrl: access });
    }
    if (input.action === 'unpublish') {
      const existing = containerPublisher.forContainer(String(input.id || ''));
      await containerPublisher.remove(String(input.id || ''));
      if (existing?.hostPort) await localNetworkAction({ action: 'firewall-remove-port', protocol: 'tcp', port: existing.hostPort });
      store.addActivity('container', `Container ${input.id} application publication was removed.`);
      await store.save();
      return send(res, 200, { id: input.id, publication: null });
    }
    const result = await createContainer(input);
    const id = String(input.id || input.name || result.id || result.name || '');
    if (input.action === 'delete') {
      const existing = containerPublisher.forContainer(id);
      await containerPublisher.remove(id);
      if (existing?.mode === 'proxy' && existing.hostPort) {
        await localNetworkAction({ action: 'firewall-remove-port', protocol: 'tcp', port: existing.hostPort }).catch(() => null);
      }
    }
    let application = null;
    if (!input.action || input.action === 'start' || input.action === 'reboot') {
      const attempts = !input.action && String(input.image || '').startsWith('template:') ? 12 : 2;
      application = await automaticContainerApplication(id, { attempts }).catch(() => null);
    }
    store.addActivity('container', input.action ? `Container ${result.name || id}: ${input.action}.` : `Container ${result.name || id} was created.`);
    await store.save();
    return send(res, input.action ? 200 : 201, application ? { ...result, application: application.publication } : result);
  }
  if (req.method === 'POST' && /^\/api\/containers\/[A-Za-z][A-Za-z0-9-]{1,39}\/exec$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const input = await bodyJson(req);
    const result = await localContainerCommand(id, input.command);
    return send(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/vms') {
    if (!requirePermission(res, permissions, 'vms.manage')) return;
    const input = await bodyJson(req);
    const result = await createVm(input);
    store.addActivity('vm', input.action ? `VM ${input.vmid}: ${input.action}.` : `Virtual machine ${result.name} was created.`);
    await store.save();
    return send(res, input.action ? 200 : 201, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/proxmox/storage') {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const input = await bodyJson(req);
    const result = await proxmoxUpdateStorage(input.storage, input.content);
    store.addActivity('storage', `Proxmox storage ${result.storage} content policy updated.`);
    await store.save();
    return send(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/proxmox/disk-clean') {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const input = await bodyJson(req);
    const result = await proxmoxCleanDisk(input.path, input.confirm);
    store.addActivity('storage', `Disk ${result.path} partition/filesystem signatures were cleaned.`, 'warning');
    await store.save();
    return send(res, 200, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    // Login/home must stay fast on old CPUs and 2 GiB systems. Filesystem
    // metadata is cheap, while ZFS/pool probing can take seconds on cold or
    // disconnected storage. Serve the last warm storage inventory immediately
    // and refresh it in the background instead of blocking the whole UI.
    const [system, filesystems] = await Promise.all([getSystemSnapshot(), getFilesystems()]);
    const storage = overviewStorageCache || quickStorageSummary(filesystems);
    if (!overviewStorageCache || Date.now() - overviewStorageCacheAt >= OVERVIEW_STORAGE_TTL_MS) warmOverviewStorage();
    return send(res, 200, {
      appliance: { deviceName: store.state.config.deviceName, username, role: isAdmin ? 'administrator' : context.apiToken ? 'api' : 'user', permissions, timezone: store.state.config.timezone, avatar: Boolean(account.avatarExt) },
      system, filesystems, storage, host: null,
      shares: store.state.shares, activity: store.state.activity.slice(0, 8)
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/storage/scan') {
    if (!requirePermission(res, permissions, 'storage.view')) return;
    const storage = await refreshOverviewStorage(true);
    return send(res, 200, {
      disks: (storage.disks || []).map(item => ({ path: item.path, sizeBytes: item.sizeBytes, system: item.system, blank: item.blank })),
      attachedVolumes: (storage.attachedVolumes || []).map(item => ({ device: item.device, mountPoint: item.mountPoint, totalBytes: item.totalBytes }))
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/network') {
    if (!requirePermission(res, permissions, 'network.view')) return;
    const [observed, control] = await Promise.all([
      networkInventory(),
      localNetworkInventory().catch(error => ({ editable: false, manager: null, reason: error.message, devices: [], connections: [], wifi: [] }))
    ]);
    return send(res, 200, { ...observed, control, host: null });
  }
  if (req.method === 'POST' && url.pathname === '/api/network') {
    const input = await bodyJson(req);
    const networkActionName = String(input.action || '');
    if (networkActionName.startsWith('firewall-')) {
      if (!requireAnyPermission(res, permissions, ['firewall.manage', 'network.manage'])) return;
    } else if (!requirePermission(res, permissions, 'network.manage')) return;
    let result;
    try { result = await localNetworkAction(input); }
    catch (error) {
      // Keep the old read-only helper compatible for installations that have
      // not yet upgraded the local host daemon.
      if (!['firewall-add', 'firewall-delete', 'wifi-connect', 'wifi-disconnect'].includes(String(input.action || ''))) throw error;
      result = await networkAction(input);
    }
    store.addActivity('network', `Network action ${result.action} completed.`);
    await store.save();
    return send(res, 200, result);
  }
  if (req.method === 'GET' && url.pathname === '/api/appliance/health') {
    if (!isAdmin && !permissions.includes('system.view') && !permissions.includes('monitoring.view')) return send(res, 403, { error: 'System health access is required.' });
    return send(res, 200, await localApplianceHealth());
  }
  if (req.method === 'POST' && url.pathname === '/api/appliance/repair') {
    if (!isAdmin) return send(res, 403, { error: 'Only the appliance administrator can run automatic repair.' });
    const result = await localApplianceRepair();
    store.addActivity('health', result.healthy ? 'Automatic appliance repair completed successfully.' : 'Automatic appliance repair completed with items still needing attention.', result.healthy ? 'success' : 'warning');
    await store.save();
    return send(res, 200, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/system') {
    if (!requireAnyPermission(res, permissions, ['system.view', 'monitoring.view'])) return;
    const local = await getSystemSnapshot();
    let host = null;
    try { host = (await runtimeInventory()).virtualization?.host || null; } catch {}
    return send(res, 200, { ...local, host });
  }
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    if (!requirePermission(res, permissions, 'storage.view')) return;
    const [filesystems, storage, runtimes] = await Promise.all([getFilesystems(), getStorageInventory(), runtimeInventory()]);
    return send(res, 200, { filesystems, ...storage, host: runtimes.virtualization?.host || null });
  }

  if (req.method === 'GET' && url.pathname === '/api/storage/pools') {
    if (!requirePermission(res, permissions, 'storage.view')) return;
    return send(res, 200, await listStoragePools());
  }
  if (req.method === 'POST' && url.pathname === '/api/storage/pools') {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const pool = await createStoragePool(await bodyJson(req));
    store.addActivity('storage', `Storage ${pool.name} was created on ${pool.mountPoint}.`);
    await store.save();
    return send(res, 201, { pool });
  }
  if (req.method === 'PATCH' && /^\/api\/storage\/pools\/[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const id = url.pathname.split('/').pop();
    const pool = await updateStoragePool(id, await bodyJson(req));
    store.addActivity('storage', `Storage ${pool.name} content policy was updated.`);
    await store.save();
    return send(res, 200, { pool });
  }
  if (req.method === 'DELETE' && /^\/api\/storage\/pools\/[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const id = url.pathname.split('/').pop();
    const result = await deleteStoragePool(id);
    store.addActivity('storage', `Storage definition ${id} was removed; files were preserved.`);
    await store.save();
    return send(res, 200, result);
  }
  if (req.method === 'GET' && /^\/api\/storage\/pools\/[A-Za-z][A-Za-z0-9_-]{1,31}\/content$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.view')) return;
    const id = url.pathname.split('/')[4];
    const type = url.searchParams.get('type') || 'iso';
    return send(res, 200, await listStorageContent(id, type));
  }
  if (req.method === 'PUT' && /^\/api\/storage\/pools\/[A-Za-z][A-Za-z0-9_-]{1,31}\/upload$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const id = url.pathname.split('/')[4];
    const type = url.searchParams.get('type') || '';
    const name = url.searchParams.get('name') || '';
    const result = await uploadStorageContent(id, type, name, req);
    store.addActivity('storage', `${type} file ${result.name} was uploaded to ${id}.`);
    await store.save();
    return send(res, 201, result);
  }
  if (req.method === 'POST' && /^\/api\/storage\/pools\/[A-Za-z][A-Za-z0-9_-]{1,31}\/import$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const id = url.pathname.split('/')[4];
    const input = await bodyJson(req);
    const result = await importStorageContent(id, input.type, input.url);
    store.addActivity('storage', `${input.type} file ${result.name} was imported to ${id}.`);
    await store.save();
    return send(res, 201, result);
  }
  if (req.method === 'DELETE' && /^\/api\/storage\/pools\/[A-Za-z][A-Za-z0-9_-]{1,31}\/content$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'storage.manage')) return;
    const id = url.pathname.split('/')[4];
    const type = url.searchParams.get('type') || '';
    const name = url.searchParams.get('name') || '';
    const result = await deleteStorageContent(id, type, name);
    store.addActivity('storage', `${type} file ${name} was removed from ${id}.`);
    await store.save();
    return send(res, 200, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/templates') {
    if (!requireAnyPermission(res, permissions, ['storage.view', 'containers.manage'])) return;
    const library = await listContainerTemplates();
    return send(res, 200, { ...library, proxmoxSource: proxmoxTemplateSource });
  }
  if (req.method === 'GET' && url.pathname === '/api/templates/catalog') {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    return send(res, 200, { source: proxmoxTemplateSource, templates: await proxmoxTemplateCatalog() });
  }
  if (req.method === 'PUT' && url.pathname === '/api/templates/upload') {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    const storageId = url.searchParams.get('storage') || '';
    const filename = url.searchParams.get('name') || '';
    const template = await uploadContainerTemplate(storageId, filename, req);
    store.addActivity('container-template', `Container template ${template.filename} was uploaded to ${template.storageLabel}.`);
    await store.save();
    return send(res, 201, { template });
  }
  if (req.method === 'POST' && url.pathname === '/api/templates/import') {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    const input = await bodyJson(req);
    const template = await importContainerTemplate({
      storageId: input.storageId,
      url: input.url,
      proxmoxTemplate: input.proxmoxTemplate
    });
    store.addActivity('container-template', `Container template ${template.filename} was imported to ${template.storageLabel}.`);
    await store.save();
    return send(res, 201, { template });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/templates') {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    const id = url.searchParams.get('id') || '';
    const result = await deleteContainerTemplate(id);
    store.addActivity('container-template', 'A container template was removed.');
    await store.save();
    return send(res, 200, result);
  }

  if (url.pathname === '/api/files') {
    const path = url.searchParams.get('path') || '';
    if (req.method === 'GET') {
      if (!requirePermission(res, permissions, 'files.read')) return;
      if (!path && url.searchParams.get('all') === '1') {
        const all = await listAllFiles(url.searchParams.get('refresh') === '1');
        return send(res, 200, { path: '', ...all });
      }
      return send(res, 200, { path, entries: await listFiles(path), truncated: false });
    }
    if (req.method === 'DELETE') {
      if (!requireAnyPermission(res, permissions, ['files.delete', 'files.write'])) return;
      await deleteEntry(path); store.addActivity('file', `File entry ${path} was deleted.`); await store.save(); return send(res, 200, { ok: true });
    }
    if (!requirePermission(res, permissions, 'files.write')) return;
    if (req.method === 'POST') { await createFolder(path); store.addActivity('file', `Folder ${path} was created.`); await store.save(); return send(res, 201, { ok: true }); }
    if (req.method === 'PUT') { await uploadFile(path, req); store.addActivity('file', `File ${path} was uploaded.`); await store.save(); return send(res, 201, { ok: true }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/files/thumbnail') {
    if (!requirePermission(res, permissions, 'files.read')) return;
    const thumbnail = await thumbnailFor(url.searchParams.get('path') || '', { preview: url.searchParams.get('preview') === '1' });
    res.writeHead(200, { 'Content-Type': thumbnail.contentType, 'Content-Length': thumbnail.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp });
    return createReadStream(thumbnail.path).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/files/archive') {
    if (!requireAnyPermission(res, permissions, ['files.download', 'files.read'])) return;
    const relative = url.searchParams.get('path') || '';
    const data = await downloadEntry(relative);
    if (!data.directory) return send(res, 400, { error: 'Select a folder to download.' });
    const folderName = basename(data.path) || 'folder';
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(folderName + '.tar.gz')}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': csp
    });
    const archive = spawn('tar', ['-czf', '-', '-C', dirname(data.path), folderName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    archive.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    archive.on('error', error => { if (!res.destroyed) res.destroy(error); });
    archive.on('close', code => {
      if (code !== 0 && !res.destroyed) res.destroy(new Error(stderr.trim() || `Folder archive failed with exit code ${code}.`));
    });
    res.on('close', () => { if (!archive.killed) archive.kill('SIGTERM'); });
    return archive.stdout.pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/files/video-preview') {
    if (!requirePermission(res, permissions, 'files.read')) return;
    const relative = url.searchParams.get('path') || '';
    const filename = relative.split('/').pop() || 'video';
    const extension = extname(filename).toLowerCase();
    const supportedVideo = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi', '.wmv', '.flv', '.mpeg', '.mpg', '.m2v', '.mts', '.m2ts', '.ts', '.3gp', '.3g2', '.vob']);
    if (!supportedVideo.has(extension)) return send(res, 415, { error: 'This file is not a supported video preview format.' });
    const data = await downloadFile(relative);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': csp
    });
    const ffmpeg = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', data.path,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg.on('error', error => { if (!res.destroyed) res.destroy(error); });
    ffmpeg.stderr.resume();
    res.on('close', () => { if (!ffmpeg.killed) ffmpeg.kill('SIGTERM'); });
    return ffmpeg.stdout.pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/files/download') {
    if (!requireAnyPermission(res, permissions, ['files.download', 'files.read'])) return;
    const path = url.searchParams.get('path') || '';
    const filename = path.split('/').pop() || 'file';
    const data = await downloadFile(path);
    const extension = extname(filename).toLowerCase();
    const mime = mimeTypes[extension] || 'application/octet-stream';
    const previewable = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('text/') || mime === 'application/pdf' || mime.startsWith('application/xml');
    res.writeHead(200, {
      'Content-Type': mime, 'Content-Length': data.size,
      'Content-Disposition': `${previewable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp
    });
    return createReadStream(data.path).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/shares') {
    if (!requirePermission(res, permissions, 'files.read')) return;
    return send(res, 200, { shares: store.state.shares });
  }
  if (req.method === 'POST' && url.pathname === '/api/shares') {
    if (!requirePermission(res, permissions, 'shares.manage')) return;
    const input = await bodyJson(req);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,63}$/.test(input.name || '')) return send(res, 400, { error: 'Share name must contain 2–64 valid characters.' });
    if (store.state.shares.some(share => share.name.toLowerCase() === input.name.toLowerCase())) return send(res, 409, { error: 'A share with this name already exists.' });
    const share = { id: crypto.randomUUID(), name: input.name, protocol: ['SMB', 'NFS', 'SFTP'].includes(input.protocol) ? input.protocol : 'SMB', description: String(input.description || '').slice(0, 160), createdAt: new Date().toISOString() };
    store.state.shares.push(share);
    store.addActivity('share', `Share plan ${share.name} was saved for ${share.protocol}.`, 'info');
    await store.save();
    return send(res, 201, { share });
  }
  if (req.method === 'DELETE' && /^\/api\/shares\/[0-9a-f-]{36}$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'shares.manage')) return;
    const id = url.pathname.split('/').pop();
    const index = store.state.shares.findIndex(share => share.id === id);
    if (index < 0) return send(res, 404, { error: 'Share plan not found.' });
    const [share] = store.state.shares.splice(index, 1);
    store.addActivity('share', `Share plan ${share.name} was removed.`, 'info');
    await store.save();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'API endpoint not found.' });
}

async function staticAsset(req, res, url) {
  const isNovnc = url.pathname.startsWith('/novnc/');
  const isXterm = url.pathname.startsWith('/xterm/');
  const isXtermFit = url.pathname.startsWith('/xterm-addon-fit/');
  const base = resolve(isNovnc ? novncRoot : isXterm ? xtermRoot : isXtermFit ? xtermFitRoot : publicRoot);
  const requested = isNovnc
    ? url.pathname.slice('/novnc/'.length)
    : isXterm
      ? url.pathname.slice('/xterm/'.length)
      : isXtermFit
        ? url.pathname.slice('/xterm-addon-fit/'.length)
        : (url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const path = resolve(base, safePath);
  if (path !== base && !path.startsWith(`${base}/`)) return send(res, 403, 'Forbidden');
  try {
    const content = await readFile(path);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': extname(path).toLowerCase() === '.html'
        ? 'no-cache, max-age=0'
        : ['.js', '.mjs', '.css'].includes(extname(path).toLowerCase())
          ? 'private, max-age=120'
          : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return send(res, 404, 'Not found');
    throw error;
  }
}

function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(message, 'utf8');
  const label = status === 401 ? 'Unauthorized' : 'Forbidden';
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`);
  socket.write(body);
  socket.destroy();
}

function sameOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}

function keepWebSocketAlive(ws) {
  const timer = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(timer);
  }, 25000);
  const stop = () => clearInterval(timer);
  ws.once('close', stop);
  ws.once('error', stop);
}

function bridgeWebSocketToSocket(ws, backend) {
  keepWebSocketAlive(ws);
  const close = () => {
    if (!backend.destroyed) backend.destroy();
    if (ws.readyState === 0 || ws.readyState === 1) ws.close();
  };
  backend.on('data', chunk => { if (ws.readyState === 1) ws.send(chunk, { binary: true }); });
  backend.on('error', () => { if (ws.readyState === 1) ws.close(1011, 'Console backend error'); });
  backend.on('close', () => { if (ws.readyState === 1) ws.close(1000, 'Console closed'); });
  ws.on('message', data => { if (!backend.destroyed) backend.write(Buffer.from(data)); });
  ws.on('close', close);
  ws.on('error', close);
  // localVmConsoleSocket intentionally pauses during the JSON-to-RFB handoff.
  // Resume only after both bridge directions are installed.
  backend.resume();
}

function bridgeWebSocketToProcess(ws, process) {
  keepWebSocketAlive(ws);
  const output = chunk => { if (ws.readyState === 1) ws.send(chunk.toString('utf8')); };
  process.stdout?.on('data', output);
  process.stderr?.on('data', output);
  process.on('error', error => { if (ws.readyState === 1) ws.send(`\r\n[terminal error: ${error.message}]\r\n`); });
  process.on('close', code => { if (ws.readyState === 1) ws.close(1000, `Shell exited (${code ?? 0})`); });
  ws.on('message', data => { if (process.stdin?.writable) process.stdin.write(Buffer.from(data)); });
  const stop = () => { if (!process.killed) process.kill('SIGTERM'); };
  ws.on('close', stop);
  ws.on('error', stop);
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const bearer = /^Bearer\s+/i.test(req.headers.authorization || '');
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-lightnas-request'] !== '1' && !bearer) send(res, 403, { error: 'This request must originate from the LightNAS interface or use a scoped API token.' });
      else if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await staticAsset(req, res, url);
    } catch (error) {
      const status = error.status || ({ ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403 }[error.code] || 500);
      if (status >= 500) console.error(error);
      const fallback = { ENOENT: 'File or folder not found.', EEXIST: 'File or folder already exists.', ENOTEMPTY: 'Folder must be empty before deletion.', EACCES: 'Access denied.' }[error.code] || 'Request failed.';
      send(res, status, { error: error.status ? error.message : status === 500 ? 'Unexpected server error.' : fallback });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (!sameOrigin(req)) return rejectUpgrade(socket, 403, 'Same-origin console connection required.');
      const context = localContext(req);
      if (!context) return rejectUpgrade(socket, 401, 'Authentication required.');
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const vm = url.pathname.match(/^\/api\/console\/vm\/([A-Za-z][A-Za-z0-9-]{1,39}|[1-9][0-9]{1,5})$/);
      const container = url.pathname.match(/^\/api\/console\/container\/([A-Za-z][A-Za-z0-9-]{1,39})$/);
      const nodeShell = url.pathname === '/api/console/node';
      if (!vm && !container && !nodeShell) return rejectUpgrade(socket, 403, 'Unknown console endpoint.');
      if (vm && !context.permissions.includes('vms.manage')) return rejectUpgrade(socket, 403, 'VM management permission required.');
      if (container && !context.permissions.includes('containers.manage')) return rejectUpgrade(socket, 403, 'Container management permission required.');
      // A host shell is equivalent to root access to the NAS. It is therefore
      // intentionally limited to the interactive appliance owner session and
      // cannot be delegated to an API token or ordinary user.
      if (nodeShell && (context.apiToken || (!context.isAdmin && !context.permissions.includes('system.shell')))) return rejectUpgrade(socket, 403, 'Node shell permission required.');
      const useExternalProxmox = process.env.LIGHTNAS_ENABLE_PROXMOX_PROVIDER === '1';
      const backend = nodeShell
        ? await localNodeConsoleSocket()
        : vm
          ? (useExternalProxmox && /^[0-9]+$/.test(vm[1]) ? await proxmoxConsoleSocket(Number(vm[1])) : await localVmConsoleSocket(vm[1]))
          : await localContainerConsoleSocket(container[1]);
      wss.handleUpgrade(req, socket, head, ws => bridgeWebSocketToSocket(ws, backend));
    } catch (error) {
      if (!socket.destroyed) rejectUpgrade(socket, error.status === 401 ? 401 : 403, error.message || 'Console unavailable.');
    }
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.NAS_HOST || '127.0.0.1';
  const port = Number(process.env.NAS_PORT || 3080);
  createServer().listen(port, host, () => console.log(`LightNAS is running at http://${host}:${port}`));
}
