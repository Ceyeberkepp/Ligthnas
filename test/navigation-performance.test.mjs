import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('runtime inventory uses stale-while-revalidate for navigation', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /Stale-while-revalidate/);
  assert.match(server, /if \(!force && runtimeInventoryCache\)/);
  assert.match(server, /refresh\(\)\.catch\(\(\) => null\)/);
  assert.match(server, /setTimeout\(\(\) => getRuntimeInventoryCached\(true\)/);
});

test('VM details are discovered concurrently with short command timeouts', async () => {
  const runtime = await read('src/runtimes-next.mjs');
  assert.match(runtime, /Math\.min\(6, selected\.length \|\| 1\)/);
  assert.match(runtime, /command\('virsh', \['-c', 'qemu:\/\/\/system', 'dominfo', name\], 4000\)/);
  assert.match(runtime, /Promise\.all\(Array\.from/);
});

test('VM editor uses a lightweight endpoint or warmed browser cache', async () => {
  const [server, dialogs, app] = await Promise.all([
    read('src/server.mjs'),
    read('public/dialog-controls.js'),
    read('public/app.js')
  ]);
  assert.match(server, /url\.pathname === '\/api\/vms\/editor'/);
  assert.match(dialogs, /window\.LightNASRuntimeInventory/);
  assert.match(dialogs, /\/api\/vms\/editor\?id=/);
  assert.match(app, /window\.LightNASRuntimeInventory = state\.runtimes/);
  assert.match(app, /\[LightNAS slow API\]/);
});
