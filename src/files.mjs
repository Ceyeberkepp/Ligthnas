import { mkdir, readdir, lstat, unlink, rmdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const root = join(dirname(process.env.NAS_DATA_FILE || 'data/state.json'), 'files');
const MAX_UPLOAD = 1024 * 1024 * 1024;
const ATTACHED_ROOT = 'Attached storage';

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
  const usedNames = new Set();
  const volumes = [];
  for (const line of mounts.trim().split('\n')) {
    const [device, encoded, type, options] = line.split(' ');
    if (!device || !encoded) continue;
    const mountPoint = encoded.replaceAll('\\040', ' ');
    if (ignoredMount(mountPoint, type)) continue;
    let name = mountPoint.split('/').filter(Boolean).join('-').replace(/[^a-zA-Z0-9._ -]/g, '-').slice(0, 100) || 'storage';
    const base = name;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) name = `${base}-${suffix++}`;
    usedNames.add(name.toLowerCase());
    volumes.push({ name, mountPoint, device, type, readOnly: (options || '').split(',').includes('ro') });
  }
  return volumes;
}

async function checked(relative, expectExisting = true) {
  const segments = parts(relative);
  let path;
  let start = 0;

  if (segments[0] === ATTACHED_ROOT) {
    if (segments.length < 2) throw Object.assign(new Error('Select an attached storage volume.'), { status: 400 });
    const volume = (await attachedVolumes()).find(item => item.name === segments[1]);
    if (!volume) throw Object.assign(new Error('Attached storage volume is no longer available.'), { status: 404 });
    if (volume.readOnly && !expectExisting) throw Object.assign(new Error('This attached storage volume is read only.'), { status: 409 });
    path = volume.mountPoint;
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

export async function listFiles(relative = '') {
  const segments = parts(relative);
  const volumes = await attachedVolumes();

  if (segments.length === 1 && segments[0] === ATTACHED_ROOT) {
    return volumes.map(volume => ({ name: volume.name, directory: true, sizeBytes: null, modifiedAt: null, supported: true, attached: true, mountPoint: volume.mountPoint }));
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
  await mkdir(await checked(relative, false), { mode: 0o700 });
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
      callback(size > MAX_UPLOAD ? Object.assign(new Error('File exceeds the 1 GB upload limit.'), { status: 413 }) : null, chunk);
    } }), file.createWriteStream());
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

export async function downloadFile(relative) {
  if (!parts(relative).length) throw Object.assign(new Error('Select a file.'), { status: 400 });
  const path = await checked(relative);
  const info = await lstat(path);
  if (!info.isFile()) throw Object.assign(new Error('Not a file.'), { status: 400 });
  return { path, size: info.size };
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
}
