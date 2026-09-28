import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('new containers get unique DHCP identity and MAC addresses', async () => {
  const agent = await read('scripts/lightnas-host-agent.py');
  assert.match(agent, /def unique_container_mac\(\)/);
  assert.match(agent, /os\.urandom\(6\)/);
  assert.match(agent, /lxc\.net\.0\.hwaddr = \{mac_address\.lower\(\)\}/);
  assert.match(agent, /machine_id = os\.urandom\(16\)\.hex\(\)/);
  assert.match(agent, /\[DHCPv4\]/);
  assert.match(agent, /ClientIdentifier=mac/);
});

test('containers with no IPv4 can repair their DHCP identity', async () => {
  const [agent, app] = await Promise.all([read('scripts/lightnas-host-agent.py'), read('public/app.js')]);
  assert.match(agent, /def repair_container_network\(name: str\)/);
  assert.match(agent, /action == "repair-network"/);
  assert.match(agent, /did not receive an IPv4 address/);
  assert.match(app, /data-container-action="repair-network"/);
  assert.match(app, />Repair network</);
});

test('Networking can edit and delete persistent static routes', async () => {
  const [agent, app, dialogs] = await Promise.all([read('scripts/lightnas-host-agent.py'), read('public/app.js'), read('public/dialog-controls.js')]);
  assert.match(agent, /action == "route-update"/);
  assert.match(agent, /-ipv4\.routes/);
  assert.match(agent, /\+ipv4\.routes/);
  assert.match(app, /data-network-edit-route/);
  assert.match(app, /data-network-delete-route/);
  assert.match(dialogs, /Edit IPv4 route/);
  assert.match(dialogs, /action: 'route-update'/);
  assert.match(dialogs, /action: 'route-delete'/);
});
