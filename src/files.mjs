import { access, constants, mkdir, readdir, lstat, unlink, rmdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const root = join(dirname(process.env.NAS_DATA_FILE || 'data/state.json'), 'files');
const configuredUploadLimit = Number(process.env.LIGHTNAS_FILE_UPLOAD_MAX_BYTES || 0);
const MAX_UPLOAD = Number.isFinite(configuredUploadLimit) && configuredUploadLimit > 0 ? configuredUploadLimit : 0;
const ATTACHED_ROOT = 'Attached storage';
const MEDIA_LIBRARY_ROOTS = ['Documents', 'Photos', 'Videos', 'Audio'];
const infrastructureImageSuffixes = [
  '.iso', '.img', '.qcow', '.qcow2', '.vmdk', '.vhd', '.vhdx', '.ova', '.ovf',
  '.vma', '.vma.zst', '.vma.gz', '.tar.zst', '.tar.xz', '.tgz'
];
const allFilesCache = new Map();
const quotaReservations = new Map();
const chunkUploads = new Map();

function infrastructureFile(name) {
  const value = String(name || '').toLowerCase();
  return infrastructureImageSuffixes.some(suffix => value.endsWith(suffix));
}

function invalidateAllFilesCache() {
  allFilesCache.clear();
}

function parts(relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || relative.includes('\\') || relative.includes('\0')) throw Object.assign(new Error('Invalid file path.'), { status: 400 });
  const segments = relative.split('/').filter(Boolean);
  if (segments.some(item => item === '.' || item === '..' || !/^[^\x00-\x1f/]{1,255}$/.test(item))) throw Object.assign(new Error('Invalid file path.'), { status: 400 });
  return segments;
}

function ignoredMount(mountPoint, type) {
  const virtual = /^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2?|overlay|squashfs|securityfs|pstore|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|rpc_pipefs|autofs|binfmt_misc)$/;
  return virtual.test(type) || mountPoint === '/' || mountPoint === '/boot' || mountPoint === '/boot/efi' ||
    mountPoint === '/etc/hosts' || mountPoint === '/etc/hostname' || mountPoint === '/etc/resolv.conf' ||
    mountPoint === '/var/lib/lightnas-pve' || mountPoint.startsWith('/var/lib/lightnas-pve/');
}

async function attachedVolumes() {
  let mounts = '';
  try { mounts = await readFile('/proc/mounts', 'utf8'); } catch { return []; }
  const records = [];
  for (const line of mounts.trim().split('\n')) {
    const [device, encoded, type, options] = line.split(' ');
    if (!device || !encoded) continue;
    records.push({ device, mountPoint: encoded.replaceAll('\\040', ' '), type, options: options || '' });
  }
  const rootDevice = records.find(item => item.mountPoint === '/')?.device;
  const explicitDataPath = mountPoint => /^(\/mnt|\/media|\/srv|\/data|\/storage)(\/|$)/.test(mountPoint);
  const usedNames = new Set();
  const volumes = [];
  for (const record of records) {
    const { device, mountPoint, type, options } = record;
    if (ignoredMount(mountPoint, type)) continue;
    if (device === rootDevice && !explicitDataPath(mountPoint)) continue;
    let writable = !options.split(',').includes('ro');
    if (writable) {
      try { await access(mountPoint, constants.W_OK); }
      catch { writable = false; }
    }
    let name = mountPoint.split('/').filter(Boolean).join('-').replace(/[^a-zA-Z0-9._ -]/g, '-').slice(0, 100) || 'storage';
    const base = name;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) name = `${base}-${suffix++}`;
    usedNames.add(name.toLowerCase());
    volumes.push({ name, mountPoint, device, type, writable, readOnly: !writable });
  }
  return volumes;
}

