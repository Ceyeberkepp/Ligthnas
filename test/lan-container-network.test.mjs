import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('LightNAS installs LXC networking for every supported installation', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /Installing native system-container engine and network bridge tools/);
  assert.match(installer, /lxc lxc-templates lxcfs uidmap bridge-utils/);
  assert.doesNotMatch(installer, /if ! systemd-detect-virt --container[^\n]+LIGHTNAS_ENABLE_NESTED_RUNTIMES[^\n]+then\n\s+echo "      Installing native system-container/);
});

test('nested LightNAS keeps the working eth0 and uses it as the direct container LAN parent', async () => {
  const network = await readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8');
  assert.match(network, /never move or readdress the/);
  assert.match(network, /type macvlan mode bridge/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-macvlan/);
  assert.match(network, /LIGHTNAS_CONTAINER_PARENT=%s/);
  assert.match(network, /management networking is unchanged/);
  assert.match(network, /nested macvlan is unavailable; using managed NAT fallback/);
});

test('host agent creates nested system containers as macvlan children of the existing uplink', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /LIGHTNAS_NETWORK_MODE"\) == "nested-macvlan"/);
  assert.match(agent, /lxc\.net\.0\.type = \{'macvlan' if direct_macvlan else 'veth'\}/);
  assert.match(agent, /lxc\.net\.0\.macvlan\.mode = bridge/);
  assert.match(agent, /return \[parent\]/);
});

test('runtime provisioning migrates old 10.77 containers to eth0 macvlan automatically', async () => {
  const provision = await readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8');
  assert.match(provision, /set_flag LIGHTNAS_ALLOW_NESTED_LXC 1/);
  assert.match(provision, /network_mode.*nested-macvlan/);
  assert.match(provision, /lxc\.net\.0\.type = macvlan/);
  assert.match(provision, /lxc\.net\.0\.macvlan\.mode = bridge/);
  assert.match(provision, /systemctl disable --now lightnas-container-network\.service/);
  assert.match(provision, /containers receive real LAN addresses/);
});

test('Proxmox installer preserves net0 settings and only disables its firewall flag for nested MACs', async () => {
  const installer = await readFile(new URL('../scripts/proxmox-lxc-install.sh', import.meta.url), 'utf8');
  assert.match(installer, /Keep the existing LightNAS eth0\/net0 connection and IP exactly as-is/);
  assert.match(installer, /pct set "\$ctid" -net0 "\$net0"/);
  assert.match(installer, /firewall=1/);
  assert.match(installer, /firewall=0/);
  assert.doesNotMatch(installer, /name=lan0/);
});


test('fresh ISO boot acquires wired DHCP before guest networking is provisioned', async () => {
  const [network, provision, iso] = await Promise.all([
    readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8'),
    readFile(new URL('../iso/build.sh', import.meta.url), 'utf8')
  ]);

  assert.match(network, /discover_wired_uplink\(\)/);
  assert.match(network, /bootstrap_wired_dhcp\(\)/);
  assert.match(network, /nmcli device set "\$\{uplink\}" managed yes/);
  assert.match(network, /nmcli device connect "\$\{uplink\}"/);
  assert.match(network, /ipv4\.method auto/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=pending-uplink/);

  assert.match(provision, /network_mode.*pending-uplink/);
  assert.match(provision, /waiting for the physical LAN uplink to receive DHCP/);

  assert.match(iso, /lightnas-network-bootstrap\.service/);
  assert.match(iso, /Requires=lightnas-network-bootstrap\.service/);
  assert.match(iso, /systemctl disable lxc-net\.service/);
  assert.doesNotMatch(iso, /systemctl enable lxc-net\.service/);
});

test('ISO build does not hard-require the Ubuntu keyring package on Debian', async () => {
  const iso = await readFile(new URL('../iso/build.sh', import.meta.url), 'utf8');
  const packageList = iso.match(/cat >config\/package-lists\/lightnas\.list\.chroot <<'EOF'([\s\S]*?)\nEOF/)?.[1] || '';
  assert.doesNotMatch(packageList, /^ubuntu-keyring$/m);
  assert.match(iso, /ubuntu-archive-keyring\.gpg/);
});
