#!/usr/bin/env bash
set -Eeuo pipefail

# Build a Debian 13 amd64 LightNAS appliance ISO.
# The Debian installer asks which disk to use; no disk is preselected here.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${REPO_ROOT}/dist/LightNAS-amd64.iso}"
BUILD_DIR="${LIGHTNAS_ISO_BUILD_DIR:-${REPO_ROOT}/.iso-build}"
LIGHTNAS_ISO_CLEAN="${LIGHTNAS_ISO_CLEAN:-1}"

[[ "${EUID}" -eq 0 ]] || {
  echo 'Run as root on a Debian/Ubuntu build machine.' >&2
  exit 1
}

BUILD_PACKAGES=(live-build debootstrap xorriso squashfs-tools rsync dosfstools mtools isolinux syslinux-common grub-pc-bin grub-efi-amd64-bin librsvg2-bin)
missing_build_tools=0
for tool in lb debootstrap xorriso unsquashfs rsvg-convert; do
  command -v "$tool" >/dev/null 2>&1 || missing_build_tools=1
done
if [[ "$missing_build_tools" -eq 1 ]]; then
  echo '=== Installing LightNAS ISO build dependencies ==='
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${BUILD_PACKAGES[@]}"
fi

if [[ -e "${BUILD_DIR}" ]]; then
  if [[ "${LIGHTNAS_ISO_CLEAN}" == "1" ]]; then
    echo "=== Removing previous LightNAS ISO build directory ==="
    rm -rf -- "${BUILD_DIR}"
  else
    echo "Build directory already exists: ${BUILD_DIR}" >&2
    echo "Set LIGHTNAS_ISO_CLEAN=1 to rebuild from a clean generated directory." >&2
    exit 1
  fi
fi

mkdir -p "${BUILD_DIR}" "$(dirname "${OUTPUT}")"
cd "${BUILD_DIR}"

# Stage the Debian Installer preseed before lb config. live-build detects this
# file while configuring the installer and automatically wires it into the
# installer boot parameters. Staging it later can leave the file on the ISO
# without actually applying the LightNAS partition recipe.
mkdir -p config/binary_debian-installer
cp "${REPO_ROOT}/iso/preseed.cfg" config/binary_debian-installer/preseed.cfg

echo "=== Configuring LightNAS Debian 13 live image ==="

lb config \
  --mode debian \
  --distribution trixie \
  --architectures amd64 \
  --binary-image iso-hybrid \
  --bootloaders 'syslinux,grub-efi' \
  --debian-installer live \
  --debian-installer-gui true \
  --debian-installer-preseedfile preseed.cfg \
  --firmware-binary true \
  --firmware-chroot true \
  --uefi-secure-boot auto \
  --iso-application 'LightNAS' \
  --iso-preparer 'LightNAS ISO Builder' \
  --iso-publisher 'Cyverax LLC' \
  --iso-volume 'LIGHTNAS' \
  --bootappend-live 'boot=live components quiet splash hostname=lightnas' \
  --archive-areas 'main contrib non-free-firmware' \
  --security false \
  --linux-packages linux-image \
  --linux-flavours amd64 \
  --compression xz

# Brand both BIOS and UEFI boot menus as LightNAS.
# live-build ships known-good bootloader templates for the installed version;
# copy those templates rather than maintaining fragile bootloader configs here.
if [[ -d /usr/share/live/build/bootloaders ]]; then
  rm -rf config/bootloaders
  cp -a /usr/share/live/build/bootloaders config/bootloaders

  cat >"${BUILD_DIR}/lightnas-splash.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <rect width="640" height="480" fill="#08111f"/>
  <rect x="214" y="118" width="34" height="104" rx="11" fill="#54df9b"/>
  <rect x="272" y="88" width="34" height="134" rx="11" fill="#5ce1c3"/>
  <rect x="330" y="132" width="34" height="90" rx="11" fill="#7ab8ff"/>
  <text x="320" y="292" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="54" font-weight="700" fill="#f4fbff">LightNAS</text>
  <text x="320" y="333" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#9db2c3">Storage · Apps · Containers · Virtual Machines</text>
  <text x="320" y="380" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="15" fill="#5ce1c3">LightNAS Installer</text>
  <text x="320" y="408" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="13" fill="#9db2c3">Graphical · VGA safe · Terminal · Serial · BIOS + UEFI</text>
