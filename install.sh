#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="${LIGHTNAS_REPOSITORY_URL:-https://github.com/Ceyeberkepp/Ligthnas.git}"
INSTALL_DIRECTORY="${LIGHTNAS_INSTALL_DIRECTORY:-/opt/lightnas}"
DATA_DIRECTORY="${LIGHTNAS_DATA_DIRECTORY:-/var/lib/lightnas}"
SERVICE_NAME="lightnas"
EXISTING_INSTALL=0
[[ -d "${INSTALL_DIRECTORY}/.git" ]] && EXISTING_INSTALL=1
APT_UPDATED=0

apt_update_once() {
  if [[ "${APT_UPDATED}" != "1" ]]; then
    apt-get update
    APT_UPDATED=1
  fi
}

package_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q '^install ok installed$'
}

install_missing_packages() {
  local missing=() package
  for package in "$@"; do
    package_installed "$package" || missing+=("$package")
  done
  if [[ "${#missing[@]}" -eq 0 ]]; then
    return 0
  fi
  apt_update_once
  echo "      Installing missing packages: ${missing[*]}"
  apt-get install -y --no-install-recommends "${missing[@]}"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root: curl ... | sudo bash" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently supports Debian and Ubuntu systems." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/6] Checking system requirements..."
install_missing_packages \
  ca-certificates curl git gnupg python3 ffmpeg imagemagick qrencode acl novnc iproute2 nftables ufw \
  tar gzip xz-utils zstd

if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" -lt 22 ]]; then
  echo "[2/6] Installing Node.js 22..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  cat >/etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main
EOF
  APT_UPDATED=0
  apt_update_once
  apt-get install -y --no-install-recommends nodejs
else
  echo "[2/6] Node.js $(node --version) is already installed."
fi

# System containers are a built-in LightNAS feature on every supported host.
# Install the LXC and bridge stack unconditionally so a new installation is
# ready to create containers with real LAN addresses without an extra setup
# flag. If LightNAS itself is nested, the host-agent will detect whether the
# outer environment permits nested namespaces/bridging and use NAT only as a
# compatibility fallback.
echo "      Installing native system-container engine and network bridge tools..."
runtime_packages=(
  lxc lxc-templates lxcfs uidmap bridge-utils debootstrap
  dnsmasq-base network-manager
)

# Archive-signing keyrings are distribution packages. apt-cache show can
# return metadata even when APT has no installable Candidate, so check the
# policy Candidate explicitly before adding an optional package.
apt_has_candidate() {
  local candidate
  candidate="$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
  [[ -n "$candidate" && "$candidate" != "(none)" ]]
}

for keyring in debian-archive-keyring ubuntu-keyring; do
  if apt_has_candidate "$keyring"; then
    runtime_packages+=("$keyring")
  else
    echo "      Optional package $keyring has no installable APT candidate; continuing."
  fi
done

# LibRaw improves camera RAW previews. Keep it optional so an architecture
# whose repository does not carry the package can still install LightNAS.
if apt_has_candidate libraw-bin; then
  runtime_packages+=(libraw-bin)
fi

install_missing_packages "${runtime_packages[@]}"

# Debian repositories do not always carry the ubuntu-keyring package, but
# LightNAS offers Ubuntu system-container images as well as Debian images.
# Install Ubuntu's official archive keyring directly when the package has no
# installable Candidate so debootstrap can still verify Ubuntu releases.
if ! apt_has_candidate ubuntu-keyring; then
  install -d -m 0755 /usr/share/keyrings
  if [[ ! -s /usr/share/keyrings/ubuntu-archive-keyring.gpg ]]; then
    echo "      Installing Ubuntu archive keyring for Ubuntu container images..."
    curl -fsSL https://archive.ubuntu.com/ubuntu/project/ubuntu-archive-keyring.gpg \
      -o /usr/share/keyrings/ubuntu-archive-keyring.gpg
    chmod 0644 /usr/share/keyrings/ubuntu-archive-keyring.gpg
  fi
fi

# VM tooling is also installed on normal hosts. Nested appliances may opt in
# when their outer hypervisor exposes the required virtualization features.
if ! systemd-detect-virt --container >/dev/null 2>&1 || [[ "${LIGHTNAS_ENABLE_NESTED_RUNTIMES:-0}" == "1" ]]; then
  echo "      Checking native VM engine..."
  install_missing_packages \
    qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst ovmf
fi

echo "[3/6] Installing LightNAS..."
if [[ -d "${INSTALL_DIRECTORY}/.git" ]]; then
  git -C "${INSTALL_DIRECTORY}" pull --ff-only
elif [[ -e "${INSTALL_DIRECTORY}" ]]; then
  echo "Refusing to overwrite existing non-Git path: ${INSTALL_DIRECTORY}" >&2
  exit 1
else
  git clone --depth 1 "${REPOSITORY_URL}" "${INSTALL_DIRECTORY}"
fi

# Install production dependencies only when package-lock.json changed or the
# dependency tree is missing. Ordinary source-only upgrades skip npm entirely.
install -d -m 0700 "${DATA_DIRECTORY}"
npm_stamp="${DATA_DIRECTORY}/.package-lock.sha256"
lock_hash=""
[[ -f "${INSTALL_DIRECTORY}/package-lock.json" ]] && lock_hash="$(sha256sum "${INSTALL_DIRECTORY}/package-lock.json" | awk '{print $1}')"
installed_hash="$(cat "${npm_stamp}" 2>/dev/null || true)"
if [[ ! -d "${INSTALL_DIRECTORY}/node_modules/ws" || ! -d "${INSTALL_DIRECTORY}/node_modules/@xterm/xterm" || "${lock_hash}" != "${installed_hash}" ]]; then
  echo "      Installing changed Node.js dependencies..."
  npm --prefix "${INSTALL_DIRECTORY}" install --omit=dev --no-audit --no-fund --prefer-offline
  [[ -n "${lock_hash}" ]] && printf '%s\n' "${lock_hash}" >"${npm_stamp}"
