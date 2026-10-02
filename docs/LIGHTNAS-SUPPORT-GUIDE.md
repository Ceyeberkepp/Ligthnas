# LightNAS Support Guide

This guide covers the **LightNAS NAS edition**: the storage, files/media, App Store, networking, native system-container and virtual-machine appliance installed with `install.sh`.

> Scope note: this document describes current repository behavior. The dedicated Hypervisor edition is documented separately in `LIGHTVISOR-SUPPORT-GUIDE.md`.

## 1. What LightNAS is

LightNAS is a local Linux appliance with one web control plane for:

- files and media
- storage inventory and storage spaces
- Docker/OCI applications
- native LXC system containers
- QEMU/KVM virtual machines
- VM noVNC console access
- networking and firewall management
- local users and permissions
- SMTP and appliance settings
- backups, activity, logs and health checks

The NAS edition remains independent of Proxmox, VMware, ZStack or any other external hypervisor. Platform-specific helpers may prepare an outer LXC or VM, but LightNAS manages its own local services after installation.

## 2. Core architecture

The main components are:

```text
Browser
  |
  | HTTP
  v
lightnas.service
Node.js web/API control plane
  |
  | Unix socket
  v
lightnas-host-agent.service
privileged host operations
  |
  +-- LXC / liblxc
  +-- libvirt / QEMU / KVM
  +-- NetworkManager
  +-- UFW / nftables
  +-- host storage operations

Docker/OCI
  |
  +-- App Store applications
```

LightNAS deliberately keeps the unprivileged web process separate from privileged host operations.

## 3. Important services

Primary services:

```bash
systemctl status lightnas --no-pager
systemctl status lightnas-host-agent --no-pager
```

Useful supporting services depend on enabled features:

```bash
systemctl status libvirtd --no-pager
systemctl status docker --no-pager
systemctl status NetworkManager --no-pager
```

Restart LightNAS after an update:

```bash
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

## 4. Important paths

Default application checkout:

```text
/opt/lightnas
```

Persistent LightNAS data:

```text
/var/lib/lightnas
```

Host-agent Unix socket:

```text
/run/lightnas/host-agent.sock
```

Runtime configuration:

```text
/etc/lightnas/runtime.env
/etc/lightnas/product-mode.env
```

The web interface normally listens on:

```text
http://<LightNAS-IP>:3080
```

## 5. Web interface behavior and performance

LightNAS uses a cache-first interface. Pages should render from the most recently known state and then refresh live information asynchronously.

Runtime inventory is warmed after service startup and uses stale-while-revalidate behavior. Normal navigation should not wait for a complete Docker, libvirt, storage and network discovery cycle.

If an API request takes longer than 1.2 seconds, the browser developer console records a message beginning with:

```text
[LightNAS slow API]
```

That entry is useful when reporting a slow page.

## 6. Storage

LightNAS distinguishes between:

- the filesystem that stores LightNAS data
- configured LightNAS storage pools
- storage spaces under the LightNAS file area
- physical disks visible to the operating system
- optional ZFS pools/datasets when ZFS is available and delegated

Inside an LXC, the appliance may legitimately report no physical disks because the outer host controls device visibility. Mounted storage and bind-mounted paths can still be used.

Useful checks:

```bash
lsblk -f
findmnt
df -h
zpool list 2>/dev/null || true
zfs list 2>/dev/null || true
```

## 7. Files and media

Files are managed through the LightNAS file area under `/var/lib/lightnas`.

The interface supports:

- folders
- multiple-file upload
- folder upload
- file download
- supported media previews
- document/photo/video/audio library views
- FFmpeg-backed conversion when FFmpeg is installed

If the Files page is slow, first verify storage latency and free space.

## 8. App Store

The App Store is a Docker/OCI application engine. It is separate from native LXC System Containers.

The UI uses:

- a built-in catalog
- a community catalog
- background catalog prewarming
- cached catalog state so a fresh page does not require manual refresh

Useful checks:

```bash
docker info
docker ps -a
systemctl status docker --no-pager
```

## 9. System Containers

System Containers use native LXC/liblxc, not Docker.

Useful checks:

```bash
lxc-ls --fancy
systemctl status lightnas-host-agent --no-pager
```

When LightNAS itself runs inside Proxmox LXC, nested LXC requires capabilities granted by the outer container. The Proxmox helper prepares nesting, KVM/TUN/vhost devices when available, and required runtime packages.

## 10. Virtual Machines

Virtual machines use QEMU/KVM through libvirt.

Useful checks:

```bash
ls -l /dev/kvm
virsh list --all
virsh net-list --all
systemctl status libvirtd --no-pager
```

If `/dev/kvm` is unavailable, QEMU can fall back to software emulation in supported nested scenarios. Windows guests will be significantly slower under software emulation.

VM inventory is cached and per-VM detail discovery is parallelized so the UI does not have to inspect every VM serially before rendering.

## 11. noVNC console

The VM console uses noVNC in the browser and a LightNAS WebSocket-to-QEMU VNC bridge.

To reduce console-open delay, LightNAS:

- keeps running VM VNC targets warm in memory
- caches VNC target information
- refreshes cached targets after VM restarts
- uses `TCP_NODELAY`
- reconnects quickly when QEMU recreates its VNC listener

Useful checks:

```bash
virsh vncdisplay <vm-name>
ss -ltnp | grep 59
journalctl -u lightnas-host-agent -n 100 --no-pager
```

## 12. Windows VM performance

Windows installation starts with compatibility-oriented virtual hardware so Setup can see the disk and network without requiring VirtIO drivers first.

After installing the VirtIO guest drivers, administrators can move toward VirtIO-backed storage/network devices for better performance. Do not switch a Windows boot disk to VirtIO until the matching guest driver is installed.

If the LightNAS appliance itself has no usable `/dev/kvm`, changing guest devices does not eliminate the performance cost of QEMU software emulation.

## 13. Networking and firewall

LightNAS uses the host network stack and NetworkManager for editable networking.

Supported workflows include:

- DHCP/static IPv4
- DNS and gateway settings
- Ethernet and Wi-Fi profiles
- bridges
- VLANs
- firewall rules
- guest virtual networks

Useful checks:

```bash
ip -br addr
ip route
nmcli connection show
virsh net-list --all
nft list ruleset
```

## 14. Users and permissions

LightNAS local accounts protect web/API access. They are separate from Linux, SMB, LDAP and Active Directory accounts unless an integration explicitly provides that behavior.

Administrative actions require matching LightNAS permissions.

Use TLS when credentials or sensitive data travel across networks you do not fully trust.

## 15. Backups

The NAS interface includes backup-job management with schedule, storage, retention and selection fields.

A backup record and a completed data backup are not the same thing. Verify the configured provider, destination and task result before relying on a backup for recovery.

## 16. Updating an existing installation

Standard checkout:

```bash
cd /opt/lightnas
git checkout main
git pull origin main
npm install --omit=dev --no-audit --no-fund
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

