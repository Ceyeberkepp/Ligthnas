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

test('sidebar file subtabs do not break global navigation startup binding', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\$\('\[data-view\]'\)\.forEach\(link => link\.addEventListener\('click'/);
  assert.doesNotMatch(app, /[^$]\$\('\[data-view\]'\)\.forEach/);
});

test('Files sidebar children can collapse and Folders never renders as photo gallery', async () => {
  const [app, index, styles] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(index, /data-files-nav-toggle/);
  assert.match(index, /data-files-nav-subtabs/);
  assert.match(app, /filesNavExpanded/);
  assert.match(app, /lightnas-files-nav-expanded/);
  assert.match(app, /effectiveFileView = foldersMode \? 'grid' : state\.fileView/);
  assert.match(styles, /\.nav-files-subtabs\[hidden\]/);
  assert.match(styles, /font-size: 13px/);
  assert.match(styles, /font-weight: 600/);
});

test('Files and media restores desktop cache instantly and background refresh cannot overwrite another active tab', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /fileSectionCache: new Map\(\)/);
  assert.match(app, /restoreMobileFilesCache\(appliance\.username\)/);
  assert.match(app, /state\.fileSectionCache\.set\('all'/);
  assert.match(app, /loadFiles\(false, \{ tab:'all', folder:'' \}\)/);
  assert.match(app, /const requestKey = filesSectionCacheKey\(requestTab, requestFolder\)/);
  assert.match(app, /const isCurrentRequest = \(\) => filesSectionCacheKey\(\) === requestKey/);
  assert.match(app, /if \(isCurrentRequest\(\)\) \{/);
});

test('Files view has no obsolete in-content library tab binding and retries stale/error data automatically', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\$\('\[data-library-tab\]'/);
  assert.match(app, /fileSectionCheckedAt/);
  assert.match(app, /filesLoadingKeys/);
  assert.match(app, /Date\.now\(\) - checkedAt > 15000/);
  assert.match(app, /setTimeout\(\(\) => \{/);
  assert.match(app, /loadFiles\(false\)\.catch/);
});
