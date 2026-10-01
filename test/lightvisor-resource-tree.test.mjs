import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('LightVisor uses a hierarchical Proxmox-style resource tree', async () => {
  const [app, css] = await Promise.all([
    read('public/app.js'),
    read('public/hypervisor.css')
  ]);

  const start = app.indexOf('function hypervisorResourceTree');
  const end = app.indexOf('function hypervisorSubViewShell', start);
  assert.ok(start >= 0 && end > start, 'hypervisorResourceTree must exist');
  const tree = app.slice(start, end);

  assert.match(tree, /RESOURCE TREE/);
  assert.match(tree, /Local Datacenter/);
  assert.match(tree, /LXC Containers/);
  assert.match(tree, /Nodes/);
  assert.match(tree, /Virtual Machines/);
  assert.match(tree, /SDN \/ Networks/);
  assert.match(tree, /Storage/);
  assert.match(tree, /OPERATIONS/);
  assert.match(tree, /Backups/);
  assert.match(tree, /Monitoring/);
  assert.match(tree, /Users & RBAC/);
  assert.match(tree, /Settings/);

  assert.match(tree, /containers\.map/);
  assert.match(tree, /vms\.map/);
  assert.match(tree, /networks\.map/);
  assert.match(tree, /pools\.map/);
  assert.match(tree, /<details class="hv-inventory-root" open>/);
  assert.match(tree, /<details class="hv-inventory-group" open>/);
  assert.match(tree, /data-view-link="containers"/);
  assert.match(tree, /data-view-link="vms"/);
  assert.match(tree, /data-view-link="network"/);
  assert.match(tree, /data-view-link="storage"/);

  assert.match(css, /\.hv-inventory-root/);
  assert.match(css, /\.hv-inventory-group/);
  assert.match(css, /\.hv-tree-children/);
  assert.match(css, /\.hv-tree-resource/);
  assert.match(css, /details\[open\] > summary \.hv-tree-chevron/);
});

test('LightVisor keeps inventory and operational navigation separate', async () => {
  const app = await read('public/app.js');
  const start = app.indexOf('function hypervisorResourceTree');
  const end = app.indexOf('function hypervisorSubViewShell', start);
  const tree = app.slice(start, end);

  const inventory = tree.indexOf('RESOURCE TREE');
  const operations = tree.indexOf('OPERATIONS');
  assert.ok(inventory >= 0 && operations > inventory);

  for (const label of ['LXC Containers','Nodes','Virtual Machines','SDN / Networks','Storage']) {
    const marker = '<b>' + label + '</b>';
    const pos = tree.indexOf(marker, inventory);
    assert.ok(pos > inventory && pos < operations, label + ' must remain in resource inventory');
  }
  for (const label of ['Backups','Monitoring','Users & RBAC','Settings']) {
    const pos = tree.indexOf('>' + label + '</button>', operations);
    assert.ok(pos > operations, label + ' must remain in operations');
  }
});
