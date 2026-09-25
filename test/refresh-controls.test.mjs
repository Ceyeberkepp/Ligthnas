import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('refresh controls bind every matching button and reload scoped data', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /\$\$\('\[data-action="refresh-runtime"\]'/);
  assert.equal(app.includes(`\n  $('[data-action="refresh-runtime"]', $('#content')).forEach`), false);
  assert.equal(/^\s*\$\([^\n]+\)\.forEach/m.test(app), false, 'single-element selectors cannot be iterated with forEach');
  assert.match(app, /button\.textContent = 'Refreshing…'/);
  assert.match(app, /await loadContainers\(\)/);
  assert.match(app, /await loadRuntimes\(\)/);
  assert.doesNotMatch(app, /state\.files = null;\s*render\('files'\);\s*await loadFiles\(true\)/);
  assert.match(app, /await loadFiles\(true\)/);
});
