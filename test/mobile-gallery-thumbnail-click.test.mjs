import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('mobile gallery click does not trigger the legacy download handler', async () => {
  const app = await read('public/app.js');
  assert.match(app, /button\.classList\.contains\('file-gallery-open'\) && matchMedia\('\(max-width: 760px\)'\)\.matches/);
  assert.match(app, /event\.preventDefault\(\);\s*return;/);
});

test('broken mobile gallery thumbnails are automatically reloaded', async () => {
  const enhancements = await read('public/enhancements.js');
  assert.match(enhancements, /existing\.complete && existing\.naturalWidth === 0/);
  assert.match(enhancements, /\/api\/files\/thumbnail\?path=.*&v=/);
});
