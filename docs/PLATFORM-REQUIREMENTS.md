# LightNAS Platform, Hardware, Image, and Performance Requirements

This document defines non-negotiable design targets for LightNAS. These are
product requirements, not claims that every target is already implemented or
verified on every platform.

## 1. Minimum-footprint target

LightNAS must remain usable on a minimum appliance with:

- **2 GB RAM**
- **35 GB total system storage**
- One supported network interface
- One supported CPU architecture listed below

The control plane must not require a large always-on memory footprint just to
display the UI, manage files, or create containers.

### Memory budget

The 2 GB target is a hard compatibility goal.

Design rules:

- The LightNAS control plane must remain operational without swap.
- Heavy optional services must not be enabled just because LightNAS is
  installed.
- VM, AI, indexing, media-transcoding, and other memory-heavy features must be
  optional and capability-gated.
- Background inventory must be bounded and must not repeatedly scan the whole
  filesystem or all images.
- Large uploads must stream to storage and must never be buffered entirely in
  RAM.
- Container/image extraction must be streaming.
- Application logs and in-memory job history must be bounded.
- The UI must clearly report when a requested workload needs more RAM than the
  current hardware can safely provide.

Target control-plane budget on a 2 GB appliance:

- LightNAS Node control plane: **<= 300 MB RSS under ordinary administration**
- Privileged host agent: **<= 100 MB RSS**
- Remaining memory must stay available for the OS, filesystem cache, and user
  workloads.

These are engineering targets and must be verified by repeatable tests.

### Storage budget

A fresh LightNAS appliance must be able to run on a **35 GB system disk**.

Design rules:

- The base LightNAS install must not consume the entire disk.
- Package caches, downloaded templates, ISO images, OCI layers, thumbnails,
  logs, and temporary extraction data must be cleaned or bounded.
- Temporary extraction should use the target storage when possible rather than
  requiring a second full copy on the OS disk.
- Downloaded images must be cached intelligently and deduplicated where
  practical.
- Large uploads must verify available space before accepting data.
- User data pools remain separate from the 35 GB minimum system-storage target
  whenever separate storage is available.

## 2. CPU generation target

The project goal is to support hardware ranging from approximately **year 2000
through current-generation systems** where the selected operating system and
runtime can execute on that CPU.

This is a compatibility goal, not a claim that the current Node.js 22 build
already supports every processor in that date range.

### Required compatibility strategy

LightNAS must not assume modern instruction sets unless a feature specifically
requires them.

The project must avoid making the base control plane depend on:

- AVX
- AVX2
- AVX-512
- AES-NI
- recent GPU features
- hardware virtualization

Features may use those capabilities when detected, but the base appliance must
remain usable without them.

### Legacy x86

32-bit x86 and very early x86_64 hardware require a separate compatibility
strategy because current Node.js releases and several modern dependencies do
not support every legacy CPU/ABI combination.

Required direction:

- Detect architecture and CPU capabilities during install.
- Use a **legacy/light control-plane build** when the normal runtime cannot
  execute.
- Keep the browser UI protocol/API compatible between modern and legacy builds.
- Do not advertise a legacy platform as supported until automated or physical
  boot/install tests exist for that class.

## 3. Architecture targets

LightNAS must be designed for these architecture families:

| Architecture | Target status |
| --- | --- |
| x86_64 / amd64 | Primary |
| x86 / i686 | Required legacy compatibility target |
| ARM64 / aarch64 | Primary multi-architecture target |
| ARM 32-bit | Compatibility target where supported by the base OS |
| RISC-V 64 | Primary emerging architecture target |
| Other RISC-V variants | Future/compatibility target |

Architecture assumptions must not be hard-coded to amd64 in container,
download, image, installer, or VM workflows.

### Multi-architecture rules

- Image manifests must record architecture.
- The UI must not offer an image incompatible with the host architecture unless
  emulation is explicitly available.
- OCI/Docker images should use multi-architecture manifests when the upstream
  project publishes them.
- Native system-container images must be selected by architecture.
- VM ISO images must be labeled by architecture.
- Checksums must be architecture-specific.
- Build workflows should generate architecture-specific artifacts.

## 4. Ready-to-use image catalog

LightNAS must provide ready-to-use images/templates without requiring users to
manually search for compatible downloads.

### OCI / Docker application images

The App Store should support reviewed OCI/Docker images with architecture-aware
pulls and persistent storage definitions.

The catalog should prefer upstream multi-arch images.

Examples of categories:

- Web servers
- Media servers
- Monitoring
- Home automation
- Developer tools
- Databases
- Backup tools
- Collaboration
- AI services when hardware permits

### Native Linux system-container images

The System Containers catalog should provide major Linux families where legal,
technically supported, and available for the host architecture.

