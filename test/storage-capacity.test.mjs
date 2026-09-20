import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProxmoxMounts } from '../src/system.mjs';

const GiB = 1024 ** 3;

test('Proxmox pct config sizes override misleading LXC filesystem geometry', () => {
  const filesystems = [
    {
      id: 'a',
      device: '/dev/loop61',
      mountPoint: '/home/SDD01',
      type: 'ext4',
      readOnly: false,
      writable: true,
      totalBytes: 5000 * GiB,
      usedBytes: 20 * GiB
    },
    {
      id: 'b',
      device: '/dev/loop62',
      mountPoint: '/Home/SDD02',
      type: 'ext4',
      readOnly: false,
      writable: true,
      totalBytes: 5000 * GiB,
      usedBytes: 30 * GiB
    },
    {
      id: 'c',
      device: '/dev/loop63',
      mountPoint: '/ssd01',
      type: 'ext4',
      readOnly: false,
      writable: true,
      totalBytes: 800 * GiB,
      usedBytes: 40 * GiB
    }
  ];

  const manifest = {
    source: 'proxmox-pct-config',
    mounts: [
      { slot: 'mp0', volume: 'GRS:170/vm-170-disk-0.raw', mountPoint: '/home/SDD01', size: '500G', sizeBytes: 500 * GiB },
      { slot: 'mp1', volume: 'EIGTBSD:170/vm-170-disk-0.raw', mountPoint: '/Home/SDD02', size: '500G', sizeBytes: 500 * GiB },
      { slot: 'mp2', volume: 'XTC:170/vm-170-disk-0.raw', mountPoint: '/ssd01', size: '800G', sizeBytes: 800 * GiB }
    ]
  };

  const volumes = reconcileProxmoxMounts(filesystems, manifest);
  assert.deepEqual(volumes.map(item => item.totalBytes), [500 * GiB, 500 * GiB, 800 * GiB]);
  assert.deepEqual(volumes.map(item => item.configuredSize), ['500G', '500G', '800G']);
  assert.equal(volumes.reduce((sum, item) => sum + item.totalBytes, 0), 1800 * GiB);
  assert.ok(volumes.every(item => item.capacitySource === 'proxmox-pct-config'));
});