async function checked(relative, expectExisting = true) {
  const segments = parts(relative);
  let path;
  let start = 0;
  let attachedVolume = null;

  if (segments[0] === ATTACHED_ROOT) {
    if (segments.length < 2) throw Object.assign(new Error('Select an attached storage volume.'), { status: 400 });
    attachedVolume = (await attachedVolumes()).find(item => item.name === segments[1]);
    if (!attachedVolume) throw Object.assign(new Error('Attached storage volume is no longer available.'), { status: 404 });
    if (attachedVolume.readOnly && !expectExisting) throw Object.assign(new Error(`LightNAS does not have write permission on ${attachedVolume.mountPoint}. Fix the Proxmox mount/ownership permissions, then refresh.`), { status: 403 });
    path = attachedVolume.mountPoint;
    start = 2;
  } else {
    await mkdir(root, { recursive: true, mode: 0o700 });
    path = root;
  }

  for (let i = start; i < segments.length; i++) {
    path = join(path, segments[i]);
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw Object.assign(new Error('Links are not supported.'), { status: 400 });
      if (i < segments.length - 1 && !entry.isDirectory()) throw Object.assign(new Error('Parent is not a folder.'), { status: 400 });
    } catch (error) {
      if (error.code !== 'ENOENT' || i < segments.length - 1 || expectExisting) throw error;
    }
  }
  return path;
}

async function directoryEntries(path) {
  return await Promise.all((await readdir(path)).map(async name => {
    const info = await lstat(join(path, name));
    return { name, directory: info.isDirectory(), sizeBytes: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString(), supported: info.isFile() || info.isDirectory() };
  }));
}

async function directorySize(path) {
  let total = 0;
  let names = [];
  try { names = await readdir(path); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (let offset = 0; offset < names.length; offset += 48) {
    const batch = names.slice(offset, offset + 48);
    const inspected = await Promise.all(batch.map(async name => {
      const absolute = join(path, name);
      try { return { absolute, info: await lstat(absolute) }; }
      catch { return null; }
    }));
    for (const item of inspected) {
      if (!item || item.info.isSymbolicLink()) continue;
      if (item.info.isFile()) total += item.info.size;
      else if (item.info.isDirectory()) total += await directorySize(item.absolute);
    }
  }
  return total;
}

export async function fileUsage(relative = '') {
  const path = await checked(relative, false);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return await directorySize(path);
}

async function recursiveFileEntries(path, prefix = '', output = [], limits = { count: 0, max: 10000 }) {
  if (limits.count >= limits.max) return output;
  let names = [];
  try { names = await readdir(path); } catch { return output; }

  // Metadata reads dominate large All Files scans. Process a bounded batch in
  // parallel so slow HDD/NAS mounts do not serialize thousands of lstat calls,
  // while keeping memory/IO pressure reasonable on the 2 GiB target.
  const directories = [];
  for (let offset = 0; offset < names.length && limits.count < limits.max; offset += 48) {
    const batch = names.slice(offset, offset + 48);
    const inspected = await Promise.all(batch.map(async name => {
      const absolute = join(path, name);
      try { return { name, absolute, info: await lstat(absolute) }; }
      catch { return null; }
    }));

    for (const item of inspected) {
      if (!item || limits.count >= limits.max || item.info.isSymbolicLink()) continue;
      const relativePath = [prefix, item.name].filter(Boolean).join('/');
      if (item.info.isDirectory()) {
        // Attached storage can contain LightNAS-managed VM disks, ISOs,
        // templates and container root files under .lightnas/. They belong to
        // Storage, VM and Container workflows, not Files & media.
        if (item.name === '.lightnas') continue;
        directories.push({ absolute: item.absolute, relativePath });
        continue;
      }
      if (!item.info.isFile() || infrastructureFile(item.name)) continue;
      output.push({
        name: item.name,
        path: relativePath,
        folder: prefix,
        directory: false,
        sizeBytes: item.info.size,
        modifiedAt: item.info.mtime.toISOString(),
        supported: true
      });
      limits.count += 1;
    }
  }

  for (const directory of directories) {
    if (limits.count >= limits.max) break;
    await recursiveFileEntries(directory.absolute, directory.relativePath, output, limits);
  }
  return output;
}

export async function listAllFiles(forceRefresh = false, scopePrefix = '') {
  const prefixSegments = parts(scopePrefix);
  const cacheKey = prefixSegments.join('/');
  const now = Date.now();
  const cached = allFilesCache.get(cacheKey);
  if (!forceRefresh && cached?.value && cached.expiresAt > now) return cached.value;

  await mkdir(root, { recursive: true, mode: 0o700 });
  // A brand-new private user scope may not exist yet. Build the validated
  // scope path below the LightNAS files root and create it recursively.
  // parts() already rejects traversal and invalid path segments.
  const base = prefixSegments.length ? join(root, ...prefixSegments) : root;
  await mkdir(base, { recursive: true, mode: 0o700 });
  const limits = { count: 0, max: 10000 };
  const entries = [];

  // Files & media is intentionally a curated personal library. For a scoped
  // user, the same virtual Documents/Photos/Videos/Audio layout lives below
  // Users/<username> but the physical prefix is never exposed to the browser.
  for (const folder of MEDIA_LIBRARY_ROOTS) {
    if (limits.count >= limits.max) break;
    const absolute = join(base, folder);
    try { await mkdir(absolute, { recursive: true, mode: 0o700 }); } catch {}
    await recursiveFileEntries(absolute, folder, entries, limits);
  }

  const value = {
    entries: entries.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime() || a.path.localeCompare(b.path)),
    truncated: limits.count >= limits.max,
    limit: limits.max
  };
  allFilesCache.set(cacheKey, { expiresAt: now + 5000, value });
  return value;
}

