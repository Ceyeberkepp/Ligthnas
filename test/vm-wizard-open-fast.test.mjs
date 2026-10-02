import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Create VM wizard uses lightweight creation options endpoint', async () => {
  const [server, runtimes, dialogs] = await Promise.all([
    read('src/server.mjs'),
    read('src/runtimes-next.mjs'),
    read('public/dialog-controls.js')
  ]);

  assert.match(server, /url\.pathname === '\/api\/vms\/create-options'/);
  assert.match(server, /await vmCreateInventory\(\)/);
  assert.match(runtimes, /export async function vmCreateInventory\(\)/);
  assert.match(dialogs, /dialogApi\('\/api\/vms\/create-options'\)/);
  assert.doesNotMatch(dialogs, /Opening VM wizard[\s\S]{0,500}\/api\/runtimes/);
});

test('Create VM click reports a visible error instead of appearing dead', async () => {
  const dialogs = await read('public/dialog-controls.js');
  assert.match(dialogs, /window\.alert\(message\)/);
  assert.match(dialogs, /Unable to open .* wizard/);
});
