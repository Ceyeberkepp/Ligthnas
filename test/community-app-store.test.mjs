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
  assert.match(catalog, /CATALOG_SCHEMA_VERSION = 2/);

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
