import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('All Files is flat, includes attached storage, and folder uploads show progress', async () => {
  const [files, app, server] = await Promise.all([
    read('src/files.mjs'),
    read('public/app.js'),
    read('src/server.mjs')
  ]);
  assert.match(files, /export async function listAllFiles/);
  assert.match(files, /for \(const volume of await attachedVolumes\(\)\)/);
  assert.match(files, /\$\{ATTACHED_ROOT\}\/\$\{volume\.name\}/);
  assert.match(server, /url\.searchParams\.get\('all'\) === '1'/);
  assert.match(app, /webkitdirectory/);
  assert.match(app, /multiple hidden/);
  assert.match(app, /uploadFilesWithProgress/);
  assert.match(app, /XMLHttpRequest/);
  assert.match(app, /ZIP and other file types are accepted/);
  assert.match(app, /All files is a flat view/);
});

test('Files refresh and storage hot-plug detection are explicit', async () => {
  const app = await read('public/app.js');
  assert.match(app, /data-action="refresh-files"/);
  assert.match(app, /Files refreshed\./);
  assert.match(app, /data-action="refresh-storage"/);
  assert.match(app, /autoDetectStorage/);
  assert.match(app, /setInterval\(autoDetectStorage, 8000\)/);
  assert.match(app, /New or changed storage detected\./);
});

test('ISO has a branded graphical fallback instead of relying only on LightDM', async () => {
  const iso = await read('iso/build.sh');
  assert.match(iso, /Install LightNAS \(Graphical\)/);
  assert.match(iso, /label\[\[:space:\]\]\+installgui/);
  assert.match(iso, /menu default/);
  assert.match(iso, /set default="Install LightNAS \(Graphical\)"/);
  assert.match(iso, /xinit/);
  assert.match(iso, /lightnas-display-fallback\.service/);
  assert.match(iso, /\/usr\/bin\/xinit \/usr\/local\/bin\/lightnas-xsession/);
  assert.match(iso, /PRETTY_NAME="LightNAS 1\.0 \(Debian 13\)"/);
  assert.match(iso, /Name=LightNAS/);
  assert.match(iso, /plymouth-set-default-theme lightnas/);
});

test('App Store is substantially expanded and supports multi-port one-click apps', async () => {
  const runtime = await read('src/runtimes-next.mjs');
  for (const id of ['plex','emby','sonarr','radarr','prowlarr','qbittorrent','transmission','syncthing','duplicati','mealie','home-assistant','forgejo','homarr']) {
    assert.ok(runtime.includes(`id: '${id}'`), `missing catalog app ${id}`);
  }
  assert.match(runtime, /app\.extraPorts \|\| \[\]/);
  assert.match(runtime, /0\.0\.0\.0:\$\{hostPort\}:\$\{containerPort\}\/\$\{protocol\}/);
});

test('collapsed sidebar hides its scrollbar and secondary clutter', async () => {
  const styles = await read('public/styles.css');
  assert.match(styles, /scrollbar-width: none/);
  assert.match(styles, /sidebar nav::-webkit-scrollbar/);
  assert.match(styles, /sidebar-collapsed .*data-view="pools"/s);
  assert.match(styles, /content: attr\(title\)/);
});
