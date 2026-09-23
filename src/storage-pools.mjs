import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getStorageInventory } from './system.mjs';

const dataRoot = dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json'));
const configPath = process.env.LIGHTNAS_STORAGE_CONFIG || join(dataRoot, 'storage-pools.json');
const localRoot = process.env.LIGHTNAS_LOCAL_STORAGE_ROOT || join(dataRoot, 'storage', 'local');
const MAX_UPLOAD_BYTES = Number(process.env.LIGHTNAS_STORAGE_UPLOAD_MAX_BYTES || 50 * 1024 ** 3);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.LIGHTNAS_STORAGE_DOWNLOAD_TIMEOUT_MS || 12 * 60 * 60_000);
const SPACE_RESERVE_BYTES = Number(process.env.LIGHTNAS_STORAGE_SPACE_RESERVE_BYTES || 128 * 1024 ** 2);

export const STORAGE_CONTENT = Object.freeze([
  { id: 'iso', label: 'ISO images', directory: 'template/iso' },
  { id: 'vztmpl', label: 'Container templates', directory: 'template/cache' },
  { id: 'images', label: 'VM disks', directory: 'images' },
  { id: 'rootdir', label: 'Container volumes', directory: 'rootdir' },
  { id: 'backup', label: 'Backups', directory: 'dump' },
  { id: 'snippets', label: 'Snippets', directory: 'snippets' },
  { id: 'files', label: 'Files', directory: 'files' }
]);

const CONTENT_BY_ID = new Map(STORAGE_CONTENT.map(item => [item.id, item]));
const poolName = /^[A-Za-z][A-Za-z0-9_-]{1,31}$/;
const extensions = {
  iso: ['.iso'],
  vztmpl: ['.tar.zst', '.tar.xz', '.tar.gz', '.tgz'],
  images: ['.qcow2', '.raw', '.vmdk', '.vhd', '.vhdx'],
  backup: ['.vma', '.vma.zst', '.vma.gz', '.tar.zst', '.tar.gz'],
  snippets: ['.txt', '.conf', '.cfg', '.yaml', '.yml', '.json', '.sh'],
  files: null
};

export function visibleStorageContentName(name, type) {
  const value = String(name || '');
  // Uploads are written to hidden .part files and atomically renamed only
  // after the final byte arrives. A browser/server interruption can leave a
  // staging file behind; it must never appear as usable VM media.
  if (!value || value.startsWith('.') || /(?:\.part|\.tmp)(?:-|$)/i.test(value)) return false;
  const allowed = extensions[type];
  return !allowed || allowed.some(suffix => value.toLowerCase().endsWith(suffix));
}

function normalizeContent(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  return [...new Set(input.map(String).filter(item => CONTENT_BY_ID.has(item)))];
}

const defaultLocalContent = ['iso', 'vztmpl', 'images', 'rootdir', 'backup', 'snippets', 'files'];

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    return {
      localContent: normalizeContent(parsed?.localContent, defaultLocalContent),
      pools: Array.isArray(parsed?.pools) ? parsed.pools : []
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { localContent: [...defaultLocalContent], pools: [] };
    throw error;
  }
}

async function saveConfig(config) {
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, localContent: normalizeContent(config.localContent, defaultLocalContent), pools: config.pools || [] }, null, 2), { mode: 0o600 });
  await rename(temporary, configPath);
}

function safeFilename(value, type) {
  const name = String(value || '').trim().split('/').pop();
  if (!name || name === '.' || name === '..' || /[\\\0]/.test(name) || name.length > 220) {
    throw Object.assign(new Error('Invalid storage filename.'), { status: 400 });
  }
  const allowed = extensions[type];
  if (allowed && !allowed.some(suffix => name.toLowerCase().endsWith(suffix))) {
    throw Object.assign(new Error(`File type is not valid for ${CONTENT_BY_ID.get(type)?.label || type}.`), { status: 400 });
  }
  return name;
}

function contentDirectory(root, type) {
  const spec = CONTENT_BY_ID.get(type);
  if (!spec) throw Object.assign(new Error('Unknown storage content type.'), { status: 400 });
  return join(root, spec.directory);
}

async function ensureLayout(root, content) {
  await mkdir(root, { recursive: true });
  for (const type of content) await mkdir(contentDirectory(root, type), { recursive: true });
}

