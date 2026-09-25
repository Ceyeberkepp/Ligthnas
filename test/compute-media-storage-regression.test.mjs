import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('container and VM inventory render operational controls directly', async () => {
  const app = await read('public/app.js');
  assert.match(app, /data-container-console=/);
  assert.match(app, /data-container-action="start"/);
  assert.match(app, /data-container-action="stop"/);
  assert.match(app, /data-container-action="shutdown"/);
  assert.match(app, /data-container-action="reboot"/);
  assert.match(app, /data-vm-console=/);
  assert.match(app, />noVNC Console<\/button>/);
  assert.match(app, /data-vm-action="start"/);
  assert.match(app, /data-vm-action="stop"/);
  assert.match(app, /data-vm-action="shutdown"/);
  assert.match(app, /data-vm-action="reboot"/);
});

test('fast container inventory still fetches live guest addresses', async () => {
  const agent = await read('scripts/lightnas-host-agent.py');
  assert.match(agent, /if fast and state == "running":/);
  assert.match(agent, /"lxc-info", "-n", name, "-iH"/);
  assert.match(agent, /"ipv4": next\(\(value for value in addresses if ":" not in value\), None\)/);
});

test('Files media library routes uploads by type and hides infrastructure images', async () => {
  const [app, files] = await Promise.all([read('public/app.js'), read('src/files.mjs')]);
  assert.match(app, /libraryCategoryForName/);
  assert.match(app, /const destination = !folderMode && state\.folder === '' \? libraryCategoryForName\(file\.name\) : state\.folder/);
  assert.match(app, /isSystemImageFile/);
  assert.match(app, /Storage > Manage storage/);
  assert.match(app, /kind === 'Photo'/);
  assert.match(app, /kind === 'Video'/);
  assert.match(app, /kind === 'Audio'/);
  assert.match(files, /infrastructureImageSuffixes/);
  assert.match(files, /if \(item\.name === '\.lightnas'\) continue/);
  assert.match(files, /infrastructureFile\(item\.name\)/);
});

test('Storage hides empty file spaces and removes advanced mounted filesystem panel', async () => {
  const app = await read('public/app.js');
  const storage = app.slice(app.indexOf('function storageView()'), app.indexOf('function poolsView()'));
  assert.match(storage, /spaces\.length \?/);
  assert.doesNotMatch(storage, /No file spaces yet/);
  assert.doesNotMatch(storage, /Advanced mounted filesystems/);
});

test('network connected state is compact and compute actions receive wider layout', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /\? 'CONNECTED' : escapeHtml/);
  assert.match(css, /\.compute-table-actions \{ min-width:1320px; \}/);
  assert.match(css, /grid-template-columns:140px 180px 112px minmax\(190px,1\.2fr\)/);
  assert.match(css, /\.network-state-badge \{[\s\S]*overflow:hidden/);
});
