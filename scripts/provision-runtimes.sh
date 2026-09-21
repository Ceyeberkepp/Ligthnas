#!/usr/bin/env bash
# Run from install.sh after the lightnas account exists. This does not change disks or PVE configuration.
set -Eeuo pipefail

status_file="${LIGHTNAS_RUNTIME_STATUS_FILE:-/var/lib/lightnas/runtime-status.txt}"
runtime_env="${LIGHTNAS_RUNTIME_ENV_FILE:-/etc/lightnas/runtime.env}"
mkdir -p "$(dirname "${status_file}")" "$(dirname "${runtime_env}")"
if [[ ! -e "$runtime_env" ]]; then install -m 0600 /dev/null "$runtime_env"; fi
chmod 0600 "$runtime_env"

set_flag() {
  local key="$1" value="$2"
  sed -i "/^${key}=/d" "$runtime_env"
  printf '%s=%s\n' "$key" "$value" >> "$runtime_env"
}
report() { printf '%s: %s\n' "$1" "$2" | tee -a "${status_file}"; }
: > "${status_file}"
chmod 0644 "${status_file}"

# Native system containers are built into LightNAS through LXC/liblxc.
if command -v lxc-create >/dev/null 2>&1 && command -v lxc-start >/dev/null 2>&1; then
  # Use the standard lxc-net helper as the owner of the LightNAS container
  # bridge. This works even when the outer LXC's eth0 is intentionally
  # unmanaged by NetworkManager. lxc-net supplies the bridge, DHCP/DNS and
  # outbound NAT through the host's current default route.
  if systemctl list-unit-files lxc-net.service --no-legend 2>/dev/null | grep -q '^lxc-net.service'; then
    systemctl stop lxc-net.service >/dev/null 2>&1 || true

    # Older LightNAS builds created a NetworkManager profile with this name.
    # Remove the inactive profile so NetworkManager and lxc-net never fight
    # over the same bridge device.
    if command -v nmcli >/dev/null 2>&1; then
      while IFS= read -r uuid; do
        [[ -n "$uuid" ]] && nmcli connection delete uuid "$uuid" >/dev/null 2>&1 || true
      done < <(nmcli -t -f UUID,NAME connection show 2>/dev/null | awk -F: '$2=="lightnas0"{print $1}')
    fi

    if ip link show lightnas0 >/dev/null 2>&1; then
      ip link set lightnas0 down >/dev/null 2>&1 || true
      ip link delete lightnas0 type bridge >/dev/null 2>&1 || true
    fi

    install -d -m 0755 /etc/default
    touch /etc/default/lxc-net
    for setting in \
      'USE_LXC_BRIDGE="true"' \
      'LXC_BRIDGE="lightnas0"' \
      'LXC_ADDR="10.77.0.1"' \
      'LXC_NETMASK="255.255.255.0"' \
      'LXC_NETWORK="10.77.0.0/24"' \
      'LXC_DHCP_RANGE="10.77.0.20,10.77.0.250"' \
      'LXC_DHCP_MAX="231"'; do
      key="${setting%%=*}"
      sed -i "/^${key}=/d" /etc/default/lxc-net
      printf '%s\n' "$setting" >> /etc/default/lxc-net
    done

    systemctl enable lxc-net.service >/dev/null 2>&1 || true
    systemctl restart lxc-net.service >/dev/null 2>&1 || true

    for attempt in {1..10}; do
      if ip link show lightnas0 2>/dev/null | grep -q 'UP' \
        && ip -4 address show dev lightnas0 2>/dev/null | grep -q '10\.77\.0\.1/24'; then
        break
      fi
      sleep 1
    done
  fi

  # Ubuntu's stock lxc-net can fail inside a nested Proxmox LXC even when
  # network namespaces/veth are available. Install a small LightNAS-owned
  # bridge service as a fallback so system-container creation does not depend
  # on that distro helper.
  if ! (ip link show lightnas0 2>/dev/null | grep -q 'UP' \
    && ip -4 address show dev lightnas0 2>/dev/null | grep -q '10\.77\.0\.1/24'); then
    install -d -m 0755 /usr/local/libexec /run/lightnas
    cat >/usr/local/libexec/lightnas-container-network <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
