import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ISO builder uses supported compression and validates installer payload', async () => {
  const build = await readFile(new URL('../iso/build.sh', import.meta.url), 'utf8');
  assert.match(build, /--compression xz/);
  assert.doesNotMatch(build, /--compression zstd/);
  assert.match(build, /Validating LightNAS installer payload/);
  assert.match(build, /BIOS and UEFI boot entries confirmed/);
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
  assert.match(workflow, /qemu-system-x86_64/);
  assert.match(workflow, /sha256sum -c/);
  assert.doesNotMatch(workflow, /README\.md/);
  assert.doesNotMatch(workflow, /docs\/\*\*/);
});
