#!/usr/bin/env bash
# Install or repair LightNAS inside an existing Proxmox LXC.
# Proxmox only supplies nesting/device capabilities. LightNAS owns its native
# LXC system containers and QEMU/libvirt VMs inside the appliance.
set -Eeuo pipefail

RAW_BASE="${LIGHTNAS_RAW_BASE:-https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main}"
ctid="${1:-${LIGHTNAS_CTID:-}}"

run_local_installer() {
  [[ ${EUID} -eq 0 ]] || { echo 'Run the LightNAS installer as root (or with sudo).' >&2; exit 1; }
  echo 'Proxmox host tools were not detected. Installing LightNAS locally.'
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
  echo 'Usage on a Proxmox VE host: bash scripts/proxmox-lxc-install.sh CTID' >&2
  exit 1
fi

config="$(pct config "$ctid")" || { echo "Unable to read LXC $ctid." >&2; exit 1; }

pve_major="$(pveversion 2>/dev/null | sed -nE 's#^pve-manager/([0-9]+).*#\1#p' | head -1)"
[[ "$pve_major" =~ ^[0-9]+$ ]] || pve_major=9

wait_for_container() {
  for attempt in {1..40}; do
    pct exec "$ctid" -- true >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "LXC $ctid did not become ready." >&2
  return 1
}

wait_for_stopped() {
  for attempt in {1..40}; do
    [[ "$(pct status "$ctid")" == *'status: stopped'* ]] && return 0
    sleep 2
  done
  echo "LXC $ctid did not stop cleanly." >&2
  return 1
}

features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
for option in nesting keyctl mknod; do
  if [[ $features =~ (^|,)${option}=[01](,|$) ]]; then
    features="$(sed -E "s/(^|,)${option}=[01]/\\1${option}=1/" <<<"$features")"
  else
    features="${features:+$features,}${option}=1"
  fi
done

if [[ "$(pct status "$ctid")" == *'status: running'* ]]; then
  echo "Stopping LXC $ctid to apply nested LightNAS capabilities..."
  pct shutdown "$ctid" --timeout 60 || pct stop "$ctid"
  wait_for_stopped
fi

# Remove the legacy host-bridge mount used by old LightNAS builds.
while IFS= read -r legacy_slot; do
  [[ -n "$legacy_slot" ]] || continue
  echo "Removing legacy LightNAS Proxmox bridge mount $legacy_slot..."
  pct set "$ctid" -delete "$legacy_slot" || true
done < <(grep -E '^mp[0-9]+: /var/lib/lightnas-pve,mp=/var/lib/lightnas-pve([,[:space:]]|$)' <<<"$config" | cut -d: -f1 || true)
rm -f "/etc/lightnas-pve/clients/${ctid}.secret" 2>/dev/null || true

current_features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
if [[ "$features" != "$current_features" ]]; then
  echo "Setting LXC features: $features"
  pct set "$ctid" -features "$features"
fi
config="$(pct config "$ctid")"

ensure_host_kvm() {
  if [[ -c /dev/kvm ]]; then return 0; fi
  echo "Proxmox host does not expose /dev/kvm; trying KVM modules..."
  modprobe kvm >/dev/null 2>&1 || true
  vendor="$(awk -F: '/vendor_id/{gsub(/[[:space:]]/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)"
  case "$vendor" in
    GenuineIntel) modprobe kvm_intel >/dev/null 2>&1 || true ;;
    AuthenticAMD) modprobe kvm_amd >/dev/null 2>&1 || true ;;
  esac
  if [[ ! -c /dev/kvm ]]; then
    echo "WARNING: /dev/kvm is unavailable on the Proxmox host. LightNAS will use QEMU software virtualization (TCG)." >&2
  fi
}

pass_device() {
  local path="$1" mode="$2" label="$3"
  [[ -e "$path" ]] || { echo "Host device $path unavailable; $label will be limited." >&2; return 0; }
  if grep -Fq "path=$path" <<<"$config"; then return 0; fi
  local devslot=''
  for slot in $(seq 0 15); do
    if ! grep -q "^dev${slot}:" <<<"$config"; then devslot="$slot"; break; fi
  done
  [[ -n "$devslot" ]] || { echo "No free Proxmox device slot for $path." >&2; return 1; }
  echo "Passing $path into LXC $ctid for $label..."
  pct set "$ctid" "--dev${devslot}" "path=$path,mode=$mode" || {
    echo "Warning: Proxmox could not pass $path; $label may be unavailable." >&2
    return 0
  }
  config="$(pct config "$ctid")"
}

ensure_host_kvm
pass_device /dev/kvm 0666 'KVM acceleration'
pass_device /dev/net/tun 0666 'TUN/TAP guest networking'
pass_device /dev/vhost-net 0666 'VirtIO network acceleration'

echo "Starting LXC $ctid..."
pct start "$ctid"
wait_for_container

guest_installer="$(mktemp)"
trap 'rm -f "$guest_installer"' EXIT
curl -fsSL "${RAW_BASE}/install.sh" -o "$guest_installer"
pct push "$ctid" "$guest_installer" /root/lightnas-install.sh
pct exec "$ctid" -- chmod 0755 /root/lightnas-install.sh

