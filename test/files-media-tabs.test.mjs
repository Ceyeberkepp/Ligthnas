import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Files and media uses desktop library tabs and compact icon actions', async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);

  for (const label of ['All files', 'Documents', 'Photos', 'Videos', 'Audio', 'Folders']) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /data-library-tab/);
  assert.match(app, /fileLibraryTab/);
  assert.match(app, /data-action="new-folder"[^>]*aria-label="New folder"/);
  assert.match(app, /data-files-settings-tab[^>]*aria-label="Files & media settings"/);
  assert.match(app, /data-action="refresh-files"[^>]*aria-label="Refresh"/);
  assert.doesNotMatch(app, /data-files-settings-tab>⚙ Settings<\/button>/);
  assert.match(styles, /\.files-library-tabs/);
  assert.match(styles, /\.files-icon-action/);
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
