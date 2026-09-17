import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apiFetch = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, 'X-LightNAS-Request': '1' } });

async function login(base, username, password) {
  const response = await apiFetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('LightNAS 0.11 setup, files, RBAC and settings', async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'lightnas-test-'));
  process.env.NAS_DATA_FILE = join(temporary, 'state.json');
  const { createServer } = await import(`../src/server.mjs?test=${Date.now()}`);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  let response = await apiFetch(`${base}/api/status`);
  assert.deepEqual(await response.json(), { version: '0.11.0', setupRequired: true });

  response = await apiFetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'test-nas', username: 'admin', password: 'TestPassword123', timezone: 'UTC' })
  });
  assert.equal(response.status, 201);
  let adminCookie = response.headers.get('set-cookie').split(';')[0];

  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: adminCookie } });
  const overview = await response.json();
  assert.equal(overview.appliance.role, 'administrator');
  assert.ok(overview.appliance.permissions.includes('vms.manage'));
  assert.ok(Array.isArray(overview.storage.attachedVolumes));

  response = await apiFetch(`${base}/api/users`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reader', password: 'ReaderPassword123' })
  });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).permissions.sort(), ['files.read', 'files.write']);

  let userCookie = await login(base, 'reader', 'ReaderPassword123');
  response = await apiFetch(`${base}/api/storage`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 403);

  response = await apiFetch(`${base}/api/files?path=Projects`, { method: 'POST', headers: { Cookie: userCookie } });
  assert.equal(response.status, 201);
  response = await apiFetch(`${base}/api/files?path=Projects%2Fnotes.txt`, { method: 'PUT', headers: { Cookie: userCookie }, body: 'hello' });
  assert.equal(response.status, 201);
  response = await apiFetch(`${base}/api/files/download?path=Projects%2Fnotes.txt`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.match(response.headers.get('content-disposition'), /^inline/);

  response = await apiFetch(`${base}/api/users/reader`, {
    method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'TestPassword123', permissions: ['files.read', 'files.write', 'storage.view'] })
  });
  assert.equal(response.status, 200);
  userCookie = await login(base, 'reader', 'ReaderPassword123');
  response = await apiFetch(`${base}/api/storage`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/network`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 403);

  response = await apiFetch(`${base}/api/runtimes`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  const runtimes = await response.json();
  assert.ok(Array.isArray(runtimes.docker.containers));
  assert.ok(Array.isArray(runtimes.virtualization.machines));

  response = await apiFetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'new-nas', timezone: 'UTC', currentPassword: 'TestPassword123', newPassword: 'NewTestPassword123' })
  });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 401);
  adminCookie = await login(base, 'admin', 'NewTestPassword123');
  userCookie = await login(base, 'reader', 'ReaderPassword123');

  response = await apiFetch(`${base}/api/files?path=Projects%2Fnotes.txt`, { method: 'DELETE', headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/files?path=Projects`, { method: 'DELETE', headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/users/reader`, { method: 'DELETE', headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
});

test('setup rejects weak credentials and invalid names', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'lightnas-validation-'));
  process.env.NAS_DATA_FILE = join(temporary, 'state.json');
  const { createServer } = await import(`../src/server.mjs?validation=${Date.now()}`);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await apiFetch(`http://127.0.0.1:${server.address().port}/api/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: '?', username: 'a', password: 'short' })
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