bridge=lightnas0
subnet=10.77.0.0/24
gateway=10.77.0.1
pidfile=/run/lightnas/dnsmasq-lightnas0.pid
case "${1:-start}" in
  start)
    ip link show "$bridge" >/dev/null 2>&1 || ip link add name "$bridge" type bridge
    ip addr replace "$gateway/24" dev "$bridge"
    ip link set "$bridge" up
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
    if [[ -s "$pidfile" ]]; then kill "$(cat "$pidfile")" >/dev/null 2>&1 || true; rm -f "$pidfile"; fi
    dnsmasq --conf-file=/dev/null --interface="$bridge" --bind-dynamic \
      --dhcp-range=10.77.0.20,10.77.0.250,255.255.255.0,12h \
      --dhcp-option=3,"$gateway" --dhcp-option=6,"$gateway" \
      --pid-file="$pidfile" >/dev/null 2>&1 || true
    if command -v nft >/dev/null 2>&1; then
      nft delete table ip lightnas_nat >/dev/null 2>&1 || true
      nft add table ip lightnas_nat >/dev/null 2>&1 || true
      nft 'add chain ip lightnas_nat postrouting { type nat hook postrouting priority srcnat; policy accept; }' >/dev/null 2>&1 || true
      nft add rule ip lightnas_nat postrouting ip saddr "$subnet" masquerade >/dev/null 2>&1 || true
    fi
    ;;
  stop)
    if [[ -s "$pidfile" ]]; then kill "$(cat "$pidfile")" >/dev/null 2>&1 || true; rm -f "$pidfile"; fi
    nft delete table ip lightnas_nat >/dev/null 2>&1 || true
    ip link set "$bridge" down >/dev/null 2>&1 || true
    ip link delete "$bridge" type bridge >/dev/null 2>&1 || true
    ;;
esac
EOF
    chmod 0755 /usr/local/libexec/lightnas-container-network
    cat >/etc/systemd/system/lightnas-container-network.service <<'EOF'
[Unit]
Description=LightNAS native container bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/libexec/lightnas-container-network start
ExecStop=/usr/local/libexec/lightnas-container-network stop

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now lightnas-container-network.service >/dev/null 2>&1 || true
  fi

  if systemd-detect-virt --container >/dev/null 2>&1 && [[ "${LIGHTNAS_ALLOW_NESTED_LXC:-0}" != "1" ]]; then
    report Containers 'native LXC installed, but this appliance is itself in a container and nested LXC was not enabled'
  elif ip link show lightnas0 2>/dev/null | grep -q 'UP' \
    && ip -4 address show dev lightnas0 2>/dev/null | grep -q '10\.77\.0\.1/24'; then
    report Containers 'native LXC/liblxc ready on lightnas0 (10.77.0.0/24 NAT)'
  else
    report Containers 'native LXC/liblxc installed, but the LightNAS container bridge is not active'
  fi
else
  report Containers 'native LXC/liblxc tools are not installed on this host'
fi

# Docker/OCI is optional and is used only by the App Store. Do not install or
# grant Docker-socket access unless the operator explicitly opts in.
if [[ "${LIGHTNAS_ENABLE_DOCKER_APPS:-1}" != "1" ]]; then
  set_flag LIGHTNAS_DOCKER_ENABLED 0
  report Apps 'optional Docker/OCI engine disabled (set LIGHTNAS_ENABLE_DOCKER_APPS=1 to enable)'
else
  if ! command -v docker >/dev/null 2>&1; then
    if ! apt-get install -y docker.io; then report Apps 'docker.io package installation failed'; fi
  fi
  if command -v docker >/dev/null 2>&1; then
    systemctl enable --now docker.service >/dev/null 2>&1 || true
    for attempt in {1..10}; do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
    if docker info >/dev/null 2>&1; then
      if getent group docker >/dev/null 2>&1; then usermod -aG docker lightnas; fi
      if runuser -u lightnas -- docker info >/dev/null 2>&1; then
        set_flag LIGHTNAS_DOCKER_ENABLED 1
        report Apps 'optional Docker/OCI engine ready'
      else
        set_flag LIGHTNAS_DOCKER_ENABLED 0
        report Apps 'Docker is running but inaccessible to the LightNAS service account'
      fi
    else
      set_flag LIGHTNAS_DOCKER_ENABLED 0
      report Apps 'Docker could not start'
    fi
  else
    set_flag LIGHTNAS_DOCKER_ENABLED 0
    report Apps 'Docker not installed'
  fi
