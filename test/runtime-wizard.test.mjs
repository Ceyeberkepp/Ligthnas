import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configureVmBootXml, configureVmEditableHardware } from '../src/runtimes-next.mjs';

test('VM and container creation use guided dialogs instead of inline forms', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const dialogs = await readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /id="container-form"/);
  assert.doesNotMatch(app, /id="vm-form"/);
  assert.match(dialogs, /showRuntimeWizard/);
  assert.match(dialogs, /Root password/);
  assert.match(dialogs, /diskGiB/);
  assert.match(dialogs, /firmware/);
  assert.match(dialogs, /LightNASProgress/);
});

test('nested VM provisioning disables unsupported libvirt ownership xattrs and cleans failed domains', async () => {
  const [provision, runtime] = await Promise.all([
    readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(provision, /remember_owner = 0/);
  assert.match(provision, /trusted\.libvirt\.security\.dac/);
  assert.match(runtime, /undefine.*--nvram/s);
  assert.match(runtime, /rm\(diskDirectory, \{ recursive: true, force: true \}\)/);
  assert.match(runtime, /nested-libvirt ownership restriction/);
});

test('VMs with selected ISO media automatically enter the installer', async () => {
  const [runtime, enhancements, dialogs] = await Promise.all([
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8')
  ]);
  assert.match(runtime, /function queueInstallerBootKey/);
  assert.match(runtime, /send-key.*--holdtime.*KEY_SPACE/s);
  assert.match(runtime, /complete boot window/);
  assert.match(runtime, /if \(!hardwareChanged && \/running\/i\.test/);
  assert.match(runtime, /'reset', target/);
  assert.match(runtime, /uefi,cdrom,hd,menu=on/);
  assert.match(runtime, /'--video', 'vga'/);
  assert.match(runtime, /if \(isoEntry\) queueInstallerBootKey\(input\.name\)/);
  assert.match(runtime, /configureVmBootXml/);
  assert.match(runtime, /installationMediaId/);
  assert.match(dialogs, /CD\/DVD drive · installer ISO/);
  assert.match(dialogs, /First boot drive/);
  assert.match(dialogs, /Display adapter/);
  assert.match(dialogs, /Standard VGA · recommended for installers/);
  assert.match(dialogs, /SCSI controller/);
  assert.match(dialogs, /Network adapter model/);
  assert.match(dialogs, /Start automatically with LightNAS/);
  assert.match(dialogs, /bootOrder: values\.bootOrder/);
  assert.doesNotMatch(enhancements, /data-vm-action="boot-installer"/);

  const original = `<domain><os><type machine='pc-q35'>hvm</type><boot dev='hd'/></os><devices><disk type='file' device='disk'><source file='/vm/disk.qcow2'/><target dev='sda' bus='scsi'/></disk></devices></domain>`;
  const updated = configureVmBootXml(original, '/iso/windows.iso', 'iso');
  assert.match(updated, /device='cdrom'/);
  assert.match(updated, /source file='\/iso\/windows\.iso'/);
  assert.match(updated, /device='cdrom'[\s\S]*boot order='1'/);
  assert.match(updated, /device='disk'[\s\S]*boot order='2'/);
  assert.doesNotMatch(updated, /boot dev=/);

  const hardware = configureVmEditableHardware(`<domain><devices><controller type='scsi' model='virtio-scsi'/><interface type='network'><model type='virtio'/></interface><video><model type='qxl' ram='65536' vram='65536' vgamem='16384' heads='1' primary='yes'/></video></devices></domain>`, { displayModel: 'vga', networkModel: 'e1000', scsiController: 'virtio-scsi-single' });
  assert.match(hardware, /<model type='vga'/);
  assert.doesNotMatch(hardware, /<model type='vga'[^>]*\bram=/);
  assert.match(hardware, /<model type='e1000'/);
  assert.match(hardware, /model='virtio-scsi-single'/);
});

test('image and ISO transfers use the progress dialog', async () => {
  const templates = await readFile(new URL('../public/templates.js', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../public/storage-manager.js', import.meta.url), 'utf8');
  assert.match(templates, /Downloading container image/);
  assert.match(storage, /Downloading VM installer image/);
  assert.match(storage, /uploaded successfully and is ready to use/);
});

test('container backend requires credentials and selected root storage', async () => {
  const [runtime, agent, dialogs] = await Promise.all([
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8')
  ]);
  assert.match(runtime, /4–128 character root password/);
  assert.match(dialogs, /minlength="4"/);
  assert.match(runtime, /resolveStoragePool\(String\(input\.pool/);
  assert.match(runtime, /image: input\.image/);
  assert.match(agent, /chpasswd/);
  assert.match(agent, /managed_container_storage_root/);
  assert.match(agent, /lightnas\.json/);
  assert.match(agent, /"imageId": str\(data\.get\("image"\)/);
  assert.match(agent, /def verify_container_installation/);
  assert.match(agent, /etc" \/ "os-release/);
  assert.match(agent, /"verified": True/);
});

test('files and media share one tabbed library with sequential previews', async () => {
  const [page, app, enhancements] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8')
  ]);
  assert.match(page, />Files & media</);
  assert.doesNotMatch(page, /data-view="media"/);
  assert.match(app, /data-library-tab/);
  assert.match(app, /\['Photos', 'Photos'\]/);
  assert.doesNotMatch(app, /\['ISO', 'ISO images'\]/);
  assert.doesNotMatch(app, />Upload files</);
  assert.match(app, />Upload<input id="file-upload"/);
  assert.match(app, /entry\.name === 'ISO'/);
  assert.match(enhancements, /data-viewer-previous/);
  assert.match(enhancements, /data-viewer-next/);
  assert.match(enhancements, /ArrowLeft/);
  assert.match(enhancements, /ArrowRight/);
  assert.match(enhancements, /previewItems\(\)/);
});
