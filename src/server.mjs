import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.mjs';
import { getFilesystems, getStorageInventory, getSystemSnapshot } from './system.mjs';
import { hashPassword, Sessions, verifyPassword } from './auth.mjs';
import { listFiles, createFolder, uploadFile, downloadFile, deleteEntry } from './files.mjs';
import { catalog, runtimeInventory, installCatalogApp, manageCatalogApp, createContainer, createVm } from './runtimes-next.mjs';
import { validateSmtp, sendSmtpTest } from './mailer.mjs';
import { mediaAvailable, convertMedia } from './media.mjs';
import { createDataset, updateDataset } from './zfs.mjs';
import { networkInventory } from './network.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = join(root, 'public');
const store = new JsonStore();
const sessions = new Sessions();
await store.load();
store.state.users ||= [];
store.state.spaces ||= [];
const spaceRoot = join(dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json')), 'files', 'Spaces');
const spaceName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}$/;

export const PERMISSIONS = Object.freeze([
  'files.read', 'files.write', 'media.convert',
  'storage.view', 'storage.manage', 'shares.manage',
  'apps.manage', 'containers.manage', 'vms.manage',
  'network.view', 'system.view'
]);
const DEFAULT_USER_PERMISSIONS = Object.freeze(['files.read', 'files.write']);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8', '.ini': 'text/plain; charset=utf-8', '.conf': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8'
};
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'";

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
    if (size > 64 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
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

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
    const [key, ...value] = item.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function requireSession(req, res) {
  const session = sessions.get(cookies(req).nas_session);
  if (!session) { send(res, 401, { error: 'Authentication required.' }); return null; }
  return session;
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) return [...DEFAULT_USER_PERMISSIONS];
  return [...new Set(value.filter(item => PERMISSIONS.includes(item)))];
}