export async function listFiles(relative = '') {
  const segments = parts(relative);
  const volumes = await attachedVolumes();

  if (segments.length === 1 && segments[0] === ATTACHED_ROOT) {
    return volumes.map(volume => ({ name: volume.name, directory: true, sizeBytes: null, modifiedAt: null, supported: true, attached: true, mountPoint: volume.mountPoint, readOnly: volume.readOnly }));
  }

  const path = await checked(relative);
  if (!(await lstat(path)).isDirectory()) throw Object.assign(new Error('Not a folder.'), { status: 400 });
  let entries = (await directoryEntries(path)).filter(entry => entry.directory || !infrastructureFile(entry.name));
  if (!segments.length) {
    // The Files & media root is a library selector, not a raw filesystem
    // browser. Only the four media/document libraries are visible here.
    for (const folder of MEDIA_LIBRARY_ROOTS) {
      try { await mkdir(join(root, folder), { recursive: true, mode: 0o700 }); } catch {}
    }
    entries = (await directoryEntries(root)).filter(entry => entry.directory && MEDIA_LIBRARY_ROOTS.includes(entry.name));
  }
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export async function createFolder(relative) {
  const segments = parts(relative);
  if (!segments.length || (segments.length <= 2 && segments[0] === ATTACHED_ROOT)) throw Object.assign(new Error('Enter a folder name inside a writable location.'), { status: 400 });
  await mkdir(await checked(relative, false), { recursive: true, mode: 0o700 });
  invalidateAllFilesCache();
}

export async function uploadFile(relative, req, options = {}) {
  const segments = parts(relative);
  if (!segments.length || (segments.length <= 2 && segments[0] === ATTACHED_ROOT)) throw Object.assign(new Error('Enter a file name inside a writable location.'), { status: 400 });
  const path = await checked(relative, false);
  const quotaBytes = Number(options.quotaBytes || 0);
  const quotaRoot = String(options.quotaRoot || '');
  const usedBefore = quotaBytes > 0 && quotaRoot ? await fileUsage(quotaRoot) : 0;
  const reservedBefore = quotaRoot ? Number(quotaReservations.get(quotaRoot) || 0) : 0;
  const declaredBytes = Math.max(0, Number(req.headers?.['content-length'] || 0));
  if (quotaBytes > 0 && usedBefore + reservedBefore >= quotaBytes) {
    throw Object.assign(new Error('Your LightNAS file storage quota is full.'), { status: 413 });
  }
  if (quotaBytes > 0 && declaredBytes > 0 && usedBefore + reservedBefore + declaredBytes > quotaBytes) {
    throw Object.assign(new Error('Upload would exceed your LightNAS file storage quota.'), { status: 413 });
  }
  if (quotaRoot && declaredBytes > 0) quotaReservations.set(quotaRoot, reservedBefore + declaredBytes);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw Object.assign(new Error('A file with this name already exists.'), { status: 409, code: 'FILE_EXISTS' });
    }
    throw error;
  }
  let size = 0;
  try {
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      let error = null;
      if (MAX_UPLOAD > 0 && size > MAX_UPLOAD) error = Object.assign(new Error('File exceeds the configured upload limit.'), { status: 413 });
      else if (quotaBytes > 0 && usedBefore + reservedBefore + size > quotaBytes) error = Object.assign(new Error('Upload would exceed your LightNAS file storage quota.'), { status: 413 });
      callback(error, chunk);
    } }), file.createWriteStream());
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  } finally {
    if (quotaRoot && declaredBytes > 0) {
      const remaining = Math.max(0, Number(quotaReservations.get(quotaRoot) || 0) - declaredBytes);
      if (remaining) quotaReservations.set(quotaRoot, remaining);
      else quotaReservations.delete(quotaRoot);
    }
  }
  invalidateAllFilesCache();
}

