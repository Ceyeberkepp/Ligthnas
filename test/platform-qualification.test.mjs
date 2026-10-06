import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeArchitecture,
  platformSupport,
  architectureCompatible
} from '../src/platform.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('platform architecture aliases and validation policy are explicit', () => {
  assert.equal(normalizeArchitecture('x86_64'), 'amd64');
  assert.equal(normalizeArchitecture('aarch64'), 'arm64');
  assert.equal(normalizeArchitecture('i686'), 'i386');
  assert.equal(platformSupport('amd64').status, 'validated');
  assert.equal(platformSupport('arm64').status, 'target');
  assert.equal(platformSupport('riscv64').installer, false);
  assert.equal(architectureCompatible('amd64', 'amd64'), true);
  assert.equal(architectureCompatible('arm64', 'amd64'), false);
  assert.equal(architectureCompatible('arm64', 'amd64', true), true);
});

test('normal installer records architecture and refuses unvalidated support claims by default', async () => {
  const installer = await read('install.sh');
  assert.match(installer, /dpkg --print-architecture/);
  assert.match(installer, /LIGHTNAS_ALLOW_UNVALIDATED_ARCH/);
  assert.match(installer, /LIGHTNAS_PLATFORM_VALIDATED/);
  assert.match(installer, /Validated installer architecture: amd64/);
});

test('base control-plane services are bounded for the 2 GiB appliance target', async () => {
  const [installer, iso] = await Promise.all([read('install.sh'), read('iso/build.sh')]);
  for (const source of [installer, iso]) {
    assert.match(source, /NODE_OPTIONS=--max-old-space-size=256/);
    assert.match(source, /MemoryHigh=300M/);
    assert.match(source, /MemoryMax=384M/);
    assert.match(source, /MemoryHigh=100M/);
    assert.match(source, /MemoryMax=128M/);
    assert.match(source, /SystemMaxUse=128M/);
    assert.match(source, /RuntimeMaxUse=64M/);
    assert.match(source, /MaxRetentionSec=7day/);
  }
});

test('release workflow qualifies the 2 GiB RAM / 35 GiB disk envelope', async () => {
  const workflow = await read('.github/workflows/build-iso.yml');
  assert.match(workflow, /Minimum appliance qualification boot/);
  assert.match(workflow, /qemu-img create -f qcow2 \/tmp\/lightnas-minimum\.qcow2 35G/);
  assert.match(workflow, /-m 2048/);
  assert.match(workflow, /Minimum appliance envelope confirmed: 2 GiB RAM \/ 35 GiB disk/);
});

test('system-container catalog hides incompatible architecture images and carries metadata', async () => {
  const templates = await read('src/templates.mjs');
  assert.match(templates, /hostArchitecture\(\)/);
  assert.match(templates, /normalizeArchitecture/);
  assert.match(templates, /architectureCompatible/);
  assert.match(templates, /LIGHTNAS_SHOW_INCOMPATIBLE_TEMPLATES/);
  assert.match(templates, /LIGHTNAS_CONTAINER_EMULATION/);
  assert.match(templates, /combined\.filter\(item => item\.compatible !== false\)/);
  assert.match(templates, /minimumRamBytes/);
  assert.match(templates, /minimumStorageBytes/);
  assert.match(templates, /cached: true/);
  assert.match(templates, /selected container image is for/);
});

test('support matrix never advertises unvalidated target architectures as supported', async () => {
  const doc = await read('docs/PLATFORM-SUPPORT.md');
  assert.match(doc, /amd64 \/ x86_64 \| Validated/);
  assert.match(doc, /arm64 \/ aarch64 \| Target/);
  assert.match(doc, /riscv64 \| Target/);
  assert.match(doc, /i386 \/ i686 \| Legacy target/);
  assert.match(doc, /not advertised as supported until/);
});