Target distribution families include:

- Debian
- Ubuntu
- Alpine
- Fedora
- Rocky Linux
- AlmaLinux
- CentOS Stream
- Arch Linux
- openSUSE
- Oracle Linux
- TurnKey Linux appliances where compatible
- Other widely used open-source Linux systems as tested templates become
  available

Images should be:

- Architecture-aware
- Versioned
- Checksum-verified
- Cached locally after first download
- Reused for subsequent container creation
- Marked with minimum RAM/storage requirements
- Marked when the image is community/tested/experimental

LightNAS must keep **OCI application images** and **full Linux system-container
images** conceptually separate in the UI even though both should be easy to
install.

## 5. ISO image support

ISO management must support large installer media efficiently.

The existing upload path must be improved so ISO upload time is limited mainly
by network/storage throughput rather than the LightNAS control plane.

Required behavior:

- Stream directly to the target storage.
- Do not buffer the whole ISO in RAM.
- Support files larger than 1 GB.
- Provide accurate byte-level progress.
- Support resumable/chunked uploads.
- Allow retrying only failed chunks rather than restarting the whole upload.
- Write to a temporary partial file and atomically finalize on success.
- Verify available free space before upload.
- Optional checksum verification must run after upload and should not block the
  transfer pipeline.
- Permit direct server-side download of an ISO from a URL when appropriate, so
  users do not have to download to a PC and re-upload it.
- Avoid copying an uploaded ISO a second time when VM storage can reference the
  existing file safely.

## 6. Faster application, image, and OS installation

Install speed is a core requirement.

### Main LightNAS installer

The installer should:

- Install only missing packages.
- Avoid repeated full package operations when dependencies are already
  satisfied.
- Avoid reinstalling unchanged Node dependencies.
- Preserve downloaded package/image caches when safe.
- Separate one-time platform preparation from ordinary LightNAS application
  updates.
- Clearly show which step is taking time.
- Support repair mode without rerunning expensive unrelated steps.

### System-container creation

Container creation should:

- Reuse cached rootfs/template downloads.
- Avoid downloading the same distribution release for every new container.
- Avoid duplicate decompression where safe cloning/snapshotting is available.
- Prefer copy-on-write or storage-native cloning when the backend supports it.
- Stream extraction.
- Avoid unnecessary post-install package upgrades before first boot.
- Start the container as soon as a valid rootfs and network are ready.

### OCI / Docker applications

Application installation should:

- Reuse existing OCI layers.
- Pull only missing layers.
- Prefer multi-architecture manifests.
- Display download/extract/start phases separately.
- Run health checks without unnecessarily delaying UI completion.

### VM installation

VM creation should:

- Reference existing ISO files without copying them.
- Use sparse/preallocated disk options appropriately.
- Create disks quickly and let the guest installer perform OS installation.
- Avoid blocking the UI while a guest installation is running.

## 7. Performance acceptance tests

Performance must be measured, not assumed.

CI and release qualification should eventually include:

- 2 GB RAM appliance test.
- 35 GB OS disk test.
- Low-core-count CPU test.
- Slow-disk test.
- Slow-network upload test.
- Large ISO upload test.
- Repeated container creation from a warm image cache.
- Cold image download + create test.
- x86_64 build/install test.
- ARM64 build/install test.
- RISC-V 64 build/install test when runners/emulation are available.
- Legacy x86 compatibility test when the legacy runtime exists.

No release should claim an architecture or hardware class as supported unless
the relevant install/boot test is passing.

## 8. UX requirements for slow hardware

Old hardware must not appear broken just because an operation is slow.

Long-running operations must expose:

- Current phase
- Progress where measurable
- Bytes downloaded/uploaded
- Transfer rate
- Elapsed time
- Cancel action when safe
- Retry action when safe
- Clear error reason

The browser should not freeze while uploads, image downloads, extraction,
package installation, checksumming, or VM operations are running.

## 9. Priority order

Engineering priority for this requirement set:

1. Fresh install reliability.
2. 2 GB RAM / 35 GB storage operation.
3. Direct LAN networking and basic container functionality.
4. ISO upload performance and resumable uploads.
5. Faster cached container/application installs.
6. Multi-architecture image catalog.
7. ARM64 release/build validation.
8. RISC-V 64 release/build validation.
9. Legacy x86 compatibility runtime and validation.

## 10. Definition of "out of the box"

For LightNAS, "out of the box" means a user installs LightNAS and does not need
to manually install dependencies, rewrite LXC files, install archive tools,
configure per-container networking, or manually discover compatible images.

The platform should detect the hardware, select compatible components, expose
only features that can run safely, and provide ready-to-use images appropriate
for that machine.