For testing an unmerged branch:

```bash
cd /opt/lightnas
git fetch origin
git checkout <branch-name>
git pull origin <branch-name>
npm install --omit=dev --no-audit --no-fund
systemctl restart lightnas-host-agent lightnas
```

Then hard-refresh the browser.

## 17. Standard support triage

Collect these first:

```bash
cd /opt/lightnas
git log -5 --oneline

systemctl --no-pager --full status lightnas lightnas-host-agent
journalctl -u lightnas -n 150 --no-pager
journalctl -u lightnas-host-agent -n 150 --no-pager

ip -br addr
ip route
df -h

docker ps -a 2>/dev/null || true
virsh list --all 2>/dev/null || true
virsh net-list --all 2>/dev/null || true
lxc-ls --fancy 2>/dev/null || true
```

For UI problems also record:

- page or button used
- approximate delay in seconds
- browser/version
- screenshot
- browser developer-console errors
- any `[LightNAS slow API]` line
- whether `Ctrl+F5` was performed

## 18. Security and support boundaries

LightNAS is not a replacement for network segmentation, TLS, endpoint security or backups.

Do not expose an unprotected LightNAS HTTP management interface directly to the public Internet.

Support documentation should distinguish between:

1. current implemented behavior
2. experimental behavior
3. future architecture

The repository and running system are the source of truth for what is implemented.

## 19. Licensing and release stage

LightNAS is currently **pre-production software for development and early testing only**.

The current source is distributed under the **LightNAS Development and Community Evaluation License** and is **not currently open source**.

Community users may use the current build without a license fee for permitted personal lab, development, evaluation, education, and early testing purposes. Production, enterprise, commercial, hosting, managed-service, and organizational operational use require a separate paid LightNAS license.

The default Community status in the interface does not authorize production or enterprise use.

The project may release designated portions under an open-source license after development and testing reach an appropriate stage. Any future open-source release will explicitly identify the applicable version/files and license.

See the repository `LICENSE` file for the complete terms.
