import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ZFS dataset changes require opt-in, verify parent and use fixed arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightnas-zfs-'));
  const before = Object.fromEntries(['PATH', 'LIGHTNAS_ZFS_ENABLED', 'LIGHTNAS_TEST_LOG'].map(key => [key, process.env[key]]));
  try {
    process.env.PATH = `${root}:${process.env.PATH}`;
    process.env.LIGHTNAS_TEST_LOG = join(root, 'log');
    await writeFile(join(root, 'zpool'), '#!/bin/sh\necho "tank\t1000000\t0\t1000000\tONLINE"\n', { mode: 0o755 });
    await writeFile(join(root, 'zfs'), `#!/bin/sh
if [ "$1" = list ]; then
  printf 'tank\\t0\\t1000000\\t/tank\\tlz4\\n'
  printf 'tank/files\\t0\\t1000000\\t/tank/files\\tlz4\\n'
else
  printf '%s\\n' "$@" >> "$LIGHTNAS_TEST_LOG"
fi
`, { mode: 0o755 });
    const { createDataset, updateDataset } = await import(`../src/zfs.mjs?test=${Date.now()}`);
    await assert.rejects(createDataset({ parent: 'tank', name: '../bad' }), { status: 400 });
    await assert.rejects(createDataset({ parent: 'missing', name: 'photos' }), { status: 409 });
    await assert.rejects(createDataset({ parent: 'tank', name: 'photos' }), { status: 409 });
    process.env.LIGHTNAS_ZFS_ENABLED = '1';
    assert.equal((await createDataset({ parent: 'tank', name: 'photos', compression: 'lz4', quotaGiB: 10 })).name, 'tank/photos');
    await assert.rejects(updateDataset({ name: 'tank', property: 'compression', value: 'off' }), { status: 400 });
    await assert.rejects(updateDataset({ name: 'tank/files', property: 'mountpoint', value: '/tmp' }), { status: 400 });
    await updateDataset({ name: 'tank/files', property: 'quota', value: '20G' });
    assert.equal(await readFile(process.env.LIGHTNAS_TEST_LOG, 'utf8'), 'create\n-o\ncompression=lz4\n-o\nquota=10G\ntank/photos\nset\nquota=20G\ntank/files\n');
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
