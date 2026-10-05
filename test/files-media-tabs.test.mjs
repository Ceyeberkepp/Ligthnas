import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Files and media library sections live in the sidebar and keep compact icon actions', async () => {
  const [app, index, styles] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);

  for (const label of ['All files', 'Documents', 'Photos', 'Videos', 'Audio', 'Folders']) {
    assert.match(index, new RegExp(label));
  }
  assert.match(index, /nav-files-subtabs/);
  assert.match(index, /data-file-library="folders"/);
  assert.match(app, /fileLibraryTab/);
  assert.match(app, /link\.dataset\.fileLibrary/);
  assert.doesNotMatch(app, /files-library-tabs" role="tablist"/);
  assert.match(app, /data-action="new-folder"[^>]*aria-label="New folder"/);
  assert.match(app, /data-files-settings-tab[^>]*aria-label="Files & media settings"/);
  assert.match(app, /data-action="refresh-files"[^>]*aria-label="Refresh"/);
  assert.match(styles, /\.nav-files-subtabs/);
  assert.match(styles, /sidebar-collapsed \.nav-files-subtabs/);
});

test('Folders tab uses folder inventory API while All files keeps recursive file inventory', async () => {
  const [app, server, files] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/files.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(app, /fileLibraryTab === 'folders'/);
  assert.match(app, /\/api\/files\?folders=1/);
  assert.match(app, /\/api\/files\?all=1/);
  assert.match(server, /listAllFolders/);
  assert.match(server, /searchParams\.get\('folders'\) === '1'/);
  assert.match(files, /export async function listAllFolders/);
  assert.match(files, /recursiveFolderEntries/);
});