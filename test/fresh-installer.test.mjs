import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fresh installer treats distro archive keyrings as optional packages', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /for keyring in debian-archive-keyring ubuntu-keyring/);
  assert.match(installer, /apt-cache show "\$keyring"/);
  assert.match(installer, /runtime_packages\+=\("\$keyring"\)/);
  assert.doesNotMatch(installer, /debian-archive-keyring ubuntu-keyring \\\n/);
});

test('Debian hosts bootstrap the official Ubuntu archive keyring when the package is unavailable', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /archive\.ubuntu\.com\/ubuntu\/project\/ubuntu-archive-keyring\.gpg/);
  assert.match(installer, /\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
});

test('Proxmox local fallback cleans up without an EXIT trap on a local variable', async () => {
  const helper = await readFile(new URL('../scripts/proxmox-lxc-install.sh', import.meta.url), 'utf8');
  const start = helper.indexOf('run_local_installer()');
  const end = helper.indexOf('\n}\n', start) + 3;
  const block = helper.slice(start, end);
  assert.doesNotMatch(block, /trap .*installer.* EXIT/);
  assert.match(block, /bash "\$installer" \|\| status=\$\?/);
  assert.match(block, /rm -f "\$installer"/);
  assert.match(block, /return "\$status"/);
});

test('Proxmox repair path uses distro-aware keyring installation', async () => {
  const helper = await readFile(new URL('../scripts/proxmox-lxc-install.sh', import.meta.url), 'utf8');
  assert.match(helper, /for keyring in debian-archive-keyring ubuntu-keyring/);
  assert.match(helper, /packages\+=\("\$keyring"\)/);
  assert.match(helper, /archive\.ubuntu\.com\/ubuntu\/project\/ubuntu-archive-keyring\.gpg/);
});
