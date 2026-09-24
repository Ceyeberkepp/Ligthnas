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

  assert.match(manager, /STORAGE_PROVIDERS/);
  for (const label of ['Directory', 'LVM', 'LVM-Thin', 'BTRFS', 'NFS', 'SMB \/ CIFS', 'GlusterFS', 'iSCSI', 'CephFS', 'RBD', 'ZFS over iSCSI', 'ZFS', 'Proxmox Backup Server', 'VMware ESXi']) {
    assert.match(manager, new RegExp(label));
  }
  assert.match(manager, /selectedType==='vztmpl'/);
  assert.match(manager, /data-template-storage/);
  assert.match(templates, /preferredStorageId/);
});
