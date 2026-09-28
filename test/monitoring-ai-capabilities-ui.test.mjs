import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('AI tab is present and wired to a real AI workspace', async () => {
  const [html, app] = await Promise.all([read('public/index.html'), read('public/app.js')]);
  assert.match(html, /href="#ai" data-view="ai"/);
  assert.match(app, /function aiView\(\)/);
  assert.match(app, /AI WORKSPACE/);
  assert.match(app, /data-install=/);
  assert.match(app, /state\.view === 'ai' \? aiView\(\)/);
});

test('monitoring has live graphs and session analytics refreshed every five seconds', async () => {
  const app = await read('public/app.js');
  assert.match(app, /function monitoringView\(\)/);
  assert.match(app, /monitoring-live-grid/);
  assert.match(app, /SESSION ANALYTICS/);
  assert.match(app, /analytics-grid/);
  assert.match(app, /\['home', 'monitoring'\]\.includes\(state\.view\)/);
  assert.match(app, /\}, 5000\);/);
});

test('capabilities expose persistent optional feature controls', async () => {
  const [server, app] = await Promise.all([read('src/server.mjs'), read('public/app.js')]);
  assert.match(server, /const DEFAULT_FEATURES = \{/);
  assert.match(server, /\/api\/capabilities\/config/);
  assert.match(server, /store\.state\.config\.features/);
  assert.match(app, /data-feature-toggle=/);
  assert.match(app, /Turn off/);
  assert.match(app, /Turn on/);
});

test('integrations and settings use compact workspaces', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /integration-summary-grid/);
  assert.match(app, /integration-list panel/);
  assert.match(css, /\.settings-dashboard \{\s*gap:10px;/);
  assert.match(css, /\.integration-row \{/);
  assert.match(css, /\.mfa-method-grid \{/);
});

test('security enhancement never rewrites Files thumbnails', async () => {
  const security = await read('public/admin-security.js');
  const enhance = security.slice(security.indexOf('async function enhance()'), security.indexOf('const observer'));
  assert.doesNotMatch(enhance, /thumb\.src/);
  assert.match(enhance, /must never rewrite Files & media thumbnails/);
});
