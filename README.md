# Lightweight AI NAS OS

This repository contains the first runnable vertical slice of Lightweight AI NAS OS: a low-dependency Node control plane and responsive browser interface designed to remain practical on constrained hardware.

## What works now

- Safe first-run appliance setup
- Appliance Settings page for changing the device name, display time zone, and administrator password (requires the current password; password changes sign out every session)
- Scrypt password hashing and secure, HTTP-only login sessions
- Responsive login, dashboard, sidebar, and mobile navigation
- Live Linux CPU, memory, kernel, uptime, disk, mount, and accessible ZFS pool/dataset inventory
- Storage Pools page listing actual accessible ZFS pools (pool creation still requires a privileged host agent)
- Containers and VMs pages listing Docker and libvirt resources if their daemons are accessible
- Optional Docker container creation, two built-in one-click Docker app recipes (Nginx and Jellyfin), and ISO-based libvirt VM creation on equipped hosts
- Authenticated file browser backed by the appliance data directory: create folders, upload/download files (32 MB upload limit), and delete files or empty folders
- Hardware eligibility estimates for core NAS, containers, VMs, local AI, and directory services
- Persistent planned-share records for SMB, NFS, and SFTP workflows (create/remove plans; configuration only)
- Recent activity timeline
- Atomic local configuration writes
- API validation, request-size limits, security headers, and protected endpoints
- Automated tests for setup, authentication, inventory, and share creation

The current storage screen reads host mount information, block-device metadata, and, if installed and accessible, the output of `zpool list` and `zfs list`. Inside LXC it may show no physical disks or pools. It does **not** create pools or datasets, modify Samba/NFS exports, or partition disks. Saved share plans do not create real shares. Files uploaded in the browser live under `/var/lib/lightnas/files` in a service installation; they are not accessible over SMB/NFS and are subject to the disk space available to that host or container. The Files page is intended for small files in this milestone; larger files will need streamed transfers.

## Container and VM runtimes (optional)

LightNAS discovers Docker and libvirt through the host's installed command-line clients. Existing resource inventory is read-only. Creation is disabled by default. **Container 170 (`nasos`) is an LXC and is not a KVM host or a physical storage controller.** The VM and pool creation features need a bare-metal system or appropriately configured virtualization host. The ISO installer places the same UI on bare metal, but it does not automatically install Docker, libvirt or ZFS.

On a dedicated, trusted Docker or libvirt test host, install and configure the relevant runtime separately; then grant the `lightnas` service account permission to use that runtime. For Docker, group membership usually grants root-equivalent access to the host, so this is an explicit operator decision. After the runtime is working, set the corresponding variable in a root-owned `/etc/lightnas/runtime.env`:

```text
LIGHTNAS_DOCKER_ENABLED=1
LIGHTNAS_VM_ENABLED=1
```

Include only the runtime you have configured. Restart `lightnas.service` after the change. VM creation requires `virt-install`, a running `qemu:///system` libvirt connection, an active libvirt storage pool and network, and readable `.iso` files under `/var/lib/libvirt/images` (or the root-configured `LIGHTNAS_VM_ISO_DIR`). VM images are created as new qcow2 volumes; an installer ISO is booted with a local-only VNC console. Docker app recipes publish ports 8081 (Nginx) and 8096 (Jellyfin) on the host; check host firewall policy before enabling them. This prototype management UI uses HTTP: add TLS and limit network access before enabling privileged runtimes on a production NAS.

## Bootable installer build (experimental)

`iso/build.sh` prepares a Debian 13 amd64 ISO hybrid live image with the Debian interactive installer and the LightNAS control plane included. The Debian installer asks the operator to select and partition the OS target disk. It does not preselect a disk, and the installer must be tested in a VM before writing it to USB or using it on a NAS. On a separate Debian or Ubuntu build machine with network access and sufficient disk space:

```bash
sudo apt-get install live-build debootstrap xorriso squashfs-tools
sudo bash iso/build.sh
```

The build writes `dist/LightNAS-amd64.iso` and a SHA-256 file. A successful GitHub Actions build produces a bootable-format ISO and uploads it under **Artifacts** on the [ISO build run](https://github.com/Ceyeberkepp/Ligthnas/actions/workflows/build-iso.yml); the artifact is a ZIP containing the ISO and checksum. The image has not yet been boot-tested in a VM or installed on disk. Treat it as experimental, test with an expendable virtual disk first, and do not install it over existing NAS data. The current running LXC is only for testing the control plane.

## App interoperability

The built-in LightNAS catalog currently has two Docker recipes. TrueNAS SCALE supports third-party apps through Docker images and Compose YAML; compatible recipes can be adapted to LightNAS with translated storage paths, permissions and network settings. LightNAS cannot connect to TrueNAS's native store or import Compose definitions yet. Proxmox Helper Scripts target the Proxmox host and are not executed inside a NAS LXC; direct Proxmox integration is not implemented. Synology `.spk` packages target DSM-specific APIs and packaging, so they cannot be installed unchanged.

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

To update an existing Git-based installation, run the same command again.
The installer performs a fast-forward-only source update and preserves the
state stored in `/var/lib/lightnas`.

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
Browser/PWA
    │
    ├── Responsive management UI
    │
HTTP API and job control plane
    │
    ├── Authentication and RBAC foundation
    ├── Hardware/capability discovery
    ├── Persistent configuration
    └── Future typed-operation queue
          │
          └── Future privileged host agent
                ├── Storage and file services
                ├── Containers and applications
                ├── KVM/QEMU virtual machines
                ├── Network and firewall
                └── Identity and backup
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
