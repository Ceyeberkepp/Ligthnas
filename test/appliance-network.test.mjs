import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('LXC appliance networking stays internal while VM and bare metal can bridge', async () => {
  const [network, provision, helper, agent, runtime, ui] = await Promise.all([
    readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/proxmox-lxc-install.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(network, /LIGHTNAS_NETWORK_MODE=lxc-nat/);
  assert.match(network, /LIGHTNAS_CONTAINER_BRIDGE=lightnas0/);
  assert.match(network, /LIGHTNAS_VM_NETWORK=default/);
  assert.match(network, /systemd-detect-virt --container/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=bridge/);

  assert.match(provision, /10\.77\.0\.1/);
  assert.match(provision, /192\.168\.122\.1/);
  assert.match(provision, /network_mode.*lxc-nat/);
  assert.match(provision, /virbr0\|lxcbr0/);

  assert.doesNotMatch(helper, /Preparing .* nested LAN bridging/);
  assert.doesNotMatch(helper, /Prepared .* nested LightNAS LAN traffic/);

  assert.match(agent, /LIGHTNAS_NETWORK_MODE.*lxc-nat/);
  assert.match(agent, /lightnas0/);
  assert.match(runtime, /LightNAS managed NAT/);
  assert.match(ui, /CURRENT APPLIANCE NETWORK/);
});