function sourceForPool(pool, inventory) {
  if (pool.id === 'local') {
    return {
      id: 'local',
      mountPoint: inventory.local?.mountPoint || '/',
      totalBytes: inventory.local?.totalBytes || 0,
      availableBytes: inventory.local?.availableBytes || 0,
      usedBytes: inventory.local?.usedBytes || 0,
      usedPercent: inventory.local?.totalBytes
        ? Math.round(((inventory.local.totalBytes - inventory.local.availableBytes) / inventory.local.totalBytes) * 100)
        : 0,
      writable: true,
      readOnly: false,
      type: 'local',
      dedicated: Boolean(inventory.local?.dedicated)
    };
  }
  return inventory.attachedVolumes.find(item => item.id === pool.sourceId) || null;
}

function publicPool(pool, source) {
  return {
    id: pool.id,
    name: pool.name,
    sourceId: pool.sourceId,
    mountPoint: source?.mountPoint || pool.mountPoint || null,
    root: pool.root,
    content: normalizeContent(pool.content),
    contentLabels: normalizeContent(pool.content).map(type => CONTENT_BY_ID.get(type)?.label || type),
    totalBytes: source?.totalBytes || 0,
    availableBytes: source?.availableBytes || 0,
    usedBytes: source?.usedBytes || 0,
    usedPercent: source?.usedPercent || 0,
    writable: Boolean(source?.writable !== false && !source?.readOnly),
    online: Boolean(source),
    local: pool.id === 'local',
    dedicated: pool.id === 'local' ? Boolean(source?.dedicated) : true,
    createdAt: pool.createdAt || null
  };
}

export async function listStoragePools() {
  const inventory = await getStorageInventory();
  const config = await readConfig();
  const local = {
    id: 'local',
    name: 'local',
    sourceId: 'local',
    mountPoint: inventory.local?.mountPoint || '/',
    root: localRoot,
    content: config.localContent,
    createdAt: null
  };
  await ensureLayout(local.root, local.content).catch(() => {});

  const pools = [local, ...config.pools].map(pool => publicPool(pool, sourceForPool(pool, inventory)));
  const configuredSources = new Set(config.pools.map(pool => pool.sourceId));
  const availableSources = inventory.attachedVolumes.map(volume => ({
    id: volume.id,
    mountPoint: volume.mountPoint,
    device: volume.device,
    type: volume.type,
    totalBytes: volume.totalBytes,
    availableBytes: volume.availableBytes,
    usedBytes: volume.usedBytes,
    usedPercent: volume.usedPercent,
    writable: Boolean(volume.writable && !volume.readOnly),
    configured: configuredSources.has(volume.id),
    capacitySource: volume.capacitySource || 'filesystem',
    configuredSize: volume.configuredSize || null,
    reportedFilesystemBytes: volume.reportedFilesystemBytes || volume.totalBytes
  }));

  const summary = pools.filter(pool => pool.online).reduce((result, pool) => {
    result.totalBytes += pool.totalBytes;
    result.availableBytes += pool.availableBytes;
    result.usedBytes += pool.usedBytes;
    result.count += 1;
    return result;
  }, { totalBytes: 0, availableBytes: 0, usedBytes: 0, count: 0 });
  summary.usedPercent = summary.totalBytes ? Math.round((summary.usedBytes / summary.totalBytes) * 100) : 0;

  return {
    pools,
    availableSources,
    summary,
    visibleSummary: inventory.usableStorage || summary,
    contentTypes: STORAGE_CONTENT
  };
}