</svg>
SVG
  rsvg-convert -w 640 -h 480 "${BUILD_DIR}/lightnas-splash.svg" >"${BUILD_DIR}/lightnas-splash.png"

  while IFS= read -r -d '' splash; do
    cp "${BUILD_DIR}/lightnas-splash.png" "${splash%/*}/splash.png"
  done < <(find config/bootloaders -type f \( -name 'splash.svg' -o -name 'splash.png' \) -print0)
  find config/bootloaders -type f -name 'splash.svg' -delete

  while IFS= read -r -d '' menu; do
    sed -i \
      -e 's/Debian GNU\/Linux/LightNAS/g' \
      -e 's/Debian Live/LightNAS Live\/Recovery/g' \
      -e 's/Graphical Debian Installer/Install LightNAS (Graphical)/g' \
      -e 's/Debian Installer/Install LightNAS (Terminal UI)/g' \
      -e 's/Graphical installer/Install LightNAS (Graphical)/g' \
      -e 's/splash\.svg/splash.png/g' \
      "$menu"
  done < <(find config/bootloaders -type f \( -name '*.cfg' -o -name '*.conf' \) -print0)

  # Brand Syslinux installer choices by their stable label IDs instead of
  # depending on Debian's human-readable menu wording. Trixie live-build uses
  # labels such as installgui/install while the displayed text can vary
  # between "Install", "Graphical install", or distribution-specific strings.
  while IFS= read -r -d '' cfg; do
    awk '
      /^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)/ {
        installer="gui"; print; next
      }
      /^[[:space:]]*label[[:space:]]+install([[:space:]]|$)/ {
        installer="text"; print; next
      }
      /^[[:space:]]*label[[:space:]]+/ {
        installer=""
      }
      installer=="gui" && /^[[:space:]]*menu[[:space:]]+label[[:space:]]+/ {
        print "  menu label ^Install LightNAS (Graphical)"
        next
      }
      installer=="text" && /^[[:space:]]*menu[[:space:]]+label[[:space:]]+/ {
        print "  menu label Install LightNAS (Terminal UI)"
        next
      }
      { print }
    ' "$cfg" >"${cfg}.tmp"
    mv "${cfg}.tmp" "$cfg"
  done < <(find config/bootloaders -type f -name '*.cfg' -print0)

  # Add Proxmox-style compatibility choices. The normal graphical installer is
  # first, but every machine has an explicit path that does not depend on a
  # modern GPU: VGA-safe framebuffer, ncurses terminal, and serial console.
  while IFS= read -r -d '' cfg; do
    if grep -Eq '^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)' "$cfg"; then
      awk '
        function emit_safe(block, mode,   out,n,i,line) {
          n=split(block,out,"\n")
          for (i=1;i<=n;i++) {
            line=out[i]
            if (mode=="vga" && line ~ /^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)/) {
              sub(/installgui/,"lightnas-vga",line)
            } else if (mode=="serial" && line ~ /^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)/) {
              sub(/installgui/,"lightnas-serial",line)
            } else if (mode=="vga" && line ~ /^[[:space:]]*menu[[:space:]]+label[[:space:]]+/) {
              line="  menu label Install LightNAS (VGA Safe Mode)"
            } else if (mode=="serial" && line ~ /^[[:space:]]*menu[[:space:]]+label[[:space:]]+/) {
              line="  menu label Install LightNAS (Serial Console)"
            } else if (mode=="vga" && line ~ /^[[:space:]]*append[[:space:]]+/) {
              line=line " nomodeset vga=normal video=vesa:off"
            } else if (mode=="serial" && line ~ /^[[:space:]]*append[[:space:]]+/) {
              line=line " DEBIAN_FRONTEND=text console=tty0 console=ttyS0,115200n8"
            }
            if (line !~ /^[[:space:]]*menu[[:space:]]+default[[:space:]]*$/) print line
          }
        }
        BEGIN { capture=0; block="" }
        /^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)/ { capture=1; block=$0 "\n"; print; next }
        capture && /^[[:space:]]*label[[:space:]]+/ {
          emit_safe(block,"vga")
          emit_safe(block,"serial")
          capture=0; block=""
          print
          next
        }
        capture { block=block $0 "\n"; print; next }
        { print }
        END {
          if (capture) {
            emit_safe(block,"vga")
            emit_safe(block,"serial")
          }
        }
      ' "$cfg" >"${cfg}.tmp"
      mv "${cfg}.tmp" "$cfg"
    fi
  done < <(find config/bootloaders -type f -name '*.cfg' -print0)

  # Add conservative graphics options to the dedicated VGA-safe entry and keep
  # terminal/serial modes independent of X, Wayland, VESA, VirtIO, VMware,
  # VirtualBox VMSVGA/VBoxVGA, or physical GPU drivers.
  while IFS= read -r -d '' grubcfg; do
    if grep -q 'Install LightNAS (Graphical)' "$grubcfg"; then
      # Rename Debian text installer consistently in GRUB menus.
      sed -i 's/Install LightNAS (Text fallback)/Install LightNAS (Terminal UI)/g' "$grubcfg"
    fi
  done < <(find config/bootloaders -type f \( -name 'grub.cfg' -o -name 'grub*.cfg' \) -print0)

  # Make the graphical installer the default BIOS/Syslinux choice instead of
  # silently entering the Debian live session. Live/Recovery remains in the
  # menu for troubleshooting.
  while IFS= read -r -d '' cfg; do
    if grep -Eq '^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)' "$cfg"; then
      sed -i '/^[[:space:]]*menu[[:space:]]\+default[[:space:]]*$/d' "$cfg"
      awk '
        { print }
        /^[[:space:]]*label[[:space:]]+installgui([[:space:]]|$)/ { print "  menu default" }
      ' "$cfg" >"${cfg}.tmp"
      mv "${cfg}.tmp" "$cfg"
    fi
  done < <(find config/bootloaders -type f -name '*.cfg' -print0)

  # GRUB/UEFI gets the same compatibility choices as BIOS/Syslinux. Derive
  # kernel/initrd commands from the existing graphical installer entry so this
  # remains compatible with future Debian live-build path changes.
  while IFS= read -r -d '' grubcfg; do
    if grep -q 'Install LightNAS (Graphical)' "$grubcfg"; then
      linux_line="$(awk '
        /menuentry .*Install LightNAS \(Graphical\)/ { inentry=1; next }
        inentry && /^[[:space:]]*(linux|linuxefi)[[:space:]]+/ { print; exit }
      ' "$grubcfg")"
      initrd_line="$(awk '
        /menuentry .*Install LightNAS \(Graphical\)/ { inentry=1; next }
        inentry && /^[[:space:]]*(initrd|initrdefi)[[:space:]]+/ { print; exit }
      ' "$grubcfg")"

      if [[ -n "$linux_line" && -n "$initrd_line" ]] && ! grep -q 'Install LightNAS (VGA Safe Mode)' "$grubcfg"; then
        {
          printf '\nmenuentry "Install LightNAS (VGA Safe Mode)" {\n'
          printf '%s nomodeset vga=normal video=vesa:off\n' "$linux_line"
          printf '%s\n' "$initrd_line"
          printf '}\n'
          printf '\nmenuentry "Install LightNAS (Serial Console)" {\n'
          printf '%s DEBIAN_FRONTEND=text console=tty0 console=ttyS0,115200n8\n' "$linux_line"
          printf '%s\n' "$initrd_line"
          printf '}\n'
        } >>"$grubcfg"
      fi

      if grep -q '^set default=' "$grubcfg"; then
        sed -i 's/^set default=.*/set default="Install LightNAS (Graphical)"/' "$grubcfg"
      else
        sed -i '1iset default="Install LightNAS (Graphical)"' "$grubcfg"
      fi
      if grep -q '^set timeout=' "$grubcfg"; then
        sed -i 's/^set timeout=.*/set timeout=10/' "$grubcfg"
      else
        sed -i '2iset timeout=10' "$grubcfg"
      fi
    fi
  done < <(find config/bootloaders -type f \( -name 'grub.cfg' -o -name 'grub*.cfg' \) -print0)
