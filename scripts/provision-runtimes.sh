#!/usr/bin/env bash
# Run from install.sh after the lightnas account exists. This does not change disks or PVE configuration.
set -Eeuo pipefail

status_file="${LIGHTNAS_RUNTIME_STATUS_FILE:-/var/lib/lightnas/runtime-status.txt}"
runtime_env="${LIGHTNAS_RUNTIME_ENV_FILE:-/etc/lightnas/runtime.env}"
mkdir -p "$(dirname "${status_file}")" "$(dirname "${runtime_env}")"
if [[ ! -e "$runtime_env" ]]; then install -m 0600 /dev/null "$runtime_env"; fi
chmod 0600 "$runtime_env"

set_flag() {
  local key="$1" value="$2"
  sed -i "/^${key}=/d" "$runtime_env"
  printf '%s=%s\n' "$key" "$value" >> "$runtime_env"
}
report() { printf '%s: %s\n' "$1" "$2" | tee -a "${status_file}"; }
: > "${status_file}"
chmod 0644 "${status_file}"

# The Docker socket grants host-level access. Only the authenticated LightNAS service account joins the group.
if [[ "${LIGHTNAS_SKIP_DOCKER:-0}" == "1" ]]; then
  set_flag LIGHTNAS_DOCKER_ENABLED 0
  report Containers 'skipped by operator (LIGHTNAS_SKIP_DOCKER=1)'
else
  if ! command -v docker >/dev/null 2>&1; then
    if ! apt-get install -y docker.io; then report Containers 'docker.io package installation failed'; fi
  fi
  if command -v docker >/dev/null 2>&1; then
    systemctl enable --now docker.service >/dev/null 2>&1 || true
    for attempt in {1..10}; do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
    if docker info >/dev/null 2>&1; then
      if getent group docker >/dev/null 2>&1; then usermod -aG docker lightnas; fi
      if runuser -u lightnas -- docker info >/dev/null 2>&1; then
        set_flag LIGHTNAS_DOCKER_ENABLED 1
        report Containers 'ready (Docker accessible to LightNAS)'
      else
        set_flag LIGHTNAS_DOCKER_ENABLED 0
        report Containers 'Docker is running but inaccessible to the service account'
      fi
    else
      set_flag LIGHTNAS_DOCKER_ENABLED 0
      report Containers 'Docker could not start; Proxmox LXC may require nesting and host kernel support'
    fi
  else
    set_flag LIGHTNAS_DOCKER_ENABLED 0
    report Containers 'Docker not installed'
  fi
fi

if [[ "${LIGHTNAS_SKIP_VM:-0}" == "1" ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs 'skipped by operator (LIGHTNAS_SKIP_VM=1)'
elif [[ -e /etc/pve ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs 'Proxmox host detected; use a dedicated VM for local libvirt or connect the Proxmox API'
elif systemd-detect-virt --container >/dev/null 2>&1; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs 'LXC cannot host KVM; run LightNAS in a VM with nested KVM or on bare metal'
elif [[ ! -c /dev/kvm ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs '/dev/kvm is unavailable; enable hardware or nested virtualization on the host'
elif [[ "$(uname -m)" != 'x86_64' ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs 'automatic KVM provisioning currently supports x86_64 only'
else
  if apt-get install -y qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst; then
    if systemctl list-unit-files libvirtd.socket --no-legend 2>/dev/null | grep -q '^libvirtd.socket'; then
      systemctl enable --now libvirtd.socket >/dev/null 2>&1 || true
    elif systemctl list-unit-files virtqemud.socket --no-legend 2>/dev/null | grep -q '^virtqemud.socket'; then
      systemctl enable --now virtqemud.socket >/dev/null 2>&1 || true
    fi
    if getent group libvirt >/dev/null 2>&1; then usermod -aG libvirt lightnas; fi
    install -d -m 0755 /var/lib/libvirt/images
    virsh -c qemu:///system pool-start default >/dev/null 2>&1 || true
    virsh -c qemu:///system pool-autostart default >/dev/null 2>&1 || true
    virsh -c qemu:///system net-start default >/dev/null 2>&1 || true
    virsh -c qemu:///system net-autostart default >/dev/null 2>&1 || true
    for attempt in {1..10}; do
      runuser -u lightnas -- virsh -c qemu:///system list --all --name >/dev/null 2>&1 && break
      sleep 1
    done
    if runuser -u lightnas -- virsh -c qemu:///system list --all --name >/dev/null 2>&1 \
      && command -v virt-install >/dev/null 2>&1; then
      set_flag LIGHTNAS_VM_ENABLED 1
      report VMs 'KVM/libvirt accessible; add an ISO and check the default pool and network'
    else
      set_flag LIGHTNAS_VM_ENABLED 0
      report VMs 'libvirt installed, but the service account cannot access qemu:///system'
    fi
  else
    set_flag LIGHTNAS_VM_ENABLED 0
    report VMs 'KVM/libvirt package installation failed'
  fi
fi
