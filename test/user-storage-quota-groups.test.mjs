import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('private file users default to a configurable 5 GiB quota', async () => {
  const [server, files, app] = await Promise.all([
    read('src/server.mjs'),
    read('src/files.mjs'),
    read('public/app.js')
  ]);

  assert.match(server, /DEFAULT_USER_STORAGE_QUOTA_BYTES = 5 \* 1024 \* 1024 \* 1024/);
  assert.match(server, /storageQuotaGiB === undefined[^\n]+\? 5/);
  assert.match(server, /storageQuotaBytes: Math\.round\(requestedQuotaGiB \* 1024 \* 1024 \* 1024\)/);
  assert.match(server, /url\.pathname === '\/api\/files\/quota'/);
  assert.match(server, /uploadFile\(path, req, \{ quotaRoot: scope \|\| '', quotaBytes \}\)/);

  assert.match(files, /export async function fileUsage/);
  assert.match(files, /quotaReservations = new Map\(\)/);
  assert.match(files, /Upload would exceed your LightNAS file storage quota/);

  assert.match(app, /name="storageQuotaGiB"[^>]+value="5"/);
  assert.match(app, /File storage quota/);
  assert.match(app, /request\('\/api\/files\/quota'\)/);
  assert.match(app, /MY STORAGE/);
});

test('group cards expose working edit/delete controls and refresh in place', async () => {
  const security = await read('public/admin-security.js');
  assert.match(security, /data-edit-group=/);
  assert.match(security, /data-delete-group=/);
  assert.match(security, /data-group-details=/);
  assert.match(security, /async function refreshGroupsPanel\(\)/);
  assert.match(security, /await refreshGroupsPanel\(\)/);
  assert.match(security, /details\.open = true/);
});
