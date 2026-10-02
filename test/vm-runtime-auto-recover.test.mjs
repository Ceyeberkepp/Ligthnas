import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('VM runtime auto-recovers stopped libvirt service', async () => {
  const [host, runtimes] = await Promise.all([
    read('scripts/lightnas-host-agent.py'),
    read('src/runtimes-next.mjs')
  ]);

  assert.match(host, /enable", "--now"/);
  assert.match(host, /virtqemud\.socket/);
  assert.match(host, /libvirtd\.socket/);

  assert.match(runtimes, /if \(!vmInfo\.ok && installer\.ok\)/);
  assert.match(runtimes, /await localRepairNestedLibvirt\(\)/);
  assert.match(runtimes, /enabled: vmInfo\.ok && installer\.ok/);
  assert.match(runtimes, /libvirt VM service is not responding/);
});

test('VM creation options validate virsh, not only virt-install', async () => {
  const runtimes = await read('src/runtimes-next.mjs');
  assert.match(runtimes, /vmCreateInventory\(\)[\s\S]*virsh[\s\S]*list[\s\S]*all[\s\S]*virt-install/);
  assert.match(runtimes, /available: vmInfo\.ok && installer\.ok/);
});
