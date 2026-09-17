import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { downloadFile } from './files.mjs';

const execute = promisify(execFile);
const dataRoot = dirname(process.env.NAS_DATA_FILE || 'data/state.json');
const cacheRoot = join(dataRoot, 'thumbnails');
const images = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
const videos = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi']);

export async function thumbnailFor(relative) {
  const extension = extname(relative).toLowerCase();
  if (!images.has(extension) && !videos.has(extension)) throw Object.assign(new Error('This file type does not support thumbnails.'), { status: 415 });
  const source = await downloadFile(relative);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(`${relative}:${source.size}`).digest('hex');
  const output = join(cacheRoot, `${key}.jpg`);
  try {
    const info = await stat(output);
    if (info.isFile() && info.size > 0) return { path: output, size: info.size, contentType: 'image/jpeg' };
  } catch {}

  const inputArgs = videos.has(extension) ? ['-ss', '0.2', '-i', source.path] : ['-i', source.path];
  try {
    await execute('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', ...inputArgs,
      '-frames:v', '1', '-vf', 'scale=320:-2:force_original_aspect_ratio=decrease',
      '-q:v', '5', output
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw Object.assign(new Error(`Unable to create thumbnail: ${String(error.stderr || error.message).trim().slice(0, 300)}`), { status: 409 });
  }
  const info = await stat(output);
  return { path: output, size: info.size, contentType: 'image/jpeg' };
}
