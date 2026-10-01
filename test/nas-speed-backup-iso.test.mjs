import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('App Store loads built-ins immediately and community catalog in background', async () => {
  const [app, community, server] = await Promise.all([
    read('public/app.js'),
    read('src/community-catalog.mjs'),
    read('src/server.mjs')
  ]);
  assert.match(app, /loadCommunityCatalog\(false\)/);
  assert.match(app, /communityCatalogLoading/);
  assert.doesNotMatch(app, /state\.communityCatalog = await request\('\/api\/catalog\/community\?refresh=1'\)/);
  assert.match(community, /stale:true, refreshing:true/);
  assert.match(community, /Promise\.all\(DEFAULT_SOURCES\.map/);
  assert.match(community, /MANIFEST_CONCURRENCY = 10/);
  assert.match(server, /RUNTIME_INVENTORY_TTL_MS = 4000/);
  assert.match(server, /getRuntimeInventoryCached\(url\.searchParams\.get\('refresh'\) === '1'\)/);
});

test('NAS backup page uses compact job table without changing hypervisor backup view', async () => {
  const [app, store, server, css] = await Promise.all([
    read('public/app.js'),
    read('src/store.mjs'),
    read('src/server.mjs'),
    read('public/styles.css')
  ]);
  assert.match(app, /This redesign is NAS-only/);
  assert.match(app, /data-backup-add/);
  assert.match(app, /data-backup-run/);
  assert.match(app, /Schedule Simulator/);
  assert.match(app, /window\.LIGHTNAS_PRODUCT_MODE === 'hypervisor'/);
  assert.match(store, /backupJobs: \[\]/);
  assert.match(server, /url\.pathname === '\/api\/backups\/jobs'/);
  assert.match(server, /Manual backup run requested/);
  assert.match(css, /body:not\(\.product-hypervisor\) \.backup-console/);
});

test('ISO workflow rebuilds when NAS source changes', async () => {
  const workflow = await read('.github/workflows/build-iso.yml');
  for (const path of ["'src/**'", "'public/**'", "'config/**'"]) {
    assert.ok(workflow.includes(path), `missing ISO workflow source trigger ${path}`);
  }
  assert.match(workflow, /BIOS boot smoke test/);
  assert.match(workflow, /UEFI boot smoke test/);
});