else
  echo "      Node.js dependencies unchanged; skipping npm install."
fi

echo "[4/6] Creating the service account and persistent storage..."
if ! id lightnas >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIRECTORY}" --shell /usr/sbin/nologin lightnas
fi
for group in libvirt kvm; do
  getent group "${group}" >/dev/null 2>&1 && usermod -aG "${group}" lightnas || true
done
install -d -o lightnas -g lightnas -m 0700 "${DATA_DIRECTORY}"
install -d -o lightnas -g lightnas -m 0700 "${DATA_DIRECTORY}/files"
install -d -o lightnas -g lightnas -m 0770 "${DATA_DIRECTORY}/storage" "${DATA_DIRECTORY}/storage/local"
for vm_user in libvirt-qemu qemu; do
  if id "$vm_user" >/dev/null 2>&1; then
    # QEMU must be able to traverse the private LightNAS data root before it
    # can reach VM disks/ISOs underneath storage. Do not grant access to state,
    # credentials, or the Files library.
    setfacl -m "u:${vm_user}:--x" "${DATA_DIRECTORY}" || true
    setfacl -m "u:${vm_user}:rwx" "${DATA_DIRECTORY}/storage" "${DATA_DIRECTORY}/storage/local" || true
    setfacl -m "d:u:${vm_user}:rwx" "${DATA_DIRECTORY}/storage" "${DATA_DIRECTORY}/storage/local" || true
  fi
done

RUNTIME_PROVISION_NEEDED=0
if [[ "${EXISTING_INSTALL}" == "0" || ! -s "${DATA_DIRECTORY}/runtime-status.txt" || "${LIGHTNAS_REPAIR_RUNTIMES:-0}" == "1" ]]; then
  RUNTIME_PROVISION_NEEDED=1
  echo "      Runtime engines will finish provisioning in the background after the control panel starts."
else
  echo "      Existing runtime configuration detected; skipping slow reprovisioning."
  echo "      Set LIGHTNAS_REPAIR_RUNTIMES=1 to force container/VM/app runtime repair."
fi
[[ -e "${DATA_DIRECTORY}/runtime-status.txt" ]] && chown lightnas:lightnas "${DATA_DIRECTORY}/runtime-status.txt"

chown -R root:root "${INSTALL_DIRECTORY}"

echo "[5/6] Installing the systemd services..."
install -d -m 0755 /run/lightnas
cat >/etc/systemd/system/lightnas-host-agent.service <<EOF
[Unit]
Description=LightNAS Privileged Local Host Agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
Group=root
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=LIGHTNAS_HOST_SOCKET=/run/lightnas/host-agent.sock
ExecStart=/usr/bin/python3 ${INSTALL_DIRECTORY}/scripts/lightnas-host-agent.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=false
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=LightNAS Management Control Plane
Wants=network-online.target lightnas-host-agent.service
After=network-online.target lightnas-host-agent.service

[Service]
Type=simple
User=lightnas
Group=lightnas
WorkingDirectory=${INSTALL_DIRECTORY}
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=LIGHTNAS_HOST_SOCKET=/run/lightnas/host-agent.sock
Environment=NODE_ENV=production
Environment=NAS_HOST=0.0.0.0
Environment=NAS_PORT=3080
Environment=NAS_DATA_FILE=${DATA_DIRECTORY}/state.json
ExecStart=/usr/bin/node ${INSTALL_DIRECTORY}/src/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=false
ProtectSystem=full
# /usr, /boot and /etc stay read-only; explicitly attached NAS mounts remain usable.
ReadWritePaths=${DATA_DIRECTORY}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable lightnas-host-agent.service
systemctl restart lightnas-host-agent.service
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

if [[ "${RUNTIME_PROVISION_NEEDED}" == "1" ]]; then
  echo "      Starting container, VM, and App Store provisioning in the background..."
  systemd-run --unit=lightnas-runtime-bootstrap --collect --no-block \
    --property=Type=oneshot \
    --setenv="LIGHTNAS_RUNTIME_STATUS_FILE=${DATA_DIRECTORY}/runtime-status.txt" \
    /bin/bash -lc "bash '${INSTALL_DIRECTORY}/scripts/provision-runtimes.sh'; chown lightnas:lightnas '${DATA_DIRECTORY}/runtime-status.txt' 2>/dev/null || true" \
    >/dev/null
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 3080/tcp >/dev/null
fi

echo "[6/6] Verifying LightNAS..."
for attempt in {1..15}; do
  if curl -fsS http://127.0.0.1:3080/api/status >/dev/null 2>&1; then
    address="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo
    echo "LightNAS installation completed. Runtime results:"
    cat "${DATA_DIRECTORY}/runtime-status.txt"
    echo "Open: http://${address:-SERVER-IP}:3080"
    exit 0
  fi
  sleep 1
done

echo "LightNAS did not pass its health check." >&2
systemctl status "${SERVICE_NAME}" --no-pager --full >&2 || true
journalctl -u "${SERVICE_NAME}" -n 50 --no-pager >&2 || true
exit 1
