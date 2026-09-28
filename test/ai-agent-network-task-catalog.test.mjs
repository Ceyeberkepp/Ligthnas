import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('nested LightNAS defaults to managed NAT and upgrades old macvlan installs', async () => {
  const [network, provision, install] = await Promise.all([read('scripts/configure-appliance-network.sh'), read('scripts/provision-runtimes.sh'), read('install.sh')]);
  assert.match(network, /LIGHTNAS_NESTED_LAN_MODE:-nat/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=lxc-nat/);
  assert.match(provision, /\$type" == "macvlan/);
  assert.match(provision, /lxc\.net\.0\.type = veth/);
  assert.match(install, /Old nested macvlan mode detected/);
});

test('managed container network is DHCP-first and repairs legacy auto-static guests', async () => {
  const [agent, provision] = await Promise.all([read('scripts/lightnas-host-agent.py'), read('scripts/provision-runtimes.sh')]);
  assert.match(agent, /mode = str\(data\.get\("ipv4Mode"\) or "dhcp"\)/);
  assert.doesNotMatch(agent, /"ipv4Address": next_managed_container_ipv4\(name\)/);
  assert.match(agent, /def kick_container_dhcp/);
  assert.match(agent, /ClientIdentifier=mac/);
  assert.match(provision, /dhcp-authoritative/);
  assert.match(provision, /Legacy LightNAS builds silently converted DHCP/);
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
