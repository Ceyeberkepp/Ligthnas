# Lightweight AI NAS OS

This repository contains the first runnable vertical slice of Lightweight AI NAS OS: a low-dependency Node control plane and responsive browser interface designed to remain practical on constrained hardware.

## What works now

- Safe first-run appliance setup
- Appliance Settings page for changing the device name, display time zone, and administrator password (requires the current password; password changes sign out every session)
- Scrypt password hashing and secure, HTTP-only login sessions
- Responsive login, dashboard, sidebar, and mobile navigation
- Live Linux CPU, memory, kernel, uptime, disk, mount, and accessible ZFS pool/dataset inventory
- Storage Pools page listing actual accessible ZFS pools; create and rename persistent file-backed storage spaces within LightNAS Files
- Local user management with administrator-only control endpoints and regular users who can manage files
- Dedicated Admin Center with account controls including disable, enable, password reset and session revocation
- Grouped navigation with Admin Center anchored at the bottom, and system, light, or dark appearance preferences
- Editable local Networking and Firewall controls backed by the privileged LightNAS host daemon, including Ethernet/Wi-Fi connection selection, DHCP/static IPv4, DNS/gateway, bridges, VLANs and UFW rules
- Available capacity and mount location of the actual LightNAS file directory, even when an LXC exposes no physical disk
- Media and image folders for documents, photos, videos, and ISO uploads; multiple file uploads stream up to 1 GB each
- FFmpeg-backed media conversion to MP4, WebM, MP3, JPEG, PNG and WebP (when the input contains a compatible stream)
- SMTP relay settings with TLS or STARTTLS, optional authentication, certificate validation and a test-send action
- Creation of ZFS datasets in existing pools and compression/quota edits on hosts that delegate ZFS permissions
- Native System Containers page backed by LXC/liblxc and native Virtual Machines page backed by QEMU/KVM + libvirt
- Native LXC system-container creation/lifecycle/terminal, native KVM VM creation/lifecycle/edit/noVNC, and an optional separate Docker/OCI App Store engine
- Authenticated file browser backed by the appliance data directory: create folders, streamed upload/download, and delete files or empty folders
- Hardware eligibility estimates for core NAS, containers, VMs, local AI, and directory services
- Persistent planned-share records for SMB, NFS, and SFTP workflows (create/remove plans; configuration only)
- Recent activity timeline
- Atomic local configuration writes
- API validation, request-size limits, security headers, and protected endpoints
- Automated tests for setup, authentication, inventory, and share creation

The storage screen displays the real available capacity of the appliance file directory, even if no physical disks are visible. If the data directory resides on the OS filesystem, the UI says so explicitly. For separate local storage, attach a Proxmox mount point or existing filesystem at `/var/lib/lightnas` before installation and verify its capacity in Storage. The installer does not partition or format a disk. The storage screen also reads host mount information, block-device metadata, and, if installed and accessible, `zpool list` and `zfs list`. Inside LXC it may show no physical disks or pools. Storage spaces are directories under `/var/lib/lightnas/files/Spaces` on the LXC's existing filesystem, not independently redundant pools. LightNAS does **not** create physical ZFS pools, modify Samba/NFS exports, or partition disks. On a host with existing ZFS pools and delegated permissions, enable `LIGHTNAS_ZFS_ENABLED=1` in `/etc/lightnas/runtime.env` to allow dataset creation and property changes. Saved share plans do not create real shares. Uploads are limited to 1 GB per file and available disk space. ISO uploads under Files/ISO are not automatically made available to libvirt hosts. Media conversion uses the installed FFmpeg codecs and is limited to five minutes per job; video encoding can consume significant CPU and may fail for unsupported inputs. Document indexing is not implemented. SMTP credentials are stored in the owner-only appliance state file and must be protected with host backups and a TLS reverse proxy. Local users can manage files but cannot access admin APIs; these are LightNAS accounts, not Linux, LDAP, or SMB accounts. The interface is plain HTTP on the LAN: use a TLS reverse proxy and trusted network before handling sensitive files or passwords.

