import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('nested LightNAS preserves management networking and uses direct LAN only when supported', async () => {
  const [network, provision, install] = await Promise.all([read('scripts/configure-appliance-network.sh'), read('scripts/provision-runtimes.sh'), read('install.sh')]);
  assert.match(network, /LIGHTNAS_NESTED_LAN_MODE:-auto/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-macvlan/);
  assert.match(network, /direct LAN is available/);
  assert.match(network, /preserving management networking and using safe container NAT fallback/);
  assert.match(provision, /direct_type="\$\{network_mode#nested-\}"/);
  assert.match(provision, /lxc\.net\.0\.macvlan\.mode = bridge/);
  assert.match(provision, /lxc\.net\.0\.ipvlan\.mode = l2/);
  assert.match(install, /automatic migration to the LightNAS host LAN/);
});

test('managed container network is DHCP-first and repairs legacy auto-static guests', async () => {
  const [agent, provision] = await Promise.all([read('scripts/lightnas-host-agent.py'), read('scripts/provision-runtimes.sh')]);
  assert.match(agent, /mode = str\(data\.get\("ipv4Mode"\) or "dhcp"\)/);
  assert.doesNotMatch(agent, /"ipv4Address": next_managed_container_ipv4\(name\)/);
  assert.match(agent, /def kick_container_dhcp/);
  assert.match(agent, /ClientIdentifier=mac/);
  assert.match(provision, /dhcp-authoritative/);
  assert.match(provision, /Older LightNAS builds silently converted DHCP/);
  assert.match(provision, /virbr0\|lxcbr0\|lightnas0/);
});

test('AI helper can diagnose and repair no-IP containers', async () => {
  const app = await read('public/app.js');
  assert.match(app, /Diagnose container networking/);
  assert.match(app, /repair-noip/);
  assert.match(app, /action:'repair-network'/);
});

test('task dock can cancel active tasks, clear tasks, and clears stale running state after reload', async () => {
  const [html, dialogs] = await Promise.all([read('public/index.html'), read('public/dialog-controls.js')]);
  assert.match(html, /id="task-cancel-all"/);
  assert.match(html, /id="task-clear-all"/);
  assert.match(dialogs, /status:'canceled'/);
  assert.match(dialogs, /const cancelAll = \(\) =>/);
  assert.match(dialogs, /const clearAll = \(\) =>/);
});

test('expanded catalog has more than one hundred twenty one-click apps including more AI tools', async () => {
  const runtime = await read('src/runtimes-next.mjs');
  const entries = [...runtime.matchAll(/\{ id: '([^']+)', name: '([^']+)'[\s\S]*? port: (\d+), containerPort: (\d+)/g)];
  assert.ok(entries.length >= 120, `expected at least 120 apps, found ${entries.length}`);
  assert.match(runtime, /id: 'anythingllm'/);
  assert.match(runtime, /id: 'langflow'/);
  assert.match(runtime, /id: 'photoprism'/);
});
