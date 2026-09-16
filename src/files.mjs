import { mkdir, readdir, lstat, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = join(dirname(process.env.NAS_DATA_FILE || 'data/state.json'), 'files');
const MAX_UPLOAD = 32 * 1024 * 1024;

function parts(relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || relative.includes('\\') || relative.includes('\0')) throw Object.assign(new Error('Invalid file path.'), { status: 400 });
  const segments = relative.split('/').filter(Boolean);
  if (segments.some(item => item === '.' || item === '..' || !/^[^\x00-\x1f/]{1,255}$/.test(item))) throw Object.assign(new Error('Invalid file path.'), { status: 400 });
  return segments;
}

async function checked(relative, expectExisting = true) {
  const segments = parts(relative);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let path = root;
  for (let i = 0; i < segments.length; i++) {
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

export async function listFiles(relative = '') {
  const path = await checked(relative);
  if (!(await lstat(path)).isDirectory()) throw Object.assign(new Error('Not a folder.'), { status: 400 });
  const entries = await Promise.all((await readdir(path)).map(async name => {
    const info = await lstat(join(path, name));
    return { name, directory: info.isDirectory(), sizeBytes: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString(), supported: info.isFile() || info.isDirectory() };
  }));
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export async function createFolder(relative) {
  if (!parts(relative).length) throw Object.assign(new Error('Enter a folder name.'), { status: 400 });
  await mkdir(await checked(relative, false), { mode: 0o700 });
}

export async function uploadFile(relative, req) {
  if (!parts(relative).length) throw Object.assign(new Error('Enter a file name.'), { status: 400 });
  const path = await checked(relative, false);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) throw Object.assign(new Error('File exceeds the 32 MB upload limit.'), { status: 413 });
    chunks.push(chunk);
  }
  await writeFile(path, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
}

export async function downloadFile(relative) {
  if (!parts(relative).length) throw Object.assign(new Error('Select a file.'), { status: 400 });
  const path = await checked(relative);
  const info = await lstat(path);
  if (!info.isFile()) throw Object.assign(new Error('Not a file.'), { status: 400 });
  if (info.size > MAX_UPLOAD) throw Object.assign(new Error('File exceeds the 32 MB browser download limit.'), { status: 413 });
  return readFile(path);
}

export async function deleteEntry(relative) {
  if (!parts(relative).length) throw Object.assign(new Error('Select a file or folder.'), { status: 400 });
  const path = await checked(relative);
  const info = await lstat(path);
  if (info.isFile()) await unlink(path);
  else if (info.isDirectory()) await rmdir(path);
  else throw Object.assign(new Error('Unsupported entry.'), { status: 400 });
}
