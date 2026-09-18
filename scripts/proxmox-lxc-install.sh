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

if [[ "$features" != "$(sed -n 's/^features: //p' <<<"$config" | head -1)" ]]; then
  echo "Setting LXC features: $features"
  pct set "$ctid" -features "$features"
fi

# Pass /dev/kvm into the appliance when available. This is hardware capability
# passthrough only; LightNAS does not use qm or the Proxmox API afterwards.
if [[ -e /dev/kvm ]] && ! grep -Eq '^dev[0-9]+: path=/dev/kvm([,[:space:]]|$)' <<<"$config"; then
  devslot=''
  for slot in $(seq 0 9); do
    if ! grep -q "^dev${slot}:" <<<"$config"; then devslot="$slot"; break; fi
  done
  if [[ -n $devslot ]]; then
    echo "Passing /dev/kvm into LXC $ctid..."
    pct set "$ctid" "--dev${devslot}" "path=/dev/kvm,mode=0666" || \
      echo 'Warning: Proxmox could not pass /dev/kvm. Local VMs will remain disabled in this LXC.' >&2
  fi
fi

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

pct exec "$ctid" -- bash -lc '
  install -d -m 0755 /etc/lightnas
  touch /etc/lightnas/runtime.env
  chmod 0600 /etc/lightnas/runtime.env
  sed -i "/^LIGHTNAS_ALLOW_NESTED_LXC=/d;/^LIGHTNAS_ENABLE_PROXMOX_PROVIDER=/d;/^LIGHTNAS_PVE_/d" /etc/lightnas/runtime.env
  printf "%s\n" "LIGHTNAS_ALLOW_NESTED_LXC=1" "LIGHTNAS_ENABLE_PROXMOX_PROVIDER=0" >> /etc/lightnas/runtime.env
  systemctl restart lightnas-host-agent lightnas
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
pct exec "$ctid" -- bash -lc '
  echo "--- Runtime status ---"
  cat /var/lib/lightnas/runtime-status.txt 2>/dev/null || true
  echo "--- KVM ---"
  ls -l /dev/kvm 2>/dev/null || echo "/dev/kvm unavailable"
  echo "--- Services ---"
  systemctl --no-pager is-active lightnas-host-agent lightnas || true
'
