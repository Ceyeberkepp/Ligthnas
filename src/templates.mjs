import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { listStoragePools } from './storage-pools.mjs';
import { architectureCompatible, hostArchitecture, normalizeArchitecture } from './platform.mjs';

const PROXMOX_IMAGES_BASE = 'https://download.proxmox.com/images/';
const SYSTEM_IMAGES_URL = `${PROXMOX_IMAGES_BASE}system/`;
const PVE_APLINFO_MAJOR = String(process.env.LIGHTNAS_PVE_APLINFO_MAJOR || '9').replace(/[^0-9]/g, '') || '9';
const PROXMOX_APLINFO_URL = `${PROXMOX_IMAGES_BASE}aplinfo-pve-${PVE_APLINFO_MAJOR}.dat`;
const PROXMOX_FALLBACK_APLINFO_URL = `${PROXMOX_IMAGES_BASE}aplinfo.dat`;
const TURNKEY_BASE = 'https://releases.turnkeylinux.org/pve/';
const TURNKEY_APLINFO_URL = `${TURNKEY_BASE}aplinfo.dat`;
const configuredTemplateLimit = Number(process.env.LIGHTNAS_TEMPLATE_MAX_BYTES || 0);
const MAX_TEMPLATE_BYTES = Number.isFinite(configuredTemplateLimit) && configuredTemplateLimit > 0 ? configuredTemplateLimit : 0;
const CATALOG_TIMEOUT_MS = Number(process.env.LIGHTNAS_TEMPLATE_CATALOG_TIMEOUT_MS || 30_000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.LIGHTNAS_TEMPLATE_DOWNLOAD_TIMEOUT_MS || 2 * 60 * 60_000);
const SPACE_RESERVE_BYTES = Number(process.env.LIGHTNAS_TEMPLATE_SPACE_RESERVE_BYTES || 128 * 1024 ** 2);
const templateName = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,180}\.(?:tar\.zst|tar\.xz|tar\.gz|tgz)$/i;
const HOST_ARCH = hostArchitecture();
const SHOW_INCOMPATIBLE = process.env.LIGHTNAS_SHOW_INCOMPATIBLE_TEMPLATES === '1';
const EMULATION_AVAILABLE = process.env.LIGHTNAS_CONTAINER_EMULATION === '1';

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

async function safeFetch(value, timeoutMs = CATALOG_TIMEOUT_MS) {
  let url = await validateUrl(value);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'LightNAS/0.12 template-manager' } });
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

function parseAplInfo(text, baseUrl, sourceName) {
  const records = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const record = {};
    let currentKey = null;
    for (const rawLine of block.split('\n')) {
      if (/^\s/.test(rawLine) && currentKey) {
        record[currentKey] = `${record[currentKey] || ''}\n${rawLine.trim()}`.trim();
        continue;
      }
      const match = rawLine.match(/^([^:]+):\s*(.*)$/);
      if (!match) continue;
      currentKey = match[1].trim().toLowerCase();
      record[currentKey] = match[2].trim();
    }
    if (record.type !== 'lxc' || !record.location || !record.package) continue;
    const filename = record.location.split('/').pop();
    if (!templateName.test(filename || '')) continue;
    records.push({
      id: `${sourceName}:${record.package}:${record.version || filename}`,
      filename,
      type: record.type,
      section: record.section || 'system',
      package: record.package,
      version: record.version || '',
      architecture: normalizeArchitecture(record.architecture || ''),
      compatible: architectureCompatible(record.architecture || '', HOST_ARCH, EMULATION_AVAILABLE),
      hostArchitecture: HOST_ARCH,
      name: record.package,
      description: record.description || record.package,
      os: record.os || null,
      url: new URL(record.location, baseUrl).toString(),
      source: sourceName,
      sha512: record.sha512sum || null,
      minimumRamBytes: 256 * 1024 ** 2,
      minimumStorageBytes: 1024 ** 3,
      cached: false
    });
  }
  return records;
}

async function fetchCatalogSource(url, baseUrl, sourceName) {
  const { response } = await safeFetch(url);
  if (!response.ok) throw new Error(`${sourceName} catalog returned HTTP ${response.status}`);
  return parseAplInfo(await response.text(), baseUrl, sourceName);
}

function friendlyTemplateName(filename) {
  return String(filename || '')
    .replace(/\.(?:tar\.zst|tar\.xz|tar\.gz|tgz)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bamd64\b|\bx86_64\b|\barm64\b|\baarch64\b/gi, match => match.toUpperCase())
    .trim();
}

