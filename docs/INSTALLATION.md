# LightNAS Installation Guide

This guide covers the normal LightNAS installation flow for bare metal and
standard Linux virtual machines. LightNAS does not require any particular
hypervisor or external virtualization control plane.

## 1. Supported installation targets

LightNAS supports:

- Bare metal Debian/Ubuntu hosts.
- Debian/Ubuntu virtual machines.
- Nested/containerized installations when the outer platform exposes the
  capabilities LightNAS needs.

The outer platform is an infrastructure choice, not a LightNAS dependency.

## 2. One-command installation

Run as root on the LightNAS host:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install.sh | bash
```

The installer places LightNAS under:

```text
/opt/lightnas
```

Persistent application state is stored under:

```text
/var/lib/lightnas
```

The management service listens on port `3080`.

## 3. What the installer prepares

The normal installer installs the local runtime and NAS dependencies LightNAS
needs, including:

```text
ca-certificates
curl
git
gnupg
python3
ffmpeg
acl
novnc
iproute2
nftables
ufw
tar
gzip
xz-utils
zstd
lxc
lxc-templates
lxcfs
uidmap
bridge-utils
debootstrap
dnsmasq-base
network-manager
qemu-system-x86
qemu-utils
libvirt-daemon-system
libvirt-clients
virtinst
ovmf
```

Node.js 22 is installed when required.

On normal hosts, LightNAS uses native LXC/liblxc for system containers and
QEMU/KVM + libvirt for virtual machines. Hardware acceleration uses `/dev/kvm`
when available. If the host does not expose hardware virtualization, LightNAS
reports that capability state rather than depending on an external control
plane.

## 4. Networking

LightNAS manages host networking locally through NetworkManager and uses
UFW/nftables for firewall management.

For system containers, LightNAS chooses the best supported network mode for the
current host. Direct LAN networking is used when available; otherwise LightNAS
falls back to its managed private network.

Users should not need to manually rewrite LXC configuration files after normal
container creation.

## 5. Imported system-container templates

LightNAS supports imported system-container archives such as:

```text
.tar.zst
.tar.xz
.tar.gz
.tgz
```

Imported archives are unpacked with LXC-safe device handling. Archived
`/dev/*` device entries are skipped because the runtime provides `/dev`
inside the container.

## 6. Update an existing installation

Inside LightNAS:

```bash
cd /opt/lightnas
git pull --ff-only
bash install.sh
```

Persistent state under `/var/lib/lightnas` is preserved.

## 7. Verify services

```bash
systemctl status lightnas --no-pager --full
systemctl status lightnas-host-agent --no-pager --full
cat /var/lib/lightnas/runtime-status.txt
```

The web control center should be available at:

```text
http://<LIGHTNAS-IP>:3080
```

## 8. Optional external integrations

Platform-specific deployment, migration, or compatibility instructions are not
part of the normal LightNAS install path. They are documented separately in:

**[INTEGRATIONS.md](INTEGRATIONS.md)**

## 9. Operator responsibility

LightNAS can create and manage virtual machines, containers, applications,
storage, networking, and services on infrastructure controlled by the operator.

The operator remains responsible for the security, availability, configuration,
licensing, backups, data, cost, compliance, and maintenance of those resources
and the underlying servers or third-party platforms.

See [LICENSE](../LICENSE) and [DISCLAIMER.md](../DISCLAIMER.md).
