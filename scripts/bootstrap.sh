#!/usr/bin/env bash
# Universal LightNAS bootstrap.
# - Proxmox VE node: provide CTID and this prepares/installs into that existing LXC.
# - Debian/Ubuntu VM, LXC, or bare metal: installs LightNAS locally.
set -Eeuo pipefail

RAW_BASE="${LIGHTNAS_RAW_BASE:-https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main}"
ctid="${1:-${LIGHTNAS_CTID:-}}"

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run LightNAS bootstrap as root (or with sudo).' >&2
  exit 1
fi

if [[ -d /etc/pve ]] && command -v pct >/dev/null 2>&1; then
  if [[ ! $ctid =~ ^[1-9][0-9]{1,5}$ ]]; then
    echo 'Proxmox VE node detected.' >&2
    echo 'Provide the existing LightNAS LXC CTID.' >&2
    echo 'Example: bash /root/lightnas-bootstrap.sh 170' >&2
    exit 1
  fi
  helper="$(mktemp)"
  trap 'rm -f "$helper"' EXIT
  curl -fsSL "${RAW_BASE}/scripts/proxmox-lxc-install.sh" -o "$helper"
  bash "$helper" "$ctid"
  exit 0
fi

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -fsSL "${RAW_BASE}/install.sh" -o "$installer"
bash "$installer"