export async function createStoragePool(input) {
  const name = String(input?.name || '').trim();
  const sourceId = String(input?.sourceId || '').trim();
  if (!poolName.test(name)) throw Object.assign(new Error('Storage name must contain 2–32 letters, numbers, underscores, or hyphens and start with a letter.'), { status: 400 });
  if (name.toLowerCase() === 'local') throw Object.assign(new Error('local is reserved for the default LightNAS storage.'), { status: 409 });
  const content = normalizeContent(input?.content, ['iso', 'vztmpl', 'images', 'rootdir', 'backup']);
  if (!content.length) throw Object.assign(new Error('Select at least one allowed content type.'), { status: 400 });

  const inventory = await getStorageInventory();
  const source = inventory.attachedVolumes.find(item => item.id === sourceId);
  if (!source) throw Object.assign(new Error('Select an attached virtual storage volume.'), { status: 400 });
  if (source.readOnly || !source.writable) throw Object.assign(new Error('The selected virtual storage is read-only to LightNAS.'), { status: 409 });

  const config = await readConfig();
  if (config.pools.some(pool => pool.id.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('A storage with this name already exists.'), { status: 409 });
  if (config.pools.some(pool => pool.sourceId === sourceId)) throw Object.assign(new Error('This virtual volume is already assigned to a LightNAS storage. Edit that storage instead.'), { status: 409 });

  const root = join(source.mountPoint, '.lightnas', 'storage', name);
  await ensureLayout(root, content);
  const pool = {
    id: name,
    name,
    sourceId,
    mountPoint: source.mountPoint,
    root,
    content,
    createdAt: new Date().toISOString()
  };
  config.pools.push(pool);
  await saveConfig(config);
  return publicPool(pool, source);
}

export async function updateStoragePool(id, input) {
  const config = await readConfig();
  const content = normalizeContent(input?.content, id === 'local' ? config.localContent : []);
  if (!content.length) throw Object.assign(new Error('Select at least one allowed content type.'), { status: 400 });

  if (id === 'local') {
    config.localContent = content;
    await ensureLayout(localRoot, content);
    await saveConfig(config);
    const inventory = await getStorageInventory();
    return publicPool({
      id: 'local', name: 'local', sourceId: 'local',
      mountPoint: inventory.local?.mountPoint || '/', root: localRoot,
      content, createdAt: null
    }, sourceForPool({ id: 'local' }, inventory));
  }

  const pool = config.pools.find(item => item.id === id);
  if (!pool) throw Object.assign(new Error('Storage not found.'), { status: 404 });
  pool.content = content;
  await ensureLayout(pool.root, content);
  await saveConfig(config);
  const inventory = await getStorageInventory();
  return publicPool(pool, sourceForPool(pool, inventory));
}

export async function deleteStoragePool(id) {
  if (id === 'local') throw Object.assign(new Error('The local storage is permanent.'), { status: 409 });
  const config = await readConfig();
  const index = config.pools.findIndex(item => item.id === id);
  if (index < 0) throw Object.assign(new Error('Storage not found.'), { status: 404 });
  const [pool] = config.pools.splice(index, 1);
  await saveConfig(config);
  return { id: pool.id, removed: true, filesPreserved: true };
}

export async function resolveStoragePool(id, requiredType = null, requireWritable = false) {
  const { pools } = await listStoragePools();
  const pool = pools.find(item => item.id === id);
  if (!pool || !pool.online) throw Object.assign(new Error('Storage is offline or unavailable.'), { status: 409 });
  if (requiredType && !pool.content.includes(requiredType)) throw Object.assign(new Error(`${pool.name} is not configured for ${CONTENT_BY_ID.get(requiredType)?.label || requiredType}.`), { status: 409 });
  if (requireWritable && !pool.writable) throw Object.assign(new Error(`${pool.name} is read-only.`), { status: 409 });
  return pool;
}

export async function listStorageContent(poolId, type) {
  const pool = await resolveStoragePool(poolId, type, false);
  const directory = contentDirectory(pool.root, type);
  try {
    const entries = [];
    for (const name of await readdir(directory)) {
      if (!visibleStorageContentName(name, type)) continue;
      try {
        const info = await stat(join(directory, name));
        if (info.isFile()) entries.push({ name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {}
    }
    return { pool, type, directory, entries: entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
  } catch {
    return { pool, type, directory, entries: [] };
  }
}

export async function listContentAcrossPools(type) {
  const { pools } = await listStoragePools();
  const results = [];
  for (const pool of pools.filter(item => item.online && item.content.includes(type))) {
    const content = await listStorageContent(pool.id, type);
    for (const entry of content.entries) {
      results.push({
        id: `${pool.id}:${type}/${entry.name}`,
        storageId: pool.id,
        storageName: pool.name,
        type,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        path: join(content.directory, entry.name)
      });
    }
  }
  return results;
}

function byteLimit() {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) return callback(Object.assign(new Error('Upload exceeds the configured maximum size.'), { status: 413 }));
      callback(null, chunk);
    }
  });
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end || total > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('Invalid or oversized chunked upload range.'), { status: 400 });
  }
  return { start, end, total, length: end - start + 1 };
}

