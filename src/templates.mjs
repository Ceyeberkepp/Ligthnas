import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { listStoragePools } from './storage-pools.mjs';

const PROXMOX_SYSTEM_URL = 'https://download.proxmox.com/images/system/';
const MAX_TEMPLATE_BYTES = Number(process.env.LIGHTNAS_TEMPLATE_MAX_BYTES || 4 * 1024 ** 3);
const templateName = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,180}\.(?:tar\.zst|tar\.xz|tar\.gz|tgz)$/i;

function safeFilename(value) {
  const name = String(value || '').trim().split('/').pop();
  if (!templateName.test(name || '')) throw Object.assign(new Error('Use a container template ending in .tar.zst, .tar.xz, .tar.gz, or .tgz.'), { status: 400 });
  return name;
}

function privateIp(address) {
  if (isIP(address) === 4) {
    const p = address.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  }
  return true;
}

async function validateUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw Object.assign(new Error('Enter a valid template URL.'), { status: 400 }); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('Template URLs must use HTTP or HTTPS without embedded credentials.'), { status: 400 });
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw Object.assign(new Error('Local/private template URLs are blocked. Upload the file instead.'), { status: 400 });
  const results = await lookup(url.hostname, { all: true });
  if (!results.length || results.some(item => privateIp(item.address))) throw Object.assign(new Error('Private or local template URLs are blocked. Upload the file instead.'), { status: 400 });
  return url;
}

async function safeFetch(value) {
  let url = await validateUrl(value);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'LightNAS/0.12 template-manager' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await validateUrl(new URL(response.headers.get('location'), url).toString());
      continue;
    }
    return { response, url };
  }
  throw Object.assign(new Error('Too many redirects while downloading the template.'), { status: 400 });
}

export async function templateStorageTargets() {
  const storage = await listStoragePools();
  return storage.pools
    .filter(pool => pool.online && pool.content.includes('vztmpl'))
    .map(pool => ({
      id: pool.id,
      label: pool.name,
      mountPoint: pool.mountPoint,
      kind: pool.local ? 'local' : 'virtual',
      writable: pool.writable,
      totalBytes: pool.totalBytes,
      availableBytes: pool.availableBytes,
      path: join(pool.root, 'template', 'cache')
    }));
}

async function targetFor(id, requireWritable = false) {
  const targets = await templateStorageTargets();
  const target = targets.find(item => item.id === id);
  if (!target) throw Object.assign(new Error('Select an available LightNAS storage target.'), { status: 400 });
  if (requireWritable && !target.writable) throw Object.assign(new Error(`${target.label} is not writable by LightNAS. Rerun the installer to grant access or choose another virtual storage.`), { status: 409 });
  return target;
}

function templateId(storageId, filename) {
  return `template:${Buffer.from(`${storageId}\0${filename}`).toString('base64url')}`;
}

export async function listContainerTemplates() {
  const targets = await templateStorageTargets();
  const templates = [];
  for (const target of targets) {
    try {
      const names = await readdir(target.path);
      for (const filename of names.filter(name => templateName.test(name))) {
        try {
          const file = join(target.path, filename);
          const info = await stat(file);
          if (!info.isFile()) continue;
          templates.push({
            id: templateId(target.id, filename),
            filename,
            name: filename.replace(/[-_](?:\d{8}|\d+(?:\.\d+)*)[-_].*$/, '').replaceAll('-', ' '),
            sizeBytes: info.size,
            storageId: target.id,
            storageLabel: target.label,
            path: file,
            source: 'local-template'
          });
        } catch {}
      }
    } catch {}
  }
  return { targets: targets.map(({ path, ...item }) => item), templates };
}

export async function resolveContainerTemplate(id) {
  const library = await listContainerTemplates();
  return library.templates.find(item => item.id === id) || null;
}

export async function proxmoxTemplateCatalog() {
  const { response } = await safeFetch(PROXMOX_SYSTEM_URL);
  if (!response.ok) throw Object.assign(new Error(`Proxmox template catalog returned HTTP ${response.status}.`), { status: 502 });
  const html = await response.text();
  const names = [...html.matchAll(/href="([^"]+\.(?:tar\.zst|tar\.xz|tar\.gz))"/gi)].map(match => decodeURIComponent(match[1]));
  const unique = [...new Set(names)].filter(name => templateName.test(name));
  return unique.map(filename => {
    const family = filename.split('-')[0].replace(/_/g, ' ');
    return {
      id: filename,
      filename,
      name: family.charAt(0).toUpperCase() + family.slice(1),
      url: new URL(filename, PROXMOX_SYSTEM_URL).toString(),
      source: 'Proxmox VE system templates'
    };
  }).sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}

function byteLimit() {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > MAX_TEMPLATE_BYTES) return callback(Object.assign(new Error('Template exceeds the configured maximum size.'), { status: 413 }));
      callback(null, chunk);
    }
  });
}

async function saveStream(stream, target, filename, contentLength = 0) {
  if (contentLength && contentLength > MAX_TEMPLATE_BYTES) throw Object.assign(new Error('Template exceeds the configured maximum size.'), { status: 413 });
  await mkdir(target.path, { recursive: true });
  const finalPath = join(target.path, filename);
  const temporary = `${finalPath}.part-${process.pid}-${Date.now()}`;
  try {
    await pipeline(stream, byteLimit(), createWriteStream(temporary, { flags: 'wx', mode: 0o640 }));
    await rename(temporary, finalPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const info = await stat(finalPath);
  return { id: templateId(target.id, filename), filename, storageId: target.id, storageLabel: target.label, sizeBytes: info.size };
}

export async function uploadContainerTemplate(storageId, filename, request) {
  const target = await targetFor(storageId, true);
  const safe = safeFilename(filename);
  const length = Number(request.headers['content-length'] || 0);
  return await saveStream(request, target, safe, length);
}

export async function importContainerTemplate({ storageId, url, proxmoxTemplate }) {
  const target = await targetFor(storageId, true);
  let source = String(url || '').trim();
  if (proxmoxTemplate) {
    const catalog = await proxmoxTemplateCatalog();
    const item = catalog.find(entry => entry.filename === proxmoxTemplate);
    if (!item) throw Object.assign(new Error('Choose a template from the current Proxmox catalog.'), { status: 400 });
    source = item.url;
  }
  const safeUrl = await validateUrl(source);
  const filename = safeFilename(safeUrl.pathname);
  const { response } = await safeFetch(safeUrl.toString());
  if (!response.ok || !response.body) throw Object.assign(new Error(`Template download failed with HTTP ${response.status}.`), { status: 502 });
  const length = Number(response.headers.get('content-length') || 0);
  return await saveStream(Readable.fromWeb(response.body), target, filename, length);
}

export async function deleteContainerTemplate(id) {
  const template = await resolveContainerTemplate(id);
  if (!template) throw Object.assign(new Error('Container template not found.'), { status: 404 });
  await rm(template.path, { force: true });
  return { id, deleted: true };
}

export const proxmoxTemplateSource = PROXMOX_SYSTEM_URL;
