import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('container page uses dedicated fast inventory and keeps existing LXC visible', async () => {
  const [server, agent, app, dialogs, presets] = await Promise.all([
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/container-presets.js', import.meta.url), 'utf8')
  ]);

  assert.match(server, /\/api\/containers\/inventory/);
  assert.match(agent, /def container_summary\(\)/);
  assert.match(agent, /def container_records\(fast: bool = False\)/);
  assert.match(agent, /Path\("\/var\/lib\/lxc"\)\.iterdir\(\)/);
  assert.match(agent, /container_records\(fast=True\)/);
  assert.match(agent, /"container-summary"/);
  assert.match(app, /async function loadContainers\(\)/);
  assert.match(app, /\/api\/containers\/inventory\?summary=1/);
  assert.match(app, /Loading existing system containers/);
  assert.match(server, /url\.searchParams\.get\('summary'\) === '1'/);
  assert.match(dialogs, /\/api\/containers\/inventory/);
  assert.match(presets, /\/api\/containers\/inventory/);
});
