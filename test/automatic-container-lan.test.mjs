import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('nested container creation always uses the LightNAS LAN parent and DHCP', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /nested_direct = network_state\.get\("LIGHTNAS_NETWORK_MODE"\) == "nested-macvlan"/);
  assert.match(agent, /"network": network/);
  assert.match(agent, /"ipv4Mode": "dhcp"/);
  assert.match(agent, /"ipv4Address": ""/);
  assert.match(agent, /"gateway": ""/);
  assert.match(agent, /"vlanTag": None/);
  assert.match(agent, /lxc\.net\.0\.type = \{'macvlan' if direct_macvlan else 'veth'\}/);
});

test('container creation is DHCP-first and guarantees managed automatic IPv4 when nested DHCP fails', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /DHCP is always attempted first/);
  assert.match(agent, /def apply_managed_automatic_address/);
  assert.match(agent, /def sanitize_nested_lxc_network/);
  assert.match(agent, /Address=\{address\}/);
  assert.match(agent, /Gateway=10\.77\.0\.1/);
  assert.match(agent, /automaticFallback/);
  assert.match(agent, /"networkMode": "direct-lan" if direct_macvlan else "managed"/);
});

test('container create UI reports the automatically assigned LAN IP', async () => {
  const controls = await readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8');
  assert.match(controls, /LAN IP:/);
  assert.match(controls, /Direct LAN networking is ready/);
});
