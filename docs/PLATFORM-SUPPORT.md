# LightNAS Platform Support Matrix

LightNAS distinguishes **validated support** from engineering targets. A target
is not advertised as supported until an install/boot qualification exists and
passes in CI or documented physical-hardware validation.

| Architecture | Status | Base control plane | Installer claim |
| --- | --- | --- | --- |
| amd64 / x86_64 | Validated | Node.js 22 | Supported |
| arm64 / aarch64 | Target | Node.js 22 | Not yet release-qualified |
| riscv64 | Target | Pending runtime/build validation | Not yet release-qualified |
| i386 / i686 | Legacy target | Legacy/light control plane required | Not yet release-qualified |
| armhf / 32-bit ARM | Legacy target | Legacy/light control plane required | Not yet release-qualified |

## Rules

- Installers record the detected architecture.
- The standard installer refuses to claim an unvalidated architecture as
  supported unless the operator explicitly enables development override.
- Application and system-container catalogs normalize architecture names.
- Incompatible system-container images are hidden unless emulation is
  explicitly enabled.
- Image compatibility is rechecked on pull/install, not only in the browser.
- Checksums remain tied to the selected image/version.
- amd64 release qualification includes a 2 GiB RAM / 35 GiB system-disk boot
  smoke test.
- ARM64, RISC-V, and legacy x86 support remain targets until equivalent
  qualification jobs are added and passing.

## Resource qualification

The base appliance is engineered around a 2 GiB RAM / 35 GiB system-disk
minimum. The service units set memory budgets for the always-on control plane,
logs are bounded, uploads stream to disk, and CI boots the installer with the
minimum RAM/disk envelope. Optional workloads still have their own hardware
requirements.
