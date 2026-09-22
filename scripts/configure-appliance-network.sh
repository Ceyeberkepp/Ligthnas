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

default_dev="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
default_gw="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"

is_virtual_name() {
  [[ "${1:-}" =~ ^(lo|docker[0-9]*|virbr[0-9]*|lightnas[0-9]*|lxcbr[0-9]*|br-[A-Fa-f0-9]+|veth.*|tap.*|tun.*)$ ]]
}

if [[ -z "${default_dev}" ]]; then
  echo "LightNAS network: no IPv4 default route is available yet." >&2
  exit 0
fi

# Already converted.
if [[ "${default_dev}" == "${BRIDGE}" ]]; then
  printf 'LIGHTNAS_NETWORK_MODE=bridge\nLIGHTNAS_LAN_BRIDGE=%s\n' "${BRIDGE}" >"${STATE_FILE}"
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
  # Proxmox LXC commonly presents eth0 as NetworkManager-unmanaged. systemd-
  # networkd is the durable configuration layer in that environment.
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
  systemctl restart systemd-networkd.service
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
  ip link set "${uplink}" nomaster >/dev/null 2>&1 || true
  ip addr replace "${address}" dev "${uplink}" >/dev/null 2>&1 || true
  [[ -n "${default_gw}" ]] && ip route replace default via "${default_gw}" dev "${uplink}" >/dev/null 2>&1 || true
  exit 1
fi

printf 'LIGHTNAS_NETWORK_MODE=bridge\nLIGHTNAS_LAN_BRIDGE=%s\nLIGHTNAS_UPLINK=%s\n' "${BRIDGE}" "${uplink}" >"${STATE_FILE}"
echo "LightNAS network: ${uplink} is now the physical port for ${BRIDGE}; guests use the real LAN."
