import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Manage user binding uses querySelectorAll helper and cannot abort view actions', async () => {
  const app = await read('public/app.js');
  assert.match(app, /\$\$\('\[data-open-user-manager\]', \$\('#content'\)\)\.forEach/);
  assert.doesNotMatch(app, /\$\('\[data-open-user-manager\]', \$\('#content'\)\)\.forEach/);
  assert.match(app, /openUserManager\(button\.dataset\.openUserManager\)\.catch/);
});
