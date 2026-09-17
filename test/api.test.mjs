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

test('setup, RBAC, files, settings and runtime inventory workflow', async (context) => {
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
    body: JSON.stringify({ deviceName: 'test-nas', username: 'admin', password: 'correct-horse-battery', timezone: 'UTC' })
  });
  assert.equal(response.status, 201);
  let adminCookie = response.headers.get('set-cookie').split(';')[0];

  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: adminCookie } });
  const overview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(overview.appliance.deviceName, 'test-nas');
  assert.equal(overview.appliance.role, 'administrator');
  assert.ok(overview.appliance.permissions.includes('vms.manage'));
  assert.ok(Array.isArray(overview.filesystems));
  assert.ok(Array.isArray(overview.storage.disks));
  assert.ok(Array.isArray(overview.storage.attachedVolumes));

  response = await apiFetch(`${base}/api/network`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).interfaces));

  response = await apiFetch(`${base}/api/spaces`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'archive', label: 'Family archive' })
  });
  assert.equal(response.status, 201);
  response = await apiFetch(`${base}/api/spaces/archive`, {
    method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Updated archive' })
  });
  assert.equal((await response.json()).space.label, 'Updated archive');

  // New users default to file read/write only.
  response = await apiFetch(`${base}/api/users`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reader', password: 'a-long-user-password' })
  });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).permissions.sort(), ['files.read', 'files.write']);

  response = await apiFetch(`${base}/api/users`, { headers: { Cookie: adminCookie } });
  const usersPayload = await response.json();
  assert.ok(usersPayload.permissionOptions.includes('storage.view'));
  assert.deepEqual(usersPayload.users[0].permissions.sort(), ['files.read', 'files.write']);

  let userCookie = await login(base, 'reader', 'a-long-user-password');
  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: userCookie } });
  const userOverview = await response.json();
  assert.equal(userOverview.appliance.role, 'user');
  assert.deepEqual(userOverview.appliance.permissions.sort(), ['files.read', 'files.write']);

  response = await apiFetch(`${base}/api/settings`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 403);
  response = await apiFetch(`${base}/api/storage`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 403);
  response = await apiFetch(`${base}/api/spaces`, { method: 'POST', headers: { Cookie: userCookie } });
  assert.equal(response.status, 403);

  // File permissions remain backward compatible for ordinary users.
  response = await apiFetch(`${base}/api/files?path=Projects`, { method: 'POST', headers: { Cookie: userCookie } });
  assert.equal(response.status, 201);
  response = await apiFetch(`${base}/api/files?path=Projects%2Fnotes.txt`, { method: 'PUT', headers: { Cookie: userCookie }, body: 'real file contents' });
  assert.equal(response.status, 201);
  response = await apiFetch(`${base}/api/files/download?path=Projects%2Fnotes.txt`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.match(response.headers.get('content-disposition'), /^inline/);
  assert.equal(await response.text(), 'real file contents');

  // Administrator can grant a narrow additional permission.
  response = await apiFetch(`${base}/api/users/reader`, {
    method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'correct-horse-battery', permissions: ['files.read', 'files.write', 'storage.view'] })
  });
  assert.equal(response.status, 200);
  userCookie = await login(base, 'reader', 'a-long-user-password');
  response = await apiFetch(`${base}/api/storage`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/network`, { headers: { Cookie: userCookie } });
  assert.equal(response.status, 403);

  // Media path validation and runtime inventory remain protected.
  response = await apiFetch(`${base}/api/media/convert`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../state.json', format: 'mp4' })
  });
  assert.equal(response.status, 400);
  response = await apiFetch(`${base}/api/runtimes`, { headers: { Cookie: adminCookie } });
  const runtimes = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(runtimes.docker.containers));
  assert.ok(Array.isArray(runtimes.virtualization.machines));
  assert.ok(runtimes.catalog.some(app => app.id === 'jellyfin'));

  // Settings/password flow still invalidates sessions.
  response = await apiFetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ deviceName: 'new-nas', timezone: 'America/New_York', currentPassword: 'correct-horse-battery', newPassword: 'a-longer-password' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).signInRequired, true);
  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 401);
  adminCookie = await login(base, 'admin', 'a-longer-password');
  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: adminCookie } });
  assert.equal((await response.json()).appliance.deviceName, 'new-nas');

  // Cleanup file and user.
  response = await apiFetch(`${base}/api/files?path=Projects%2Fnotes.txt`, { method: 'DELETE', headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/files?path=Projects`, { method: 'DELETE', headers: { Cookie: userCookie } });
  assert.equal(response.status, 200);
  response = await apiFetch(`${base}/api/users/reader`, { method: 'DELETE', headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);

  response = await apiFetch(`${base}/api/overview`);
  assert.equal(response.status, 401);
  response = await apiFetch(`${base}/api/files`);
  assert.equal(response.status, 401);
});

test('setup rejects weak credentials and invalid device names', async () => {
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
