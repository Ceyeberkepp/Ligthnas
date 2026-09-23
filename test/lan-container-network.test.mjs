import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('LightNAS installs LXC networking for every supported installation', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /Installing native system-container engine and network bridge tools/);
  assert.match(installer, /lxc lxc-templates lxcfs uidmap bridge-utils/);
  assert.doesNotMatch(installer, /if ! systemd-detect-virt --container[^\n]+LIGHTNAS_ENABLE_NESTED_RUNTIMES[^\n]+then\n\s+echo "      Installing native system-container/);
});

test('nested LightNAS prefers a real LAN bridge and keeps NAT only as fallback', async () => {
  const network = await readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8');
  assert.match(network, /nested appliance supports transparent bridging; system containers will use the real LAN/);
  assert.match(network, /nested_bridge_ok=1/);
  assert.match(network, /LIGHTNAS_NESTED_LAN_BRIDGE:-1/);
  assert.match(network, /nested appliance cannot create a transparent LAN bridge; using managed NAT fallback/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=bridge/);
});

test('runtime provisioning migrates old private containers to the LAN bridge automatically', async () => {
  const provision = await readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8');
  assert.match(provision, /set_flag LIGHTNAS_ALLOW_NESTED_LXC 1/);
  assert.match(provision, /lightnas0\|lxcbr0/);
  assert.match(provision, /\$\{lan_bridge\}/);
  assert.match(provision, /systemctl disable --now lightnas-container-network\.service/);
  assert.match(provision, /containers receive real LAN addresses/);
});
