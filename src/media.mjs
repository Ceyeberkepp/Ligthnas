import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink, lstat } from 'node:fs/promises';
import { mediaPaths } from './files.mjs';

const execute = promisify(execFile);
let converting = false;

export async function mediaAvailable() {
  try { await execute('ffmpeg', ['-version'], { timeout: 3000 }); return true; } catch { return false; }
}

export async function convertMedia(path, format) {
  if (converting) throw Object.assign(new Error('Another conversion is in progress.'), { status: 409 });
  const paths = await mediaPaths(path, format);
  if (await lstat(paths.output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Object.assign(new Error('Converted file already exists.'), { status: 409 });
  const formats = {
    mp4: ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-c:a', 'aac', '-movflags', '+faststart'],
    webm: ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-b:v', '1M', '-c:a', 'libopus'],
    mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '4'],
    jpg: ['-frames:v', '1', '-q:v', '3'],
    png: ['-frames:v', '1'],
    webp: ['-frames:v', '1']
  };
  converting = true;
  try {
    await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-n', '-i', paths.input, ...formats[format], paths.output], { timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 });
    return { path: paths.outputRelative };
  } catch (error) {
    await unlink(paths.output).catch(() => {});
    throw Object.assign(new Error(error.code === 'ENOENT' ? 'FFmpeg is not installed on this host.' : 'Conversion failed. Check that the input has a supported media stream and the host has space available.'), { status: 409 });
  } finally { converting = false; }
}