fi

if [[ "${LIGHTNAS_SKIP_VM:-0}" == "1" ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  set_flag LIGHTNAS_VM_ACCELERATION disabled
  report VMs 'skipped by operator (LIGHTNAS_SKIP_VM=1)'
elif [[ "$(uname -m)" != 'x86_64' ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  set_flag LIGHTNAS_VM_ACCELERATION unsupported
  report VMs 'automatic x86 VM provisioning currently supports x86_64 LightNAS hosts only'
else
  if apt-get install -y qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst; then
    if systemctl list-unit-files libvirtd.socket --no-legend 2>/dev/null | grep -q '^libvirtd.socket'; then
      systemctl enable --now libvirtd.socket >/dev/null 2>&1 || true
    elif systemctl list-unit-files virtqemud.socket --no-legend 2>/dev/null | grep -q '^virtqemud.socket'; then
      systemctl enable --now virtqemud.socket >/dev/null 2>&1 || true
    fi
    if getent group libvirt >/dev/null 2>&1; then usermod -aG libvirt lightnas; fi

    install -d -m 0755 /var/lib/libvirt/images
    setfacl -m u:lightnas:rwx /var/lib/libvirt/images >/dev/null 2>&1 || true

    for attempt in {1..15}; do
      virsh -c qemu:///system list --all >/dev/null 2>&1 && break
      sleep 1
    done

    if ! virsh -c qemu:///system pool-info default >/dev/null 2>&1; then
      pool_xml="$(mktemp)"
      cat >"$pool_xml" <<'EOF'
<pool type='dir'>
  <name>default</name>
  <target><path>/var/lib/libvirt/images</path></target>
</pool>
EOF
      virsh -c qemu:///system pool-define "$pool_xml" >/dev/null 2>&1 || true
      rm -f "$pool_xml"
    fi
    virsh -c qemu:///system pool-build default >/dev/null 2>&1 || true
    virsh -c qemu:///system pool-start default >/dev/null 2>&1 || true
    virsh -c qemu:///system pool-autostart default >/dev/null 2>&1 || true

    if ! virsh -c qemu:///system net-info default >/dev/null 2>&1; then
      network_xml="$(mktemp)"
      cat >"$network_xml" <<'EOF'
<network>
  <name>default</name>
  <forward mode='nat'/>
  <bridge name='virbr0' stp='on' delay='0'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp><range start='192.168.122.2' end='192.168.122.254'/></dhcp>
  </ip>
</network>
EOF
      virsh -c qemu:///system net-define "$network_xml" >/dev/null 2>&1 || true
      rm -f "$network_xml"
    fi
    virsh -c qemu:///system net-start default >/dev/null 2>&1 || true
    virsh -c qemu:///system net-autostart default >/dev/null 2>&1 || true

    acceleration=tcg
    if [[ -c /dev/kvm ]]; then
      acceleration=kvm
    fi
    set_flag LIGHTNAS_VM_ACCELERATION "$acceleration"

    for attempt in {1..10}; do
      runuser -u lightnas -- virsh -c qemu:///system list --all --name >/dev/null 2>&1 && break
      sleep 1
    done

    if runuser -u lightnas -- virsh -c qemu:///system list --all --name >/dev/null 2>&1 \
      && virsh -c qemu:///system pool-info default >/dev/null 2>&1 \
      && virsh -c qemu:///system net-info default >/dev/null 2>&1 \
      && command -v virt-install >/dev/null 2>&1; then
      set_flag LIGHTNAS_VM_ENABLED 1
      if [[ "$acceleration" == kvm ]]; then
        report VMs 'native QEMU/KVM + libvirt ready; hardware acceleration enabled'
      else
        report VMs 'QEMU/libvirt software virtualization ready (TCG); VMs work without VT-x/AMD-V but run slower'
      fi
    else
      set_flag LIGHTNAS_VM_ENABLED 0
      report VMs 'QEMU/libvirt installed, but the local VM pool/network or LightNAS service access is not ready'
    fi
  else
    set_flag LIGHTNAS_VM_ENABLED 0
    set_flag LIGHTNAS_VM_ACCELERATION unavailable
    report VMs 'QEMU/libvirt package installation failed'
  fi
fi