export async function uploadStorageContent(poolId, type, filename, request) {
  const pool = await resolveStoragePool(poolId, type, true);
  const name = safeFilename(filename, type);
  const length = Number(request.headers['content-length'] || 0);
  const range = parseContentRange(request.headers['content-range']);
  const uploadId = String(request.headers['x-lightnas-upload-id'] || '');
  if (range && !/^[A-Za-z0-9-]{20,80}$/.test(uploadId)) {
    throw Object.assign(new Error('Chunked uploads require a valid upload identifier.'), { status: 400 });
  }
  const expectedLength = range?.length || length;
  const totalLength = range?.total || length;
  if (expectedLength && length && expectedLength !== length) throw Object.assign(new Error('Upload chunk length does not match Content-Range.'), { status: 400 });
  if (totalLength && totalLength > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Upload exceeds the 50 GiB maximum size.'), { status: 413 });
  if (totalLength && pool.availableBytes > 0 && totalLength + SPACE_RESERVE_BYTES > pool.availableBytes) {
    throw Object.assign(new Error('The selected storage does not have enough free space for this upload and the safety reserve.'), { status: 507 });
  }
  const directory = contentDirectory(pool.root, type);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, name);
  const temporary = range ? join(directory, `.${name}.${uploadId}.part`) : `${destination}.part-${process.pid}-${Date.now()}`;
  try {
    if (range?.start) {
      const current = await stat(temporary).catch(() => null);
      if (!current || current.size !== range.start) {
        throw Object.assign(new Error(`Upload resume position mismatch. Server has ${current?.size || 0} bytes; browser expected ${range.start}.`), { status: 409 });
      }
    } else if (range) {
      await rm(temporary, { force: true });
    }
    await pipeline(request, byteLimit(), createWriteStream(temporary, { flags: range?.start ? 'a' : 'wx', mode: 0o640 }));
    const received = (await stat(temporary)).size;
    if (range && received !== range.end + 1) throw Object.assign(new Error('The uploaded chunk was incomplete.'), { status: 400 });
    if (range && received < range.total) {
      return { poolId, type, name, complete: false, receivedBytes: received, totalBytes: range.total };
    }
    await rename(temporary, destination);
  } catch (error) {
    if (!range || error.status !== 409) await rm(temporary, { force: true }).catch(() => {});
    throw normalizeStorageTransferError(error);
  }
  const info = await stat(destination);
  return { poolId, type, name, complete: true, receivedBytes: info.size, totalBytes: info.size, sizeBytes: info.size };
}

function privateIp(address) {
  if (isIP(address) === 4) {
    const p = address.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  if (isIP(address) === 6) {
    const v = address.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
  }
  return true;
}

async function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('Enter a valid HTTP or HTTPS URL.'), { status: 400 }); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Only HTTP/HTTPS URLs without embedded credentials are supported.'), { status: 400 });
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => privateIp(item.address))) throw Object.assign(new Error('Private/local URLs are blocked. Upload the file instead.'), { status: 400 });
  return url;
}

export function normalizeStorageTransferError(error) {
  if (error?.status) return error;
  const code = error?.code || error?.cause?.code;
  if (['AbortError', 'TimeoutError'].includes(error?.name) || ['ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return Object.assign(new Error('Image download timed out. Check the NAS internet connection or increase LIGHTNAS_STORAGE_DOWNLOAD_TIMEOUT_MS.'), { status: 504, cause: error });
  }
  if (code === 'ENOSPC') {
    return Object.assign(new Error('The selected storage ran out of free space during the image transfer.'), { status: 507, cause: error });
  }
  if (['EACCES', 'EPERM'].includes(code)) {
    return Object.assign(new Error('LightNAS cannot write to the selected storage. Correct its permissions or select another storage.'), { status: 403, cause: error });
  }
  if (['ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code)) {
    return Object.assign(new Error('The image server could not be reached or closed the transfer. Check DNS and internet access, then try again.'), { status: 502, cause: error });
  }
  return error;
}

export async function importStorageContent(poolId, type, inputUrl) {
  const pool = await resolveStoragePool(poolId, type, true);
  let url = await validatePublicUrl(inputUrl);
  let response;
  try {
    for (let hop = 0; hop < 5; hop += 1) {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'User-Agent': 'LightNAS/0.12 storage-manager' } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        url = await validatePublicUrl(new URL(response.headers.get('location'), url).toString());
        continue;
      }
      break;
    }
  } catch (error) {
    throw normalizeStorageTransferError(error);
  }
  if (!response?.ok || !response.body) throw Object.assign(new Error(`Download failed with HTTP ${response?.status || 'unknown'}.`), { status: 502 });
  const name = safeFilename(url.pathname, type);
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Download exceeds the configured maximum size.'), { status: 413 });
  if (length && pool.availableBytes > 0 && length + SPACE_RESERVE_BYTES > pool.availableBytes) {
    throw Object.assign(new Error('The selected storage does not have enough free space for this image and the safety reserve.'), { status: 507 });
  }
  const directory = contentDirectory(pool.root, type);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, name);
  const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
  try {
    await pipeline(Readable.fromWeb(response.body), byteLimit(), createWriteStream(temporary, { flags: 'wx', mode: 0o640 }));
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw normalizeStorageTransferError(error);
  }
  const info = await stat(destination);
  return { poolId, type, name, sizeBytes: info.size };
}

export async function deleteStorageContent(poolId, type, filename) {
  const pool = await resolveStoragePool(poolId, type, true);
  const name = safeFilename(filename, type);
  await rm(join(contentDirectory(pool.root, type), name), { force: true });
  return { poolId, type, name, deleted: true };
}
