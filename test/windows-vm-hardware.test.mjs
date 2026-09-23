import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configureVmEditableHardware } from '../src/runtimes-next.mjs';

test('existing VM disk can be converted from VirtIO SCSI to SATA without changing its source file', () => {
  const source = `
<domain type='kvm'>
  <devices>
    <controller type='scsi' model='virtio-scsi'/>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/var/lib/lightnas/vms/SVR-AS-CL1.qcow2'/>
      <target dev='sda' bus='scsi'/>
      <boot order='2'/>
    </disk>
    <interface type='network'><model type='virtio'/></interface>
    <video><model type='vga'/></video>
  </devices>
</domain>`;
  const updated = configureVmEditableHardware(source, {
    displayModel: 'vga',
    scsiController: 'virtio-scsi',
    diskBus: 'sata',
    networkModel: 'e1000'
  });

  assert.match(updated, /source file='\/var\/lib\/lightnas\/vms\/SVR-AS-CL1\.qcow2'/);
  assert.match(updated, /target dev='sda' bus='sata'/);
  assert.match(updated, /model type='e1000'/);
  assert.doesNotMatch(updated, /target dev='sda' bus='scsi'/);
});

test('new local Windows VMs force driver-free SATA and E1000 defaults', async () => {
  const runtime = await readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /const windowsInstaller = isWindowsInstaller\(isoEntry\)/);
  assert.match(runtime, /const diskBus = windowsInstaller \? 'sata' : requestedDiskBus/);
  assert.match(runtime, /const networkModel = windowsInstaller \? 'e1000' : requestedNetworkModel/);
  assert.match(runtime, /const firmware = windowsInstaller[\s\S]*?\? 'uefi'/);
});

test('VM wizard detects Windows media and selects compatible hardware automatically', async () => {
  const ui = await readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8');
  assert.match(ui, /function looksLikeWindowsMedia/);
  assert.match(ui, /form\.elements\.diskBus\.value = windows \? 'sata' : 'scsi'/);
  assert.match(ui, /form\.elements\.networkModel\.value = windows \? 'e1000' : 'virtio'/);
  assert.match(ui, /form\.elements\.firmware\.value = windows \? 'uefi' : 'bios'/);
  assert.match(ui, /name: 'diskBus'.*Windows compatible/);
});

test('Proxmox VM creation uses the same Windows-compatible defaults', async () => {
  const proxmox = await readFile(new URL('../src/proxmox.mjs', import.meta.url), 'utf8');
  assert.match(proxmox, /const diskBus = windowsInstaller \? 'sata' : requestedDiskBus/);
  assert.match(proxmox, /const networkModel = windowsInstaller \? 'e1000' : requestedNetworkModel/);
  assert.match(proxmox, /ostype: windowsInstaller \? 'win11' : 'l26'/);
});
