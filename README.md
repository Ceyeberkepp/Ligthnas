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
- Live Networking, Firewall, and Integrations status pages that read host inventory without modifying network policy
- Available capacity and mount location of the actual LightNAS file directory, even when an LXC exposes no physical disk
- Media and image folders for documents, photos, videos, and ISO uploads; multiple file uploads stream up to 1 GB each
- FFmpeg-backed media conversion to MP4, WebM, MP3, JPEG, PNG and WebP (when the input contains a compatible stream)
- SMTP relay settings with TLS or STARTTLS, optional authentication, certificate validation and a test-send action
- Creation of ZFS datasets in existing pools and compression/quota edits on hosts that delegate ZFS permissions
- Containers and VMs pages listing Docker and libvirt resources if their daemons are accessible
- Optional Docker container creation, five in-app Docker recipes (Nginx, Jellyfin, Uptime Kuma, Heimdall and OpenSpeedTest) with install, start, stop, restart and removal controls, and ISO-based libvirt VM creation on equipped hosts
- Authenticated file browser backed by the appliance data directory: create folders, streamed upload/download, and delete files or empty folders
- Hardware eligibility estimates for core NAS, containers, VMs, local AI, and directory services
- Persistent planned-share records for SMB, NFS, and SFTP workflows (create/remove plans; configuration only)
- Recent activity timeline
- Atomic local configuration writes
- API validation, request-size limits, security headers, and protected endpoints
- Automated tests for setup, authentication, inventory, and share creation

The storage screen displays the real available capacity of the appliance file directory, even if no physical disks are visible. If the data directory resides on the OS filesystem, the UI says so explicitly. For separate local storage, attach a Proxmox mount point or existing filesystem at `/var/lib/lightnas` before installation and verify its capacity in Storage. The installer does not partition or format a disk. The storage screen also reads host mount information, block-device metadata, and, if installed and accessible, `zpool list` and `zfs list`. Inside LXC it may show no physical disks or pools. Storage spaces are directories under `/var/lib/lightnas/files/Spaces` on the LXC's existing filesystem, not independently redundant pools. LightNAS does **not** create physical ZFS pools, modify Samba/NFS exports, or partition disks. On a host with existing ZFS pools and delegated permissions, enable `LIGHTNAS_ZFS_ENABLED=1` in `/etc/lightnas/runtime.env` to allow dataset creation and property changes. Saved share plans do not create real shares. Uploads are limited to 1 GB per file and available disk space. ISO uploads under Files/ISO are not automatically made available to libvirt hosts. Media conversion uses the installed FFmpeg codecs and is limited to five minutes per job; video encoding can consume significant CPU and may fail for unsupported inputs. Document indexing is not implemented. SMTP credentials are stored in the owner-only appliance state file and must be protected with host backups and a TLS reverse proxy. Local users can manage files but cannot access admin APIs; these are LightNAS accounts, not Linux, LDAP, or SMB accounts. The interface is plain HTTP on the LAN: use a TLS reverse proxy and trusted network before handling sensitive files or passwords.

## Container and VM runtimes

The normal one-command installer now installs Docker, starts it, gives the LightNAS service account Docker access, and verifies it with a real `docker info` call as that account. This account then has **host-level privileges through Docker**. Set `LIGHTNAS_SKIP_DOCKER=1` before running the installer to opt out. It also installs KVM, libvirt, and `virt-install` on supported x86-64 bare-metal or nested-VM hosts with `/dev/kvm`, tests libvirt access as `lightnas`, and starts existing `default` storage and network resources. It never tries to install KVM inside an LXC or on a Proxmox host. A missing libvirt network, storage pool or installer ISO must still be configured. The installer reports the verified status of both runtimes in `/var/lib/lightnas/runtime-status.txt` and the VM/Containers pages show live checks.

