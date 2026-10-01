import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('private file permission isolates normal users to their own library', async () => {
  const [server, files, app, security] = await Promise.all([
    read('src/server.mjs'),
    read('src/files.mjs'),
    read('public/app.js'),
    read('public/admin-security.js')
  ]);

  assert.match(server, /'files\.own'/);
  assert.match(server, /DEFAULT_USER_PERMISSIONS = Object\.freeze\(\['files\.own'\]\)/);
  assert.match(server, /return `Users\/\$\{context\.username\}`/);
  assert.match(server, /listAllFiles\(url\.searchParams\.get\('refresh'\) === '1', scope\)/);
  assert.match(files, /scopePrefix = ''/);
  assert.match(files, /physical prefix is never exposed to the browser/);
  assert.match(app, /files: \['files\.own', 'files\.read'\]/);
  assert.match(security, /'files\.own':'Manage only my own files'/);
});

test('container edit opens from cached summary and does not block on app probing', async () => {
  const dialogs = await read('public/dialog-controls.js');
  assert.match(dialogs, /window\.LightNASContainerInventory/);
  assert.match(dialogs, /\/api\/containers\/inventory\?summary=1/);
  assert.match(dialogs, /queueMicrotask\(\(\) =>/);
  assert.doesNotMatch(dialogs, /const detected = await dialogApi\('\/api\/containers'/);
});
