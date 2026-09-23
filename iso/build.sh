#!/usr/bin/env bash
set -Eeuo pipefail

# Build a Debian 13 amd64 LightNAS appliance ISO.
# The Debian installer asks which disk to use; no disk is preselected here.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${REPO_ROOT}/dist/LightNAS-amd64.iso}"
BUILD_DIR="${LIGHTNAS_ISO_BUILD_DIR:-${REPO_ROOT}/.iso-build}"

[[ "${EUID}" -eq 0 ]] || {
  echo 'Run as root on a Debian/Ubuntu build machine.' >&2
  exit 1
}

command -v lb >/dev/null || {
  echo 'Install live-build, debootstrap, xorriso, and squashfs-tools first.' >&2
  exit 1
}

[[ ! -e "${BUILD_DIR}" ]] || {
  echo "Build directory already exists: ${BUILD_DIR}" >&2
  exit 1
}

mkdir -p "${BUILD_DIR}" "$(dirname "${OUTPUT}")"
cd "${BUILD_DIR}"

echo "=== Configuring LightNAS Debian 13 live image ==="

lb config \
  --mode debian \
  --distribution trixie \
  --architectures amd64 \
  --binary-image iso-hybrid \
  --debian-installer live \
  --archive-areas 'main contrib non-free-firmware' \
  --security false \
  --linux-packages linux-image \
  --linux-flavours amd64

mkdir -p \
  config/package-lists \
  config/binary_debian-installer \
  config/includes.chroot/opt/lightnas \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants \
  config/includes.chroot/etc/apt/sources.list.d \
  config/includes.chroot/etc/modules-load.d \
  config/hooks/live

echo \
  'deb http://security.debian.org/debian-security trixie-security main contrib non-free-firmware' \
  >config/includes.chroot/etc/apt/sources.list.d/debian-security.list

#
# LightNAS base packages.
#
# IMPORTANT:
# linux-headers-amd64 + dkms + zfs-dkms are included so the ZFS module is
# compiled for the kernel that is actually installed inside the LightNAS ISO.
#
cat >config/package-lists/lightnas.list.chroot <<'EOF'
ca-certificates
curl
gnupg
git
systemd
openssh-server
util-linux
python3
ffmpeg
acl
novnc
iproute2
nftables
ufw
smartmontools

lxc
lxc-templates
lxcfs
uidmap
bridge-utils
debootstrap
debian-archive-keyring
zstd

qemu-system-x86
qemu-utils
libvirt-daemon-system
libvirt-clients
virtinst
ovmf

dnsmasq-base
network-manager
iw
rfkill
wpasupplicant

linux-headers-amd64
dkms
zfs-dkms
zfs-initramfs
zfsutils-linux
EOF

#
# Make ZFS available for normal LightNAS boots.
#
echo 'zfs' >config/includes.chroot/etc/modules-load.d/zfs.conf

#
# Include LightNAS application code.
#
cp -a \
  "${REPO_ROOT}/src" \
  "${REPO_ROOT}/public" \
  "${REPO_ROOT}/scripts" \
  "${REPO_ROOT}/package.json" \
  config/includes.chroot/opt/lightnas/

cp \
  "${REPO_ROOT}/iso/preseed.cfg" \
  config/binary_debian-installer/preseed.cfg

#
# First-boot host network bootstrap.
#
# Do not rely on network-online.target alone: a fresh Debian live/install image
# can reach that target with a detected Ethernet NIC but no active DHCP
# connection profile. LightNAS explicitly acquires the host LAN before guest
# runtime initialization.
#
cat >config/includes.chroot/etc/systemd/system/lightnas-network-bootstrap.service <<'EOF'
[Unit]
Description=Bring up the LightNAS appliance LAN
Wants=NetworkManager.service
After=NetworkManager.service
Before=lightnas-runtime-init.service lightnas-host-agent.service lightnas.service

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/lightnas/scripts/configure-appliance-network.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

#
# Runtime initialization service
#
cat >config/includes.chroot/etc/systemd/system/lightnas-runtime-init.service <<'EOF'
[Unit]
Description=Initialize LightNAS native runtime engines
Requires=lightnas-network-bootstrap.service
After=lightnas-network-bootstrap.service
Before=lightnas-host-agent.service lightnas.service

