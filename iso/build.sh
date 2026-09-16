#!/usr/bin/env bash
set -Eeuo pipefail

# Build a Debian 13 amd64 live ISO with the interactive Debian installer.
# The installer asks which disk to use; no disk is preselected or formatted by this script.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${REPO_ROOT}/dist/LightNAS-amd64.iso}"
BUILD_DIR="${LIGHTNAS_ISO_BUILD_DIR:-${REPO_ROOT}/.iso-build}"
[[ "${EUID}" -eq 0 ]] || { echo 'Run as root on a Debian/Ubuntu build machine.' >&2; exit 1; }
command -v lb >/dev/null || { echo 'Install live-build, debootstrap, xorriso, and squashfs-tools first.' >&2; exit 1; }
[[ ! -e "${BUILD_DIR}" ]] || { echo "Build directory already exists: ${BUILD_DIR}" >&2; exit 1; }
mkdir -p "${BUILD_DIR}" "$(dirname "${OUTPUT}")"
cd "${BUILD_DIR}"
lb config --mode debian --distribution trixie --architectures amd64 --binary-image iso-hybrid \
  --debian-installer live --archive-areas 'main contrib non-free-firmware' --security false \
  --linux-packages linux-image --linux-flavours amd64

mkdir -p config/package-lists config/includes.chroot/opt/lightnas \
  config/includes.chroot/etc/systemd/system/multi-user.target.wants \
  config/includes.chroot/etc/apt/sources.list.d \
  config/hooks/live
echo 'deb http://security.debian.org/debian-security trixie-security main contrib non-free-firmware' \
  >config/includes.chroot/etc/apt/sources.list.d/debian-security.list
cat >config/package-lists/lightnas.list.chroot <<'EOF'
ca-certificates curl gnupg git systemd openssh-server util-linux python3 ffmpeg
EOF
cp -a "${REPO_ROOT}/src" "${REPO_ROOT}/public" "${REPO_ROOT}/package.json" \
  config/includes.chroot/opt/lightnas/
cat >config/includes.chroot/etc/systemd/system/lightnas.service <<'EOF'
[Unit]
Description=LightNAS Management Control Plane
After=network-online.target
Wants=network-online.target

[Service]
User=lightnas
Group=lightnas
WorkingDirectory=/opt/lightnas
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=NODE_ENV=production
Environment=NAS_HOST=0.0.0.0
Environment=NAS_PORT=3080
Environment=NAS_DATA_FILE=/var/lib/lightnas/state.json
ExecStart=/usr/bin/node /opt/lightnas/src/server.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/lightnas

[Install]
WantedBy=multi-user.target
EOF
ln -s ../lightnas.service config/includes.chroot/etc/systemd/system/multi-user.target.wants/lightnas.service
cat >config/hooks/live/0100-lightnas.hook.chroot <<'EOF'
#!/bin/sh
set -eu
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
useradd --system --home-dir /var/lib/lightnas --shell /usr/sbin/nologin lightnas
install -d -o lightnas -g lightnas -m 0700 /var/lib/lightnas
EOF
chmod 755 config/hooks/live/0100-lightnas.hook.chroot
lb build
ISO="$(find . -maxdepth 1 -name '*.iso' -type f -print -quit)"
[[ -n "${ISO}" ]] || { echo 'Build did not produce an ISO.' >&2; exit 1; }
cp "${ISO}" "${OUTPUT}"
sha256sum "${OUTPUT}" >"${OUTPUT}.sha256"
echo "Built ${OUTPUT}"
