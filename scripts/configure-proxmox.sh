#!/usr/bin/env bash
# Interactive, optional Proxmox API setup. Called during install on an LXC with a terminal.
set -Eeuo pipefail
settings=/etc/lightnas/runtime.env
if ! (: </dev/tty) 2>/dev/null || [[ -n "${LIGHTNAS_PVE_URL:-}" ]] || grep -q '^LIGHTNAS_PVE_URL=' "$settings" 2>/dev/null; then exit 0; fi
printf '\nVMs on an LXC need a Proxmox API connection. Press Enter to set one up, or type skip: ' >/dev/tty
IFS= read -r choice </dev/tty || exit 0
if [[ ${choice,,} == 'skip' ]]; then exit 0; fi
IFS= read -r -p 'Proxmox HTTPS URL (for example https://pve.example.com:8006): ' address </dev/tty || exit 0
[[ -n $address ]] || exit 0
IFS= read -r -p 'Proxmox node name (for example pve01): ' node </dev/tty || exit 0
IFS= read -r -p 'Dedicated API token ID (user@pve!token): ' token_id </dev/tty || exit 0
IFS= read -rs -p 'API token secret (input hidden): ' token_secret </dev/tty || exit 0
printf '\n' >/dev/tty
if [[ ! $address =~ ^https://[a-zA-Z0-9._:-]+/?$ || ! $node =~ ^[a-zA-Z0-9._-]+$ || ! $token_id =~ ^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$ || ! $token_secret =~ ^[a-zA-Z0-9-]+$ ]]; then
  echo 'Proxmox connection was not saved: invalid URL, node or token. LightNAS still runs.' >&2
  exit 0
fi
# Ensure the host certificate is trusted; do not silently disable TLS verification.
if ! curl -sS --max-time 8 -o /dev/null "${address%/}/api2/json/version"; then
  echo 'Proxmox certificate is not trusted or API is unreachable. Install the Proxmox CA certificate in this LXC, then rerun.' >&2
  exit 0
fi
install -d -m 0755 /etc/lightnas
touch "$settings"
chmod 0600 "$settings"
# Replace only the four integration variables; preserve other runtime settings.
sed -i '/^LIGHTNAS_PVE_\(URL\|NODE\|TOKEN_ID\|TOKEN_SECRET\)=/d' "$settings"
printf 'LIGHTNAS_PVE_URL=%s\nLIGHTNAS_PVE_NODE=%s\nLIGHTNAS_PVE_TOKEN_ID=%s\nLIGHTNAS_PVE_TOKEN_SECRET=%s\n' \
  "$address" "$node" "$token_id" "$token_secret" >>"$settings"
echo 'Proxmox API connection saved. LightNAS will verify token permissions when the VM page opens.'