fi

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
imagemagick
qrencode
acl
novnc
iproute2
nftables
ufw
smartmontools
xserver-xorg
xserver-xorg-video-all
xserver-xorg-video-vesa
xserver-xorg-video-fbdev
xserver-xorg-input-all
fbset
xinit
xauth
lightdm
openbox
chromium
dbus-x11
x11-xserver-utils
fonts-dejavu-core
plymouth
plymouth-themes

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

# Preinstall the App Store engine and RAW helper so first boot does not wait
# for package downloads before the LightNAS control center becomes useful.
docker.io
libraw-bin
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

if [[ -f "${REPO_ROOT}/package-lock.json" ]]; then
  cp "${REPO_ROOT}/package-lock.json" config/includes.chroot/opt/lightnas/
fi

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
After=network-online.target

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
Wants=network-online.target lightnas-host-agent.service lightnas-runtime-init.service
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
if apt-cache policy libraw-bin 2>/dev/null | awk '/Candidate:/{exit $2=="(none)" || $2==""}'; then
  apt-get install -y libraw-bin || true
fi

# Install guest display/integration helpers when the Debian repository exposes
# them. These are optional so the same ISO build remains portable.
for guest_pkg in qemu-guest-agent spice-vdagent open-vm-tools open-vm-tools-desktop virtualbox-guest-x11; do
  candidate="$(apt-cache policy "$guest_pkg" 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
  if [[ -n "$candidate" && "$candidate" != "(none)" ]]; then
    apt-get install -y "$guest_pkg" || true
  fi
