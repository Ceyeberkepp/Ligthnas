import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('LightNAS installs LXC networking for every supported installation', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /Installing native system-container engine and network bridge tools/);
  assert.match(installer, /lxc lxc-templates lxcfs uidmap bridge-utils/);
  assert.doesNotMatch(installer, /if ! systemd-detect-virt --container[^\n]+LIGHTNAS_ENABLE_NESTED_RUNTIMES[^\n]+then\n\s+echo "      Installing native system-container/);
});

test('nested LightNAS never risks the appliance management link for guest networking', async () => {
  const network = await readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8');
  assert.match(network, /never move the appliance management IP or default route/);
  assert.match(network, /LIGHTNAS_NESTED_LAN_MODE:-auto/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-macvlan/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-ipvlan/);
  assert.match(network, /LIGHTNAS_CONTAINER_PARENT=%s/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=lxc-nat/);
  assert.match(network, /preserving management networking and using safe container NAT fallback/);
});

test('host agent creates nested system containers with safe direct-LAN macvlan or ipvlan', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /\{"nested-macvlan", "nested-ipvlan"\}/);
  assert.match(agent, /direct_type = "macvlan".*"ipvlan"/);
  assert.match(agent, /lxc\.net\.0\.macvlan\.mode = bridge/);
  assert.match(agent, /lxc\.net\.0\.ipvlan\.mode = l2/);
  assert.match(agent, /return \[parent\]/);
});

test('runtime provisioning migrates old private NAT containers to direct host LAN automatically', async () => {
  const provision = await readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8');
  assert.match(provision, /set_flag LIGHTNAS_ALLOW_NESTED_LXC 1/);
  assert.match(provision, /nested-\(macvlan\|ipvlan\)/);
  assert.match(provision, /direct_type="\$\{network_mode#nested-\}"/);
  assert.match(provision, /lxc\.net\.0\.macvlan\.mode = bridge/);
  assert.match(provision, /lxc\.net\.0\.ipvlan\.mode = l2/);
  assert.match(provision, /LIGHTNAS_CONTAINER_PARENT/);
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


test('nested networking never bridges over the appliance management interface', async () => {
  const network = await readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8');
  assert.match(network, /never move the appliance management IP or default route/);
  assert.match(network, /LIGHTNAS_NETWORK_MODE=nested-macvlan/);
  assert.match(network, /preserving management networking and using safe container NAT fallback/);
  assert.doesNotMatch(network, /LIGHTNAS_NESTED_LAN_BRIDGE:-lightnas-lan0/);
});


test('legacy 10.77 guest profiles are restored to DHCP during LAN migration', async () => {
  const provision = await readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8');
  assert.match(provision, /restore_guest_lan_dhcp\(\)/);
  assert.match(provision, /Address=10\\\.77\\\.0/);
  assert.match(provision, /DHCP=ipv4/);
  assert.match(provision, /ClientIdentifier=mac/);
  assert.match(provision, /automaticFallback.*False/);
  assert.match(provision, /lxc\\\.net\\\.0\\\.ipv4\\\.address/);
  assert.match(provision, /lxc\\\.net\\\.0\\\.ipv4\\\.gateway/);
});


test('nested LightNAS derives a managed pool from its own LAN address', async () => {
  const network = await readFile(new URL('../scripts/configure-appliance-network.sh', import.meta.url), 'utf8');
  assert.match(network, /derive_managed_lan_pool\(\)/);
  assert.match(network, /LIGHTNAS_CONTAINER_SUBNET/);
  assert.match(network, /LIGHTNAS_CONTAINER_POOL_START/);
  assert.match(network, /LIGHTNAS_CONTAINER_POOL_END/);
  assert.match(network, /LIGHTNAS_CONTAINER_GATEWAY/);
  assert.match(network, /start_index=50/);
  assert.match(network, /end_index=200/);
});