**Running on the existing `nasos` LXC:** Proxmox must enable `nesting=1,keyctl=1` for Docker inside this LXC; other host constraints can still prevent it from starting. The Proxmox-host helper `scripts/proxmox-lxc-install.sh 170` preserves existing feature flags, applies these two flags, gracefully restarts that LXC if its configuration changed, copies the public Proxmox CA certificate, and runs the normal installer inside it. Run that script **on the Proxmox host**, not inside the LXC, and expect a brief interruption if features change. If Docker still fails, read `/var/lib/lightnas/runtime-status.txt` and `journalctl -u docker`. For a production app host, [Proxmox recommends running Docker in a QEMU VM](https://pve.proxmox.com/wiki/Linux_Container).

A Proxmox LXC cannot host local KVM. To create VMs from LightNAS in this LXC, connect it to the Proxmox HTTPS API. The installer offers an interactive connection prompt on a terminal; enter the Proxmox HTTPS hostname, node name and a dedicated API token. It stores the token in the root-owned `/etc/lightnas/runtime.env` (mode 0600), verifies the server certificate using the OS trust store, and exposes only available storage, bridges and ISO images in the VM form. Create a dedicated Proxmox API token with permission to audit the node and storage, allocate VMs and storage, and edit VM configuration; add VM.PowerMgmt to boot the new VM. For a Proxmox-generated certificate, the LXC must trust the Proxmox cluster CA, and the URL hostname must match the server certificate. The host helper copies the public CA and runs `update-ca-certificates` automatically; it never copies a private key. You can rerun `bash /opt/lightnas/scripts/configure-proxmox.sh` from an interactive LXC root console to connect later. The token is never returned to the browser. VM creation waits for the Proxmox create task, then requests a boot when the token has VM.PowerMgmt. Open the VM console in Proxmox to complete the ISO installer. If a task fails or times out, check the Proxmox task log before trying again.

You can alternatively use local libvirt when LightNAS runs on a KVM-capable bare-metal or nested VM host. Upload a bootable ISO into `/var/lib/libvirt/images` (or configure `LIGHTNAS_VM_ISO_DIR`), and ensure there is an active pool and network. VM disk creation uses a new qcow2 volume without formatting an existing physical disk. The ISO build is still experimental and has its own package setup; this section covers the Debian/Ubuntu `install.sh` path.

## Bootable installer build (experimental)

`iso/build.sh` prepares a Debian 13 amd64 ISO hybrid live image with the Debian interactive installer and the LightNAS control plane included. The Debian installer asks the operator to select and partition the OS target disk. It does not preselect a disk, and the installer must be tested in a VM before writing it to USB or using it on a NAS. On a separate Debian or Ubuntu build machine with network access and sufficient disk space:

```bash
sudo apt-get install live-build debootstrap xorriso squashfs-tools
sudo bash iso/build.sh
```

The build writes `dist/LightNAS-amd64.iso` and a SHA-256 file. A successful GitHub Actions build produces a bootable-format ISO and uploads it under **Artifacts** on the [ISO build run](https://github.com/Ceyeberkepp/Ligthnas/actions/workflows/build-iso.yml); the artifact is a ZIP containing the ISO and checksum. The image has not yet been boot-tested in a VM or installed on disk. Treat it as experimental, test with an expendable virtual disk first, and do not install it over existing NAS data. The current running LXC is only for testing the control plane.

## App interoperability

The built-in LightNAS catalog installs reviewed open-source Docker recipes for Nginx, Jellyfin, Uptime Kuma, Heimdall and OpenSpeedTest directly inside the LightNAS interface. It can start, stop, restart, or remove managed app containers; persistent app settings under `/var/lib/lightnas/apps` remain after removal. A Proxmox Helper Script targets the Proxmox host, and LightNAS never runs arbitrary downloaded scripts inside its NAS LXC. A future Proxmox integration will need a separate authenticated host connection and audited deployment plans. The complete upstream Helper Scripts collection cannot be installed by this LXC: those scripts require a root shell on the Proxmox host and can prompt for input. Integrating that collection safely requires an authenticated Proxmox host executor with audited plans and log streaming. Direct remote catalog syncing and Compose imports are not implemented. On an LXC without a Docker engine, the Install button explains the missing host runtime and cannot install until a supported Docker host is configured.

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

The installer now attempts Docker automatically and prepares KVM/libvirt when the host supports `/dev/kvm`. It reports which runtime is actually available. To skip Docker, run `LIGHTNAS_SKIP_DOCKER=1 bash /root/lightnas-install.sh` after downloading the installer.

On the **Proxmox node shell** (prompt such as `root@pve:~#`), with the existing LXC 170, you can use the host preparation and install helper instead. Do not run this helper at the `root@nasos:~#` prompt: `nasos` is inside the LXC and cannot change its own Proxmox configuration:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/scripts/proxmox-lxc-install.sh -o /root/proxmox-lxc-install.sh
bash /root/proxmox-lxc-install.sh 170
```

To update the web service only from `root@nasos:~#`, run the normal `install.sh` command above instead. The host helper preserves the NAS account and data. If features have to change, it gracefully restarts the LXC before installation. Follow the secure API-token prompt to connect VM creation to Proxmox. If running without a terminal, run `/opt/lightnas/scripts/configure-proxmox.sh` later from a root console in the LXC. The Proxmox host remains the owner of the VM hardware and physical storage. Check `/var/lib/lightnas/runtime-status.txt` for the results.

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
