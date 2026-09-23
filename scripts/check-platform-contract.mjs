#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = JSON.parse(await read('config/platform-support.json'));
const [
  hostAgent,
  files,
  storagePools,
  storageManager,
  installer,
  isoBuilder,
  isoWorkflow,
  packageJsonText,
  readme
] = await Promise.all([
  read('scripts/lightnas-host-agent.py'),
  read('src/files.mjs'),
  read('src/storage-pools.mjs'),
  read('public/storage-manager.js'),
  read('install.sh'),
  read('iso/build.sh'),
  read('.github/workflows/build-iso.yml'),
  read('package.json'),
  read('README.md')
]);

const packageJson = JSON.parse(packageJsonText);

assert.equal(contract.minimum.ramMiB, 2048, 'platform contract must keep the 2 GiB RAM target');
assert.equal(contract.minimum.systemStorageGiB, 35, 'platform contract must keep the 35 GiB system-storage target');

for (const arch of ['amd64', 'i386', 'arm64', 'armhf', 'riscv64']) {
  assert.ok(contract.architectures[arch], `missing architecture target: ${arch}`);
}

assert.equal(contract.architectures.amd64.controlPlane, 'supported');
assert.equal(contract.architectures.amd64.bootArtifact, 'iso');
for (const arch of ['i386', 'arm64', 'armhf', 'riscv64']) {
  assert.notEqual(
    contract.architectures[arch].controlPlane,
    'supported',
    `${arch} must not be advertised as supported until release validation exists`
  );
}

// Native system-container builds must follow the host architecture rather than
// silently producing x86 root filesystems on ARM/RISC-V.
assert.doesNotMatch(hostAgent, /--arch=amd64/);
assert.doesNotMatch(hostAgent, /lxc\.arch = x86_64/);
assert.doesNotMatch(hostAgent, /"arch": "x86_64"/);
assert.match(hostAgent, /def native_debian_arch\(\)/);
assert.match(hostAgent, /"aarch64": "arm64"/);
assert.match(hostAgent, /"riscv64": "riscv64"/);
assert.match(hostAgent, /ports\.ubuntu\.com\/ubuntu-ports/);

// Large NAS/ISO transfers must stay streaming and above the historical 1 GiB
// limit. Storage images must preserve Content-Range resume support.
assert.match(files, /LIGHTNAS_FILE_UPLOAD_MAX_BYTES \|\| 50 \* 1024 \*\* 3/);
assert.doesNotMatch(files, /1 GB upload limit/);
assert.match(storagePools, /LIGHTNAS_STORAGE_UPLOAD_MAX_BYTES \|\| 50 \* 1024 \*\* 3/);
assert.match(storagePools, /parseContentRange/);
assert.match(storagePools, /Content-Range/);
assert.match(storageManager, /\(type==='iso'\?64:32\)\*1024\*\*2/);
assert.match(storageManager, /performance\.now\(\)/);

// A fresh install must include archive/container dependencies without requiring
// manual post-install package work.
for (const dependency of ['tar', 'gzip', 'xz-utils', 'zstd', 'lxc', 'debootstrap']) {
  assert.ok(installer.includes(dependency), `installer is missing required dependency: ${dependency}`);
}

// The only currently release-qualified boot artifact is amd64 ISO. Keep the
// artifact name/build architecture aligned with the machine-readable contract.
assert.match(isoBuilder, /--architectures amd64/);
assert.match(isoWorkflow, /LightNAS-amd64\.iso/);

// Node 22 is the current modern control-plane runtime. Until a legacy runtime
// exists, 32-bit x86 must remain a target rather than a support claim.
assert.match(String(packageJson.engines?.node || ''), /22/);
assert.notEqual(contract.architectures.i386.controlPlane, 'supported');

assert.match(readme, /docs\/PLATFORM-REQUIREMENTS\.md/);

console.log('LightNAS platform contract: PASS');
console.log(`Minimum target: ${contract.minimum.ramMiB} MiB RAM / ${contract.minimum.systemStorageGiB} GiB storage`);
console.log('Release-qualified control plane: amd64');
console.log('Required architecture targets: i386, arm64, armhf, riscv64');
console.log(`ISO chunk target: ${contract.upload.isoChunkMiB} MiB`);
