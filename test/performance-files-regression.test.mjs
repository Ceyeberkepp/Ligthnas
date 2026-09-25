import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('installer is single-pass, syntactically structured, and incremental', async () => {
  const installer = await read('install.sh');
  assert.equal((installer.match(/install_missing_packages\(\)/g) || []).length, 1);
  assert.equal((installer.match(/echo "\[1\/6\]/g) || []).length, 1);
  assert.match(installer, /package_installed\(\)[\s\S]*?install ok installed\$/);
  assert.match(installer, /Node\.js dependencies unchanged; skipping npm install\./);
  assert.match(installer, /Existing runtime configuration detected; skipping slow reprovisioning\./);
  assert.doesNotMatch(installer, /Installing system requirements\.\.\.[\s\S]*apt-get update[\s\S]*apt-get install -y ca-certificates/);
});

test('dashboard does not block on cold storage discovery', async () => {
  const server = await read('src/server.mjs');
  const overviewStart = server.indexOf("url.pathname === '/api/overview'");
  const overviewEnd = server.indexOf("url.pathname === '/api/storage/scan'", overviewStart);
  const block = server.slice(overviewStart, overviewEnd);
  assert.match(server, /overviewStorageCache/);
  assert.match(server, /warmOverviewStorage/);
  assert.match(block, /quickStorageSummary\(filesystems\)/);
  assert.doesNotMatch(block, /await Promise\.all\(\[\s*getSystemSnapshot\(\), getFilesystems\(\), getStorageInventory\(\), listStoragePools\(\)/);
});

test('current Files UI supports true All Files and multi/folder uploads with progress', async () => {
  const [app, files, server] = await Promise.all([
    read('public/app.js'),
    read('src/files.mjs'),
    read('src/server.mjs')
  ]);
  assert.match(app, /Upload files<input id="file-upload" type="file" multiple/);
  assert.match(app, /Upload folder<input id="folder-upload" type="file" webkitdirectory directory multiple/);
  assert.match(app, /uploadFilesWithProgress/);
  assert.match(app, /XMLHttpRequest/);
  assert.match(app, /All files is a flat view/);
  assert.match(files, /export async function listAllFiles/);
  assert.match(files, /for \(const volume of await attachedVolumes\(\)\)/);
  assert.match(server, /url\.searchParams\.get\('all'\) === '1'/);
  assert.match(server, /url\.searchParams\.get\('refresh'\) === '1'/);
});

test('sidebar scrollbar is completely hidden', async () => {
  const css = await read('public/styles.css');
  assert.match(css, /scrollbar-width: none/);
  assert.match(css, /-ms-overflow-style: none/);
  assert.match(css, /sidebar nav::-webkit-scrollbar \{ display: none; width: 0; height: 0; \}/);
});

test('ISO uses faster zstd live filesystem and remains branded graphical LightNAS', async () => {
  const iso = await read('iso/build.sh');
  assert.match(iso, /--compression zstd/);
  assert.match(iso, /Install LightNAS \(Graphical\)/);
  assert.match(iso, /lightnas-display-fallback\.service/);
  assert.match(iso, /LightNAS 1\.0/);
});

test('App Store remains broad enough for NAS use cases', async () => {
  const runtime = await read('src/runtimes-next.mjs');
  const catalog = runtime.slice(runtime.indexOf('export const catalog'), runtime.indexOf(']);', runtime.indexOf('export const catalog')) + 3);
  const ids = [...catalog.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1]);
  assert.ok(ids.length >= 50, `expected at least 50 one-click apps, found ${ids.length}`);
  for (const id of ['plex','jellyfin','nextcloud','sonarr','radarr','qbittorrent','syncthing','home-assistant','vaultwarden','grafana','n8n','minio']) {
    assert.ok(ids.includes(id), `missing expected NAS app ${id}`);
  }
});
