import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ISO builder uses supported compression and validates installer payload', async () => {
  const build = await readFile(new URL('../iso/build.sh', import.meta.url), 'utf8');
  assert.match(build, /--compression xz/);
  assert.doesNotMatch(build, /--compression zstd/);
  assert.match(build, /--debian-installer-preseedfile preseed\.cfg/);
  assert.ok(build.indexOf('config/binary_debian-installer/preseed.cfg') < build.indexOf('\nlb config \\'), 'preseed must be staged before the lb config command');
  assert.match(build, /Validating LightNAS installer payload/);
  assert.match(build, /BIOS and UEFI boot entries confirmed/);
  assert.match(build, /installer="gui"/);
  assert.match(build, /installer="text"/);
  assert.match(build, /menu label \^Install LightNAS \(Graphical\)/);
  assert.match(build, /menu label Install LightNAS \(Terminal UI\)/);
  assert.match(build, /Install LightNAS \(VGA Safe Mode\)/);
  assert.match(build, /Install LightNAS \(Serial Console\)/);
  assert.match(build, /Graphical, VGA-safe, terminal, and serial LightNAS installer entries confirmed/);
  assert.match(build, /Installer payload confirmed inside final ISO/);
  assert.match(build, /LIGHTNAS_ISO_CLEAN/);
});

test('ISO partition recipe fits the documented 35 GB minimum and does not force a timezone', async () => {
  const preseed = await readFile(new URL('../iso/preseed.cfg', import.meta.url), 'utf8');
  assert.match(preseed, /16384 18432 20480 ext4/);
  assert.match(preseed, /1024 1536 2048 linux-swap/);
  assert.match(preseed, /8192 12000 1000000000 ext4/);
  assert.match(preseed, /mountpoint\{ \/var\/lib\/lightnas\/storage\/local \}/);
  assert.doesNotMatch(preseed, /time\/zone string America\/New_York/);
  assert.match(preseed, /Time zone is intentionally not preseeded/);
});

test('ISO workflow avoids doc-only rebuild noise and performs a QEMU smoke boot', async () => {
  const workflow = await readFile(new URL('../.github/workflows/build-iso.yml', import.meta.url), 'utf8');
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /BIOS boot smoke test/);
  assert.match(workflow, /UEFI boot smoke test/);
  assert.match(workflow, /qemu-system-x86_64/);
  assert.match(workflow, /find \/usr\/share\/OVMF \/usr\/share\/qemu/);
  assert.match(workflow, /Using UEFI firmware/);
  assert.match(workflow, /-bios "\$OVMF_CODE"/);
  assert.doesNotMatch(workflow, /-bios \/usr\/share\/OVMF\/OVMF_CODE_4M\.fd/);
  assert.match(workflow, /sha256sum -c/);
  assert.doesNotMatch(workflow, /README\.md/);
  assert.doesNotMatch(workflow, /docs\/\*\*/);
  // The appliance ISO embeds src/public, so source changes must rebuild it.
  assert.match(workflow, /src\/\*\*/);
  assert.match(workflow, /public\/\*\*/);
  assert.match(workflow, /config\/\*\*/);
});
