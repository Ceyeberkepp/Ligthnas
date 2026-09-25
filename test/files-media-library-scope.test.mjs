import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('All Files contains only Documents Photos Videos and Audio libraries', async () => {
  const [files, app] = await Promise.all([read('src/files.mjs'), read('public/app.js')]);
  assert.match(files, /const MEDIA_LIBRARY_ROOTS = \['Documents', 'Photos', 'Videos', 'Audio'\]/);
  const allFiles = files.slice(files.indexOf('export async function listAllFiles'), files.indexOf('export async function listFiles'));
  assert.match(allFiles, /for \(const folder of MEDIA_LIBRARY_ROOTS\)/);
  assert.doesNotMatch(allFiles, /attachedVolumes\(\)/);
  assert.match(app, /All files shows only your Documents, Photos, Videos, and Audio libraries/);
});

test('Files root does not expose Attached storage or arbitrary root folders', async () => {
  const files = await read('src/files.mjs');
  const listFiles = files.slice(files.indexOf('export async function listFiles'), files.indexOf('export async function createFolder'));
  assert.match(listFiles, /MEDIA_LIBRARY_ROOTS\.includes\(entry\.name\)/);
  assert.doesNotMatch(listFiles, /entries\.push\(\{ name: ATTACHED_ROOT/);
});
