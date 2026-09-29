import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('nested container creation uses the LightNAS LAN parent and managed automatic addressing', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /nested_direct = nested_mode in \{"nested-macvlan", "nested-ipvlan"\}/);
  assert.match(agent, /"network": network/);
  assert.match(agent, /"ipv4Mode": "dhcp"/);
  assert.match(agent, /"ipv4Address": ""/);
  assert.match(agent, /"gateway": ""/);
  assert.match(agent, /"vlanTag": None/);
  assert.match(agent, /direct_type = "macvlan".*"ipvlan"/);
});

test('direct-LAN containers use the host-derived LightNAS managed pool', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /def managed_container_ipv4_pool/);
  assert.match(agent, /LIGHTNAS_CONTAINER_POOL_START/);
  assert.match(agent, /LIGHTNAS_CONTAINER_POOL_END/);
  assert.match(agent, /LIGHTNAS_CONTAINER_GATEWAY/);
  assert.match(agent, /managed_pool_direct = direct_lan/);
  assert.match(agent, /apply_managed_automatic_address\(name, config\)/);
  assert.match(agent, /managedLanPool/);
  assert.match(agent, /"networkMode": "direct-lan" if direct_lan else "managed"/);
});

test('container create UI reports the automatically assigned LAN IP', async () => {
  const controls = await readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8');
  assert.match(controls, /LAN IP:/);
  assert.match(controls, /Direct LAN networking is ready/);
});


test('nested ipvlan uses a unique DHCP client identity without moving the host IP', async () => {
  const [network, agent] = await Promise.all([
    readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  assert.match(network, /type ipvlan mode l2/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-ipvlan/);
  assert.match(agent, /lxc\.net\.0\.ipvlan\.mode = l2/);
  assert.match(agent, /ClientIdentifier=\{client_id\}/);
  assert.match(agent, /nested_mode.*nested-ipvlan/);
  assert.match(agent, /client_id = "duid"/);
});


test('private NAT never receives an address from the host LAN pool', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /direct_mode = .*nested-macvlan.*nested-ipvlan.*bridge/);
  assert.match(agent, /host LAN pool is only valid on direct-LAN container networking/);
  assert.match(agent, /10\.77\.0\.0\/24/);
});
