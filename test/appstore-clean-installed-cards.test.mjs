import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('App Store keeps installed instance status but not management buttons', () => {
  const start = app.indexOf("if (view === 'apps')");
  const end = app.indexOf("async function loadNetwork()", start);
  const block = app.slice(start, end);

  assert.match(block, /installed instance/);
  assert.match(block, /data-instance-count/);
  assert.match(block, />Install<\/button>/);
  assert.doesNotMatch(block, /Install another instance/);
  assert.doesNotMatch(block, /data-app-terminal=/);
  assert.doesNotMatch(block, /data-app-action=/);
  assert.doesNotMatch(block, /data-app-edit=/);
});