async function fetchSystemDirectoryCatalog() {
  const { response } = await safeFetch(SYSTEM_IMAGES_URL);
  if (!response.ok) throw new Error(`System image catalog returned HTTP ${response.status}`);
  const html = await response.text();
  const seen = new Set();
  const records = [];
  for (const match of html.matchAll(/href=["']([^"'?#]+)["']/gi)) {
    let href = String(match[1] || '').trim();
    if (!href || href === '../' || href.endsWith('/')) continue;
    try { href = decodeURIComponent(href); } catch {}
    const filename = href.split('/').pop();
    if (!templateName.test(filename || '') || seen.has(filename)) continue;
    seen.add(filename);
    const base = friendlyTemplateName(filename);
    const osMatch = filename.match(/^([a-z0-9]+)[-_]/i);
    records.push({
      id: `system:${filename}`,
      filename,
      type: 'lxc',
      section: 'system',
      package: base,
      version: filename.match(/(?:^|[-_])(\d+(?:\.\d+){0,3})(?=[-_.])/i)?.[1] || '',
      architecture: /(?:amd64|x86_64)/i.test(filename) ? 'amd64'
        : /(?:arm64|aarch64)/i.test(filename) ? 'arm64'
        : /(?:riscv64)/i.test(filename) ? 'riscv64'
        : /(?:i386|i686|x86-32)/i.test(filename) ? 'i386'
        : /(?:armhf|armv7)/i.test(filename) ? 'armhf'
        : '',
      compatible: architectureCompatible(
        /(?:amd64|x86_64)/i.test(filename) ? 'amd64'
          : /(?:arm64|aarch64)/i.test(filename) ? 'arm64'
          : /(?:riscv64)/i.test(filename) ? 'riscv64'
          : /(?:i386|i686|x86-32)/i.test(filename) ? 'i386'
          : /(?:armhf|armv7)/i.test(filename) ? 'armhf'
          : '',
        HOST_ARCH,
        EMULATION_AVAILABLE
      ),
      hostArchitecture: HOST_ARCH,
      name: base,
      description: `${base} system container image`,
      os: osMatch?.[1]?.toLowerCase() || null,
      url: new URL(href, SYSTEM_IMAGES_URL).toString(),
      source: 'System catalog',
      sha512: null,
      minimumRamBytes: 256 * 1024 ** 2,
      minimumStorageBytes: 1024 ** 3,
      cached: false
    });
  }
  return records;
}

export async function proxmoxTemplateCatalog() {
  let systemDirectory = [];
  try { systemDirectory = await fetchSystemDirectoryCatalog(); }
  catch {}

  let primary = [];
  try {
    primary = await fetchCatalogSource(PROXMOX_APLINFO_URL, PROXMOX_IMAGES_BASE, 'System catalog');
  } catch {
    try { primary = await fetchCatalogSource(PROXMOX_FALLBACK_APLINFO_URL, PROXMOX_IMAGES_BASE, 'System catalog'); }
    catch {}
  }

  let appliances = [];
  try { appliances = await fetchCatalogSource(TURNKEY_APLINFO_URL, TURNKEY_BASE, 'Appliance catalog'); }
  catch {}

  const byFilename = new Map();
  for (const item of [...systemDirectory, ...primary, ...appliances]) {
    const existing = byFilename.get(item.filename);
    if (!existing || (!existing.sha512 && item.sha512)) byFilename.set(item.filename, { ...existing, ...item });
  }
  const combined = [...byFilename.values()];
  const visible = SHOW_INCOMPATIBLE ? combined : combined.filter(item => item.compatible !== false);
  if (!visible.length) throw Object.assign(new Error(`No compatible system container images are currently available for ${HOST_ARCH}.`), { status: 502 });
  return visible.sort((a, b) =>
    a.section.localeCompare(b.section) ||
    a.package.localeCompare(b.package, undefined, { numeric: true }) ||
    b.version.localeCompare(a.version, undefined, { numeric: true })
  );
}

function byteLimit() {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (MAX_TEMPLATE_BYTES > 0 && total > MAX_TEMPLATE_BYTES) return callback(Object.assign(new Error('Template exceeds the configured maximum size.'), { status: 413 }));
      callback(null, chunk);
    }
  });
}

