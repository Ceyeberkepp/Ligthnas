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
  assert.match(app, /id="file-upload" type="file"/);
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


test('Containers inventory includes App Store managed Docker containers', async () => {
  const app = await read('public/app.js');
  assert.match(app, /APP STORE CONTAINERS/);
  assert.match(app, /lightnas-app-/);
  assert.match(app, /App Store managed/);
  assert.match(app, /Docker \/ OCI/);
  assert.match(app, /data-app-action="restart"/);
  assert.match(app, /Promise\.all\(\[loadContainers\(\), loadRuntimes\(\)\]\)/);
});

test('non-modal long running work uses the Tasks dock without creating a dialog', async () => {
  const dialogs = await read('public/dialog-controls.js');
  assert.match(dialogs, /options\.modal === false \|\| options\.taskOnly === true/);
  const taskOnlyIndex = dialogs.indexOf('options.modal === false || options.taskOnly === true');
  const dialogIndex = dialogs.indexOf("document.createElement('dialog')", taskOnlyIndex);
  assert.ok(taskOnlyIndex >= 0 && dialogIndex > taskOnlyIndex, 'task-only return must happen before dialog creation');
  assert.match(dialogs, /Creating system container[\s\S]*\{ modal:false \}/);
  assert.match(dialogs, /Deleting \$\{label\}[\s\S]*\{ modal:false \}/);
});

test('Settings and MFA have responsive structured layouts', async () => {
  const styles = await read('public/styles.css');
  assert.match(styles, /\.settings-dashboard \{/);
  assert.match(styles, /\.mfa-method-grid,/);
  assert.match(styles, /\.mfa-config-grid/);
  assert.match(styles, /@media \(max-width: 1050px\)[\s\S]*\.settings-dashboard/);
});


test('managed App Store containers show access address and terminal controls', async () => {
  const [app, server, system, terminal] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('src/system.mjs'),
    read('public/container-console.js')
  ]);
  assert.match(app, /data-app-terminal/);
  assert.match(app, /data-app-open/);
  assert.match(app, /primaryIpv4 \|\| location\.hostname/);
  assert.match(app, /http:\/\/\$\{hostAddress\}:\$\{app\.port\}/);
  assert.match(server, /\/api\\\/console\\\/app\\\//);
  assert.match(server, /openContainerShell\(appContainer\[1\]\)/);
  assert.match(server, /apps\.manage/);
  assert.match(system, /network\.primaryIpv4 = primaryIpv4/);
  assert.match(terminal, /params\.get\('type'\) === 'app'/);
});

test('General settings owns both text and picture branding', async () => {
  const [app, server, index, styles] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/index.html'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /Brand \/ logo name/);
  assert.match(app, /Upload picture logo/);
  assert.doesNotMatch(app, /<span class="eyebrow">BRANDING<\/span>/);
  assert.match(server, /brandName: store\.state\.config\.brandName \|\| 'LightNAS'/);
  assert.match(index, /data-brand-name>LightNAS/);
  assert.match(styles, /\.general-branding-row/);
});
