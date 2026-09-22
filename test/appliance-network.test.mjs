import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wired appliance networking converges on virbr0 LAN bridge', async () => {
  const [bridge, provision, agent, ui] = await Promise.all([
    readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(bridge, /BRIDGE="\$\{LIGHTNAS_LAN_BRIDGE:-virbr0\}"/);
  assert.match(bridge, /LIGHTNAS_NETWORK_MODE=bridge/);
  assert.match(bridge, /Bridge=\$\{BRIDGE\}/);
  assert.match(provision, /configure-appliance-network\.sh/);
  assert.match(provision, /real LAN bridge/);
  assert.match(agent, /physicalPort/);
  assert.match(agent, /veth\.\*/);
  assert.match(ui, /CURRENT APPLIANCE NETWORK/);
  assert.match(ui, /physical port/);
});
