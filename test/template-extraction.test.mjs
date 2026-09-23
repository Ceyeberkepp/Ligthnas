import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('main installer installs all archive tools used by imported templates', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /tar gzip xz-utils zstd/);
  assert.match(installer, /lxc lxc-templates lxcfs uidmap bridge-utils debootstrap/);
});

test('template extraction skips archived dev nodes in nested unprivileged LightNAS', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /--exclude=\.\/dev\/\*/);
  assert.match(agent, /--exclude=dev\/\*/);
  assert.match(agent, /\(rootfs \/ "dev"\)\.mkdir\(mode=0o755, exist_ok=True\)/);
  assert.match(agent, /LXC supplies the runtime \/dev mount/);
});
