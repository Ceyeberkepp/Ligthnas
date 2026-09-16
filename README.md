# Lightweight AI NAS OS

This repository contains the first runnable vertical slice of Lightweight AI NAS OS: a low-dependency Node control plane and responsive browser interface designed to remain practical on constrained hardware.

## What works now

- Safe first-run appliance setup
- Scrypt password hashing and secure, HTTP-only login sessions
- Responsive login, dashboard, sidebar, and mobile navigation
- Live Linux CPU, memory, kernel, uptime, disk, mount, and accessible ZFS pool/dataset inventory
- Hardware eligibility estimates for core NAS, containers, VMs, local AI, and directory services
- Persistent planned-share records for SMB, NFS, and SFTP workflows (configuration only)
- Recent activity timeline
- Atomic local configuration writes
- API validation, request-size limits, security headers, and protected endpoints
- Automated tests for setup, authentication, inventory, and share creation

The current storage screen reads host mount information, block-device metadata, and, if installed and accessible, the output of `zpool list` and `zfs list`. Inside LXC it may show no physical disks or pools. It does **not** create pools or datasets, modify Samba/NFS exports, partition disks, or change user data. Saved share plans do not create real shares.

## Bootable installer build (experimental)

`iso/build.sh` prepares a Debian 13 amd64 ISO hybrid live image with the Debian interactive installer and the LightNAS control plane included. The Debian installer asks the operator to select and partition the OS target disk. It does not preselect a disk, and the installer must be tested in a VM before writing it to USB or using it on a NAS. On a separate Debian or Ubuntu build machine with network access and sufficient disk space:

```bash
sudo apt-get install live-build debootstrap xorriso squashfs-tools
sudo bash iso/build.sh
```

The build writes `dist/LightNAS-amd64.iso` and a SHA-256 file. A successful GitHub Actions build produces a bootable-format ISO and uploads it under **Artifacts** on the [ISO build run](https://github.com/Ceyeberkepp/Ligthnas/actions/workflows/build-iso.yml); the artifact is a ZIP containing the ISO and checksum. The image has not yet been boot-tested in a VM or installed on disk. Treat it as experimental, test with an expendable virtual disk first, and do not install it over existing NAS data. The current running LXC is only for testing the control plane.

## App interoperability

TrueNAS SCALE supports third-party apps through Docker images and Compose YAML. A future LightNAS app runtime can support compatible OCI images and Compose projects with translated storage paths, permissions, and network settings. Synology `.spk` packages target DSM-specific APIs and packaging, so they cannot be installed unchanged. Applications that publish standard OCI images can be packaged separately for LightNAS. No app catalog, import, or container installer is active in this release.

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
