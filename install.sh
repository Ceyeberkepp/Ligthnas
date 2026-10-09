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

LIGHTNAS_ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "${LIGHTNAS_ARCH}" in
  x86_64) LIGHTNAS_ARCH=amd64 ;;
  aarch64) LIGHTNAS_ARCH=arm64 ;;
  i386|i486|i586|i686) LIGHTNAS_ARCH=i386 ;;
  armv7l|armv6l) LIGHTNAS_ARCH=armhf ;;
esac
if [[ "${LIGHTNAS_ARCH}" != "amd64" && "${LIGHTNAS_ALLOW_UNVALIDATED_ARCH:-0}" != "1" ]]; then
  echo "LightNAS detected architecture ${LIGHTNAS_ARCH}. This architecture is an engineering target but is not release-qualified yet." >&2
  echo "Validated installer architecture: amd64. Set LIGHTNAS_ALLOW_UNVALIDATED_ARCH=1 only for development testing." >&2
  exit 1
fi
echo "Detected LightNAS architecture: ${LIGHTNAS_ARCH}"

echo "[1/6] Checking system requirements..."
install_missing_packages \
  ca-certificates curl git gnupg python3 ffmpeg imagemagick qrencode acl novnc iproute2 nftables ufw samba openssh-server ovmf \
  tar gzip xz-utils zstd

# Node.js and npm are both mandatory. Some minimal images have node but no
# npm; do not skip the dependency installation in that case.
node_major=0
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null || true)"
  [[ "$node_version" =~ ^v([0-9]+)\. ]] && node_major="${BASH_REMATCH[1]}"
fi
if (( node_major < 22 )) || ! command -v npm >/dev/null 2>&1; then
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
  echo "[2/6] Node.js $(node --version) and npm $(npm --version) are already installed."
fi

# Fail early if an image ships broken executables or an incomplete Node.js
# installation. Install npm separately where the distribution splits it out.
for tool in curl git node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: Required installer tool missing: $tool" >&2
    exit 1
  fi
done
if ! npm --version >/dev/null 2>&1; then
  echo "ERROR: npm is installed but cannot execute." >&2
  exit 1
fi
if ! curl --version >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  echo "ERROR: curl or git is installed but cannot execute." >&2
  exit 1
fi
echo "      Verified: curl $(curl --version | head -n 1), git $(git --version), node $(node --version), npm $(npm --version)"

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
  # Never report a successful update if fetching/pulling failed.
  git -C "${INSTALL_DIRECTORY}" rev-parse --is-inside-work-tree >/dev/null
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
  if [[ -f "${INSTALL_DIRECTORY}/package-lock.json" ]]; then
    npm --prefix "${INSTALL_DIRECTORY}" ci --omit=dev --no-audit --no-fund --prefer-offline
  else
    npm --prefix "${INSTALL_DIRECTORY}" install --omit=dev --no-audit --no-fund --prefer-offline
  fi
  [[ -n "${lock_hash}" ]] && printf '%s\n' "${lock_hash}" >"${npm_stamp}"
else
  echo "      Node.js dependencies unchanged; skipping npm install."
fi

# Do not silently skip broken or incomplete dependency trees on updates.
node -e 'for(const name of ["ws","@xterm/xterm","@xterm/addon-fit"]) require.resolve(name,{paths:[process.argv[1]]})' "${INSTALL_DIRECTORY}"
echo "      Node.js production dependencies verified."

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
install -d -o root -g lightnas -m 0750 /etc/lightnas
cat >/etc/lightnas/platform.env <<EOF
LIGHTNAS_ARCH=${LIGHTNAS_ARCH}
LIGHTNAS_PLATFORM_VALIDATED=$([[ "${LIGHTNAS_ARCH}" == "amd64" ]] && echo 1 || echo 0)
EOF
chown root:lightnas /etc/lightnas/platform.env
chmod 0640 /etc/lightnas/platform.env

