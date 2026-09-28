import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('previewable file clicks never trigger the legacy download handler', async () => {
  const app = await read('public/app.js');
  assert.match(app, /isPreviewableFileName\(button\.dataset\.open \|\| ''\)/);
  assert.match(app, /event\.preventDefault\(\);\s*return;/);
});

test('gallery thumbnails are not rewritten by enhancement observers', async () => {
  const enhancements = await read('public/enhancements.js');
  const enhancer = enhancements.slice(enhancements.indexOf('function enhanceFileThumbnails()'), enhancements.indexOf('function permissionsMarkup'));
  assert.match(enhancer, /Thumbnails are rendered directly by app\.js/);
  assert.doesNotMatch(enhancer, /thumbnail\?path/);
});
