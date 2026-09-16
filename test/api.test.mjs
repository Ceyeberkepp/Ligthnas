import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('setup, authentication, overview, and share workflow', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'lightnas-test-'));
  process.env.NAS_DATA_FILE = join(temporary, 'state.json');
  const { createServer } = await import(`../src/server.mjs?test=${Date.now()}`);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${base}/api/status`);
  assert.deepEqual(await response.json(), { version: '0.2.0', setupRequired: true });

  response = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'test-nas', username: 'admin', password: 'correct-horse-battery', timezone: 'UTC', updates: true })
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];

  response = await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } });
  const overview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(overview.appliance.deviceName, 'test-nas');
  assert.ok(overview.system.memory.totalBytes > 0);
  assert.ok(Array.isArray(overview.system.capabilities));
  assert.ok(Array.isArray(overview.filesystems));
  assert.ok(Array.isArray(overview.storage.disks));
  assert.ok(Array.isArray(overview.storage.zfs.pools));
  assert.ok(Array.isArray(overview.storage.zfs.datasets));

  response = await fetch(`${base}/api/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Team Files', protocol: 'SMB', description: 'Shared project files' })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).share.name, 'Team Files');

  response = await fetch(`${base}/api/shares`, { headers: { Cookie: cookie } });
  assert.equal((await response.json()).shares.length, 1);

  response = await fetch(`${base}/api/overview`);
  assert.equal(response.status, 401);
});

test('setup rejects weak credentials and invalid device names', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'lightnas-validation-'));
  process.env.NAS_DATA_FILE = join(temporary, 'state.json');
  const { createServer } = await import(`../src/server.mjs?validation=${Date.now()}`);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: '?', username: 'a', password: 'short' })
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
