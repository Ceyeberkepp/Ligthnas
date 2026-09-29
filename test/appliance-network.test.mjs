import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('LXC appliance networking follows the host LAN when direct nested LAN is available', async () => {
  const [network, provision, helper, agent, runtime, ui] = await Promise.all([
    readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/proxmox-lxc-install.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-macvlan/);
  assert.match(network, /LIGHTNAS_CONTAINER_PARENT/);
  assert.match(network, /LIGHTNAS_NESTED_LAN_MODE:-auto/);
  assert.match(network, /systemd-detect-virt --container/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=bridge/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=lxc-nat/);

  assert.match(provision, /10\.77\.0\.1/);
  assert.match(provision, /192\.168\.122\.1/);
  assert.match(provision, /network_mode.*lxc-nat/);
  assert.match(provision, /virbr0\|lxcbr0/);

  assert.match(helper, /Keep the existing LightNAS eth0\/net0 connection and IP exactly as-is/);
  assert.match(helper, /firewall=0/);

  assert.match(agent, /\{"nested-macvlan", "nested-ipvlan"\}/);
  assert.match(agent, /lxc\.net\.0\.macvlan\.mode = bridge/);
  assert.match(agent, /lxc\.net\.0\.ipvlan\.mode = l2/);
  assert.match(agent, /LIGHTNAS_NETWORK_MODE.*lxc-nat/);
  assert.match(runtime, /LightNAS managed NAT/);
  assert.match(ui, /Proxmox-style host networking/);
  assert.match(ui, /network-table-row/);
});


test('network bootstrap service never performs a nested management-interface cutover', async () => {
  const [installer, network] = await Promise.all([
    readFile(new URL('../install.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8')
  ]);
  assert.match(installer, /lightnas-network-bootstrap\.service/);
  assert.match(network, /preserving management networking/);
  assert.doesNotMatch(network, /trying transparent host-LAN bridge/);
});