done

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
# Local graphical LightNAS control center.
# This is deliberately a tiny kiosk session, not a general-purpose desktop.
# If a machine has no usable display adapter the web interface still runs on
# port 3080 and the remaining TTYs provide a text fallback.
#
if ! id lightnas-ui >/dev/null 2>&1; then
  useradd --create-home --home-dir /var/lib/lightnas-ui --shell /bin/bash lightnas-ui
fi
install -d -o lightnas-ui -g lightnas-ui -m 0700 /var/lib/lightnas-ui/.config/openbox
cat >/usr/local/bin/lightnas-kiosk <<'KIOSK'
#!/bin/bash
set -u
xset -dpms >/dev/null 2>&1 || true
xset s off >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true
for _ in $(seq 1 90); do
  curl -fsS http://127.0.0.1:3080/api/status >/dev/null 2>&1 && break
  sleep 1
done
exec chromium \
  --ozone-platform=x11 \
  --kiosk \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  http://127.0.0.1:3080/
KIOSK
chmod 0755 /usr/local/bin/lightnas-kiosk

cat >/usr/local/bin/lightnas-xsession <<'XSESSION'
#!/bin/bash
set -Eeuo pipefail
xsetroot -solid '#08111f' >/dev/null 2>&1 || true
xhost +SI:localuser:lightnas-ui >/dev/null 2>&1 || true
exec runuser -u lightnas-ui -- env \
  HOME=/var/lib/lightnas-ui \
  USER=lightnas-ui \
  LOGNAME=lightnas-ui \
  DISPLAY="${DISPLAY:-:0}" \
  XDG_SESSION_TYPE=x11 \
  openbox-session
XSESSION
chmod 0755 /usr/local/bin/lightnas-xsession

