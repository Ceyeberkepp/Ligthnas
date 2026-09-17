#!/usr/bin/env bash
# Proxmox-aware installer for an existing LXC.
# On a Proxmox VE node this prepares the LXC, installs the local host bridge,
# and configures LightNAS automatically. No Proxmox API token is required.
# On any other Debian/Ubuntu guest/host it falls back to the portable installer.
set -Eeuo pipefail

RAW_BASE="${LIGHTNAS_RAW_BASE:-https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main}"
ctid="${1:-${LIGHTNAS_CTID:-}}"
HOST_BRIDGE_DIR=/var/lib/lightnas-pve
GUEST_BRIDGE_DIR=/var/lib/lightnas-pve
HOST_CLIENT_DIR=/etc/lightnas-pve/clients
HOST_AGENT=/usr/local/libexec/lightnas-proxmox-agent
HOST_SERVICE=/etc/systemd/system/lightnas-proxmox-agent.service

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
    if pct exec "$ctid" -- true >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "LXC $ctid did not become ready for commands." >&2
  return 1
}

wait_for_stopped() {
  local attempt
  for attempt in {1..30}; do
    if [[ "$(pct status "$ctid")" == *'status: stopped'* ]]; then return 0; fi
    sleep 2
  done
  echo "LXC $ctid did not stop cleanly." >&2
  return 1
}

install_host_bridge() {
  echo 'Installing LightNAS Proxmox host bridge...'
  command -v python3 >/dev/null 2>&1 || { apt-get update; apt-get install -y python3; }
  install -d -m 0755 /usr/local/libexec "$HOST_BRIDGE_DIR"
  install -d -m 0700 "$HOST_CLIENT_DIR"
  curl -fsSL "${RAW_BASE}/scripts/proxmox-host-agent.py" -o "$HOST_AGENT"
  chmod 0755 "$HOST_AGENT"
  cat >"$HOST_SERVICE" <<'EOF'
[Unit]
Description=LightNAS Proxmox Host Bridge
After=pve-cluster.service
Wants=pve-cluster.service

[Service]
Type=simple
ExecStart=/usr/local/libexec/lightnas-proxmox-agent
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now lightnas-proxmox-agent.service
}

install_host_bridge

secret_file="${HOST_CLIENT_DIR}/${ctid}.secret"
if [[ ! -s "$secret_file" ]]; then
  umask 077
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$secret_file"
fi
chmod 0600 "$secret_file"
secret="$(cat "$secret_file")"
[[ $secret =~ ^[a-f0-9]{64}$ ]] || { echo 'Host bridge secret generation failed.' >&2; exit 1; }

features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
for option in nesting keyctl; do
  if [[ $features =~ (^|,)${option}=[01](,|$) ]]; then
    features="$(sed -E "s/(^|,)${option}=[01]/\\1${option}=1/" <<<"$features")"
  else
    features="${features:+$features,}${option}=1"
  fi
done
current_features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
feature_change=0
[[ "$features" != "$current_features" ]] && feature_change=1

mount_change=0
mount_slot=''
if ! grep -Eq '^mp[0-9]+: /var/lib/lightnas-pve,mp=/var/lib/lightnas-pve([,[:space:]]|$)' <<<"$config"; then
  mount_change=1
  legacy_mount_line="$(grep -E '^mp[0-9]+: /var/lib/lightnas-pve,mp=/run/lightnas-pve([,[:space:]]|$)' <<<"$config" | head -1 || true)"
  if [[ -n $legacy_mount_line ]]; then
    mount_slot="${legacy_mount_line%%:*}"
    mount_slot="${mount_slot#mp}"
  else
    for slot in $(seq 0 255); do
      if ! grep -q "^mp${slot}:" <<<"$config"; then mount_slot="$slot"; break; fi
    done
  fi
  [[ -n $mount_slot ]] || { echo 'No free Proxmox LXC mount-point slot is available for the LightNAS host bridge.' >&2; exit 1; }
fi

was_running=0
if [[ "$(pct status "$ctid")" == *'status: running'* ]]; then
  was_running=1
  pct exec "$ctid" -- install -d -m 0755 "$GUEST_BRIDGE_DIR"
