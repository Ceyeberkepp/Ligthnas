import { access, constants, mkdir, readdir, lstat, unlink, rmdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const root = join(dirname(process.env.NAS_DATA_FILE || 'data/state.json'), 'files');
const configuredUploadLimit = Number(process.env.LIGHTNAS_FILE_UPLOAD_MAX_BYTES || 0);
const MAX_UPLOAD = Number.isFinite(configuredUploadLimit) && configuredUploadLimit > 0 ? configuredUploadLimit : 0;
const ATTACHED_ROOT = 'Attached storage';
let allFilesCache = { expiresAt: 0, value: null };

function invalidateAllFilesCache() {
  allFilesCache = { expiresAt: 0, value: null };
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
        directories.push({ absolute: item.absolute, relativePath });
        continue;
      }
      if (!item.info.isFile()) continue;
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

export async function listAllFiles(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && allFilesCache.value && allFilesCache.expiresAt > now) return allFilesCache.value;

  await mkdir(root, { recursive: true, mode: 0o700 });
  const limits = { count: 0, max: 10000 };
  const entries = [];
  await recursiveFileEntries(root, '', entries, limits);

  // "All files" means all files LightNAS can currently see, including
  // attached NAS volumes. Keep one global safety cap so a very large mount
  // cannot lock the browser or the control-plane process.
  for (const volume of await attachedVolumes()) {
    if (limits.count >= limits.max) break;
    await recursiveFileEntries(
      volume.mountPoint,
      `${ATTACHED_ROOT}/${volume.name}`,
      entries,
      limits
    );
  }

  const value = {
    entries: entries.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime() || a.path.localeCompare(b.path)),
    truncated: limits.count >= limits.max,
    limit: limits.max
  };
  allFilesCache = { expiresAt: now + 5000, value };
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
  const entries = await directoryEntries(path);
  if (!segments.length && volumes.length) entries.push({ name: ATTACHED_ROOT, directory: true, sizeBytes: null, modifiedAt: null, supported: true, attached: true });
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export async function createFolder(relative) {
  const segments = parts(relative);
  if (!segments.length || (segments.length <= 2 && segments[0] === ATTACHED_ROOT)) throw Object.assign(new Error('Enter a folder name inside a writable location.'), { status: 400 });
  await mkdir(await checked(relative, false), { recursive: true, mode: 0o700 });
  invalidateAllFilesCache();
}

export async function uploadFile(relative, req) {
  const segments = parts(relative);
  if (!segments.length || (segments.length <= 2 && segments[0] === ATTACHED_ROOT)) throw Object.assign(new Error('Enter a file name inside a writable location.'), { status: 400 });
  const path = await checked(relative, false);
  const file = await open(path, 'wx', 0o600);
  let size = 0;
  try {
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(MAX_UPLOAD > 0 && size > MAX_UPLOAD ? Object.assign(new Error('File exceeds the configured upload limit.'), { status: 413 }) : null, chunk);
    } }), file.createWriteStream());
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  invalidateAllFilesCache();
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
