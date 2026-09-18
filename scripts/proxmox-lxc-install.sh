#!/usr/bin/env bash
# Install LightNAS inside an existing Proxmox LXC while keeping compute local
# to LightNAS. Proxmox is used only to grant guest nesting/KVM capabilities.
set -Eeuo pipefail

RAW_BASE="${LIGHTNAS_RAW_BASE:-https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main}"
ctid="${1:-${LIGHTNAS_CTID:-}}"

run_local_installer() {
  [[ ${EUID} -eq 0 ]] || { echo 'Run the LightNAS installer as root (or with sudo).' >&2; exit 1; }
  echo 'Proxmox host tools were not detected. Installing LightNAS locally.'
  local installer
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL "${RAW_BASE}/install.sh" -o "$installer"
  bash "$installer"
}

if [[ ! -d /etc/pve ]] || ! command -v pct >/dev/null 2>&1; then
  run_local_installer
  exit 0
fi

if [[ ${EUID} -ne 0 || ! $ctid =~ ^[1-9][0-9]{1,5}$ ]]; then
  echo 'Usage on a Proxmox VE host: bash scripts/proxmox-lxc-install.sh CTID' >&2
  exit 1
fi

config="$(pct config "$ctid")" || { echo "Unable to read LXC $ctid." >&2; exit 1; }

wait_for_container() {
  for attempt in {1..40}; do
    pct exec "$ctid" -- true >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "LXC $ctid did not become ready." >&2
  return 1
}

wait_for_stopped() {
  for attempt in {1..40}; do
    [[ "$(pct status "$ctid")" == *'status: stopped'* ]] && return 0
    sleep 2
  done
  echo "LXC $ctid did not stop cleanly." >&2
  return 1
}

features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
for option in nesting keyctl mknod; do
  if [[ $features =~ (^|,)${option}=[01](,|$) ]]; then
    features="$(sed -E "s/(^|,)${option}=[01]/\\1${option}=1/" <<<"$features")"
  else
    features="${features:+$features,}${option}=1"
  fi
done

if [[ "$(pct status "$ctid")" == *'status: running'* ]]; then
  echo "Stopping LXC $ctid to grant nested LightNAS runtime capabilities..."
  pct shutdown "$ctid" --timeout 60 || pct stop "$ctid"
  wait_for_stopped
fi

# Remove the legacy Proxmox host-bridge mount from earlier LightNAS builds.
# The new architecture runs LXC/KVM locally inside the LightNAS appliance.
while IFS= read -r legacy_slot; do
  [[ -n "$legacy_slot" ]] || continue
  echo "Removing legacy LightNAS Proxmox host bridge mount $legacy_slot..."
  pct set "$ctid" -delete "$legacy_slot" || true
done < <(grep -E '^mp[0-9]+: /var/lib/lightnas-pve,mp=/var/lib/lightnas-pve([,[:space:]]|$)' <<<"$config" | cut -d: -f1 || true)
rm -f "/etc/lightnas-pve/clients/${ctid}.secret" 2>/dev/null || true

if [[ "$features" != "$(sed -n 's/^features: //p' <<<"$config" | head -1)" ]]; then
  echo "Setting LXC features: $features"
  pct set "$ctid" -features "$features"
fi

ensure_host_kvm() {
  if [[ -c /dev/kvm ]]; then
    return 0
  fi

  echo "Proxmox host does not currently expose /dev/kvm; trying to load KVM modules..."
  modprobe kvm >/dev/null 2>&1 || true

  vendor="$(awk -F: '/vendor_id/{gsub(/[[:space:]]/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)"
  case "$vendor" in
    GenuineIntel) modprobe kvm_intel >/dev/null 2>&1 || true ;;
    AuthenticAMD) modprobe kvm_amd >/dev/null 2>&1 || true ;;
  esac

  if [[ -c /dev/kvm ]]; then
    echo "Host KVM device is now available."
    return 0
  fi

  echo "WARNING: /dev/kvm is still unavailable on the Proxmox host." >&2
  if grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo; then
    echo "CPU virtualization flags are present, but the KVM device/module is unavailable. Check Proxmox host module errors." >&2
  else
    echo "CPU virtualization flags (vmx/svm) are not visible. Enable Intel VT-x/AMD-V in firmware or expose nested virtualization to this Proxmox host." >&2
  fi
  return 0
}

ensure_host_kvm

pass_device() {
  local path="$1" mode="${2:-0666}" label="$3"
  [[ -e "$path" ]] || { echo "Host device $path is unavailable; $label will be limited." >&2; return 0; }
  if grep -Eq "^dev[0-9]+: path=${path//\//\\/}([,[:space:]]|$)" <<<"$config"; then return 0; fi
  local devslot=''
  for slot in $(seq 0 15); do
    if ! grep -q "^dev${slot}:" <<<"$config"; then devslot="$slot"; break; fi
  done
  [[ -n "$devslot" ]] || { echo "No free Proxmox device slot for $path." >&2; return 1; }
  echo "Passing $path into LXC $ctid for $label..."
  pct set "$ctid" "--dev${devslot}" "path=$path,mode=$mode" || {
    echo "Warning: Proxmox could not pass $path; $label may remain unavailable." >&2
    return 0
  }
  config="$(pct config "$ctid")"
}

# These are capability passthrough devices only. LightNAS still creates and
# manages its own QEMU/KVM guests; it does not call qm or the Proxmox API.
pass_device /dev/kvm 0666 'KVM acceleration'
pass_device /dev/net/tun 0666 'tap/TUN guest networking'
pass_device /dev/vhost-net 0666 'VirtIO network acceleration'

