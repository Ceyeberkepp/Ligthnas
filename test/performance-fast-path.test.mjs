import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('installer upgrades skip unchanged package, npm and runtime work', async () => {
  const installer = await read('install.sh');
  assert.match(installer, /install_missing_packages\(\)/);
  assert.match(installer, /package_installed\(\)/);
  assert.match(installer, /Node\.js dependencies unchanged; skipping npm install/);
  assert.match(installer, /Existing runtime configuration detected; skipping slow reprovisioning/);
  assert.match(installer, /LIGHTNAS_REPAIR_RUNTIMES=1/);
  assert.match(installer, /\.package-lock\.sha256/);
});

test('runtime provisioning does not reinstall QEMU when tools already exist', async () => {
  const runtime = await read('scripts/provision-runtimes.sh');
  assert.match(runtime, /vm_packages_ready=1/);
  assert.match(runtime, /qemu-system-x86_64 qemu-img virsh virt-install/);
  assert.match(runtime, /\[\[ "\$vm_packages_ready" == "1" \]\] \|\| apt-get install/);
});

test('initial dashboard defers Docker LXC and VM runtime discovery', async () => {
  const server = await read('src/server.mjs');
  const start = server.indexOf("url.pathname === '/api/overview'");
  const end = server.indexOf("url.pathname === '/api/network'", start);
  const overview = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(overview, /runtimeInventory\(/);
  assert.match(overview, /getSystemSnapshot\(\), getFilesystems\(\), getStorageInventory\(\), listStoragePools\(\)/);
});

test('automatic drive detection uses a lightweight storage scan', async () => {
  const [server, app] = await Promise.all([read('src/server.mjs'), read('public/app.js')]);
  assert.match(server, /url\.pathname === '\/api\/storage\/scan'/);
  assert.match(app, /request\('\/api\/storage\/scan'\)/);
  assert.match(app, /setInterval\(autoDetectStorage, 12000\)/);
  assert.match(app, /Only pay for a full overview refresh when/);
});

test('static JS and CSS can be cached briefly while HTML revalidates', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /private, max-age=120/);
  assert.match(server, /no-cache, max-age=0/);
});