# LightNAS is an appliance, not a Debian desktop. Start the local control center
# directly on VT7 so boot can never fall through to a Debian/LightDM login screen.
cat >/usr/local/sbin/lightnas-display-console <<'DISPLAY_CONSOLE'
#!/bin/bash
set -Eeuo pipefail
exec /usr/bin/xinit /usr/local/bin/lightnas-xsession -- :0 vt7 -keeptty -nolisten tcp
DISPLAY_CONSOLE
chmod 0755 /usr/local/sbin/lightnas-display-console

cat >/etc/systemd/system/lightnas-display-console.service <<'DISPLAY_UNIT'
[Unit]
Description=LightNAS local graphical control center
After=systemd-user-sessions.service lightnas.service
Wants=lightnas.service
Conflicts=display-manager.service lightdm.service getty@tty7.service

[Service]
Type=simple
User=root
TTYPath=/dev/tty7
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
ExecStart=/usr/local/sbin/lightnas-display-console
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical.target
DISPLAY_UNIT

cat >/var/lib/lightnas-ui/.config/openbox/autostart <<'AUTOSTART'
/usr/local/bin/lightnas-kiosk &
AUTOSTART
chown lightnas-ui:lightnas-ui /var/lib/lightnas-ui/.config/openbox/autostart

# Keep LightDM installed only as an emergency package dependency. It must not
# own the display or expose a generic Debian login screen on the appliance.
systemctl disable lightdm.service >/dev/null 2>&1 || true
systemctl mask lightdm.service >/dev/null 2>&1 || true
systemctl enable lightnas-display-console.service >/dev/null 2>&1 || true

cat >/etc/issue <<'ISSUE'
LightNAS 1.0
Private cloud storage appliance · Debian 13 base
Local control center starts automatically
Web control center: http://<this-system-IP>:3080

ISSUE
cp /etc/issue /etc/issue.net

# Keep Debian compatibility for package/tool detection while making the
# appliance identify itself as LightNAS in the console and desktop.
if [[ -f /etc/os-release ]]; then
  sed -i     -e 's/^NAME=.*/NAME="LightNAS"/'     -e 's/^PRETTY_NAME=.*/PRETTY_NAME="LightNAS 1.0 (Debian 13)"/'     /etc/os-release
fi
printf '%s\n' 'LightNAS 1.0' 'Storage · Apps · Containers · Virtual Machines' >/etc/motd

# Branded Plymouth boot splash.
install -d -m 0755 /usr/share/plymouth/themes/lightnas
cat >/usr/share/plymouth/themes/lightnas/lightnas.plymouth <<'PLYMOUTH'
[Plymouth Theme]
Name=LightNAS
Description=LightNAS appliance boot splash
ModuleName=script

[script]
ImageDir=/usr/share/plymouth/themes/lightnas
ScriptFile=/usr/share/plymouth/themes/lightnas/lightnas.script
PLYMOUTH
cat >/usr/share/plymouth/themes/lightnas/lightnas.script <<'PLYMOUTH_SCRIPT'
Window.SetBackgroundTopColor(0.03, 0.07, 0.12);
Window.SetBackgroundBottomColor(0.03, 0.07, 0.12);
title = Image.Text("LightNAS", 0.94, 0.98, 1.0);
subtitle = Image.Text("Storage  •  Apps  •  Containers  •  Virtual Machines", 0.36, 0.88, 0.76);
ts = Sprite(title);
ss = Sprite(subtitle);
ts.SetX(Window.GetWidth()/2 - title.GetWidth()/2);
ts.SetY(Window.GetHeight()/2 - 55);
ss.SetX(Window.GetWidth()/2 - subtitle.GetWidth()/2);
ss.SetY(Window.GetHeight()/2 + 10);
PLYMOUTH_SCRIPT
plymouth-set-default-theme lightnas || true

