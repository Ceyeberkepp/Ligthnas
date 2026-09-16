import test from 'node:test';
import assert from 'node:assert/strict';

test('Proxmox VM creation checks live inventory, verifies TLS endpoint, and never sends token in API response', async () => {
  const keys = ['LIGHTNAS_PVE_URL', 'LIGHTNAS_PVE_NODE', 'LIGHTNAS_PVE_TOKEN_ID', 'LIGHTNAS_PVE_TOKEN_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  try {
    process.env.LIGHTNAS_PVE_URL = 'https://pve.example.test:8006';
    process.env.LIGHTNAS_PVE_NODE = 'pve01';
    process.env.LIGHTNAS_PVE_TOKEN_ID = 'lightnas@pve!vm';
    process.env.LIGHTNAS_PVE_TOKEN_SECRET = 'test-secret-never-printed';
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      assert.equal(url.protocol, 'https:');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'PVEAPIToken=lightnas@pve!vm=test-secret-never-printed');
      const path = String(url);
      const result = path.includes('cluster/nextid') ? 142 : path.includes('content?content=iso') ? [{ content: 'iso', volid: 'local:iso/debian.iso' }] :
        path.includes('/storage?content=iso') ? [{ storage: 'local', enabled: 1, active: 1 }] :
        path.includes('/storage?content=images') ? [{ storage: 'local-lvm', enabled: 1, active: 1 }] :
        path.includes('/network') ? [{ iface: 'vmbr0', type: 'bridge', active: 1 }] :
        path.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } :
        path.includes('/qemu') && options.method === 'POST' ? 'UPID:job' : [];
      return { ok: true, json: async () => ({ data: result }) };
    };
    const { proxmoxInventory, proxmoxCreateVm } = await import('../src/proxmox.mjs');
    const inventory = await proxmoxInventory();
    assert.equal(inventory.provider, 'proxmox');
    assert.deepEqual(inventory.pools, ['local-lvm']);
    assert.deepEqual(inventory.images, ['local:iso/debian.iso']);
    const options = { name: 'NewVm', pool: 'local-lvm', network: 'vmbr0', iso: 'local:iso/debian.iso', memoryMiB: 2048, cpus: 2, diskGiB: 20 };
    await assert.rejects(proxmoxCreateVm({ ...options, iso: 'local:iso/unknown.iso' }, inventory), { status: 409 });
    const result = await proxmoxCreateVm(options, inventory);
    assert.equal(result.vmid, 142);
    assert.equal(result.startTask, 'UPID:job');
    assert.equal(JSON.stringify(result).includes('test-secret'), false);
    const create = requests.find(item => item.url.endsWith('/qemu') && item.options.method === 'POST');
    assert.equal(new URLSearchParams(create.options.body).get('scsi0'), 'local-lvm:20');
    assert.equal(new URLSearchParams(create.options.body).get('ide2'), 'local:iso/debian.iso,media=cdrom');
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