## Container and VM runtimes

LightNAS now treats virtualization as a **built-in OS function**, not as a dependency on Proxmox or another hypervisor control plane.

- **System containers:** native LXC/liblxc. LightNAS creates full Linux system containers with their own userspace, init/services, filesystem and network namespace while sharing the LightNAS kernel. Docker is not the Containers backend.
- **Virtual machines:** native QEMU/KVM managed through libvirt. LightNAS creates qcow2-backed guests, attaches ISO media, uses VirtIO devices, controls lifecycle through libvirt and exposes the guest console through embedded noVNC.
- **Privileged operations:** a root-owned `lightnas-host-agent.service` exposes a narrow Unix-socket API to the unprivileged Node control plane. It owns LXC lifecycle and host network/firewall mutations; it does not expose arbitrary shell execution.
- **Networking:** NetworkManager is the editable host network layer for wired Ethernet, Wi-Fi, connection profiles, DHCP/static IPv4, DNS/gateway, bridges and VLANs. UFW/nftables provide the firewall layer. Wi-Fi can be the appliance uplink; guests should normally use a routed/NAT virtual network when a station-mode Wi-Fi device cannot participate in a transparent Ethernet bridge.
- **Apps:** Docker/OCI is optional and separate. It is enabled only when `LIGHTNAS_ENABLE_DOCKER_APPS=1` is supplied. The App Store may use it, but the Containers page never does.

On bare metal or a normal VM, `install.sh` installs the native LXC and KVM/libvirt stack automatically. Hardware virtualization requires `/dev/kvm`; if it is missing, LightNAS reports VMs as unavailable instead of silently delegating creation to another host.

When LightNAS itself is installed inside an LXC, nested LXC/KVM depends on capabilities granted by the outer hypervisor. The Proxmox helper is only a **deployment/capability helper**: it enables nesting/mknod/keyctl and, when possible, passes `/dev/kvm` into the LightNAS appliance. After that, LightNAS creates and manages its own LXC containers and KVM virtual machines locally. Normal compute operations do not call `pct`, `qm`, or the Proxmox API.

This mirrors the underlying open-source architecture used by virtualization appliances: LXC-style kernel isolation for system containers and QEMU/KVM for full virtual machines. Incus is another open-source implementation of the same distinction, using LXC for system containers and QEMU for VMs.


## Bootable installer build (experimental)

`iso/build.sh` prepares a Debian 13 amd64 ISO hybrid live image with the Debian interactive installer and the LightNAS control plane included. The Debian installer asks the operator to select and partition the OS target disk. It does not preselect a disk, and the installer must be tested in a VM before writing it to USB or using it on a NAS. On a separate Debian or Ubuntu build machine with network access and sufficient disk space:

```bash
sudo apt-get install live-build debootstrap xorriso squashfs-tools
sudo bash iso/build.sh
```