systemctl disable lightdm.service >/dev/null 2>&1 || true
systemctl mask lightdm.service >/dev/null 2>&1 || true
systemctl enable lightnas-display-console.service >/dev/null 2>&1 || true
systemctl set-default graphical.target >/dev/null 2>&1 || true

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
if [[ -f /opt/lightnas/package-lock.json ]]; then
  npm --prefix /opt/lightnas ci --omit=dev --no-audit --no-fund --prefer-offline
else
  npm --prefix /opt/lightnas install --omit=dev --no-audit --no-fund --prefer-offline
fi

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
# Validate that the finished image contains the installer payload before it is
# published. The graphical installer is preferred, while the text installer
# remains an explicit fallback for older or unusual graphics hardware.
#
echo
echo "=== Validating LightNAS installer payload ==="
INSTALLER_KERNEL_COUNT="$(find binary -type f \( -name 'linux' -o -name 'vmlinuz' \) -path '*install*' | wc -l)"
INSTALLER_INITRD_COUNT="$(find binary -type f -name 'initrd*' -path '*install*' | wc -l)"
if [[ "${INSTALLER_KERNEL_COUNT}" -lt 1 || "${INSTALLER_INITRD_COUNT}" -lt 1 ]]; then
  echo "ERROR: Debian Installer kernel/initrd payload is missing from the LightNAS ISO tree." >&2
  exit 1
fi
if [[ ! -f binary/install/preseed.cfg && ! -f binary/preseed.cfg && ! -f config/binary_debian-installer/preseed.cfg ]]; then
  echo "ERROR: LightNAS installer preseed was not staged." >&2
  exit 1
fi
echo "Installer kernel/initrd and LightNAS preseed confirmed."

if ! grep -Rqs -- 'Install LightNAS (Graphical)' binary 2>/dev/null; then
  echo "ERROR: final ISO tree does not contain the branded graphical LightNAS installer entry." >&2
  exit 1
fi
if ! grep -Rqs -- 'Install LightNAS (Terminal UI)' binary 2>/dev/null; then
  echo "ERROR: final ISO tree does not contain the terminal installer entry." >&2
  exit 1
fi
if ! grep -Rqs -- 'Install LightNAS (VGA Safe Mode)' binary 2>/dev/null; then
  echo "ERROR: final ISO tree does not contain the VGA-safe installer entry." >&2
  exit 1
fi
if ! grep -Rqs -- 'Install LightNAS (Serial Console)' binary 2>/dev/null; then
  echo "ERROR: final ISO tree does not contain the serial-console installer entry." >&2
  exit 1
fi
echo "Graphical, VGA-safe, terminal, and serial LightNAS installer entries confirmed."

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

echo
echo "=== Verifying BIOS + UEFI bootability ==="
ELTORITO_REPORT="$(xorriso -indev "${ISO}" -report_el_torito plain 2>/dev/null || true)"
if ! grep -qi 'BIOS' <<<"${ELTORITO_REPORT}"; then
  echo 'ERROR: generated ISO does not advertise a BIOS El Torito boot image.' >&2
  exit 1
fi
if ! grep -Eqi 'UEFI|EFI' <<<"${ELTORITO_REPORT}"; then
  echo 'ERROR: generated ISO does not advertise a UEFI boot image.' >&2
  exit 1
fi
echo 'BIOS and UEFI boot entries confirmed.'

echo
echo "=== Verifying installer files inside final ISO ==="
ISO_FILE_LIST="$(xorriso -indev "${ISO}" -find / -type f -exec lsdl -- 2>/dev/null || true)"
if ! grep -Eqi '/install[^ ]*/.*(vmlinuz|linux)' <<<"${ISO_FILE_LIST}"; then
  echo 'ERROR: final ISO does not contain an installer kernel.' >&2
  exit 1
fi
if ! grep -Eqi '/install[^ ]*/.*initrd' <<<"${ISO_FILE_LIST}"; then
  echo 'ERROR: final ISO does not contain an installer initrd.' >&2
  exit 1
fi
echo 'Installer payload confirmed inside final ISO.'

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
