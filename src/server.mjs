import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.mjs';
import { getFilesystems, getStorageInventory, getSystemSnapshot } from './system.mjs';
import { hashPassword, Sessions, verifyPassword } from './auth.mjs';
import { listFiles, createFolder, uploadFile, downloadFile, deleteEntry } from './files.mjs';
import { catalog, runtimeInventory, installCatalogApp, createContainer, createVm } from './runtimes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = join(root, 'public');
const store = new JsonStore();
const sessions = new Sessions();
await store.load();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
    ...headers
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
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const [key, ...value] = item.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function requireSession(req, res) {
  const session = sessions.get(cookies(req).nas_session);
  if (!session) {
    send(res, 401, { error: 'Authentication required.' });
    return null;
  }
  return session;
}

function validateSetup(input) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,31}$/.test(input.deviceName || '')) return 'Device name must contain 2–32 letters, numbers, or hyphens.';
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(input.username || '')) return 'Administrator username must contain 3–32 valid characters.';
  if (typeof input.password !== 'string' || input.password.length < 10) return 'Password must contain at least 10 characters.';
  return null;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { version: '0.5.0', setupRequired: !store.state.config });
  }

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
      createdAt: new Date().toISOString()
    };
    store.addActivity('setup', `Appliance ${input.deviceName} was configured.`, 'success');
    await store.save();
    const token = sessions.create(input.username);
    return send(res, 201, { ok: true }, { 'Set-Cookie': `nas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!store.state.config) return send(res, 409, { error: 'Complete setup first.' });
    const input = await bodyJson(req);
    const validUser = input.username === store.state.config.username;
    const validPassword = validUser && await verifyPassword(input.password, store.state.config.passwordHash);
    if (!validPassword) return send(res, 401, { error: 'Username or password is incorrect.' });
    const token = sessions.create(input.username);
    store.addActivity('login', `Administrator ${input.username} signed in.`, 'info');
    await store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `nas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(cookies(req).nas_session);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'nas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const session = requireSession(req, res);
  if (!session) return;

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const { username, deviceName, timezone } = store.state.config;
    return send(res, 200, { username, deviceName, timezone });
  }
  if (req.method === 'GET' && url.pathname === '/api/runtimes') return send(res, 200, { ...(await runtimeInventory()), catalog });
  if (req.method === 'POST' && /^\/api\/catalog\/[a-z0-9-]+\/install$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const installed = await installCatalogApp(id);
    store.addActivity('app', `Catalog app ${id} was installed as a Docker container.`);
    await store.save();
    return send(res, 201, installed);
  }
  if (req.method === 'POST' && url.pathname === '/api/containers') {
    const created = await createContainer(await bodyJson(req));
    store.addActivity('container', `Container ${created.name} was created.`);
    await store.save();
    return send(res, 201, created);
  }
  if (req.method === 'POST' && url.pathname === '/api/vms') {
    const created = await createVm(await bodyJson(req));
    store.addActivity('vm', `Virtual machine ${created.name} was created.`);
    await store.save();
    return send(res, 201, created);
  }
  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    const input = await bodyJson(req);
    if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, store.state.config.passwordHash))) {
      return send(res, 403, { error: 'Current administrator password is incorrect.' });
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,31}$/.test(input.deviceName || '')) {
      return send(res, 400, { error: 'Device name must contain 2–32 letters, numbers, or hyphens.' });
    }
    if (!['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'].includes(input.timezone)) {
      return send(res, 400, { error: 'Choose a supported time zone.' });
    }
    const changedPassword = Boolean(input.newPassword);
    if (changedPassword && (typeof input.newPassword !== 'string' || input.newPassword.length < 10)) {
      return send(res, 400, { error: 'New password must contain at least 10 characters.' });
    }
    store.state.config.deviceName = input.deviceName;
    store.state.config.timezone = input.timezone;
    if (changedPassword) store.state.config.passwordHash = await hashPassword(input.newPassword);
    store.addActivity('settings', changedPassword ? 'Administrator password was changed.' : 'Appliance settings were updated.');
    await store.save();
    if (changedPassword) sessions.clear();
    return send(res, 200, { ok: true, signInRequired: changedPassword }, changedPassword ? { 'Set-Cookie': 'nas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' } : {});
  }

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const [system, filesystems, storage] = await Promise.all([getSystemSnapshot(), getFilesystems(), getStorageInventory()]);
    return send(res, 200, {
      appliance: { deviceName: store.state.config.deviceName, username: session.username, timezone: store.state.config.timezone },
      system,
      filesystems,
      storage,
      shares: store.state.shares,
      activity: store.state.activity.slice(0, 8)
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/system') return send(res, 200, await getSystemSnapshot());
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    const [filesystems, storage] = await Promise.all([getFilesystems(), getStorageInventory()]);
    return send(res, 200, { filesystems, ...storage });
  }
  if (req.method === 'GET' && url.pathname === '/api/shares') return send(res, 200, { shares: store.state.shares });
  if (url.pathname === '/api/files') {
    const path = url.searchParams.get('path') || '';
    if (req.method === 'GET') return send(res, 200, { path, entries: await listFiles(path) });
    if (req.method === 'POST') { await createFolder(path); store.addActivity('file', `Folder ${path} was created.`); await store.save(); return send(res, 201, { ok: true }); }
    if (req.method === 'PUT') { await uploadFile(path, req); store.addActivity('file', `File ${path} was uploaded.`); await store.save(); return send(res, 201, { ok: true }); }
    if (req.method === 'DELETE') { await deleteEntry(path); store.addActivity('file', `File entry ${path} was deleted.`); await store.save(); return send(res, 200, { ok: true }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/files/download') {
    const path = url.searchParams.get('path') || '';
    const filename = path.split('/').pop();
    const data = await downloadFile(path);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(data);
  }

  if (req.method === 'POST' && url.pathname === '/api/shares') {
    const input = await bodyJson(req);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,63}$/.test(input.name || '')) return send(res, 400, { error: 'Share name must contain 2–64 valid characters.' });
    if (store.state.shares.some((share) => share.name.toLowerCase() === input.name.toLowerCase())) return send(res, 409, { error: 'A share with this name already exists.' });
    const share = {
      id: crypto.randomUUID(),
      name: input.name,
      protocol: ['SMB', 'NFS', 'SFTP'].includes(input.protocol) ? input.protocol : 'SMB',
      description: String(input.description || '').slice(0, 160),
      createdAt: new Date().toISOString()
    };
    store.state.shares.push(share);
    store.addActivity('share', `Share plan ${share.name} was saved for ${share.protocol}.`, 'info');
    await store.save();
    return send(res, 201, { share });
  }
  if (req.method === 'DELETE' && /^\/api\/shares\/[0-9a-f-]{36}$/.test(url.pathname)) {
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
      'Content-Type': mimeTypes[extname(path)] || 'application/octet-stream',
      'Cache-Control': extname(path) === '.js' || extname(path) === '.css' || extname(path) === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'"
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
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await staticFile(req, res, url);
    } catch (error) {
      const status = error.status || ({ ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403 }[error.code] || 500);
      if (status >= 500) console.error(error);
      send(res, status, { error: status === 500 ? 'Unexpected server error.' : error.status ? error.message : ({ ENOENT: 'File or folder not found.', EEXIST: 'File or folder already exists.', ENOTEMPTY: 'Folder must be empty before deletion.', EACCES: 'Access denied.' }[error.code] || 'Request failed.') });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.NAS_HOST || '127.0.0.1';
  const port = Number(process.env.NAS_PORT || 3080);
  createServer().listen(port, host, () => console.log(`Lightweight AI NAS OS is running at http://${host}:${port}`));
}
