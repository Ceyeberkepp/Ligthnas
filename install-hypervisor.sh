#!/usr/bin/env bash
set -Eeuo pipefail

# Install the dedicated LightNAS Hypervisor edition from the same repository.
# This is a separate appliance install: it boots directly into Hypervisor UI
# and does not expose the NAS/Hypervisor workspace switch.
export LIGHTNAS_PRODUCT_MODE=hypervisor
export LIGHTNAS_INSTALL_DIRECTORY="${LIGHTNAS_INSTALL_DIRECTORY:-/opt/lightnas}"
export LIGHTNAS_DATA_DIRECTORY="${LIGHTNAS_DATA_DIRECTORY:-/var/lib/lightnas}"

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install.sh -o "${tmp}"
bash "${tmp}"

install -d -m 0750 /etc/lightnas
cat >/etc/lightnas/product-mode.env <<'EOF'
LIGHTNAS_PRODUCT_MODE=hypervisor
EOF
chmod 0644 /etc/lightnas/product-mode.env

if [[ -f /etc/systemd/system/lightnas.service ]]; then
  install -d /etc/systemd/system/lightnas.service.d
  cat >/etc/systemd/system/lightnas.service.d/product-mode.conf <<'EOF'
[Service]
Environment=LIGHTNAS_PRODUCT_MODE=hypervisor
EOF
  systemctl daemon-reload
  systemctl restart lightnas
fi

echo
echo "LightNAS Hypervisor edition installed."
echo "This installation starts directly in the dedicated Hypervisor interface."
