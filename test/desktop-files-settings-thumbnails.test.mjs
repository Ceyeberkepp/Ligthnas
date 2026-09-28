import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('desktop Files exposes Photos view and Settings tab', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /desktop-files-settings-tab/);
  assert.match(app, /filesSettingsOpen/);
  assert.match(css, /\.mobile-photo-view-button \{ display:inline-flex; \}/);
  assert.match(css, /\.desktop-files-settings-tab \{ display:inline-flex; \}/);
});

test('phone sync is configured from Files settings instead of regular desktop toolbar', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /files-setting-box/);
  assert.match(app, /Configure phone sync/);
  assert.match(css, /\.files-sync-trigger \{ display:none !important; \}/);
});

test('all previewable file clicks bypass legacy download handler on desktop and mobile', async () => {
  const app = await read('public/app.js');
  assert.match(app, /const previewableFileExtensions = new Set/);
  assert.match(app, /if \(isPreviewableFileName\(button\.dataset\.open \|\| ''\)\) \{/);
  assert.match(app, /event\.preventDefault\(\);\s*return;/);
});

test('all image and video cards use cached thumbnail endpoint with retry repair', async () => {
  const enhancements = await read('public/enhancements.js');
  assert.match(enhancements, /Always use LightNAS' dedicated thumbnail endpoint/);
  assert.match(enhancements, /media\.src = `\/api\/files\/thumbnail\?path=/);
  assert.match(enhancements, /existing\.complete && existing\.naturalWidth === 0/);
  assert.match(enhancements, /media\.dataset\.retry === '1'/);
});

test('native images bypass FFmpeg while HEIC and HEIF use the conversion pipeline', async () => {
  const [enhancements, thumbnails] = await Promise.all([read('public/enhancements.js'), read('src/thumbnails.mjs')]);
  assert.match(enhancements, /'heic', 'heif'/);
  assert.match(thumbnails, /nativeImageTypes/);
  assert.match(thumbnails, /if \(nativeImageTypes\.has\(extension\)\)/);
  assert.match(thumbnails, /'\.heic', '\.heif'/);
  assert.match(enhancements, /preview=1&path=/);
  assert.match(enhancements, /dialog\.dataset\.sourcePath = path/);
});