[Service]
Type=oneshot
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=LIGHTNAS_RUNTIME_STATUS_FILE=/var/lib/lightnas/runtime-status.txt
ExecStart=/bin/bash /opt/lightnas/scripts/provision-runtimes.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

#
# Privileged host agent
#
cat >config/includes.chroot/etc/systemd/system/lightnas-host-agent.service <<'EOF'
[Unit]
Description=LightNAS Privileged Local Host Agent
Wants=network-online.target
After=network-online.target lightnas-runtime-init.service

[Service]
Type=simple
User=root
Group=root
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=LIGHTNAS_HOST_SOCKET=/run/lightnas/host-agent.sock
ExecStart=/usr/bin/python3 /opt/lightnas/scripts/lightnas-host-agent.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=false
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

#
# LightNAS management service
#
cat >config/includes.chroot/etc/systemd/system/lightnas.service <<'EOF'
[Unit]
Description=LightNAS Management Control Plane
Wants=network-online.target lightnas-host-agent.service
After=network-online.target lightnas-host-agent.service

[Service]
User=lightnas
Group=lightnas
WorkingDirectory=/opt/lightnas
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=LIGHTNAS_HOST_SOCKET=/run/lightnas/host-agent.sock
Environment=NODE_ENV=production
Environment=NAS_HOST=0.0.0.0
Environment=NAS_PORT=3080
Environment=NAS_DATA_FILE=/var/lib/lightnas/state.json
ExecStart=/usr/bin/node /opt/lightnas/src/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=false
ProtectSystem=full
ReadWritePaths=/var/lib/lightnas

[Install]
WantedBy=multi-user.target
EOF

ln -s ../lightnas-network-bootstrap.service \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants/lightnas-network-bootstrap.service

ln -s ../lightnas-runtime-init.service \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants/lightnas-runtime-init.service

ln -s ../lightnas-host-agent.service \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants/lightnas-host-agent.service

ln -s ../lightnas.service \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants/lightnas.service

#
# LightNAS chroot configuration.
#
cat >config/hooks/live/0100-lightnas.hook.chroot <<'EOF'
#!/bin/bash
set -Eeuo pipefail

echo "=== LightNAS chroot configuration ==="

export DEBIAN_FRONTEND=noninteractive

install -d -m 0755 \
  /etc/apt/keyrings \
  /etc/lightnas \
  /run/lightnas

#
# Node.js 22
#
curl -fsSL \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

printf '%s\n' \
  'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  >/etc/apt/sources.list.d/nodesource.list

apt-get update
apt-get install -y nodejs

# Debian images do not need the ubuntu-keyring package to build LightNAS, but
# debootstrap must still be able to verify Ubuntu system-container releases.
ubuntu_candidate="$(apt-cache policy ubuntu-keyring 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
if [[ -n "$ubuntu_candidate" && "$ubuntu_candidate" != "(none)" ]]; then
  apt-get install -y ubuntu-keyring
else
  curl -fsSL https://archive.ubuntu.com/ubuntu/project/ubuntu-archive-keyring.gpg \
    -o /usr/share/keyrings/ubuntu-archive-keyring.gpg
  chmod 0644 /usr/share/keyrings/ubuntu-archive-keyring.gpg
fi

#
# LightNAS service account
#
if ! id lightnas >/dev/null 2>&1; then
  useradd \
    --system \
    --home-dir /var/lib/lightnas \
    --shell /usr/sbin/nologin \
    lightnas
fi

for group in libvirt kvm; do
  if getent group "$group" >/dev/null 2>&1; then
    usermod -aG "$group" lightnas
  fi
done

#
# LightNAS data locations
#
install -d \
  -o lightnas \
  -g lightnas \
  -m 0700 \
  /var/lib/lightnas \
  /var/lib/lightnas/files

install -d \
  -o lightnas \
  -g lightnas \
  -m 0770 \
  /var/lib/lightnas/storage \
  /var/lib/lightnas/storage/local

for vm_user in libvirt-qemu qemu; do
  if id "$vm_user" >/dev/null 2>&1; then
    setfacl -m "u:${vm_user}:rwx" \
      /var/lib/lightnas/storage \
      /var/lib/lightnas/storage/local || true

    setfacl -m "d:u:${vm_user}:rwx" \
      /var/lib/lightnas/storage \
      /var/lib/lightnas/storage/local || true
  fi