export async function uploadFileChunk(relative, { uploadId, offset, totalBytes, data, quotaRoot = '', quotaBytes = 0 } = {}) {
  const segments = parts(relative);
  if (!segments.length || (segments.length <= 2 && segments[0] === ATTACHED_ROOT)) {
    throw Object.assign(new Error('Enter a file name inside a writable location.'), { status: 400 });
  }
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(String(uploadId || ''))) {
    throw Object.assign(new Error('Invalid upload session.'), { status: 400 });
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    throw Object.assign(new Error('Upload chunk is empty.'), { status: 400 });
  }

  offset = Number(offset);
  totalBytes = Number(totalBytes);
  quotaBytes = Number(quotaBytes || 0);
  quotaRoot = String(quotaRoot || '');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 || offset >= totalBytes) {
    throw Object.assign(new Error('Invalid upload chunk range.'), { status: 400 });
  }
  if (offset + data.length > totalBytes) {
    throw Object.assign(new Error('Upload chunk exceeds the declared file size.'), { status: 400 });
  }
  if (MAX_UPLOAD > 0 && totalBytes > MAX_UPLOAD) {
    throw Object.assign(new Error('File exceeds the configured upload limit.'), { status: 413 });
  }

  const path = await checked(relative, false);
  const key = `${quotaRoot}::${uploadId}`;
  let session = chunkUploads.get(key);

  if (!session) {
    if (offset !== 0) throw Object.assign(new Error('Upload session expired. Start the file again.'), { status: 409, code: 'UPLOAD_RESTART' });
    const usedBefore = quotaBytes > 0 && quotaRoot ? await fileUsage(quotaRoot) : 0;
    const reservedBefore = quotaRoot ? Number(quotaReservations.get(quotaRoot) || 0) : 0;
    if (quotaBytes > 0 && usedBefore + reservedBefore + totalBytes > quotaBytes) {
      throw Object.assign(new Error('Upload would exceed your LightNAS file storage quota.'), { status: 413 });
    }
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      try { await handle?.close(); } catch {}
      if (error?.code === 'EEXIST') {
        throw Object.assign(new Error('A file with this name already exists.'), { status: 409, code: 'FILE_EXISTS' });
      }
      throw error;
    }
    if (quotaRoot) quotaReservations.set(quotaRoot, reservedBefore + totalBytes);
    session = { path, relative, expectedOffset: 0, totalBytes, quotaRoot, reservedBytes: totalBytes, updatedAt: Date.now() };
    chunkUploads.set(key, session);
  } else {
    if (session.path !== path || session.totalBytes !== totalBytes) {
      throw Object.assign(new Error('Upload session does not match this file.'), { status: 409, code: 'UPLOAD_RESTART' });
    }
  }

  // Idempotent retry: if a client lost the response after a successful chunk,
  // acknowledge the already-written range instead of corrupting the file.
  if (offset < session.expectedOffset && offset + data.length <= session.expectedOffset) {
    session.updatedAt = Date.now();
    return { complete: session.expectedOffset >= session.totalBytes, receivedBytes: session.expectedOffset, totalBytes: session.totalBytes };
  }
  if (offset !== session.expectedOffset) {
    throw Object.assign(new Error(`Upload chunk offset mismatch. Expected ${session.expectedOffset}.`), {
      status: 409,
      code: 'UPLOAD_OFFSET',
      expectedOffset: session.expectedOffset
    });
  }

  let handle;
  try {
    handle = await open(path, 'r+');
    await handle.write(data, 0, data.length, offset);
    await handle.close();
    handle = null;
  } catch (error) {
    try { await handle?.close(); } catch {}
    throw error;
  }

  session.expectedOffset += data.length;
  session.updatedAt = Date.now();
  const complete = session.expectedOffset >= session.totalBytes;

  if (complete) {
    chunkUploads.delete(key);
    if (session.quotaRoot) {
      const remaining = Math.max(0, Number(quotaReservations.get(session.quotaRoot) || 0) - session.reservedBytes);
      if (remaining) quotaReservations.set(session.quotaRoot, remaining);
      else quotaReservations.delete(session.quotaRoot);
    }
    invalidateAllFilesCache();
  }

  return { complete, receivedBytes: session.expectedOffset, totalBytes: session.totalBytes };
}

