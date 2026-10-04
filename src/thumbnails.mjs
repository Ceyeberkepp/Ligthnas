import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { downloadFile } from './files.mjs';

const execute = promisify(execFile);
const dataRoot = dirname(process.env.NAS_DATA_FILE || 'data/state.json');
const cacheRoot = join(dataRoot, 'thumbnails');
const thumbnailJobs = new Map();
const images = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const rawImages = new Set(['.heic', '.heif', '.raw', '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f']);
const videos = new Set(['.mp4', '.m4v', '.mov', '.qt', '.webm', '.ogv', '.mkv', '.avi', '.wmv', '.asf', '.flv', '.f4v', '.mpeg', '.mpg', '.mpe', '.m2v', '.mts', '.m2ts', '.m2t', '.ts', '.3gp', '.3g2', '.vob', '.mxf', '.rm', '.rmvb', '.divx', '.mod', '.tod', '.dat']);

const nativeImageTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'], ['.avif', 'image/avif']
]);

export async function thumbnailFor(relative, options = {}) {
  const extension = extname(relative).toLowerCase();
  if (!images.has(extension) && !rawImages.has(extension) && !videos.has(extension)) throw Object.assign(new Error('This file type does not support thumbnails.'), { status: 415 });
  const source = await downloadFile(relative);

  if (extension === '.svg') {
    return { path: source.path, size: source.size, contentType: nativeImageTypes.get(extension) };
  }

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const preview = options.preview === true;
  const maxWidth = preview ? 1280 : 320;
  const key = createHash('sha256').update(`${relative}:${source.size}:${source.mtimeMs || 0}:${maxWidth}`).digest('hex');
  const output = join(cacheRoot, `${key}.jpg`);

  try {
    const info = await stat(output);
    if (info.isFile() && info.size > 0) return { path: output, size: info.size, contentType: 'image/jpeg' };
  } catch {}

  if (!thumbnailJobs.has(output)) {
    thumbnailJobs.set(output, (async () => {
      const inputArgs = videos.has(extension) ? ['-ss', '0.2', '-i', source.path] : ['-i', source.path];
      try {
        await execute('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y', ...inputArgs,
          '-frames:v', '1', '-vf', `scale=${maxWidth}:-2:force_original_aspect_ratio=decrease`,
          '-q:v', preview ? '4' : '6', output
        ], { timeout: preview ? 30000 : 15000, maxBuffer: 1024 * 1024 });
      } catch (firstError) {
        if (!rawImages.has(extension)) {
          throw Object.assign(new Error(`Unable to create thumbnail: ${String(firstError.stderr || firstError.message).trim().slice(0, 300)}`), { status: 409 });
        }
        try {
          await execute('convert', [
            `${source.path}[0]`, '-auto-orient', '-thumbnail', `${maxWidth}x${maxWidth}>`, '-quality', preview ? '88' : '80', output
          ], { timeout: preview ? 45000 : 25000, maxBuffer: 1024 * 1024 });
        } catch (secondError) {
          throw Object.assign(new Error(`Unable to preview RAW image: ${String(secondError.stderr || secondError.message || firstError.message).trim().slice(0, 300)}`), { status: 409 });
        }
      }
    })().finally(() => thumbnailJobs.delete(output)));
  }

  await thumbnailJobs.get(output);
  const info = await stat(output);
  return { path: output, size: info.size, contentType: 'image/jpeg' };
}) {
  const extension = extname(relative).toLowerCase();
  if (!images.has(extension) && !rawImages.has(extension) && !videos.has(extension)) throw Object.assign(new Error('This file type does not support thumbnails.'), { status: 415 });
  const source = await downloadFile(relative);

  // Never send a multi-megabyte camera original just to paint a tiny grid
  // tile. Mobile libraries can contain thousands of photos, so normal raster
  // images get real cached thumbnails. SVG can stay native because it is
  // already resolution-independent and generally small.
  if (extension === '.svg') {
    return { path: source.path, size: source.size, contentType: nativeImageTypes.get(extension) };
  }

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const preview = options.preview === true;
  const maxWidth = preview ? 1600 : 320;
  const key = createHash('sha256').update(`${relative}:${source.size}:${source.mtimeMs || 0}:${maxWidth}`).digest('hex');
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