done

install -m 0600 /dev/null /etc/lightnas/runtime.env

#
# Install application dependencies.
#
npm \
  --prefix /opt/lightnas \
  install \
  --omit=dev \
  --no-audit \
  --no-fund

#
# ------------------------------------------------------------
# ZFS VALIDATION
# ------------------------------------------------------------
#
echo
echo "=== Verifying LightNAS ZFS kernel support ==="

ZFS_OK=0

for kdir in /lib/modules/*; do
  [ -d "$kdir" ] || continue

  kernel="$(basename "$kdir")"

  echo "Kernel found: ${kernel}"

  depmod -a "$kernel"

  if modinfo -k "$kernel" zfs >/dev/null 2>&1; then
    echo "ZFS module found for kernel ${kernel}"

    modinfo -k "$kernel" zfs |
      grep -E '^(filename|version|vermagic):' || true

    ZFS_OK=1
  else
    echo "ERROR: No ZFS module for kernel ${kernel}" >&2
  fi
done

if [ "$ZFS_OK" -ne 1 ]; then
  echo >&2
  echo "==================================================" >&2
  echo "LIGHTNAS ISO BUILD FAILED" >&2
  echo "ZFS kernel module was not built." >&2
  echo "The ISO will NOT be published." >&2
  echo "==================================================" >&2
  exit 1
fi

#
# Regenerate initramfs after ZFS/DKMS installation.
#
echo
echo "=== Rebuilding initramfs ==="

for kdir in /lib/modules/*; do
  [ -d "$kdir" ] || continue

  kernel="$(basename "$kdir")"

  echo "Updating initramfs for ${kernel}"

  update-initramfs -u -k "$kernel"
done

#
# NetworkManager is the LightNAS host networking engine.
#
systemctl enable NetworkManager.service >/dev/null 2>&1 || true

#
# Native system containers.
#
# Do not start the private 10.77 bridge preemptively. Runtime provisioning
# enables it only for an explicit compatibility/NAT mode after host LAN setup.
systemctl disable lxc-net.service >/dev/null 2>&1 || true

#
# Native VM runtime.
#
if systemctl list-unit-files libvirtd.socket >/dev/null 2>&1; then
  systemctl enable libvirtd.socket >/dev/null 2>&1 || true
fi

echo
echo "=== LightNAS chroot configuration complete ==="
EOF

chmod 755 config/hooks/live/0100-lightnas.hook.chroot

#
# Build ISO.
#
echo
echo "=================================================="
echo "Building LightNAS ISO"
echo "=================================================="

lb build

#
# Verify the final SquashFS actually contains ZFS.
#
echo
echo "=== Verifying final LightNAS filesystem ==="

SQUASHFS="binary/live/filesystem.squashfs"

if [[ ! -f "${SQUASHFS}" ]]; then
  echo "ERROR: ${SQUASHFS} was not created." >&2
  exit 1
fi

if ! unsquashfs -l "${SQUASHFS}" |
  grep -Eq '/lib/modules/.*/(updates/dkms/)?zfs\.ko(\.(xz|zst|gz))?$'; then

  echo >&2
  echo "==================================================" >&2
  echo "LIGHTNAS ISO BUILD FAILED" >&2
  echo "Final filesystem does NOT contain zfs.ko" >&2
  echo "ISO will not be published." >&2
  echo "==================================================" >&2

  exit 1
fi

echo "ZFS module confirmed inside final LightNAS filesystem."

#
# Find resulting ISO.
#
ISO="$(find . -maxdepth 1 -name '*.iso' -type f -print -quit)"

[[ -n "${ISO}" ]] || {
  echo 'Build did not produce an ISO.' >&2
  exit 1
}

#
# Copy final artifact.
#
cp "${ISO}" "${OUTPUT}"

#
# SHA256 checksum.
#
sha256sum "${OUTPUT}" >"${OUTPUT}.sha256"

echo
echo "=================================================="
echo "LightNAS ISO build SUCCESSFUL"
echo "=================================================="
echo
echo "ISO:"
echo "${OUTPUT}"
echo
echo "SHA256:"
cat "${OUTPUT}.sha256"
