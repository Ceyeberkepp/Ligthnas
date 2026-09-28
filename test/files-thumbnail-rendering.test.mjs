import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Files renders thumbnails directly instead of mutating them later', async () => {
  const [app, enhancements] = await Promise.all([read('public/app.js'), read('public/enhancements.js')]);
  assert.match(app, /<img class="file-thumb"/);
  assert.match(app, /\/api\/files\/thumbnail\?path=/);
  assert.match(app, /entry\.modifiedAt \|\| entry\.sizeBytes/);
  const enhancer = enhancements.slice(enhancements.indexOf('function enhanceFileThumbnails()'), enhancements.indexOf('function permissionsMarkup'));
  assert.match(enhancer, /Thumbnails are rendered directly by app\.js/);
  assert.doesNotMatch(enhancer, /createElement\('img'\)/);
});

test('viewer close no longer rewrites gallery thumbnail sources', async () => {
  const enhancements = await read('public/enhancements.js');
  const close = enhancements.slice(enhancements.indexOf("dialog.addEventListener('close'"), enhancements.indexOf("dialog.querySelector('[data-viewer-close]')"));
  assert.doesNotMatch(close, /file-thumb/);
  assert.doesNotMatch(close, /thumbnail\?path/);
});

test('desktop keeps Photos and exposes Files Settings in tab and toolbar', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /desktop-files-settings-tab/);
  assert.match(app, /desktop-files-settings-button/);
  assert.match(app, /data-file-view="gallery"/);
  assert.match(css, /\.mobile-photo-view-button \{ display:inline-flex; \}/);
  assert.match(css, /\.desktop-files-settings-button \{ display:inline-flex; \}/);
});
