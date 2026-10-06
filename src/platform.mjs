import { arch as osArch } from 'node:os';

export const ARCH_ALIASES = Object.freeze({
  x64: 'amd64',
  amd64: 'amd64',
  x86_64: 'amd64',
  arm64: 'arm64',
  aarch64: 'arm64',
  arm: 'armhf',
  armhf: 'armhf',
  ia32: 'i386',
  i386: 'i386',
  i686: 'i386',
  riscv64: 'riscv64'
});

export function normalizeArchitecture(value = osArch()) {
  const key = String(value || '').trim().toLowerCase();
  return ARCH_ALIASES[key] || key || 'unknown';
}

export function hostArchitecture() {
  return normalizeArchitecture(process.arch || osArch());
}

// "validated" means release/boot qualification exists in this repository.
// Other entries are explicit engineering targets and must not be advertised
// as generally supported until their validation job is enabled and passing.
export const PLATFORM_SUPPORT = Object.freeze({
  amd64: { status: 'validated', controlPlane: 'node22', installer: true },
  arm64: { status: 'target', controlPlane: 'node22', installer: false },
  riscv64: { status: 'target', controlPlane: 'pending-runtime-validation', installer: false },
  i386: { status: 'legacy-target', controlPlane: 'legacy-light-runtime-required', installer: false },
  armhf: { status: 'legacy-target', controlPlane: 'legacy-light-runtime-required', installer: false }
});

export function platformSupport(architecture = hostArchitecture()) {
  const normalized = normalizeArchitecture(architecture);
  return {
    architecture: normalized,
    ...(PLATFORM_SUPPORT[normalized] || { status: 'unsupported', controlPlane: 'unsupported', installer: false })
  };
}

export function architectureCompatible(imageArchitecture, host = hostArchitecture(), emulation = false) {
  const image = normalizeArchitecture(imageArchitecture);
  const machine = normalizeArchitecture(host);
  if (!image || image === 'unknown') return true;
  if (image === machine) return true;
  return Boolean(emulation);
}
