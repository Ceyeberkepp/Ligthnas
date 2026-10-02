import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('App Store hides default instance label and container IP', () => {
  const start = app.indexOf("if (view === 'apps')");
  const end = app.indexOf("async function loadNetwork()", start);
  const block = app.slice(start, end);

  assert.match(block, /instanceName === 'default' \? ''/);
  assert.doesNotMatch(block, /· IP /);
  assert.match(block, /· Port \$\{hostPort\}/);
});
