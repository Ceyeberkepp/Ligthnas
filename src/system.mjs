import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';

const GIB = 1024 ** 3;

async function readText(path, fallback = '') {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
}

async function cpuCapabilities() {
  const cpuInfo = await readText('/proc/cpuinfo');
  const flagsLine = cpuInfo.split('\n').find((line) => /^(flags|Features)\s*:/.test(line));
  const flags = new Set((flagsLine?.split(':')[1] || '').trim().split(/\s+/));
  return {
    hardwareVirtualization: flags.has('vmx') || flags.has('svm'),
    aesAcceleration: flags.has('aes'),
    avx: flags.has('avx'),
    avx2: flags.has('avx2')
  };
}

function capability(name, available, reason, minimum) {
  return { name, available, reason: available ? null : reason, minimum };
}

export async function getSystemSnapshot() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const cores = os.cpus();
  const cpu = await cpuCapabilities();
  const ramGiB = totalMemory / GIB;
  const load = os.loadavg()[0];
  const loadPercent = Math.min(100, Math.round((load / Math.max(cores.length, 1)) * 100));

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    architecture: os.arch(),
    kernel: os.release(),
    uptimeSeconds: os.uptime(),
    cpu: {
      model: cores[0]?.model?.trim() || 'Unknown processor',
      cores: cores.length,
      loadPercent,
      ...cpu
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: totalMemory - freeMemory,
      usedPercent: Math.round(((totalMemory - freeMemory) / totalMemory) * 100)
    },
    capabilities: [
      capability('Core NAS', totalMemory >= 1.5 * GIB, 'At least 2 GB RAM is recommended.', '2 GB RAM'),
      capability('Containers', ramGiB >= 4 && os.arch() === 'x64', 'Requires a 64-bit CPU and at least 4 GB RAM.', '4 GB RAM, x86-64'),
      capability('Virtual machines', ramGiB >= 8 && cpu.hardwareVirtualization, 'Requires VT-x/AMD-V and at least 8 GB RAM.', '8 GB RAM, VT-x/AMD-V'),
      capability('Local AI', ramGiB >= 16 && os.arch() === 'x64', 'Use a remote or network AI provider on this hardware.', '16 GB RAM, modern x86-64'),
      capability('Directory services', ramGiB >= 8, 'Joining a directory is supported earlier; hosting one requires 8 GB RAM.', '8 GB RAM')
    ]
  };
}

export async function getFilesystems() {
  const mounts = await readText('/proc/mounts');
  const ignored = /^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2?|overlay|squashfs|securityfs|pstore|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|rpc_pipefs|autofs|binfmt_misc)$/;
  const seen = new Set();
  const entries = [];

  for (const line of mounts.trim().split('\n')) {
    const [device, mountPointEncoded, type, options] = line.split(' ');
    if (!device || ignored.test(type)) continue;
    const mountPoint = mountPointEncoded.replaceAll('\\040', ' ');
    if (seen.has(mountPoint)) continue;
    seen.add(mountPoint);
    try {
      const stats = await statfs(mountPoint, { bigint: true });
      const total = Number(stats.blocks * stats.bsize);
      const available = Number(stats.bavail * stats.bsize);
      entries.push({
        id: Buffer.from(`${device}:${mountPoint}`).toString('base64url'),
        device,
        mountPoint,
        type,
        readOnly: options.split(',').includes('ro'),
        totalBytes: total,
        availableBytes: available,
        usedBytes: Math.max(0, total - available),
        usedPercent: total ? Math.round(((total - available) / total) * 100) : 0
      });
    } catch {
      // A mount may disappear while inventory is running.
    }
  }

  return entries.sort((a, b) => b.totalBytes - a.totalBytes);
}
