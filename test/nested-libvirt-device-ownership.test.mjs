import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('nested LXC libvirt avoids device chown failures', async () => {
  const [provision, runtimes] = await Promise.all([
    read('scripts/provision-runtimes.sh'),
    read('src/runtimes-next.mjs')
  ]);

  assert.match(provision, /user = "root"/);
  assert.match(provision, /group = "root"/);
  assert.match(provision, /dynamic_ownership = 0/);
  assert.match(provision, /remember_owner = 0/);
  assert.match(provision, /systemd-detect-virt --container/);

  assert.match(runtimes, /Failed to chown device \\/dev\\/urandom/);
  assert.match(runtimes, /localApplianceRepair\(\)/);
  assert.match(runtimes, /retry this request once automatically/);
});