# On a fresh interactive install, enumerate real physical Ethernet and Wi-Fi
# adapters and let the administrator choose the management uplink. Existing
# installs keep their saved choice unless LIGHTNAS_RESELECT_UPLINK=1 is set.
select_lightnas_uplink() {
  local choice_file=/etc/lightnas/network-choice.env
  [[ "${EXISTING_INSTALL}" == "0" || "${LIGHTNAS_RESELECT_UPLINK:-0}" == "1" ]] || return 0
  [[ -t 0 && -t 1 ]] || return 0

  local -a devices=()
  local path name type carrier ipv4 state
  echo
  echo "=== LightNAS management network ==="
  while IFS= read -r path; do
    [[ -e "${path}" ]] || continue
    name="$(basename "${path}")"
    [[ "${name}" == "lo" || "${name}" =~ ^(docker|virbr|br-|veth|tap|tun|lightnas|lxcbr) ]] && continue
    [[ "$(cat "${path}/type" 2>/dev/null || true)" == "1" ]] || continue
    if [[ -d "${path}/wireless" ]]; then type="Wi-Fi"; else type="Ethernet"; fi
    carrier="$(cat "${path}/carrier" 2>/dev/null || true)"
    ipv4="$(ip -4 -o addr show dev "${name}" scope global 2>/dev/null | awk 'NR==1{print $4}')"
    state="$(cat "${path}/operstate" 2>/dev/null || true)"
    devices+=("${name}")
    printf '  %d) %-14s %-8s link=%-8s IPv4=%s\n' "${#devices[@]}" "${name}" "${type}" "${carrier:-${state:-unknown}}" "${ipv4:-none}"
  done < <(find /sys/class/net -mindepth 1 -maxdepth 1 -type l -print | sort)

  if [[ "${#devices[@]}" -eq 0 ]]; then
    echo "No physical Ethernet or Wi-Fi interfaces were detected; LightNAS will use automatic network discovery."
    return 0
  fi

  local default_dev selected answer
  default_dev="$(ip -4 route show default 2>/dev/null | awk 'NR==1{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
  selected=""
  if [[ "${#devices[@]}" -eq 1 ]]; then
    selected="${devices[0]}"
    echo "Using the only detected management interface: ${selected}"
  else
    local default_index=1 i
    for i in "${!devices[@]}"; do
      [[ "${devices[$i]}" == "${default_dev}" ]] && default_index=$((i+1))
    done
    read -r -p "Choose the LightNAS management interface [${default_index}]: " answer
    answer="${answer:-${default_index}}"
    if [[ "${answer}" =~ ^[0-9]+$ ]] && (( answer >= 1 && answer <= ${#devices[@]} )); then
      selected="${devices[$((answer-1))]}"
    else
      echo "Invalid selection; keeping ${devices[$((default_index-1))]}."
      selected="${devices[$((default_index-1))]}"
    fi
  fi

  printf 'LIGHTNAS_UPLINK_PREFERENCE=%s\n' "${selected}" >"${choice_file}"
  chown root:lightnas "${choice_file}"
  chmod 0640 "${choice_file}"

  # If Wi-Fi was selected and is not connected, allow an interactive fresh
  # install to establish the connection without ever writing the password to
  # the LightNAS configuration files.
  if [[ -d "/sys/class/net/${selected}/wireless" ]] && command -v nmcli >/dev/null 2>&1; then
    if ! nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep -Eq "^${selected}:(connected|connecting)$"; then
      echo
      nmcli device wifi rescan ifname "${selected}" >/dev/null 2>&1 || true
      nmcli -f IN-USE,SSID,SIGNAL,SECURITY device wifi list ifname "${selected}" 2>/dev/null | head -20 || true
      local ssid wifi_password
      read -r -p "Wi-Fi SSID for ${selected} (leave blank to configure later): " ssid
      if [[ -n "${ssid}" ]]; then
        read -r -s -p "Wi-Fi password: " wifi_password
        echo
        nmcli device wifi connect "${ssid}" ifname "${selected}" password "${wifi_password}" >/dev/null
        unset wifi_password
      fi
    fi
  fi
}

select_lightnas_uplink
if [[ ! -e /etc/lightnas/feature-gates.json ]]; then
  cat >/etc/lightnas/feature-gates.json <<'EOF'
{
  "edition": "community-preview",
  "enforce": false,
  "features": {
    "advanced-backups": true,
    "replication": true,
    "multi-node": true,
    "enterprise-storage": true,
    "sso": true,
    "audit-export": true,
    "advanced-analytics": true,
    "priority-support": true,
    "branding": true,
    "gpu-passthrough": true
  }
}
EOF
  chown root:lightnas /etc/lightnas/feature-gates.json
  chmod 0640 /etc/lightnas/feature-gates.json
fi
if [[ ! -e /etc/lightnas/license.env ]]; then
  cat >/etc/lightnas/license.env <<'EOF'
# Future LightNAS Pro/Enterprise verification.
# Set the HTTPS verification endpoint when your licensing/auth server is ready.
LIGHTNAS_LICENSE_SERVER_URL=
LIGHTNAS_LICENSE_PUBLIC_KEY_FILE=/etc/lightnas/license-public.pem
EOF
  chown root:lightnas /etc/lightnas/license.env
  chmod 0640 /etc/lightnas/license.env
fi
if [[ ! -e /etc/lightnas/sms.env ]]; then
  cat >/etc/lightnas/sms.env <<'EOF'
# Central LightNAS SMS verification service.
# These values are provisioned for the appliance by the LightNAS service operator.
# End users do not need Twilio, carrier, or modem credentials.
LIGHTNAS_SMS_GATEWAY_URL=
LIGHTNAS_SMS_GATEWAY_TOKEN=
EOF
  chown root:lightnas /etc/lightnas/sms.env
  chmod 0640 /etc/lightnas/sms.env
fi
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
if [[ -r /etc/lightnas/network.env ]] && grep -q '^LIGHTNAS_NETWORK_MODE=lxc-nat$' /etc/lightnas/network.env; then
  RUNTIME_PROVISION_NEEDED=1
  echo "      Existing private container NAT detected; scheduling automatic migration to the LightNAS host LAN."
fi
if [[ "${EXISTING_INSTALL}" == "0" || ! -s "${DATA_DIRECTORY}/runtime-status.txt" || "${LIGHTNAS_REPAIR_RUNTIMES:-0}" == "1" || "${RUNTIME_PROVISION_NEEDED}" == "1" ]]; then
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
cat >/etc/systemd/system/lightnas-network-bootstrap.service <<EOF
[Unit]
Description=LightNAS automatic host LAN configuration
Wants=network-online.target
After=network-online.target
Before=lightnas-host-agent.service ${SERVICE_NAME}.service

[Service]
Type=oneshot
ExecStart=/bin/bash ${INSTALL_DIRECTORY}/scripts/configure-appliance-network.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/lightnas-host-agent.service <<EOF
[Unit]
Description=LightNAS Privileged Local Host Agent
Wants=network-online.target lightnas-network-bootstrap.service
After=network-online.target lightnas-network-bootstrap.service

[Service]
Type=simple
User=root
Group=root
EnvironmentFile=-/etc/lightnas/runtime.env
EnvironmentFile=-/etc/lightnas/license.env
Environment=LIGHTNAS_HOST_SOCKET=/run/lightnas/host-agent.sock
ExecStart=/usr/bin/python3 ${INSTALL_DIRECTORY}/scripts/lightnas-host-agent.py
Restart=on-failure
RestartSec=3
MemoryHigh=100M
MemoryMax=128M
TasksMax=512
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
EnvironmentFile=-/etc/lightnas/license.env
EnvironmentFile=-/etc/lightnas/sms.env
Environment=LIGHTNAS_HOST_SOCKET=/run/lightnas/host-agent.sock
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=256
Environment=NAS_HOST=0.0.0.0
Environment=NAS_PORT=3080
Environment=NAS_DATA_FILE=${DATA_DIRECTORY}/state.json
ExecStart=/usr/bin/node ${INSTALL_DIRECTORY}/src/server.mjs
Restart=on-failure
RestartSec=5
MemoryHigh=300M
MemoryMax=384M
TasksMax=1024
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=false
ProtectSystem=full
# /usr, /boot and /etc stay read-only; explicitly attached NAS mounts remain usable.
ReadWritePaths=${DATA_DIRECTORY}

[Install]
WantedBy=multi-user.target
EOF

install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/lightnas-limits.conf <<'EOF'
[Journal]
SystemMaxUse=128M
RuntimeMaxUse=64M
MaxRetentionSec=7day
EOF

systemctl daemon-reload
systemctl try-restart systemd-journald.service >/dev/null 2>&1 || true
systemctl enable lightnas-network-bootstrap.service
if [[ "${EXISTING_INSTALL}" == "0" || "${LIGHTNAS_REPAIR_NETWORK:-0}" == "1" ]]; then
  echo "      Applying LightNAS network bootstrap..."
  systemctl restart lightnas-network-bootstrap.service || true
else
  echo "      Existing network configuration detected; skipping live network changes during update."
  echo "      Set LIGHTNAS_REPAIR_NETWORK=1 only when an administrator explicitly wants network repair."
fi
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