export async function downloadFile(relative) {
  if (!parts(relative).length) throw Object.assign(new Error('Select a file.'), { status: 400 });
  const path = await checked(relative);
  const info = await lstat(path);
  if (!info.isFile()) throw Object.assign(new Error('Not a file.'), { status: 400 });
  return { path, size: info.size };
}

export async function downloadEntry(relative) {
  if (!parts(relative).length) throw Object.assign(new Error('Select a file or folder.'), { status: 400 });
  const path = await checked(relative);
  const info = await lstat(path);
  if (!info.isFile() && !info.isDirectory()) throw Object.assign(new Error('Unsupported file entry.'), { status: 400 });
  return { path, size: info.isFile() ? info.size : null, directory: info.isDirectory() };
}

export async function mediaPaths(relative, format) {
  if (!['mp4', 'webm', 'mp3', 'jpg', 'png', 'webp'].includes(format)) throw Object.assign(new Error('Unsupported output format.'), { status: 400 });
  if (!parts(relative).length) throw Object.assign(new Error('Select an input file.'), { status: 400 });
  const input = await checked(relative);
  if (!(await lstat(input)).isFile()) throw Object.assign(new Error('Input must be a file.'), { status: 400 });
  const outputRelative = relative.replace(/\.[^./]+$/, '') + `-converted.${format}`;
  const output = await checked(outputRelative, false);
  return { input, output, outputRelative };
}

export async function deleteEntry(relative) {
  const segments = parts(relative);
  if (!segments.length || (segments.length <= 2 && segments[0] === ATTACHED_ROOT)) throw Object.assign(new Error('The attached storage root cannot be deleted.'), { status: 400 });
  const path = await checked(relative);
  const info = await lstat(path);
  if (info.isFile()) await unlink(path);
  else if (info.isDirectory()) await rmdir(path);
  else throw Object.assign(new Error('Unsupported entry.'), { status: 400 });
  invalidateAllFilesCache();
}
