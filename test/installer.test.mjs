import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);

test('installer keeps Docker optional for Apps and does not use it as the Containers backend', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'lightnas-provision-'));
  const envPath = join(sandbox, 'runtime.env');
  const statusPath = join(sandbox, 'status.txt');
  try {
    for (const name of ['systemctl', 'usermod', 'runuser', 'systemd-detect-virt', 'sleep']) {
      await writeFile(join(sandbox, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const docker = join(sandbox, 'docker');
    await writeFile(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const baseEnv = {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH}`,
      LIGHTNAS_RUNTIME_ENV_FILE: envPath,
      LIGHTNAS_RUNTIME_STATUS_FILE: statusPath
    };

    // Default install: Docker is not the Containers backend and stays disabled.
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env: baseEnv });
    let result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=0/);
    assert.match(result, /LIGHTNAS_VM_ENABLED=0/);
    let status = await readFile(statusPath, 'utf8');
    assert.match(status, /Containers: system-container provider/);
    assert.match(status, /Apps: optional Docker\/OCI engine disabled/);

    // Explicit opt-in enables the optional App Store Docker engine when usable.
    const appEnv = { ...baseEnv, LIGHTNAS_ENABLE_DOCKER_APPS: '1' };
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env: appEnv });
    result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=1/);
    status = await readFile(statusPath, 'utf8');
    assert.match(status, /Apps: optional Docker\/OCI engine ready/);

    // A broken Docker daemon cannot leave the optional app engine enabled.
    await writeFile(docker, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await execute('bash', [resolve('scripts/provision-runtimes.sh')], { env: appEnv });
    result = await readFile(envPath, 'utf8');
    assert.match(result, /LIGHTNAS_DOCKER_ENABLED=0/);
    assert.equal(result.includes('LIGHTNAS_DOCKER_ENABLED=1'), false);
    status = await readFile(statusPath, 'utf8');
    assert.match(status, /Apps: Docker could not start/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
