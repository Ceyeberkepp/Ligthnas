import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Shell launcher is in the top bar and not duplicated in the sidebar', async () => {
  const [html, app] = await Promise.all([read('public/index.html'), read('public/app.js')]);
  assert.match(html, /id="node-shell-top"/);
  assert.match(html, /<b>Shell<\/b>/);
  assert.doesNotMatch(html, /href="#shell" data-view="shell"/);
  assert.match(app, /#node-shell-top/);
  assert.match(app, /window\.open\(\x60\/node-shell\.html/);
});

test('node Bash prompt identifies root and the actual node hostname', async () => {
  const [agent, html, js] = await Promise.all([
    read('scripts/lightnas-host-agent.py'),
    read('public/node-shell.html'),
    read('public/node-shell.js')
  ]);
  assert.match(agent, /node_name = socket\.gethostname\(\)\.strip\(\) or "lightnas"/);
  assert.match(agent, /"PS1": f"root@\{node_name\}:\\\\w# "/);
  assert.match(html, /LightNAS Bash shell/);
  assert.match(js, /Connected · Bash shell/);
});

test('task dock aligns to desktop sidebar widths', async () => {
  const css = await read('public/enhancements.css');
  assert.match(css, /\.task-dock \{ left:250px; \}/);
  assert.match(css, /\.console\.sidebar-collapsed \.task-dock \{ left:86px; \}/);
});

test('network status uses compact non-button badges', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/enhancements.css')]);
  assert.match(app, /network-state-badge/);
  assert.doesNotMatch(app, /volume-state \$\{\/connected\|up/);
  assert.match(css, /\.network-state-badge\.online/);
  assert.match(css, /white-space:nowrap/);
});