echo "Starting LXC $ctid..."
pct start "$ctid"
wait_for_container

guest_installer="$(mktemp)"
trap 'rm -f "$guest_installer"' EXIT
curl -fsSL "${RAW_BASE}/install.sh" -o "$guest_installer"
pct push "$ctid" "$guest_installer" /root/lightnas-install.sh
pct exec "$ctid" -- chmod 0755 /root/lightnas-install.sh
pct exec "$ctid" -- env \
  LIGHTNAS_ENABLE_NESTED_RUNTIMES=1 \
  LIGHTNAS_ALLOW_NESTED_LXC=1 \
  bash /root/lightnas-install.sh

echo "Verifying native LightNAS engines inside LXC $ctid..."
if ! pct exec "$ctid" -- bash -lc 'command -v lxc-ls >/dev/null && command -v lxc-create >/dev/null && command -v virsh >/dev/null && command -v virt-install >/dev/null'; then
  echo "Native engines are incomplete; repairing packages inside LXC $ctid..."
  pct exec "$ctid" -- bash -lc '
    set -Eeuo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y \
      lxc lxc-templates lxcfs uidmap bridge-utils \
      qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst ovmf \
      dnsmasq-base network-manager iproute2 nftables ufw
  '
fi

pct exec "$ctid" -- bash -lc '
  install -d -m 0755 /etc/lightnas
  touch /etc/lightnas/runtime.env
  chmod 0600 /etc/lightnas/runtime.env
  sed -i "/^LIGHTNAS_ALLOW_NESTED_LXC=/d;/^LIGHTNAS_ENABLE_PROXMOX_PROVIDER=/d;/^LIGHTNAS_PVE_/d" /etc/lightnas/runtime.env
  printf "%s\n" "LIGHTNAS_ALLOW_NESTED_LXC=1" "LIGHTNAS_ENABLE_PROXMOX_PROVIDER=0" >> /etc/lightnas/runtime.env

  LIGHTNAS_ALLOW_NESTED_LXC=1 LIGHTNAS_RUNTIME_STATUS_FILE=/var/lib/lightnas/runtime-status.txt \
    bash /opt/lightnas/scripts/provision-runtimes.sh

  systemctl daemon-reload
  systemctl enable --now NetworkManager.service >/dev/null 2>&1 || true
  systemctl enable --now lxc-net.service >/dev/null 2>&1 || true
  systemctl enable --now libvirtd.socket >/dev/null 2>&1 || true
  systemctl enable --now lightnas-host-agent.service
  systemctl enable --now lightnas.service
'

latest_config="$(pct config "$ctid")"
mapfile -t guest_data_mounts < <(sed -nE 's/^mp[0-9]+: .*mp=([^,]+).*/\1/p' <<<"$latest_config" | grep -E '^/(mnt|media|srv|data|storage)(/|$)' || true)
for guest_mount in "${guest_data_mounts[@]}"; do
  echo "Granting LightNAS managed access to ${guest_mount}..."
  pct exec "$ctid" -- bash -lc 'mount="$1"; [[ -d "$mount" ]] && setfacl -m u:lightnas:rwx "$mount" && setfacl -m d:u:lightnas:rwx "$mount"' _ "$guest_mount" || \
    echo "Warning: unable to add LightNAS ACL on ${guest_mount}; it will remain browse-only." >&2
done

echo
echo "LightNAS local-runtime installation finished in LXC $ctid."
echo 'Containers: native LXC/liblxc inside LightNAS.'
echo 'VMs: native QEMU/KVM + libvirt inside LightNAS when /dev/kvm is available.'
echo 'Proxmox host APIs are not used for normal LightNAS compute operations.'

echo "Performing strict post-install verification..."
latest_config="$(pct config "$ctid")"
grep -Eq '(^|,)nesting=1(,|$)' <<<"${latest_config#*features: }" || { echo 'ERROR: nesting=1 is missing.' >&2; exit 1; }
grep -Eq '^features: .*keyctl=1' <<<"$latest_config" || { echo 'ERROR: keyctl=1 is missing.' >&2; exit 1; }
grep -Eq '^features: .*mknod=1' <<<"$latest_config" || { echo 'ERROR: mknod=1 is missing.' >&2; exit 1; }

pct exec "$ctid" -- bash -lc '
  set -Eeuo pipefail
  command -v lxc-ls >/dev/null
  command -v lxc-create >/dev/null
  command -v virsh >/dev/null
  command -v virt-install >/dev/null
  systemctl is-active --quiet lightnas-host-agent
  systemctl is-active --quiet lightnas
' || {
  echo "ERROR: LightNAS nested runtime verification failed." >&2
  pct exec "$ctid" -- systemctl status lightnas-host-agent lightnas --no-pager --full || true
  exit 1
}

pct exec "$ctid" -- bash -lc '
  echo "--- Runtime status ---"
  cat /var/lib/lightnas/runtime-status.txt 2>/dev/null || true
  echo "--- KVM ---"
  ls -l /dev/kvm 2>/dev/null || echo "/dev/kvm unavailable"
  echo "--- Services ---"
  systemctl --no-pager is-active lightnas-host-agent lightnas || true
'
echo "--- Nested runtime self-test ---"
pct exec "$ctid" -- python3 -c 'import json,socket; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.connect("/run/lightnas/host-agent.sock"); s.sendall(b"{\"action\":\"runtime-diagnostics\"}\n"); data=b""; exec("while b\\\"\\n\\\" not in data:\\n chunk=s.recv(65536)\\n if not chunk: break\\n data+=chunk"); print(json.dumps(json.loads(data.split(b"\\n",1)[0]), indent=2))'
