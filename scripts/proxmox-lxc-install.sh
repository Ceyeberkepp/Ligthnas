#!/usr/bin/env bash
# Proxmox-aware installer for an existing LXC. If this is run inside a guest instead
# of on a Proxmox node, it safely falls back to the normal portable LightNAS installer.
set -Eeuo pipefail

RAW_BASE="${LIGHTNAS_RAW_BASE:-https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main}"
ctid="${1:-${LIGHTNAS_CTID:-}}"

run_local_installer() {
  if [[ ${EUID} -ne 0 ]]; then
    echo 'Run the LightNAS installer as root (or with sudo).' >&2
    exit 1
  fi
  echo 'Proxmox host tools were not detected. Installing LightNAS locally in this Linux guest/host.'
  local installer
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL "${RAW_BASE}/install.sh" -o "$installer"
  bash "$installer"
}

# This makes the command forgiving: if the helper is accidentally run from
# root@nasos (inside the LXC), install LightNAS there instead of just failing.
if [[ ! -d /etc/pve ]] || ! command -v pct >/dev/null 2>&1; then
  run_local_installer
  exit 0
fi

if [[ ${EUID} -ne 0 || ! $ctid =~ ^[1-9][0-9]{1,5}$ ]]; then
  echo 'Proxmox VE host detected.' >&2
  echo 'Usage: bash /root/lightnas-lxc-install.sh CTID' >&2
  echo 'Example: bash /root/lightnas-lxc-install.sh 170' >&2
  exit 1
fi

config="$(pct config "$ctid")" || {
  echo "Unable to read LXC $ctid. Verify the CTID exists on this Proxmox node." >&2
  exit 1
}

wait_for_container() {
  local attempt
  for attempt in {1..30}; do
    if pct exec "$ctid" -- true >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "LXC $ctid did not become ready for commands." >&2
  return 1
}

if [[ "$(pct status "$ctid")" != *'status: running'* ]]; then
  echo "Starting LXC $ctid..."
  pct start "$ctid"
  wait_for_container
fi

features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
for option in nesting keyctl; do
  if [[ $features =~ (^|,)${option}=[01](,|$) ]]; then
    features="$(sed -E "s/(^|,)${option}=[01]/\\1${option}=1/" <<<"$features")"
  else
    features="${features:+$features,}${option}=1"
  fi
done

current="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
if [[ "$features" != "$current" ]]; then
  echo "Preparing LXC $ctid: features=$features"
  pct set "$ctid" -features "$features"
  echo "Restarting LXC $ctid to apply feature changes..."
  pct shutdown "$ctid" --timeout 60
  pct start "$ctid"
  wait_for_container
fi

# The public cluster CA is safe to copy; HTTPS still verifies the host name.
if [[ -r /etc/pve/pve-root-ca.pem ]]; then
  pct exec "$ctid" -- install -d -m 0755 /usr/local/share/ca-certificates
  pct push "$ctid" /etc/pve/pve-root-ca.pem /usr/local/share/ca-certificates/lightnas-pve.crt
  pct exec "$ctid" -- update-ca-certificates
fi

# Run the portable installer as root INSIDE the existing container.
pct exec "$ctid" -- bash -lc "set -Eeuo pipefail; curl -fsSL '${RAW_BASE}/install.sh' -o /root/lightnas-install.sh; bash /root/lightnas-install.sh"

echo
printf 'LightNAS installation finished in LXC %s.\n' "$ctid"
pct exec "$ctid" -- bash -lc 'echo "--- Runtime status ---"; cat /var/lib/lightnas/runtime-status.txt 2>/dev/null || true; echo "--- Service ---"; systemctl --no-pager --full is-active lightnas || true'
echo 'VM creation inside an LXC uses the Proxmox API integration; local KVM remains unavailable inside LXC.'
