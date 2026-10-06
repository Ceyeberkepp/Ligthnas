import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('community App Store entries are normalized and deployable Compose apps expose Install', async () => {
  const [catalog, app, server] = await Promise.all([
    readFile(new URL('../src/community-catalog.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(catalog, /stripLocalePrefix/);
  assert.match(catalog, /en_US/);
  assert.match(catalog, /installable: Boolean/);
  assert.match(catalog, /composeUrl/);
  assert.match(catalog, /docker'[\s\S]*compose[\s\S]*up[\s\S]*-d/);
  assert.match(catalog, /CATALOG_SCHEMA_VERSION = 3/);

  assert.match(app, /app\.installable/);
  assert.match(app, /data-community-install/);
  assert.match(app, />Install<\/button>/);
  assert.doesNotMatch(app, />Community package<\/button>/);
  assert.doesNotMatch(app, /Compose installer integration is required/);

  assert.match(server, /installCommunityApp/);
  assert.match(server, /api\\\/catalog\\\/community/);
});

test('community installer preserves unsupported entries as unavailable instead of pretending they install', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const catalog = await readFile(new URL('../src/community-catalog.mjs', import.meta.url), 'utf8');

  assert.match(app, /app\.installReason/);
  assert.match(app, />Unavailable<\/button>/);
  assert.match(catalog, /does not provide a Docker Compose manifest/);
  assert.match(catalog, /does not support this CPU architecture/);
});

test('community catalog refresh never wipes a healthy cached catalog when a source fails', async () => {
  const catalog = await readFile(new URL('../src/community-catalog.mjs', import.meta.url), 'utf8');
  assert.match(catalog, /cachedBySource/);
  assert.match(catalog, /keeping cached catalog/);
  assert.match(catalog, /unknownCachedApps/);
  assert.match(catalog, /shouldWrite = deduped\.length > 0 \|\| !cachedApps\.length/);
  assert.doesNotMatch(catalog, /writeFile\(CACHE_FILE,[\s\S]*if \(!deduped\.length && cached\?\.apps\?\.length\)/);
});

test('App Store refresh and community install bindings do not crash on a single-element selector', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\$\('\[data-community-install\]'/);
  assert.doesNotMatch(app, /[^$]\$\('\[data-community-install\]'[\s\S]{0,80}\.forEach/);
  assert.match(app, /data-action="refresh-runtime"/);
});

test('CasaOS catalog rebuild uses the GitHub tree and defers Compose downloads until install time', async () => {
  const catalog = await readFile(new URL('../src/community-catalog.mjs', import.meta.url), 'utf8');
  assert.match(catalog, /return manifests\.map/);
  assert.match(catalog, /humanizeId/);
  assert.match(catalog, /composeUrl:'https:\/\/raw\.githubusercontent\.com/);
});

test('community catalog UI polls automatically until the local index is ready', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /communityCatalogPollTimer/);
  assert.match(app, /result\?\.refreshing/);
  assert.match(app, /loadCommunityCatalog\(false\)\.catch/);
  assert.match(app, /Apps will appear automatically as soon as the local index is ready/);
  assert.match(app, /App catalog refresh started in the background/);
});

test('TrueNAS catalog entries stay visible without pretending every TrueNAS template is standalone Compose', async () => {
  const [catalog, app] = await Promise.all([
    readFile(new URL('../src/community-catalog.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(catalog, /id:'truenas'/);
  assert.match(catalog, /trueNasCatalog/);
  assert.match(app, /TrueNAS catalog entry/);
});

test('TrueNAS catalog apps use the official renderer and expose a real Install action', async () => {
  const [catalog, app] = await Promise.all([
    readFile(new URL('../src/community-catalog.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(catalog, /ghcr\.io\/truenas\/apps_validation:latest/);
  assert.match(catalog, /apps_render_app/);
  assert.match(catalog, /sparse-checkout/);
  assert.match(catalog, /installTrueNasCatalogApp/);
  assert.match(catalog, /app\.trueNasCatalog\) return installTrueNasCatalogApp/);
  assert.match(catalog, /CATALOG_SCHEMA_VERSION = 4/);
  assert.match(app, /app\.installable \|\| app\.trueNasCatalog/);
  assert.doesNotMatch(app, />TrueNAS catalog<\/button>/);
});

test('Files and photos paint before quota work and visible thumbnails are not deliberately deprioritized', async () => {
  const [app, files] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/files.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(app, /const result = await request\(endpoint\);/);
  assert.match(app, /request\('\/api\/files\/quota'\)\.then/);
  assert.match(app, /loading="eager"/);
  assert.doesNotMatch(app, /class="file-thumb" loading="lazy" fetchpriority="low"/);
  assert.match(files, /expiresAt: now \+ 60000/);
});
