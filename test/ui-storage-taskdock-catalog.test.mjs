import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('overview storage exposes configured pools and sources', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /storage\.configuredPools = storagePools\.pools \|\| \[\]/);
  assert.match(server, /storage\.availableSources = storagePools\.availableSources \|\| \[\]/);
});

test('files UI removes attached-storage tab and simplifies upload label', async () => {
  const app = await read('public/app.js');
  assert.doesNotMatch(app, /\['Attached storage', 'Attached storage'\]/);
  assert.match(app, />Upload<input id="file-upload"/);
  assert.match(app, />Upload folder<input id="folder-upload"/);
});

test('bottom task dock records progress and is collapsible', async () => {
  const [html, dialogs] = await Promise.all([read('public/index.html'), read('public/dialog-controls.js')]);
  assert.match(html, /id="task-dock"/);
  assert.match(html, /id="task-dock-toggle"/);
  assert.match(dialogs, /lightnasTasks/);
  assert.match(dialogs, /sessionStorage\.setItem\('lightnas-tasks'/);
  assert.match(dialogs, /lightnas-task-dock-collapsed/);
});

test('compute inventory exposes manage actions and shell is named Bash', async () => {
  const [app, html] = await Promise.all([read('public/app.js'), read('public/index.html')]);
  assert.match(app, /data-container-edit=/);
  assert.match(app, /data-vm-edit=/);
  assert.match(app, /Bash Shell/);
  assert.match(html, /id="node-shell-top"/);
  assert.match(html, /<b>Shell<\/b>/);
});

test('App Store contains at least ninety unique one-click entries and host ports', async () => {
  const runtime = await read('src/runtimes-next.mjs');
  const entries = [...runtime.matchAll(/\{ id: '([^']+)', name: '([^']+)'[\s\S]*? port: (\d+), containerPort: (\d+)/g)]
    .map(match => ({ id:match[1], port:Number(match[3]) }));
  assert.ok(entries.length >= 90, `expected at least 90 apps, found ${entries.length}`);
  assert.equal(new Set(entries.map(item => item.id)).size, entries.length, 'app IDs must be unique');
  assert.equal(new Set(entries.map(item => item.port)).size, entries.length, 'host ports must be unique');
});