fi

if [[ $feature_change -eq 1 || $mount_change -eq 1 ]]; then
  if [[ $was_running -eq 1 ]]; then
    echo "Stopping LXC $ctid to apply LightNAS runtime integration..."
    pct shutdown "$ctid" --timeout 60
    wait_for_stopped
  fi
  if [[ $feature_change -eq 1 ]]; then
    echo "Preparing LXC $ctid: features=$features"
    pct set "$ctid" -features "$features"
  fi
  if [[ $mount_change -eq 1 ]]; then
    echo "Adding LightNAS host bridge as mp${mount_slot}..."
    pct set "$ctid" "-mp${mount_slot}" "${HOST_BRIDGE_DIR},mp=${GUEST_BRIDGE_DIR}"
  fi
fi

if [[ "$(pct status "$ctid")" != *'status: running'* ]]; then
  echo "Starting LXC $ctid..."
  pct start "$ctid"
  wait_for_container
fi

guest_installer="$(mktemp)"
curl -fsSL "${RAW_BASE}/install.sh" -o "$guest_installer"
pct push "$ctid" "$guest_installer" /root/lightnas-install.sh
rm -f "$guest_installer"
pct exec "$ctid" -- chmod 0755 /root/lightnas-install.sh
pct exec "$ctid" -- bash /root/lightnas-install.sh

# Give the LightNAS service account access to data volumes intentionally mounted
# into standard NAS paths. ACLs add service access without changing ownership or
# recursively rewriting existing permissions. The host-bridge mount is excluded.
latest_config="$(pct config "$ctid")"
mapfile -t guest_data_mounts < <(sed -nE 's/^mp[0-9]+: .*mp=([^,]+).*/\1/p' <<<"$latest_config" | grep -E '^/(mnt|media|srv|data|storage)(/|$)' || true)
for guest_mount in "${guest_data_mounts[@]}"; do
  echo "Granting LightNAS managed access to ${guest_mount}..."
  pct exec "$ctid" -- bash -lc 'mount="$1"; if [[ -d "$mount" ]]; then setfacl -m u:lightnas:rwx "$mount" && setfacl -m d:u:lightnas:rwx "$mount"; fi' _ "$guest_mount" || \
    echo "Warning: unable to add LightNAS ACL on ${guest_mount}; it will remain browse-only." >&2
done

pct exec "$ctid" -- bash -lc "set -Eeuo pipefail
install -d -m 0755 /etc/lightnas
touch /etc/lightnas/runtime.env
chmod 0600 /etc/lightnas/runtime.env
sed -i '/^LIGHTNAS_PVE_\\(SOCKET\\|CLIENT_ID\\|SECRET\\)=/d' /etc/lightnas/runtime.env
printf '%s\\n' \\
  'LIGHTNAS_PVE_SOCKET=${GUEST_BRIDGE_DIR}/agent.sock' \\
  'LIGHTNAS_PVE_CLIENT_ID=${ctid}' \\
  'LIGHTNAS_PVE_SECRET=${secret}' >> /etc/lightnas/runtime.env
if grep -q '^VMs:' /var/lib/lightnas/runtime-status.txt 2>/dev/null; then
  sed -i 's|^VMs:.*|VMs: ready through automatic Proxmox host bridge|' /var/lib/lightnas/runtime-status.txt
else
  printf '%s\\n' 'VMs: ready through automatic Proxmox host bridge' >> /var/lib/lightnas/runtime-status.txt
fi
systemctl restart lightnas
"

systemctl is-active --quiet lightnas-proxmox-agent.service
pct exec "$ctid" -- test -S "${GUEST_BRIDGE_DIR}/agent.sock"
pct exec "$ctid" -- systemctl is-active --quiet lightnas

echo
printf 'LightNAS installation finished in LXC %s.\n' "$ctid"
echo 'Proxmox VM management is connected automatically; no API token setup is required.'
pct exec "$ctid" -- bash -lc 'echo "--- Runtime status ---"; cat /var/lib/lightnas/runtime-status.txt 2>/dev/null || true; echo "--- Service ---"; systemctl --no-pager --full is-active lightnas || true'
