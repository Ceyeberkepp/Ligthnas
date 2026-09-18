import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);

test('installer enables the local App Store engine while keeping System Containers on native LXC', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'lightnas-provision-'));
  const envPath = join(sandbox, 'runtime.env');
  const statusPath = join(sandbox, 'status.txt');
  try {
    for (const name of ['systemctl', 'usermod', 'runuser', 'systemd-detect-virt', 'sleep', 'lxc-create', 'lxc-start']) {
      await writeFile(join(sandbox, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const docker = join(sandbox, 'docker');
    await writeFile(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const baseEnv = {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH}`,
      LIGHTNAS_RUNTIME_ENV_FILE: envPath,
      LIGHTNAS_RUNTIME_STATUS_FILE: statusPath,
      LIGHTNAS_ALLOW_NESTED_LXC: '1',
      LIGHTNAS_SKIP_VM: '1'
    };

    // Default install enables the local OCI App Store engine, but System
    // Containers remain native LXC/liblxc and never become Docker containers.
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env: baseEnv });
    let result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=1/);
    assert.match(result, /LIGHTNAS_VM_ENABLED=0/);
    let status = await readFile(statusPath, 'utf8');
    assert.match(status, /Containers: native LXC\/liblxc ready/);
    assert.match(status, /Apps: optional Docker\/OCI engine ready/);

    // Operators can still explicitly disable the App Store OCI engine.
    const disabledEnv = { ...baseEnv, LIGHTNAS_ENABLE_DOCKER_APPS: '0' };
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env: disabledEnv });
    result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=0/);
    status = await readFile(statusPath, 'utf8');
    assert.match(status, /Apps: optional Docker\/OCI engine disabled/);

    // A broken Docker daemon cannot leave the App Store engine enabled.
    await writeFile(docker, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env: baseEnv });
    result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=0/);
    assert.equal(result.includes('LIGHTNAS_DOCKER_ENABLED=1'), false);
    status = await readFile(statusPath, 'utf8');
    assert.match(status, /Apps: Docker could not start/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
