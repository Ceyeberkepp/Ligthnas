import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('desktop Files exposes Photos view and Settings control', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /data-files-settings-tab/);
  assert.match(app, /filesSettingsOpen/);
  assert.match(css, /\.mobile-photo-view-button \{ display:inline-flex; \}/);
  assert.match(css, /\.desktop-files-settings-button \{ display:inline-flex; \}/);
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

test('all image and video cards render stable thumbnail URLs directly', async () => {
  const [app, enhancements] = await Promise.all([read('public/app.js'), read('public/enhancements.js')]);
  assert.match(app, /<img class="file-thumb"/);
  assert.match(app, /\/api\/files\/thumbnail\?path=/);
  assert.match(app, /thumbVersion/);
  const enhancer = enhancements.slice(enhancements.indexOf('function enhanceFileThumbnails()'), enhancements.indexOf('function permissionsMarkup'));
  assert.doesNotMatch(enhancer, /createElement\('img'\)/);
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