function permissionsFor(account, isAdmin) {
  return isAdmin ? [...PERMISSIONS] : normalizePermissions(account.permissions);
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

function validateSetup(input) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,31}$/.test(input.deviceName || '')) return 'Device name must contain 2–32 letters, numbers, or hyphens.';
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(input.username || '')) return 'Administrator username must contain 3–32 valid characters.';
  if (typeof input.password !== 'string' || input.password.length < 10) return 'Password must contain at least 10 characters.';
  return null;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { version: '0.11.0', setupRequired: !store.state.config });

  if (req.method === 'POST' && url.pathname === '/api/setup') {
    if (store.state.config) return send(res, 409, { error: 'This appliance is already configured.' });
    const input = await bodyJson(req);
    const problem = validateSetup(input);
    if (problem) return send(res, 400, { error: problem });
    store.state.config = { deviceName: input.deviceName, username: input.username, passwordHash: await hashPassword(input.password), timezone: input.timezone || 'UTC', createdAt: new Date().toISOString() };
    store.addActivity('setup', `Appliance ${input.deviceName} was configured.`, 'success');
    await store.save();
    const token = sessions.create(input.username);
    return send(res, 201, { ok: true }, { 'Set-Cookie': `nas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!store.state.config) return send(res, 409, { error: 'Complete setup first.' });
    const input = await bodyJson(req);
    const account = input.username === store.state.config.username ? store.state.config : store.state.users.find(user => user.username === input.username);
    const validPassword = account && !account.disabled && await verifyPassword(input.password, account.passwordHash);
    if (!validPassword) return send(res, 401, { error: 'Username or password is incorrect.' });
    const token = sessions.create(input.username);
    store.addActivity('login', `${input.username} signed in.`, 'info');
    await store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `nas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(cookies(req).nas_session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'nas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const session = requireSession(req, res);
  if (!session) return;
  const account = session.username === store.state.config.username ? store.state.config : store.state.users.find(user => user.username === session.username);
  if (!account || account.disabled) return send(res, 401, { error: 'Account is unavailable.' });
  const isAdmin = session.username === store.state.config.username;
  const permissions = permissionsFor(account, isAdmin);

  // Owner-only appliance administration.
  const adminOnly = url.pathname === '/api/settings' || url.pathname === '/api/users' || url.pathname.startsWith('/api/users/') || url.pathname === '/api/smtp' || url.pathname === '/api/smtp/test';
  if (adminOnly && !isAdmin) return send(res, 403, { error: 'Appliance owner access required.' });

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

  if (req.method === 'GET' && url.pathname === '/api/users') {
    return send(res, 200, { permissionOptions: PERMISSIONS, users: store.state.users.map(({ username, createdAt, disabled, permissions: saved }) => ({ username, createdAt, disabled: Boolean(disabled), permissions: normalizePermissions(saved) })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    const input = await bodyJson(req);
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(input.username || '') || typeof input.password !== 'string' || input.password.length < 10) return send(res, 400, { error: 'Use a 3–32 character username and a password of at least 10 characters.' });
    if (input.username === store.state.config.username || store.state.users.some(user => user.username === input.username)) return send(res, 409, { error: 'Username already exists.' });
    const user = { username: input.username, passwordHash: await hashPassword(input.password), permissions: normalizePermissions(input.permissions), createdAt: new Date().toISOString() };
    store.state.users.push(user);
    store.addActivity('user', `User ${input.username} was created.`);
    await store.save();
    return send(res, 201, { username: input.username, permissions: user.permissions });
  }
  if (req.method === 'DELETE' && /^\/api\/users\/[a-zA-Z0-9._-]{3,32}$/.test(url.pathname)) {
    const username = url.pathname.split('/').pop();
    const index = store.state.users.findIndex(user => user.username === username);
    if (index < 0) return send(res, 404, { error: 'User not found.' });
    store.state.users.splice(index, 1);
    sessions.clearUser(username);
    store.addActivity('user', `User ${username} was removed.`);
    await store.save();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'PATCH' && /^\/api\/users\/[a-zA-Z0-9._-]{3,32}$/.test(url.pathname)) {
    const username = url.pathname.split('/').pop();
    const user = store.state.users.find(item => item.username === username);
    if (!user) return send(res, 404, { error: 'User not found.' });
    const input = await bodyJson(req);
    if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, store.state.config.passwordHash))) return send(res, 403, { error: 'Current administrator password is incorrect.' });
    let changed = false;
    if (typeof input.disabled === 'boolean') { user.disabled = input.disabled; changed = true; }
    if (typeof input.password === 'string' && input.password) {
      if (input.password.length < 10 || input.password.length > 1024) return send(res, 400, { error: 'New password must contain at least 10 characters.' });
      user.passwordHash = await hashPassword(input.password); changed = true;
    }
    if (Array.isArray(input.permissions)) { user.permissions = normalizePermissions(input.permissions); changed = true; }
    if (!changed) return send(res, 400, { error: 'Choose a password, enable/disable state, or permissions to update.' });
    sessions.clearUser(username);
    store.addActivity('user', `User ${username} was updated.`);
    await store.save();
    return send(res, 200, { ok: true, permissions: normalizePermissions(user.permissions) });
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

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const { username, deviceName, timezone } = store.state.config;
    return send(res, 200, { username, deviceName, timezone });
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

  if (req.method === 'GET' && url.pathname === '/api/runtimes') {
    if (!requireAnyPermission(res, permissions, ['apps.manage', 'containers.manage', 'vms.manage'])) return;
    return send(res, 200, { ...(await runtimeInventory()), catalog });
  }
  if (req.method === 'POST' && /^\/api\/catalog\/[a-z0-9-]+\/install$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'apps.manage')) return;
    const id = url.pathname.split('/')[3];
    const installed = await installCatalogApp(id);
    store.addActivity('app', `Catalog app ${id} was installed as a Docker container.`);
    await store.save();
    return send(res, 201, installed);
  }
  if (req.method === 'POST' && /^\/api\/catalog\/[a-z0-9-]+\/(start|stop|restart|remove)$/.test(url.pathname)) {
    if (!requirePermission(res, permissions, 'apps.manage')) return;
    const [, , , id, action] = url.pathname.split('/');
    const result = await manageCatalogApp(id, action);
    store.addActivity('app', `App ${id}: ${action}.`);
    await store.save();
    return send(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/containers') {
    if (!requirePermission(res, permissions, 'containers.manage')) return;
    const input = await bodyJson(req);
    const result = await createContainer(input);
    store.addActivity('container', input.action ? `Container ${result.name}: ${input.action}.` : `Container ${result.name} was created.`);
    await store.save();
    return send(res, input.action ? 200 : 201, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/vms') {
    if (!requirePermission(res, permissions, 'vms.manage')) return;
    const input = await bodyJson(req);
    const result = await createVm(input);
    store.addActivity('vm', input.action ? `VM ${input.vmid}: ${input.action}.` : `Virtual machine ${result.name} was created.`);
    await store.save();
    return send(res, input.action ? 200 : 201, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const [system, filesystems, storage] = await Promise.all([getSystemSnapshot(), getFilesystems(), getStorageInventory()]);
    return send(res, 200, {
      appliance: { deviceName: store.state.config.deviceName, username: session.username, role: isAdmin ? 'administrator' : 'user', permissions, timezone: store.state.config.timezone },
      system, filesystems, storage, shares: store.state.shares, activity: store.state.activity.slice(0, 8)
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/network') {
    if (!requirePermission(res, permissions, 'network.view')) return;
    return send(res, 200, await networkInventory());
  }
  if (req.method === 'GET' && url.pathname === '/api/system') {
    if (!requirePermission(res, permissions, 'system.view')) return;
    return send(res, 200, await getSystemSnapshot());
  }
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    if (!requirePermission(res, permissions, 'storage.view')) return;
    const [filesystems, storage] = await Promise.all([getFilesystems(), getStorageInventory()]);
    return send(res, 200, { filesystems, ...storage });
  }

  if (url.pathname === '/api/files') {
    const path = url.searchParams.get('path') || '';
    if (req.method === 'GET') {
      if (!requirePermission(res, permissions, 'files.read')) return;
      return send(res, 200, { path, entries: await listFiles(path) });
    }
    if (!requirePermission(res, permissions, 'files.write')) return;
    if (req.method === 'POST') { await createFolder(path); store.addActivity('file', `Folder ${path} was created.`); await store.save(); return send(res, 201, { ok: true }); }
    if (req.method === 'PUT') { await uploadFile(path, req); store.addActivity('file', `File ${path} was uploaded.`); await store.save(); return send(res, 201, { ok: true }); }
    if (req.method === 'DELETE') { await deleteEntry(path); store.addActivity('file', `File entry ${path} was deleted.`); await store.save(); return send(res, 200, { ok: true }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/files/download') {
    if (!requirePermission(res, permissions, 'files.read')) return;
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

async function staticFile(req, res, url) {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const path = join(publicRoot, safePath);
  if (!path.startsWith(publicRoot)) return send(res, 403, 'Forbidden');
  try {
    const content = await readFile(path);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': ['.js', '.mjs', '.css', '.html'].includes(extname(path).toLowerCase()) ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not found');
    throw error;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-lightnas-request'] !== '1') send(res, 403, { error: 'This request must originate from the LightNAS interface.' });
      else if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await staticFile(req, res, url);
    } catch (error) {
      const status = error.status || ({ ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403 }[error.code] || 500);
      if (status >= 500) console.error(error);
      const fallback = { ENOENT: 'File or folder not found.', EEXIST: 'File or folder already exists.', ENOTEMPTY: 'Folder must be empty before deletion.', EACCES: 'Access denied.' }[error.code] || 'Request failed.';
      send(res, status, { error: error.status ? error.message : status === 500 ? 'Unexpected server error.' : fallback });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.NAS_HOST || '127.0.0.1';
  const port = Number(process.env.NAS_PORT || 3080);
  createServer().listen(port, host, () => console.log(`Lightweight AI NAS OS is running at http://${host}:${port}`));
}