export function normalizeTemplateTransferError(error) {
  if (error?.status) return error;
  const code = error?.code || error?.cause?.code;
  if (['AbortError', 'TimeoutError'].includes(error?.name) || ['ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return Object.assign(new Error('Template download timed out. Check the NAS internet connection or increase LIGHTNAS_TEMPLATE_DOWNLOAD_TIMEOUT_MS.'), { status: 504, cause: error });
  }
  if (code === 'ENOSPC') {
    return Object.assign(new Error('The selected storage ran out of free space while downloading the template.'), { status: 507, cause: error });
  }
  if (['EACCES', 'EPERM'].includes(code)) {
    return Object.assign(new Error('LightNAS cannot write to the selected storage. Rerun the installer or correct the storage permissions.'), { status: 403, cause: error });
  }
  if (['ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code)) {
    return Object.assign(new Error('The upstream template server could not be reached or closed the transfer. Check DNS and internet access, then try again.'), { status: 502, cause: error });
  }
  return error;
}

async function saveStream(stream, target, filename, contentLength = 0, expectedSha512 = null) {
  if (MAX_TEMPLATE_BYTES > 0 && contentLength && contentLength > MAX_TEMPLATE_BYTES) throw Object.assign(new Error('Template exceeds the configured maximum size.'), { status: 413 });
  if (contentLength && target.availableBytes > 0 && contentLength + SPACE_RESERVE_BYTES > target.availableBytes) {
    throw Object.assign(new Error('The selected storage does not have enough free space for this template and the safety reserve.'), { status: 507 });
  }
  await mkdir(target.path, { recursive: true });
  const finalPath = join(target.path, filename);
  const temporary = `${finalPath}.part-${process.pid}-${Date.now()}`;
  const hash = expectedSha512 ? createHash('sha512') : null;
  const verify = new Transform({
    transform(chunk, encoding, callback) {
      if (hash) hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(stream, byteLimit(), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o640 }));
    if (hash) {
      const actual = hash.digest('hex').toLowerCase();
      if (actual !== String(expectedSha512).toLowerCase()) {
        throw Object.assign(new Error('Template checksum did not match the upstream catalog. The downloaded file was rejected.'), { status: 502 });
      }
    }
    await rename(temporary, finalPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw normalizeTemplateTransferError(error);
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
  let expectedSha512 = null;
  if (proxmoxTemplate) {
    const catalog = await proxmoxTemplateCatalog();
    const item = catalog.find(entry => entry.id === proxmoxTemplate || entry.filename === proxmoxTemplate);
    if (!item) throw Object.assign(new Error('Choose a template from the current upstream catalog.'), { status: 400 });
    if (item.compatible === false && !EMULATION_AVAILABLE) {
      throw Object.assign(new Error(`The selected container image is for ${item.architecture || 'another architecture'}; this host is ${HOST_ARCH} and emulation is not enabled.`), { status: 409 });
    }
    source = item.url;
    expectedSha512 = item.sha512 || null;
  }
  const safeUrl = await validateUrl(source);
  let response;
  let finalUrl = safeUrl;
  let lastError = null;

  // Pulls can briefly fail when an upstream mirror/CDN rotates, rate-limits,
  // or closes an idle connection. Retry transient failures automatically so a
  // normal "Pull image" action does not require the administrator to repeat it.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      ({ response, url: finalUrl } = await safeFetch(safeUrl.toString(), DOWNLOAD_TIMEOUT_MS));
      if (response.ok && response.body) break;
      const transient = response.status === 429 || response.status >= 500;
      if (!transient) {
        throw Object.assign(new Error(`Template download failed with HTTP ${response.status}.`), { status: 502 });
      }
      lastError = Object.assign(new Error(`Template download failed with HTTP ${response.status}.`), { status: 502 });
    } catch (error) {
      lastError = normalizeTemplateTransferError(error);
    }
    if (attempt < 3) await delay(attempt * 750);
  }

  if (!response?.ok || !response.body) {
    throw lastError || Object.assign(new Error('Template download failed after three attempts.'), { status: 502 });
  }

  // A catalog/CDN may redirect to the real archive filename. Use the final URL
  // rather than the original request URL so redirected image pulls are saved
  // with the correct .tar.zst/.tar.xz/.tar.gz filename.
  const filename = safeFilename(finalUrl.pathname);
  const length = Number(response.headers.get('content-length') || 0);
  return await saveStream(Readable.fromWeb(response.body), target, filename, length, expectedSha512);
}

export async function deleteContainerTemplate(id) {
  const template = await resolveContainerTemplate(id);
  if (!template) throw Object.assign(new Error('Container template not found.'), { status: 404 });
  await rm(template.path, { force: true });
  return { id, deleted: true };
}

export const proxmoxTemplateSource = PROXMOX_APLINFO_URL;
export const containerTemplateSources = [PROXMOX_APLINFO_URL, TURNKEY_APLINFO_URL];