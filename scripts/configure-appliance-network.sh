#!/usr/bin/env bash
# Configure the LightNAS appliance LAN automatically.
#
# Wired uplink:
#   physical NIC -> virbr0 -> LightNAS host + VMs + native LXC containers
#
# Wi-Fi uplink:
#   keep the Wi-Fi connection on the host; VM/container runtimes use routed/NAT
#   networking because a station-mode Wi-Fi NIC cannot be a transparent
#   Ethernet bridge on normal hardware.
set -Eeuo pipefail

BRIDGE="${LIGHTNAS_LAN_BRIDGE:-virbr0}"
STATE_DIR=/etc/lightnas
STATE_FILE="${STATE_DIR}/network.env"
mkdir -p "${STATE_DIR}"

bridge_uplink() {
  local port path
  if [[ -r "${STATE_FILE}" ]]; then
    port="$(sed -n 's/^LIGHTNAS_UPLINK=//p' "${STATE_FILE}" | tail -1)"
    [[ -n "${port}" && -e "/sys/class/net/${port}" ]] && { printf '%s\n' "${port}"; return 0; }
  fi
  for path in "/sys/class/net/${BRIDGE}/brif/"*; do
    [[ -e "${path}" ]] || continue
    port="$(basename "${path}")"
    [[ "${port}" =~ ^(veth|tap|tun|docker|br-|lightnas|lxcbr) ]] && continue
    printf '%s\n' "${port}"
    return 0
  done
  # Repair older partial conversions where virbr0 owns the host address but
  # the actual Ethernet interface was never attached as a bridge port.
  for path in /sys/class/net/*; do
    [[ -e "${path}" ]] || continue
    port="$(basename "${path}")"
    [[ "${port}" == "${BRIDGE}" || "${port}" == "lo" ]] && continue
    [[ "${port}" =~ ^(veth|tap|tun|docker|br-|lightnas|lxcbr|virbr) ]] && continue
    [[ -d "${path}/wireless" ]] && continue
    [[ "$(cat "${path}/operstate" 2>/dev/null || true)" =~ ^(up|unknown)$ ]] || continue
    printf '%s\n' "${port}"
    return 0
  done
  return 1
}

tune_transparent_bridge() {
  local port="${1:-}"
  [[ -e "/sys/class/net/${BRIDGE}" ]] || return 0
  ip link set "${BRIDGE}" promisc on >/dev/null 2>&1 || true
  if [[ -n "${port}" && -e "/sys/class/net/${port}" ]]; then
    ip link set "${port}" promisc on >/dev/null 2>&1 || true
    bridge link set dev "${port}" learning on flood on mcast_flood on bcast_flood on hairpin on >/dev/null 2>&1 || true
  fi
  for path in "/sys/class/net/${BRIDGE}/brif/"*; do
    [[ -e "${path}" ]] || continue
    local member
    member="$(basename "${path}")"
    bridge link set dev "${member}" learning on flood on mcast_flood on bcast_flood on >/dev/null 2>&1 || true
  done

  # Transparent guest traffic must remain Layer 2. br_netfilter would otherwise
  # send bridged DHCP/ARP/IP frames through host firewall forwarding policy.
  cat >/etc/sysctl.d/99-lightnas-transparent-bridge.conf <<'EOF'
net.bridge.bridge-nf-call-iptables = 0
net.bridge.bridge-nf-call-ip6tables = 0
net.bridge.bridge-nf-call-arptables = 0
EOF
  modprobe br_netfilter >/dev/null 2>&1 || true
  for setting in bridge-nf-call-iptables bridge-nf-call-ip6tables bridge-nf-call-arptables; do
    [[ -e "/proc/sys/net/bridge/${setting}" ]] && printf '0' >"/proc/sys/net/bridge/${setting}" || true
  done
}

# When LightNAS itself runs inside an LXC, the hypervisor owns the outer NIC.
# Never bridge, enslave, readdress, or otherwise modify that host-provided NIC.
# LightNAS keeps eth0 as its appliance uplink and builds private managed
# networks behind it for VMs and system containers.
container_kind="$(systemd-detect-virt --container 2>/dev/null || true)"
if [[ -n "$container_kind" && "$container_kind" != "none" ]]; then
  uplink="$(sed -n 's/^LIGHTNAS_UPLINK=//p' "$STATE_FILE" 2>/dev/null | tail -1 || true)"
  [[ -n "$uplink" && -e "/sys/class/net/$uplink" ]] || uplink=eth0

  # Undo legacy LightNAS bridge conversions from development builds. This is
  # entirely inside the LightNAS appliance; it does not touch Proxmox bridges,
  # firewall settings, or the host veth configuration.
  if ip link show "$BRIDGE" >/dev/null 2>&1; then
    bridge_addr="$(ip -4 -o addr show dev "$BRIDGE" scope global 2>/dev/null | awk 'NR==1{print $4}')"
    bridge_gw="$(ip -4 route show default dev "$BRIDGE" 2>/dev/null | awk 'NR==1{for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"

    if [[ -e "/sys/class/net/$uplink" ]]; then
      ip link set "$uplink" nomaster >/dev/null 2>&1 || true
      ip link set "$uplink" up >/dev/null 2>&1 || true
      if [[ -n "$bridge_addr" ]]; then
        ip addr replace "$bridge_addr" dev "$uplink" >/dev/null 2>&1 || true
        [[ -n "$bridge_gw" ]] && ip route replace default via "$bridge_gw" dev "$uplink" >/dev/null 2>&1 || true
      fi
    fi

    ip addr flush dev "$BRIDGE" scope global >/dev/null 2>&1 || true
    ip link set "$BRIDGE" down >/dev/null 2>&1 || true
    ip link delete "$BRIDGE" type bridge >/dev/null 2>&1 || true
  fi

  rm -f \
    "/etc/systemd/network/05-lightnas-$BRIDGE.netdev" \
    "/etc/systemd/network/06-lightnas-$uplink.network" \
    "/etc/systemd/network/07-lightnas-$BRIDGE.network" \
    /etc/sysctl.d/99-lightnas-transparent-bridge.conf

  if [[ -e "/sys/class/net/$uplink" ]]; then
    current_addr="$(ip -4 -o addr show dev "$uplink" scope global 2>/dev/null | awk 'NR==1{print $4}')"
    current_gw="$(ip -4 route show default dev "$uplink" 2>/dev/null | awk 'NR==1{for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"
    mkdir -p /etc/systemd/network
    if ip -4 -o addr show dev "$uplink" scope global dynamic 2>/dev/null | grep -q . || [[ -z "$current_addr" ]]; then
      cat >"/etc/systemd/network/10-lightnas-lxc-uplink.network" <<EOF
[Match]
Name=$uplink

[Network]
DHCP=yes
IPv6AcceptRA=yes

[DHCPv4]
RouteMetric=50
ClientIdentifier=mac
EOF
    else
      {
        printf '[Match]\nName=%s\n\n[Network]\nAddress=%s\n' "$uplink" "$current_addr"
        [[ -n "$current_gw" ]] && printf 'Gateway=%s\n' "$current_gw"
        printf 'IPv6AcceptRA=yes\n'
      } >"/etc/systemd/network/10-lightnas-lxc-uplink.network"
    fi
    systemctl enable systemd-networkd.service >/dev/null 2>&1 || true
    networkctl reload >/dev/null 2>&1 || true
    networkctl reconfigure "$uplink" >/dev/null 2>&1 || true
  fi

  printf 'LIGHTNAS_NETWORK_MODE=lxc-nat\nLIGHTNAS_UPLINK=%s\nLIGHTNAS_CONTAINER_BRIDGE=lightnas0\nLIGHTNAS_VM_NETWORK=default\n' "$uplink" >"$STATE_FILE"
  echo "LightNAS network: LXC appliance mode on $uplink; VM/container networking stays internal to LightNAS."
  exit 0
fi

default_dev="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
default_gw="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"

is_virtual_name() {
  [[ "${1:-}" =~ ^(lo|docker[0-9]*|virbr[0-9]*|lightnas[0-9]*|lxcbr[0-9]*|br-[A-Fa-f0-9]+|veth.*|tap.*|tun.*)$ ]]
}

if [[ -z "${default_dev}" ]]; then
  echo "LightNAS network: no IPv4 default route is available yet." >&2
  exit 0
fi

# Already converted. Re-apply transparent switching settings every time so
# existing installations are repaired after upgrades/reboots too.
if [[ "${default_dev}" == "${BRIDGE}" ]]; then
  uplink="$(bridge_uplink || true)"
  if [[ -n "${uplink}" ]]; then
    current_master="$(basename "$(readlink -f "/sys/class/net/${uplink}/master" 2>/dev/null || true)")"
    if [[ "${current_master}" != "${BRIDGE}" ]]; then
      ip link set "${uplink}" master "${BRIDGE}" >/dev/null 2>&1 || true
      ip link set "${uplink}" up >/dev/null 2>&1 || true
    fi
  fi
  tune_transparent_bridge "${uplink}"
  printf 'LIGHTNAS_NETWORK_MODE=bridge\nLIGHTNAS_LAN_BRIDGE=%s\nLIGHTNAS_UPLINK=%s\n' "${BRIDGE}" "${uplink}" >"${STATE_FILE}"
  exit 0
fi

# Wi-Fi cannot be transparently enslaved to an Ethernet bridge in ordinary
# station mode. Leave it as the host uplink and let LightNAS provision NAT.
if [[ -d "/sys/class/net/${default_dev}/wireless" ]] ||    command -v iw >/dev/null 2>&1 && iw dev "${default_dev}" info >/dev/null 2>&1; then
  printf 'LIGHTNAS_NETWORK_MODE=wifi-nat\nLIGHTNAS_UPLINK=%s\n' "${default_dev}" >"${STATE_FILE}"
  echo "LightNAS network: Wi-Fi uplink ${default_dev}; using routed/NAT guest networking."
  exit 0
fi

if is_virtual_name "${default_dev}"; then
  printf 'LIGHTNAS_NETWORK_MODE=virtual-uplink\nLIGHTNAS_UPLINK=%s\n' "${default_dev}" >"${STATE_FILE}"
  echo "LightNAS network: default route is already on virtual interface ${default_dev}; leaving it unchanged."
  exit 0
fi

uplink="${default_dev}"
mac="$(cat "/sys/class/net/${uplink}/address" 2>/dev/null || true)"
address="$(ip -4 -o addr show dev "${uplink}" scope global | awk 'NR==1{print $4}')"
dynamic=0
ip -4 -o addr show dev "${uplink}" scope global dynamic 2>/dev/null | grep -q . && dynamic=1

if [[ -z "${address}" || -z "${mac}" ]]; then
  echo "LightNAS network: unable to determine address/MAC for wired uplink ${uplink}; leaving it unchanged." >&2
  exit 0
fi

# libvirt's stock default network owns virbr0. Retire it before making virbr0
# the actual appliance LAN bridge.
if command -v virsh >/dev/null 2>&1; then
  if virsh -c qemu:///system net-info default >/dev/null 2>&1; then
    virsh -c qemu:///system net-destroy default >/dev/null 2>&1 || true
    virsh -c qemu:///system net-autostart default --disable >/dev/null 2>&1 || true
    virsh -c qemu:///system net-undefine default >/dev/null 2>&1 || true
  fi
fi

if ip link show "${BRIDGE}" >/dev/null 2>&1; then
  # Only delete an old private virbr0. Never tear down an already-routed LAN
  # bridge that owns the current default route.
  if ! ip -4 route show default dev "${BRIDGE}" 2>/dev/null | grep -q .; then
    ip link set "${BRIDGE}" down >/dev/null 2>&1 || true
    ip link delete "${BRIDGE}" type bridge >/dev/null 2>&1 || true
  fi
fi

# Prefer NetworkManager when it actually manages the wired NIC.
nm_state=""
nm_connection=""
if command -v nmcli >/dev/null 2>&1; then
  nm_state="$(nmcli -g GENERAL.STATE device show "${uplink}" 2>/dev/null | head -1 || true)"
  nm_connection="$(nmcli -g GENERAL.CONNECTION device show "${uplink}" 2>/dev/null | head -1 || true)"
fi

if [[ -n "${nm_state}" && "${nm_state}" != *unmanaged* && -n "${nm_connection}" && "${nm_connection}" != "--" ]]; then
  method="$(nmcli -g ipv4.method connection show "${nm_connection}" 2>/dev/null | head -1 || true)"
  while IFS=: read -r uuid name; do
    [[ -n "${uuid}" ]] && nmcli connection delete uuid "${uuid}" >/dev/null 2>&1 || true
  done < <(nmcli -t -f UUID,NAME connection show 2>/dev/null | awk -F: -v b="${BRIDGE}" '$2==b || $2==(b"-uplink"){print $1":"$2}')

  nmcli connection add type bridge ifname "${BRIDGE}" con-name "${BRIDGE}" >/dev/null
  nmcli connection modify "${BRIDGE}" connection.autoconnect yes bridge.stp no >/dev/null
  nmcli connection modify "${BRIDGE}" 802-3-ethernet.cloned-mac-address "${mac}" >/dev/null 2>&1 || true

  if [[ "${method}" == "manual" ]]; then
    nmcli connection modify "${BRIDGE}" ipv4.method manual ipv4.addresses "${address}" >/dev/null
    [[ -n "${default_gw}" ]] && nmcli connection modify "${BRIDGE}" ipv4.gateway "${default_gw}" >/dev/null
    dns="$(nmcli -g IP4.DNS device show "${uplink}" 2>/dev/null | paste -sd, - || true)"
    [[ -n "${dns}" ]] && nmcli connection modify "${BRIDGE}" ipv4.dns "${dns}" >/dev/null
  else
    nmcli connection modify "${BRIDGE}" ipv4.method auto >/dev/null
  fi
  nmcli connection add type ethernet ifname "${uplink}" con-name "${BRIDGE}-uplink" master "${BRIDGE}" slave-type bridge >/dev/null
  nmcli connection down "${nm_connection}" >/dev/null 2>&1 || true
  nmcli connection up "${BRIDGE}" >/dev/null
else
  # Proxmox LXC commonly presents eth0 as NetworkManager-unmanaged. Perform
  # the bridge cutover live first so the appliance keeps its current address
  # during installation, then persist the topology with systemd-networkd.
  ip link add name "${BRIDGE}" type bridge 2>/dev/null || true
  ip link set dev "${BRIDGE}" address "${mac}" 2>/dev/null || true
  ip link set "${BRIDGE}" up
  ip link set "${uplink}" master "${BRIDGE}"

  # Keep the current appliance address alive while ownership moves from the
  # physical NIC to the bridge. This prevents a management outage while DHCP
  # or persistent network configuration catches up.
  ip addr replace "${address}" dev "${BRIDGE}"
  [[ -n "${default_gw}" ]] && ip route replace default via "${default_gw}" dev "${BRIDGE}"
  ip addr del "${address}" dev "${uplink}" >/dev/null 2>&1 || true
  ip link set "${uplink}" up

  mkdir -p /etc/systemd/network
  cat >"/etc/systemd/network/05-lightnas-${BRIDGE}.netdev" <<EOF
[NetDev]
Name=${BRIDGE}
Kind=bridge
MACAddress=${mac}

[Bridge]
STP=false
EOF

  cat >"/etc/systemd/network/06-lightnas-${uplink}.network" <<EOF
[Match]
Name=${uplink}

[Network]
Bridge=${BRIDGE}
LinkLocalAddressing=no
IPv6AcceptRA=no
EOF

  if [[ "${dynamic}" == "1" ]]; then
    cat >"/etc/systemd/network/07-lightnas-${BRIDGE}.network" <<EOF
[Match]
Name=${BRIDGE}

[Network]
DHCP=yes
IPv6AcceptRA=yes

[DHCPv4]
RouteMetric=50
ClientIdentifier=mac
EOF
  else
    cat >"/etc/systemd/network/07-lightnas-${BRIDGE}.network" <<EOF
[Match]
Name=${BRIDGE}

[Network]
Address=${address}
${default_gw:+Gateway=${default_gw}}
IPv6AcceptRA=yes
EOF
  fi

  systemctl enable systemd-networkd.service >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null 2>&1 || true
  networkctl reload >/dev/null 2>&1 || true
  networkctl reconfigure "${uplink}" >/dev/null 2>&1 || true
  networkctl reconfigure "${BRIDGE}" >/dev/null 2>&1 || true
fi

# Wait for the bridge to become the real appliance default route.
for _ in {1..30}; do
  if ip -4 route show default dev "${BRIDGE}" 2>/dev/null | grep -q . &&      ip -4 addr show dev "${BRIDGE}" scope global 2>/dev/null | grep -q 'inet '; then
    break
  fi
  sleep 1
done

if ! ip -4 route show default dev "${BRIDGE}" 2>/dev/null | grep -q .; then
  echo "LightNAS network: LAN bridge did not acquire the default route; restoring live address on ${uplink}." >&2
  ip addr flush dev "${BRIDGE}" scope global >/dev/null 2>&1 || true
  ip link set "${uplink}" nomaster >/dev/null 2>&1 || true
  ip addr replace "${address}" dev "${uplink}" >/dev/null 2>&1 || true
  [[ -n "${default_gw}" ]] && ip route replace default via "${default_gw}" dev "${uplink}" >/dev/null 2>&1 || true
  exit 1
fi

# At this point eth0 (or the detected wired NIC) is a pure bridge port. The
# appliance address/default route belong only to virbr0.
ip addr flush dev "${uplink}" scope global >/dev/null 2>&1 || true
tune_transparent_bridge "${uplink}"

printf 'LIGHTNAS_NETWORK_MODE=bridge\nLIGHTNAS_LAN_BRIDGE=%s\nLIGHTNAS_UPLINK=%s\n' "${BRIDGE}" "${uplink}" >"${STATE_FILE}"
echo "LightNAS network: ${uplink} is now the physical port for ${BRIDGE}; guests use the real LAN."
