import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Integrations automation uses compact two-column cards without large empty forms', async () => {
  const [security, css] = await Promise.all([read('public/admin-security.js'), read('public/enhancements.css')]);
  assert.match(security, /automation-grid/);
  assert.match(security, /automation-card/);
  assert.match(security, /automation-permissions/);
  assert.match(security, /integration-list/);
  assert.doesNotMatch(security.slice(security.indexOf('async function renderAutomation()'), security.indexOf('async function renderEditableNetwork()')), /class="panel creation-form" data-token-form/);
  assert.match(css, /\.automation-grid \{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.automation-permissions \.security-check-grid/);
  assert.match(css, /max-height:220px/);
});
