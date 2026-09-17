import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('runtime inventory and creation use fixed command arguments and validate requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightnas-runtime-'));
  const previous = Object.fromEntries(['PATH', 'NAS_DATA_FILE', 'LIGHTNAS_VM_ISO_DIR', 'LIGHTNAS_DOCKER_ENABLED', 'LIGHTNAS_VM_ENABLED', 'LIGHTNAS_TEST_LOG'].map(key => [key, process.env[key]]));
  try {
    process.env.PATH = `${root}:${process.env.PATH}`;
    process.env.NAS_DATA_FILE = join(root, 'state.json');
    process.env.LIGHTNAS_VM_ISO_DIR = root;
    process.env.LIGHTNAS_DOCKER_ENABLED = '1';
    process.env.LIGHTNAS_VM_ENABLED = '1';
    process.env.LIGHTNAS_TEST_LOG = join(root, 'commands.log');
    await writeFile(join(root, 'install.iso'), 'test image');
    await writeFile(join(root, 'docker'), `#!/bin/sh
case "$1" in
  info) echo 28.0 ;;
  ps) echo '{"Names":"other","Image":"nginx","State":"running","Status":"Up","Ports":""}' ;;
  pull) printf 'docker:%s\n' "$@" >> "$LIGHTNAS_TEST_LOG"; echo pulled ;;
  run) printf 'docker:%s\n' "$@" >> "$LIGHTNAS_TEST_LOG"; echo container-id ;;
  start|stop|restart|rm) printf 'docker:%s\n' "$@" >> "$LIGHTNAS_TEST_LOG" ;;
esac
`, { mode: 0o755 });
    await writeFile(join(root, 'virsh'), `#!/bin/sh
case "$3" in
  list) echo existing-vm ;;
  pool-list) echo default ;;
  net-list) echo default ;;
esac
`, { mode: 0o755 });
    await writeFile(join(root, 'virt-install'), `#!/bin/sh
if [ "$1" = '--version' ]; then echo 4.2; else printf 'vm:%s\n' "$@" >> "$LIGHTNAS_TEST_LOG"; echo created; fi
`, { mode: 0o755 });
    const { runtimeInventory, installCatalogApp, manageCatalogApp, createContainer, createVm } = await import(`../src/runtimes.mjs?test=${Date.now()}`);
    const inventory = await runtimeInventory();
    assert.equal(inventory.docker.available, true);
    assert.equal(inventory.virtualization.available, true);
    assert.deepEqual(inventory.virtualization.images, ['install.iso']);
    assert.equal((await installCatalogApp('nginx')).port, 8081);
    assert.equal((await installCatalogApp('openspeedtest')).port, 8082);
    assert.equal((await manageCatalogApp('nginx', 'stop')).action, 'stop');
    await assert.rejects(manageCatalogApp('nginx', 'exec'), { status: 400 });
    await assert.rejects(createContainer({ name: 'bad;name', image: 'nginx', memoryMiB: 512 }), { status: 400 });
    await createContainer({ name: 'test-web', image: 'nginx:stable-alpine', memoryMiB: 512 });
    await assert.rejects(createVm({ name: 'x', memoryMiB: 2048, cpus: 2, diskGiB: 20, pool: 'default', network: 'default', iso: 'install.iso' }), { status: 400 });
    await createVm({ name: 'NewVm', memoryMiB: 2048, cpus: 2, diskGiB: 20, pool: 'default', network: 'default', iso: 'install.iso' });
    const commands = await readFile(process.env.LIGHTNAS_TEST_LOG, 'utf8');
    assert.match(commands, /docker:pull\ndocker:nginx:stable-alpine/);
    assert.match(commands, /docker:pull\ndocker:openspeedtest\/latest/);
    assert.match(commands, /docker:--label\ndocker:lightnas\.catalog=nginx/);
    assert.match(commands, /docker:openspeedtest\/latest/);
    assert.match(commands, /docker:stop\ndocker:lightnas-app-nginx/);
    assert.match(commands, /docker:--cap-drop\ndocker:ALL/);
    assert.match(commands, /vm:--disk\nvm:pool=default,size=20,format=qcow2/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});