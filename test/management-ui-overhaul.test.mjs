import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Files and storage transfers are unlimited by default but remain configurable', async () => {
  const [files, storage, templates, contract] = await Promise.all([
    read('src/files.mjs'),
    read('src/storage-pools.mjs'),
    read('src/templates.mjs'),
    read('config/platform-support.json')
  ]);
  assert.match(files, /LIGHTNAS_FILE_UPLOAD_MAX_BYTES \|\| 0/);
  assert.match(storage, /LIGHTNAS_STORAGE_UPLOAD_MAX_BYTES \|\| 0/);
  assert.match(templates, /LIGHTNAS_TEMPLATE_MAX_BYTES \|\| 0/);
  const platform = JSON.parse(contract);
  assert.equal(platform.upload.unlimitedByDefault, true);
  assert.equal(platform.upload.genericFileDefaultMaxGiB, 0);
  assert.equal(platform.upload.storageImageDefaultMaxGiB, 0);
  assert.equal(platform.upload.templateDefaultMaxGiB, 0);
});

test('Files UI supports persistent list/grid views and streamed folder downloads', async () => {
  const [app, server] = await Promise.all([read('public/app.js'), read('src/server.mjs')]);
  assert.match(app, /lightnas-file-view/);
  assert.match(app, /data-file-view="list"/);
  assert.match(app, /data-file-view="grid"/);
  assert.match(app, /data-download-folder/);
  assert.match(server, /\/api\/files\/archive/);
  assert.match(server, /spawn\('tar'/);
  assert.match(server, /application\/gzip/);
});

test('RAW photos and broad video formats have preview paths', async () => {
  const [thumbs, server, enhancements] = await Promise.all([
    read('src/thumbnails.mjs'),
    read('src/server.mjs'),
    read('public/enhancements.js')
  ]);
  for (const extension of ['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2']) {
    assert.ok(thumbs.includes(extension), `missing RAW preview format ${extension}`);
  }
  for (const extension of ['.mkv', '.avi', '.wmv', '.mts', '.m2ts', '.vob']) {
    assert.ok(thumbs.includes(extension), `missing video preview format ${extension}`);
  }
  assert.match(server, /\/api\/files\/video-preview/);
  assert.match(server, /libx264/);
  assert.match(enhancements, /\/api\/files\/thumbnail\?preview=1/);
  assert.match(enhancements, /\/api\/files\/video-preview/);
});

test('VM and container pages show resource summaries instead of capability boxes', async () => {
  const app = await read('public/app.js');
  assert.match(app, /runtimeResourceSummary/);
  assert.match(app, /Total \$\{label\}/);
  assert.match(app, /Allocated RAM/);
  assert.match(app, /Allocated vCPU/);
  const containers = app.slice(app.indexOf('function containersView()'), app.indexOf('function vmsView()'));
  const vms = app.slice(app.indexOf('function vmsView()'), app.indexOf('function sharesView()'));
  for (const legacy of ['Nested mode', 'cgroups', 'Namespaces / veth', 'Container bridge']) assert.doesNotMatch(containers, new RegExp(legacy));
  for (const legacy of ['VM engine', 'KVM', 'TUN/TAP']) assert.doesNotMatch(vms, new RegExp(legacy.replace('/', '\\/')));
});

test('Permissions has its own tab with expanded enforceable scopes', async () => {
  const [index, app, server, security] = await Promise.all([
    read('public/index.html'),
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/admin-security.js')
  ]);
  assert.match(index, /href="#permissions"/);
  assert.match(app, /function permissionsView\(\)/);
  for (const permission of ['files.download', 'files.delete', 'firewall.manage', 'monitoring.view']) {
    assert.ok(server.includes(`'${permission}'`), `missing permission ${permission}`);
    assert.ok(security.includes(`'${permission}'`), `missing permission label ${permission}`);
  }
  assert.doesNotMatch(server, /'shell\.access'/);
});

test('node shell is a real permission-controlled root PTY exposed through the GUI', async () => {
  const [agent, local, server, index, app, shell] = await Promise.all([
    read('scripts/lightnas-host-agent.py'),
    read('src/local-host.mjs'),
    read('src/server.mjs'),
    read('public/index.html'),
    read('public/app.js'),
    read('public/node-shell.js')
  ]);
  assert.match(agent, /def stream_node_shell\(/);
  assert.match(agent, /"node-console"/);
  assert.match(agent, /cwd="\/root"/);
  assert.match(local, /localNodeConsoleSocket/);
  assert.match(server, /url\.pathname === '\/api\/console\/node'/);
  assert.match(server, /context\.permissions\.includes\('system\.shell'\)/);
  assert.match(index, /href="#shell"/);
  assert.match(app, /data-open-node-shell/);
  assert.match(shell, /\/api\/console\/node/);
});

test('sidebar collapse and profile picture upload are integrated', async () => {
  const [index, app, styles, server] = await Promise.all([
    read('public/index.html'),
    read('public/app.js'),
    read('public/styles.css'),
    read('src/server.mjs')
  ]);
  assert.match(app, /lightnas-sidebar-collapsed/);
  assert.match(styles, /\.console\.sidebar-collapsed/);
  assert.match(index, /id="avatar"/);
  assert.match(app, /\/api\/profile\/avatar/);
  assert.match(server, /url\.pathname === '\/api\/profile\/avatar'/);
  assert.match(server, /image\/jpeg/);
  assert.match(server, /image\/webp/);
});

test('Networking exposes Proxmox-style interfaces plus bridges VLANs bonds and routes', async () => {
  const [app, dialogs, agent] = await Promise.all([
    read('public/app.js'),
    read('public/dialog-controls.js'),
    read('scripts/lightnas-host-agent.py')
  ]);
  assert.match(app, /network-table-row/);
  assert.match(app, /data-network-add-bridge/);
  assert.match(app, /data-network-add-vlan/);
  assert.match(app, /data-network-add-bond/);
  assert.match(app, /data-network-add-route/);
  assert.match(dialogs, /action: 'bond-create'/);
  assert.match(dialogs, /action: 'route-create'/);
  assert.match(agent, /action == "bond-create"/);
  assert.match(agent, /action == "route-create"/);
  assert.match(agent, /activated": False/);
});

test('Admin Center is a focused operational dashboard and legacy injectors are disabled', async () => {
  const [app, enhancements] = await Promise.all([read('public/app.js'), read('public/enhancements.js')]);
  const admin = app.slice(app.indexOf('function adminView()'), app.indexOf('function moduleView'));
  assert.match(admin, /admin-overview-grid/);
  assert.match(admin, /Self-management/);
  assert.doesNotMatch(admin, /Application catalog/);
  assert.match(enhancements, /Admin Center is rendered directly by app\.js/);
  assert.match(enhancements, /Permissions moved to the dedicated #permissions workspace/);
});


test('All Files is flat and file/folder uploads expose real progress', async () => {
  const [files, server, app] = await Promise.all([
    read('src/files.mjs'),
    read('src/server.mjs'),
    read('public/app.js')
  ]);
  assert.match(files, /export async function listAllFiles/);
  assert.match(files, /recursiveFileEntries/);
  assert.match(server, /url\.searchParams\.get\('all'\) === '1'/);
  assert.match(app, /\/api\/files\?all=1/);
  assert.match(app, /id="file-upload" type="file" multiple/);
  assert.match(app, /id="folder-upload" type="file" webkitdirectory directory multiple/);
  assert.match(app, /new XMLHttpRequest\(\)/);
  assert.match(app, /xhr\.upload\.addEventListener\('progress'/);
  assert.match(app, /uploadFilesWithProgress/);
  assert.doesNotMatch(app, /accept="[^"]*zip/i);
});

test('Storage inventory automatically exposes and refreshes newly detected drives', async () => {
  const [system, app, server] = await Promise.all([
    read('src/system.mjs'),
    read('public/app.js'),
    read('src/server.mjs')
  ]);
  assert.match(system, /system:/);
  assert.match(system, /blank:/);
  assert.match(server, /\/api\/storage\/scan/);
  assert.match(app, /autoDetectStorage/);
  assert.match(app, /setInterval\(autoDetectStorage, 12000\)/);
  assert.match(app, /New or changed storage detected/);
});

test('App Store contains a broad searchable one-click catalog', async () => {
  const [runtime, app] = await Promise.all([read('src/runtimes-next.mjs'), read('public/app.js')]);
  const catalogBlock = runtime.slice(runtime.indexOf('export const catalog'), runtime.indexOf(']);', runtime.indexOf('export const catalog')));
  const appCount = (catalogBlock.match(/\{ id: '/g) || []).length;
  assert.ok(appCount >= 20, `expected at least 20 curated apps, found ${appCount}`);
  for (const id of ['jellyfin','navidrome','freshrss','gitea','vaultwarden','actual-budget','nextcloud','open-webui']) {
    assert.match(catalogBlock, new RegExp(`id: '${id}'`));
  }
  assert.match(app, /id="app-search"/);
  assert.match(app, /id="app-category"/);
  assert.match(app, /data-app-card/);
});

test('ISO is branded, graphical, hybrid BIOS-UEFI, and provides a local web kiosk', async () => {
  const [build, preseed] = await Promise.all([read('iso/build.sh'), read('iso/preseed.cfg')]);
  assert.match(build, /--debian-installer-gui true/);
  assert.match(build, /--bootloaders 'syslinux,grub-efi'/);
  assert.match(build, /--uefi-secure-boot auto/);
  assert.match(build, /--firmware-binary true/);
  assert.match(build, /--iso-application 'LightNAS'/);
  assert.match(build, /lightnas-splash\.svg/);
  assert.match(build, /Install LightNAS \(Graphical\)/);
  assert.match(build, /xserver-xorg/);
  assert.match(build, /lightdm/);
  assert.match(build, /chromium/);
  assert.match(build, /http:\/\/127\.0\.0\.1:3080/);
  assert.match(build, /report_el_torito plain/);
  assert.match(preseed, /netcfg\/get_hostname string lightnas/);
});

test('collapsed sidebar uses a clean icon rail without visible scrollbar', async () => {
  const styles = await read('public/styles.css');
  assert.match(styles, /sidebar-collapsed \{ grid-template-columns: 86px 1fr/);
  assert.match(styles, /sidebar nav::\-webkit-scrollbar \{ width: 0; height: 0/);
  assert.match(styles, /scrollbar-width: none/);
});