pct exec "$ctid" -- env \
  LIGHTNAS_ENABLE_NESTED_RUNTIMES=1 \
  LIGHTNAS_ALLOW_NESTED_LXC=1 \
  bash /root/lightnas-install.sh

echo "Verifying native LightNAS engines inside LXC $ctid..."
if ! pct exec "$ctid" -- bash -lc 'command -v lxc-ls >/dev/null && command -v lxc-create >/dev/null && command -v debootstrap >/dev/null && command -v virsh >/dev/null && command -v virt-install >/dev/null'; then
  echo "Native engines are incomplete; repairing packages inside LXC $ctid..."
  pct exec "$ctid" -- bash -lc '
    set -Eeuo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y \
      lxc lxc-templates lxcfs uidmap bridge-utils debootstrap debian-archive-keyring ubuntu-keyring zstd \
      qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst ovmf \
      dnsmasq-base network-manager iproute2 nftables ufw
  '
fi

pct exec "$ctid" -- env LIGHTNAS_DETECTED_PVE_MAJOR="$pve_major" bash -lc '
  set -Eeuo pipefail
  install -d -m 0755 /etc/lightnas
  touch /etc/lightnas/runtime.env
  chmod 0600 /etc/lightnas/runtime.env
  sed -i "/^LIGHTNAS_ALLOW_NESTED_LXC=/d;/^LIGHTNAS_ENABLE_PROXMOX_PROVIDER=/d;/^LIGHTNAS_PVE_/d;/^LIGHTNAS_PVE_APLINFO_MAJOR=/d" /etc/lightnas/runtime.env
  printf "%s\n" "LIGHTNAS_ALLOW_NESTED_LXC=1" "LIGHTNAS_ENABLE_PROXMOX_PROVIDER=0" "LIGHTNAS_PVE_APLINFO_MAJOR=${LIGHTNAS_DETECTED_PVE_MAJOR}" >> /etc/lightnas/runtime.env

  LIGHTNAS_ALLOW_NESTED_LXC=1 LIGHTNAS_RUNTIME_STATUS_FILE=/var/lib/lightnas/runtime-status.txt \
    bash /opt/lightnas/scripts/provision-runtimes.sh

  systemctl daemon-reload
  systemctl enable --now NetworkManager.service >/dev/null 2>&1 || true
  systemctl enable --now lxc-net.service >/dev/null 2>&1 || true
  systemctl enable --now libvirtd.socket >/dev/null 2>&1 || true
  systemctl enable --now lightnas-host-agent.service
  systemctl enable --now lightnas.service
'

# Grant the unprivileged LightNAS web service access to every virtual data mount
# explicitly attached as mpN. The OS/root filesystem is not changed.
latest_config="$(pct config "$ctid")"

# Persist Proxmox's authoritative virtual-disk sizes inside the guest.
storage_manifest="$(mktemp)"
PCT_CONFIG="$latest_config" python3 - "$ctid" >"$storage_manifest" <<'PY'
import json, os, re, sys

ctid = int(sys.argv[1])
config = os.environ.get("PCT_CONFIG", "")
units = {"": 1, "B": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5}

def size_bytes(value):
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([BKMGTP]?)", str(value or "").strip(), re.I)
    if not match:
        return 0
    return int(float(match.group(1)) * units[match.group(2).upper()])

def parse_entry(slot, raw):
    parts = [part.strip() for part in raw.split(",") if part.strip()]
    volume = parts[0] if parts else ""
    options = {}
    for part in parts[1:]:
        if "=" in part:
            key, value = part.split("=", 1)
            options[key] = value
    mount = "/" if slot == "rootfs" else options.get("mp")
    if mount and not mount.startswith("/"):
        mount = "/" + mount
    return {
        "slot": slot,
        "volume": volume,
        "storage": volume.split(":", 1)[0] if ":" in volume else None,
        "mountPoint": mount,
        "size": options.get("size"),
        "sizeBytes": size_bytes(options.get("size")),
    }

rootfs = None
mounts = []
for line in config.splitlines():
    match = re.match(r"^(rootfs|mp\d+):\s*(.+)$", line)
    if not match:
        continue
    entry = parse_entry(match.group(1), match.group(2))
    if entry["slot"] == "rootfs":
        rootfs = entry
    elif entry["mountPoint"] != "/var/lib/lightnas-pve":
        mounts.append(entry)

print(json.dumps({
    "version": 1,
    "source": "proxmox-pct-config",
    "ctid": ctid,
    "rootfs": rootfs,
    "mounts": mounts,
}, indent=2))
PY

pct exec "$ctid" -- install -d -m 0755 /etc/lightnas
pct push "$ctid" "$storage_manifest" /etc/lightnas/proxmox-storage.json
pct exec "$ctid" -- chmod 0644 /etc/lightnas/proxmox-storage.json
rm -f "$storage_manifest"

