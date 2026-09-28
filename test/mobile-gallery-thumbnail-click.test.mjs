import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('previewable file clicks never trigger the legacy download handler', async () => {
  const app = await read('public/app.js');
  assert.match(app, /isPreviewableFileName\(button\.dataset\.open \|\| ''\)/);
  assert.match(app, /event\.preventDefault\(\);\s*return;/);
});

test('broken mobile gallery thumbnails are automatically reloaded', async () => {
  const enhancements = await read('public/enhancements.js');
  assert.match(enhancements, /existing\.complete && existing\.naturalWidth === 0/);
  assert.match(enhancements, /\/api\/files\/thumbnail\?path=.*&v=/);
});
