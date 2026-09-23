# LightNAS Build Validation

LightNAS uses automated build gates to keep implementation aligned with the
platform requirements in [PLATFORM-REQUIREMENTS.md](PLATFORM-REQUIREMENTS.md).

## What "passes the build" means today

Every pull request must pass:

1. JavaScript/unit tests.
2. JavaScript, shell, and Python syntax validation.
3. The machine-readable platform contract in
   `config/platform-support.json`.
4. A low-memory control-plane smoke test.
5. Native-container architecture checks.
6. Large-upload contract checks.

Run the platform gate locally with:

```bash
npm run check:platform
```

## Resource baseline

The product target remains:

```text
RAM:            2 GiB minimum
System storage: 35 GiB minimum
```

The CI smoke test starts the current Node control plane with:

```text
Node heap limit: 256 MiB
Idle RSS gate:   <= 300 MiB
```

This does not prove every possible workload fits in 2 GiB. It prevents the
base control plane from silently growing beyond the intended low-resource
design. Container, VM, media, AI, and application workloads have their own
resource needs and must be capability-gated.

## Architecture status

The authoritative status is stored in:

```text
config/platform-support.json
```

Current release qualification:

| Architecture | Control plane | System containers | Boot artifact |
| --- | --- | --- | --- |
| amd64 / x86_64 | supported | supported | ISO |
| i386 / 32-bit x86 | target | target | target |
| arm64 / aarch64 | target | target | target |
| armhf / 32-bit ARM | target | target | target |
| riscv64 | target | target | target |

"Target" means LightNAS is required to support the architecture, but the
repository must not claim it is production-supported until boot/install and
runtime tests pass on that architecture.

## Native system-container architecture behavior

System-container creation must be architecture-neutral.

For Debian/Ubuntu builds LightNAS obtains the native Debian architecture with:

```bash
dpkg --print-architecture
```

with a machine-name fallback for:

```text
amd64
i386
arm64
armhf
riscv64
```

LightNAS passes that native architecture to debootstrap rather than forcing
amd64.

On non-x86 Ubuntu hosts, the container builder uses:

```text
https://ports.ubuntu.com/ubuntu-ports
```

Native manually generated LXC configuration does not force
`lxc.arch=x86_64`; LXC uses the native host/container architecture unless a
specific imported image explicitly requires otherwise.

## Upload validation

Large storage-image uploads must remain streaming.

Current storage-image behavior:

- Maximum default size: 50 GiB.
- ISO browser transfer window: 64 MiB.
- Other storage-image transfer window: 32 MiB.
- Content-Range chunk/resume protocol.
- Direct stream to a partial file on target storage.
- Atomic rename after completion.
- Free-space check plus safety reserve.
- URL-side server download option.
- Transfer rate and ETA in the browser.

The generic Files uploader also defaults to 50 GiB and streams through Node
without loading the whole file into memory.

Full cross-session resume and further upload-speed work remain tracked in the
ISO performance issue.

## ISO/build artifacts

The current release-qualified bootable image is still:

```text
LightNAS-amd64.iso
```

That is deliberate. The build must not rename or market the existing amd64 ISO
as a universal image.

ARM and RISC-V systems frequently require architecture/platform-specific boot
images rather than a PC-style ISO. Those artifacts must be built and validated
separately before their status changes from `target` to `supported`.

## Legacy x86

The current modern control plane requires Node.js 22. That is not a valid
guarantee for every 32-bit x86 processor dating to approximately 2000.

Therefore CI enforces that i386 remains marked `target` until a tested legacy
control-plane runtime/build exists.

The long-term requirement is still to provide a compatible LightNAS experience
on that hardware class without forcing modern CPU instruction sets.

## Release rule

An architecture or resource class is moved from `target` to `supported`
only after:

1. Installer completes on that target.
2. LightNAS boots successfully.
3. Management UI/API starts.
4. Storage inventory works.
5. A compatible native system container can be created and started.
6. Network connectivity works.
7. File upload/download works.
8. Upgrade/reinstall preserves state.
9. Automated or repeatable hardware/emulator validation exists.

Documentation alone is not sufficient for a support claim.
