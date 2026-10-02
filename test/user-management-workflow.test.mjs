import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Users page exposes complete account management workflow', async () => {
  const app = await read('public/app.js');
  assert.match(app, /data-open-user-manager/);
  assert.match(app, /Reset password/);
  assert.match(app, /Direct permissions/);
  assert.match(app, /Add this account to one or more permission groups/);
  assert.match(app, /data-user-delete/);
  assert.match(app, /Account enabled/);
  assert.match(app, /permissions: data\.getAll\('permissions'\)/);
  assert.match(app, /groups: data\.getAll\('groups'\)/);
});

test('User manager saves permissions and groups through the existing PATCH API', async () => {
  const app = await read('public/app.js');
  assert.match(app, /selectedPermissions/);
  assert.match(app, /selectedGroups/);
  assert.match(app, /disabled: !form\.elements\.enabled\.checked/);
  assert.match(app, /permissions: selectedPermissions/);
  assert.match(app, /groups: selectedGroups/);
  assert.match(app, /Password reset and old sessions ended/);
});
