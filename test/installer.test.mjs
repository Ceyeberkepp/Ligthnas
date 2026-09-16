import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);
test('installer enables containers only after the service account can use Docker; LXC skips KVM', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'lightnas-provision-'));
  const envPath = join(sandbox, 'runtime.env');
  try {
    for (const name of ['systemctl', 'usermod', 'runuser', 'systemd-detect-virt', 'sleep']) {
      await writeFile(join(sandbox, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const docker = join(sandbox, 'docker');
    await writeFile(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${sandbox}:${process.env.PATH}`, LIGHTNAS_RUNTIME_ENV_FILE: envPath, LIGHTNAS_RUNTIME_STATUS_FILE: join(sandbox, 'status.txt') };
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env });
    assert.match(await readFile(envPath, 'utf8'), /LIGHTNAS_DOCKER_ENABLED=1/);
    assert.match(await readFile(envPath, 'utf8'), /LIGHTNAS_VM_ENABLED=0/);
    await writeFile(docker, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env });
    const result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=0/);
    assert.equal(result.includes('LIGHTNAS_DOCKER_ENABLED=1'), false);
    assert.match(await readFile(join(sandbox, 'status.txt'), 'utf8'), /Docker could not start/);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
