import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Files and Media supports grid view, streamed folder downloads and broad previews', async () => {
  const [app, enhancements, files, server, thumbnails] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/files.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/thumbnails.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(app, /data-file-layout="grid"/);
  assert.match(app, /data-download-folder/);
  assert.match(server, /\/api\/files\/archive/);
  assert.match(server, /tar', \['-czf', '-'/);
  assert.doesNotMatch(files, /MAX_UPLOAD/);
  assert.match(enhancements, /video-preview/);
  assert.match(enhancements, /\bcr3\b/);
  assert.match(thumbnails, /\bnef\b/);
  assert.match(thumbnails, /\bm2ts\b/);
});

test('compute dashboards show operational resource summaries instead of readiness boxes', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Container memory use/);
  assert.match(app, /VM memory use/);
  assert.match(app, /Host CPU use/);
  assert.doesNotMatch(app, /<h3>Nested mode<\/h3>/);
  assert.doesNotMatch(app, /<h3>VM engine<\/h3>/);
});

test('node shell, profile pictures, expanded permissions and collapsible navigation are wired end to end', async () => {
  const [page, app, server, localHost, agent, terminal] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/local-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../public/node-console.js', import.meta.url), 'utf8')
  ]);
  assert.match(page, /#permissions/);
  assert.match(page, /#shell/);
  assert.match(page, /avatar-upload/);
  assert.match(app, /sidebar-collapsed/);
  assert.match(server, /system\.shell/);
  assert.match(server, /\/api\/profile\/avatar/);
  assert.match(server, /\/api\/console\/node/);
  assert.match(localHost, /localNodeConsoleSocket/);
  assert.match(agent, /def stream_node/);
  assert.match(terminal, /api\/console\/node/);
});

test('networking includes Proxmox-style bridge, bond, VLAN and profile controls', async () => {
  const [app, dialog, agent] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  assert.match(app, /data-network-add-bridge/);
  assert.match(app, /data-network-add-bond/);
  assert.match(app, /data-network-add-vlan/);
  assert.match(dialog, /NETWORK BOND/);
  assert.match(agent, /action == "bond-create"/);
});
