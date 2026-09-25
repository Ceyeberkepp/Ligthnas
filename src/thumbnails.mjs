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
const rawImages = new Set(['.raw', '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f']);
const videos = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi', '.wmv', '.flv', '.mpeg', '.mpg', '.m2v', '.mts', '.m2ts', '.ts', '.3gp', '.3g2', '.vob']);

export async function thumbnailFor(relative, options = {}) {
  const extension = extname(relative).toLowerCase();
  if (!images.has(extension) && !rawImages.has(extension) && !videos.has(extension)) throw Object.assign(new Error('This file type does not support thumbnails.'), { status: 415 });
  const source = await downloadFile(relative);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const preview = options.preview === true;
  const maxWidth = preview ? 1920 : 320;
  const key = createHash('sha256').update(`${relative}:${source.size}:${maxWidth}`).digest('hex');
  const output = join(cacheRoot, `${key}.jpg`);
  try {
    const info = await stat(output);
    if (info.isFile() && info.size > 0) return { path: output, size: info.size, contentType: 'image/jpeg' };
  } catch {}

  const inputArgs = videos.has(extension) ? ['-ss', '0.2', '-i', source.path] : ['-i', source.path];
  try {
    await execute('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', ...inputArgs,
      '-frames:v', '1', '-vf', `scale=${maxWidth}:-2:force_original_aspect_ratio=decrease`,
      '-q:v', preview ? '3' : '5', output
    ], { timeout: preview ? 45000 : 20000, maxBuffer: 1024 * 1024 });
  } catch (firstError) {
    if (!rawImages.has(extension)) {
      throw Object.assign(new Error(`Unable to create thumbnail: ${String(firstError.stderr || firstError.message).trim().slice(0, 300)}`), { status: 409 });
    }
    // ImageMagick + LibRaw provides a second path for camera RAW formats that
    // the installed FFmpeg build cannot decode directly.
    try {
      await execute('convert', [
        `${source.path}[0]`, '-auto-orient', '-thumbnail', `${maxWidth}x${maxWidth}>`, '-quality', preview ? '90' : '82', output
      ], { timeout: preview ? 60000 : 30000, maxBuffer: 1024 * 1024 });
    } catch (secondError) {
      throw Object.assign(new Error(`Unable to preview RAW image: ${String(secondError.stderr || secondError.message || firstError.message).trim().slice(0, 300)}`), { status: 409 });
    }
  }
  const info = await stat(output);
  return { path: output, size: info.size, contentType: 'image/jpeg' };
}
