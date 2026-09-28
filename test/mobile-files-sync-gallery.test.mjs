import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('All Files thumbnails use direct stable versioned thumbnail URLs', async () => {
  const app = await read('public/app.js');
  assert.match(app, /<img class="file-thumb"/);
  assert.match(app, /entry\.modifiedAt \|\| entry\.sizeBytes/);
  assert.match(app, /\/api\/files\/thumbnail\?path=/);
});

test('Files supports an iPhone-style gallery view and contextual multi-select media upload', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /\['list','grid','gallery'\]/);
  assert.match(app, /data-file-view="gallery"/);
  assert.match(app, /file-photo-gallery/);
  assert.match(app, /accept="image\/\*"/);
  assert.match(app, /accept="video\/\*"/);
  assert.match(app, /type="file"[\s\S]*multiple hidden/);
  assert.match(css, /\.file-photo-gallery/);
  assert.match(css, /grid-template-columns:repeat\(3,1fr\)/);
});

test('Phone sync creates a restricted key and auto-routes mobile uploads', async () => {
  const [server, app] = await Promise.all([read('src/server.mjs'), read('public/app.js')]);
  assert.match(server, /\/api\/mobile-sync\/key/);
  assert.match(server, /permissions: \['files\.read', 'files\.write'\]/);
  assert.match(server, /\/api\/mobile-sync\/upload/);
  assert.match(server, /mobileLibraryDestination/);
  assert.match(server, /type\.startsWith\('image\/'\)/);
  assert.match(server, /type\.startsWith\('video\/'\)/);
  assert.match(app, /data-phone-sync/);
  assert.match(app, /iPhone, use Shortcuts automation/);
});

test('Mobile sidebar has close button, backdrop, and Escape handling', async () => {
  const [html, app, css] = await Promise.all([read('public/index.html'), read('public/app.js'), read('public/enhancements.css')]);
  assert.match(html, /id="sidebar-close"/);
  assert.match(html, /id="sidebar-backdrop"/);
  assert.match(app, /function setMobileSidebar/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(css, /\.sidebar-backdrop:not\(\[hidden\]\)/);
});

test('Mobile login automatically fits the viewport without iOS input zoom', async () => {
  const [html, css] = await Promise.all([read('public/index.html'), read('public/enhancements.css')]);
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /min-height:100dvh/);
  assert.match(css, /\.auth-form input,[\s\S]*font-size:16px/);
});