mapfile -t guest_data_mounts < <(sed -nE 's/^mp[0-9]+: .*mp=([^,]+).*/\1/p' <<<"$latest_config" | grep -v '^/var/lib/lightnas-pve$' || true)
for guest_mount in "${guest_data_mounts[@]}"; do
  [[ "$guest_mount" == /* ]] || guest_mount="/$guest_mount"
  echo "Granting LightNAS managed access to $guest_mount..."
  pct exec "$ctid" -- bash -lc '
    set -Eeuo pipefail
    mount="$1"
    if [[ -d "$mount" ]]; then
      setfacl -m u:lightnas:rwx "$mount"
      setfacl -m d:u:lightnas:rwx "$mount"
      install -d -m 0770 "$mount/.lightnas/template/cache" "$mount/.lightnas/storage"
      setfacl -R -m u:lightnas:rwx "$mount/.lightnas"
      setfacl -R -m d:u:lightnas:rwx "$mount/.lightnas"
      for vm_user in libvirt-qemu qemu; do
        if id "$vm_user" >/dev/null 2>&1; then
          setfacl -m "u:${vm_user}:rwx" "$mount" "$mount/.lightnas"
          setfacl -m "d:u:${vm_user}:rwx" "$mount/.lightnas"
          setfacl -R -m "u:${vm_user}:rwx" "$mount/.lightnas/storage"
          setfacl -R -m "d:u:${vm_user}:rwx" "$mount/.lightnas/storage"
        fi
      done
    fi
  ' _ "$guest_mount" || echo "Warning: unable to grant LightNAS access on $guest_mount; it will remain browse-only." >&2
done

# The built-in local pool can also hold VM disks and ISO images. Ensure the
# libvirt QEMU account can traverse and write LightNAS-managed VM content.
pct exec "$ctid" -- bash -lc '
  install -d -m 0770 /var/lib/lightnas/storage/local
  setfacl -m u:lightnas:rwx /var/lib/lightnas/storage/local || true
  setfacl -m d:u:lightnas:rwx /var/lib/lightnas/storage/local || true
  for vm_user in libvirt-qemu qemu; do
    if id "$vm_user" >/dev/null 2>&1; then
      setfacl -m "u:${vm_user}:rwx" /var/lib/lightnas/storage/local || true
      setfacl -m "d:u:${vm_user}:rwx" /var/lib/lightnas/storage/local || true
      setfacl -R -m "u:${vm_user}:rwx" /var/lib/lightnas/storage/local || true
    fi
  done
'
pct exec "$ctid" -- systemctl restart lightnas-host-agent lightnas

echo
echo "LightNAS local-runtime installation finished in LXC $ctid."
echo 'Containers: native LXC/liblxc inside LightNAS.'
echo 'VMs: QEMU/libvirt inside LightNAS; KVM is used when available and TCG otherwise.'
echo 'Proxmox host APIs are not used for normal LightNAS compute operations.'

echo "Performing strict post-install verification..."
latest_config="$(pct config "$ctid")"
grep -Eq '^features: .*nesting=1' <<<"$latest_config" || { echo 'ERROR: nesting=1 is missing.' >&2; exit 1; }
grep -Eq '^features: .*keyctl=1' <<<"$latest_config" || { echo 'ERROR: keyctl=1 is missing.' >&2; exit 1; }
grep -Eq '^features: .*mknod=1' <<<"$latest_config" || { echo 'ERROR: mknod=1 is missing.' >&2; exit 1; }

pct exec "$ctid" -- bash -lc '
  set -Eeuo pipefail
  command -v lxc-ls >/dev/null
  command -v lxc-create >/dev/null
  command -v debootstrap >/dev/null
  command -v virsh >/dev/null
  command -v virt-install >/dev/null
  systemctl is-active --quiet lightnas-host-agent
  systemctl is-active --quiet lightnas
' || {
  echo "ERROR: LightNAS nested runtime verification failed." >&2
  pct exec "$ctid" -- systemctl status lightnas-host-agent lightnas --no-pager --full || true
  exit 1
}

pct exec "$ctid" -- bash -lc '
  echo "--- Runtime status ---"
  cat /var/lib/lightnas/runtime-status.txt 2>/dev/null || true
  echo "--- Bridges ---"
  ip -br addr show type bridge 2>/dev/null || true
  echo "--- Services ---"
  systemctl --no-pager is-active lightnas-host-agent lightnas lxc-net.service 2>/dev/null || true
  echo "--- VM acceleration ---"
  grep "^LIGHTNAS_VM_" /etc/lightnas/runtime.env 2>/dev/null || true
  echo "--- Proxmox storage manifest ---"
  cat /etc/lightnas/proxmox-storage.json 2>/dev/null || true
'

echo "--- Nested runtime self-test ---"
pct exec "$ctid" -- python3 -c 'import json,socket; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.connect("/run/lightnas/host-agent.sock"); s.sendall(b"{\"action\":\"runtime-diagnostics\"}\n"); line=s.makefile("rb").readline(); print(json.dumps(json.loads(line), indent=2))'
