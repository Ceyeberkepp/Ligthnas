import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('App Store paints a fast built-in catalog and bounds DOM card count', async () => {
  const [app, server] = await Promise.all([read('public/app.js'), read('src/server.mjs')]);
  assert.match(server, /url\.pathname === '\/api\/catalog\/builtin'/);
  assert.match(app, /loadBuiltinCatalog\(\)/);
  assert.match(app, /appVisibleLimit: 72/);
  assert.match(app, /filteredApps\.slice\(0, limit\)/);
  assert.match(app, /data-app-more/);
  assert.match(app, /queueMicrotask\(\(\) =>/);
});

test('fresh installs warm the community catalog without manual refresh', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /Prime the community App Store cache shortly after boot/);
  assert.match(server, /setTimeout\(warmCatalog, 1500\)/);
  assert.match(server, /attempts < 5/);
});

test('noVNC console path is fail-fast and latency tuned', async () => {
  const [agent, localHost, server, consoleJs] = await Promise.all([
    read('scripts/lightnas-host-agent.py'),
    read('src/local-host.mjs'),
    read('src/server.mjs'),
    read('public/vm-console.js')
  ]);
  assert.match(agent, /vncdisplay", name\], timeout=3/);
  assert.match(agent, /deadline = time\.monotonic\(\) \+ 5/);
  assert.match(agent, /TCP_NODELAY/);
  assert.doesNotMatch(agent, /VM display is not ready after 75 seconds/);
  assert.match(localHost, /socket\.setTimeout\(6500/);
  assert.match(server, /backend\.setNoDelay\?\.\(true\)/);
  assert.match(consoleJs, /compressionLevel = 1/);
  assert.match(consoleJs, /qualityLevel = 7/);
});
