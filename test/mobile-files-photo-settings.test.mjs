import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('mobile Files exposes only Grid and Photos view controls', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /if \(mobileFiles && state\.fileView === 'list'\) state\.fileView = 'grid'/);
  assert.match(css, /@media \(max-width:760px\)[\s\S]*\[data-file-view="list"\] \{ display:none !important; \}/);
  assert.match(css, /mobile-files-settings-button/);
});

test('mobile photo mode hides Files chrome but preserves Settings and gallery', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /files-page \$\{state\.fileView === 'gallery' \? 'photo-mode' : 'grid-mode'\}/);
  assert.match(app, /data-mobile-files-settings/);
  assert.match(css, /files-page\.photo-mode > \.page-head/);
  assert.match(css, /files-page\.photo-mode > \.mobile-files-settings-button/);
  assert.doesNotMatch(css, /@media \(min-width:761px\)[\s\S]*\.files-page\.photo-mode > \.page-head/);
});

test('phone sync remains available through mobile Files settings', async () => {
  const app = await read('public/app.js');
  assert.match(app, /data-open-phone-sync-from-settings/);
  assert.match(app, /#content \.phone-sync-button/);
});

test('gallery thumbnails use the stable cached thumbnail endpoint and HEIC preview support', async () => {
  const enhancements = await read('public/enhancements.js');
  assert.match(enhancements, /Always use LightNAS' cached JPEG thumbnail endpoint/);
  assert.match(enhancements, /media\.src = `\/api\/files\/thumbnail\?path=/);
  assert.match(enhancements, /'heic', 'heif'/);
});

test('mobile viewer becomes full-screen without changing desktop viewer rules', async () => {
  const css = await read('public/enhancements.css');
  assert.match(css, /@media \(max-width:760px\)[\s\S]*\.lightnas-viewer \{[\s\S]*height:100dvh/);
  assert.match(css, /@media \(max-width:760px\)[\s\S]*object-fit:contain/);
});