The build writes `dist/LightNAS-amd64.iso` and a SHA-256 file. A successful GitHub Actions build produces a bootable-format ISO and uploads it under **Artifacts** on the [ISO build run](https://github.com/Ceyeberkepp/Ligthnas/actions/workflows/build-iso.yml); the artifact is a ZIP containing the ISO and checksum. The image has not yet been boot-tested in a VM or installed on disk. Treat it as experimental, test with an expendable virtual disk first, and do not install it over existing NAS data. The current running LXC is only for testing the control plane.

## App interoperability

The built-in App Store may use reviewed Docker/OCI recipes for services such as Nginx, Jellyfin, Uptime Kuma, Heimdall and OpenSpeedTest, but that engine is optional and intentionally separated from **System Containers**. Native LXC containers are for full Linux environments; OCI app containers are only an application deployment mechanism. Persistent app settings under `/var/lib/lightnas/apps` remain separate from LXC root filesystems.

## Run locally

Requirements: Linux or macOS and Node.js 22 or newer.

```bash
npm start
```

Open `http://127.0.0.1:3080`.

To make the preview reachable from another computer on the LAN:

```bash
NAS_HOST=0.0.0.0 npm start
```

Do not expose this development milestone directly to the public internet.

## One-command Debian/Ubuntu installation

Run as `root` on the NAS host or test LXC:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install.sh | bash
```

The installer adds Node.js 22 when required, checks out LightNAS under
`/opt/lightnas`, keeps appliance state under `/var/lib/lightnas`, and installs
an automatically starting `lightnas.service`. Open port `3080` at the IP shown
when installation finishes.

The installer prepares native LXC/liblxc and KVM/libvirt when the environment supports them. Docker is not installed for Containers; it is optional for the App Store and can be enabled explicitly with `LIGHTNAS_ENABLE_DOCKER_APPS=1`.

On the **Proxmox node shell** (prompt such as `root@pve:~#`), with the existing LXC 170, you can use the host preparation and install helper instead. Do not run this helper at the `root@nasos:~#` prompt: `nasos` is inside the LXC and cannot change its own Proxmox configuration:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/scripts/proxmox-lxc-install.sh -o /root/proxmox-lxc-install.sh
bash /root/proxmox-lxc-install.sh 170
```

To update the web service only from inside the appliance, run the normal `install.sh` command above. The Proxmox helper preserves the NAS account and data, grants nested runtime capabilities, passes `/dev/kvm` when possible, and then installs the same local LightNAS engines used on bare metal. No Proxmox API token is required for normal LightNAS VM/container operations. Check `/var/lib/lightnas/runtime-status.txt` for capability results.

To update an existing Git-based installation, run `install.sh` again. It performs a fast-forward-only source update and preserves state under `/var/lib/lightnas`.

## Test

```bash
npm test
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NAS_HOST` | `127.0.0.1` | HTTP listen address |
| `NAS_PORT` | `3080` | HTTP listen port |
| `NAS_DATA_FILE` | `data/state.json` | Persistent control-plane state |
| `NAS_DEV` | unset | Disables static caching when set |

State is written atomically with owner-only file permissions. Production deployment will add TLS termination, encrypted secret storage, persistent sessions, CSRF tokens, rate limiting, and a root-owned privileged agent with a narrow authenticated command interface.

## Architecture

```text
Browser / PWA
    │
    ├── Responsive management UI
    │
HTTP API + job control plane (unprivileged)
    │
    ├── Authentication, RBAC, groups, 2FA and API/webhook layer
    ├── Hardware/capability discovery
    ├── Persistent configuration
    └── Typed operations / audit boundary
          │
          └── LightNAS privileged host daemon (local Unix socket)
                ├── Storage and filesystem operations
                ├── Native LXC/liblxc system containers
                │     └── interactive browser terminal
                ├── Native QEMU/KVM + libvirt virtual machines
                │     └── embedded noVNC
                ├── NetworkManager
                │     ├── Ethernet / Wi-Fi
                │     ├── DHCP / static addressing
                │     ├── bridges / VLANs
                │     └── DNS / gateways
                ├── UFW / nftables firewall
                └── Identity / backup adapters

Optional application engine
    └── Docker / OCI (App Store only; never the System Containers backend)

Optional external integrations
    └── Proxmox / other hypervisors for migration or interoperability only
        (not required for normal LightNAS compute)
```


## Next engineering milestone

The next milestone is the storage agent and operation framework:

1. Enumerate physical disks through `/sys`, `lsblk`, SMART, and udev.
2. Model disks, pools, filesystems, shares, and health independently.
3. Generate an exact impact preview for every storage mutation.
4. Run approved operations through a narrow root-owned service.
5. Add progress events, cancellation boundaries, logs, and rollback metadata.
6. Configure Samba/NFS shares with idempotent adapters and validation.

See `Lightweight_AI_NAS_OS_Design_Brief.md` for the complete product vision and phased roadmap.
