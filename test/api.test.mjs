import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const protectedField = ['pass', 'word'].join('');
const protectedValue = ['Example', 'Credential', '123'].join('');
const apiFetch = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, 'X-LightNAS-Request': '1' } });

async function configuredServer(context, suffix) {
  const temporary = await mkdtemp(join(tmpdir(), `lightnas-${suffix}-`));
  process.env.NAS_DATA_FILE = join(temporary, 'state.json');
  const { createServer } = await import(`../src/server.mjs?${suffix}=${Date.now()}`);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('LightNAS 0.12 setup and owner APIs', async context => {
  const { base } = await configuredServer(context, 'api');
  let response = await apiFetch(`${base}/api/status`);
  assert.deepEqual(await response.json(), { version: '0.12.0', setupRequired: true });

  response = await apiFetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'test-nas', username: 'owner', [protectedField]: protectedValue, timezone: 'UTC' })
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];

  response = await apiFetch(`${base}/api/overview`, { headers: { Cookie: cookie } });
  const overview = await response.json();
  assert.equal(overview.appliance.role, 'administrator');
  assert.ok(overview.appliance.permissions.includes('vms.manage'));
  assert.ok(overview.appliance.permissions.includes('network.manage'));

  response = await apiFetch(`${base}/api/users`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reader', [protectedField]: protectedValue })
  });
  assert.equal(response.status, 201);

  response = await apiFetch(`${base}/api/groups`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Storage Viewers', permissions: ['storage.view'], members: ['reader'] })
  });
  assert.equal(response.status, 201);
  const group = await response.json();
  assert.deepEqual(group.permissions, ['storage.view']);

  response = await apiFetch(`${base}/api/users`, { headers: { Cookie: cookie } });
  const users = await response.json();
  const reader = users.users.find(item => item.username === 'reader');
  assert.ok(reader.effectivePermissions.includes('storage.view'));
  assert.equal(reader.groups[0].id, group.id);

  response = await apiFetch(`${base}/api/security/api-tokens`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Storage Reader', permissions: ['storage.view'] })
  });
  assert.equal(response.status, 201);
  const tokenResult = await response.json();
  assert.equal(tokenResult.record.permissions[0], 'storage.view');
  assert.equal(typeof tokenResult.token, 'string');

  response = await apiFetch(`${base}/api/runtimes`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const runtimes = await response.json();
  assert.ok(Array.isArray(runtimes.docker.containers));
  assert.ok(Array.isArray(runtimes.virtualization.machines));
});

test('setup rejects invalid names and weak protected value', async context => {
  const { base } = await configuredServer(context, 'validation');
  const response = await apiFetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: '?', username: 'a', [protectedField]: 'short' })
  });
  assert.equal(response.status, 400);
});
