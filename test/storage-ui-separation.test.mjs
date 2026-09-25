import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Storage and Pools & datasets have separate responsibilities', async () => {
  const [app, manager, templates] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/storage-manager.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/templates.js', import.meta.url), 'utf8')
  ]);

  const poolsView = app.slice(app.indexOf('function poolsView()'), app.indexOf('async function loadSpaces()'));
  assert.doesNotMatch(poolsView, /id="storage-manager"/);
  assert.doesNotMatch(poolsView, /id="container-template-library"/);
  assert.doesNotMatch(poolsView, /id="space-form"/);
  assert.match(poolsView, /Pools & datasets/);
  assert.match(poolsView, /Storage pools/);
  assert.match(poolsView, /Datasets/);
  assert.match(poolsView, /data-create-storage/);

  assert.match(manager, /Detected drives/);
  assert.match(manager, /data-create-storage-source/);
  assert.match(manager, /selectedType==='vztmpl'/);
  assert.match(manager, /data-template-storage/);
  assert.match(manager, /already in use/);
  assert.match(templates, /preferredStorageId/);
});

test('Overview presents one switchable live graph including network throughput', async () => {
  const [app, system] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/system.mjs', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(app, /class="node-tabs"/);
  assert.match(app, /overview-graph-tabs/);
  assert.match(app, /\['network','Network'\]/);
  assert.match(app, /overviewChart\('CPU usage'/);
  assert.match(app, /overviewChart\('System load'/);
  assert.match(app, /overviewChart\('Memory usage'/);
  assert.match(app, /overviewChart\('Storage usage'/);
  assert.match(app, /setInterval/);
  assert.match(system, /loadAverage/);
  assert.match(system, /receivedBytes/);
  assert.match(system, /transmittedBytes/);
});
