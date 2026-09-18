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

# Native system containers are built into LightNAS through LXC/liblxc.
if command -v lxc-create >/dev/null 2>&1 && command -v lxc-start >/dev/null 2>&1; then
  if systemctl list-unit-files lxc-net.service --no-legend 2>/dev/null | grep -q '^lxc-net.service'; then
    if [[ -f /etc/default/lxc-net ]]; then
      sed -i 's/^USE_LXC_BRIDGE=.*/USE_LXC_BRIDGE="true"/' /etc/default/lxc-net || true
    fi
    systemctl enable --now lxc-net.service >/dev/null 2>&1 || true
  fi
  if systemd-detect-virt --container >/dev/null 2>&1 && [[ "${LIGHTNAS_ALLOW_NESTED_LXC:-0}" != "1" ]]; then
    report Containers 'native LXC installed, but this appliance is itself in a container and nested LXC was not enabled'
  else
    report Containers 'native LXC/liblxc ready'
  fi
else
  report Containers 'native LXC/liblxc tools are not installed on this host'
fi

# Docker/OCI is optional and is used only by the App Store. Do not install or
# grant Docker-socket access unless the operator explicitly opts in.
if [[ "${LIGHTNAS_ENABLE_DOCKER_APPS:-0}" != "1" ]]; then
  set_flag LIGHTNAS_DOCKER_ENABLED 0
  report Apps 'optional Docker/OCI engine disabled (set LIGHTNAS_ENABLE_DOCKER_APPS=1 to enable)'
else
  if ! command -v docker >/dev/null 2>&1; then
    if ! apt-get install -y docker.io; then report Apps 'docker.io package installation failed'; fi
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
        report Apps 'optional Docker/OCI engine ready'
      else
        set_flag LIGHTNAS_DOCKER_ENABLED 0
        report Apps 'Docker is running but inaccessible to the LightNAS service account'
      fi
    else
      set_flag LIGHTNAS_DOCKER_ENABLED 0
      report Apps 'Docker could not start'
    fi
  else
    set_flag LIGHTNAS_DOCKER_ENABLED 0
    report Apps 'Docker not installed'
  fi
fi

if [[ "${LIGHTNAS_SKIP_VM:-0}" == "1" ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs 'skipped by operator (LIGHTNAS_SKIP_VM=1)'
elif systemd-detect-virt --container >/dev/null 2>&1 && [[ ! -c /dev/kvm ]]; then
  set_flag LIGHTNAS_VM_ENABLED 0
  report VMs 'this appliance is inside a container and /dev/kvm was not passed through; local KVM is unavailable'
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
    setfacl -m u:lightnas:rwx /var/lib/libvirt/images >/dev/null 2>&1 || true

    if ! virsh -c qemu:///system pool-info default >/dev/null 2>&1; then
      virsh -c qemu:///system pool-define-as default dir --target /var/lib/libvirt/images >/dev/null 2>&1 || true
      virsh -c qemu:///system pool-build default >/dev/null 2>&1 || true
    fi
    virsh -c qemu:///system pool-start default >/dev/null 2>&1 || true
    virsh -c qemu:///system pool-autostart default >/dev/null 2>&1 || true

    if ! virsh -c qemu:///system net-info default >/dev/null 2>&1; then
      network_xml="$(mktemp)"
      cat >"$network_xml" <<'EOF'
<network>
  <name>default</name>
  <forward mode='nat'/>
  <bridge name='virbr0' stp='on' delay='0'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='192.168.122.2' end='192.168.122.254'/>
    </dhcp>
  </ip>
</network>
EOF
      virsh -c qemu:///system net-define "$network_xml" >/dev/null 2>&1 || true
      rm -f "$network_xml"
    fi
    virsh -c qemu:///system net-start default >/dev/null 2>&1 || true
    virsh -c qemu:///system net-autostart default >/dev/null 2>&1 || true

    for attempt in {1..10}; do
      runuser -u lightnas -- virsh -c qemu:///system list --all --name >/dev/null 2>&1 && break
      sleep 1
    done
    if runuser -u lightnas -- virsh -c qemu:///system list --all --name >/dev/null 2>&1 \
      && command -v virt-install >/dev/null 2>&1; then
      set_flag LIGHTNAS_VM_ENABLED 1
      report VMs 'native QEMU/KVM + libvirt ready; add an ISO and use a local storage pool/network'
    else
      set_flag LIGHTNAS_VM_ENABLED 0
      report VMs 'libvirt installed, but the service account cannot access qemu:///system'
    fi
  else
    set_flag LIGHTNAS_VM_ENABLED 0
    report VMs 'KVM/libvirt package installation failed'
  fi
fi
