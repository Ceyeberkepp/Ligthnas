import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { access, constants, readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const GIB = 1024 ** 3;
const execute = promisify(execFile);

async function command(file, args) {
  try {
    const { stdout } = await execute(file, args, { timeout: 4000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readText(path, fallback = '') {
  try { return await readFile(path, 'utf8'); }
  catch { return fallback; }
}

function isSystemMount(mountPoint) {
  return mountPoint === '/' || mountPoint === '/boot' || mountPoint === '/boot/efi' ||
    mountPoint === '/etc/hosts' || mountPoint === '/etc/hostname' || mountPoint === '/etc/resolv.conf' ||
    mountPoint === '/var/lib/lightnas-pve' || mountPoint.startsWith('/var/lib/lightnas-pve/');
}

export async function getStorageInventory() {
  const [blockDevices, pools, datasets, containerType, filesystems] = await Promise.all([
    command('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,MODEL,TRAN']),
    command('zpool', ['list', '-H', '-p', '-o', 'name,size,alloc,free,health']),
    command('zfs', ['list', '-H', '-p', '-o', 'name,used,available,mountpoint,compression']),
    command('systemd-detect-virt', ['--container']),
    getFilesystems()
  ]);
  const inContainer = Boolean(containerType && containerType !== 'none');
  let disks = [];
  try {
    disks = (JSON.parse(blockDevices).blockdevices || [])
      .filter(device => device.type === 'disk')
      .map(({ name, path, size, model, tran, children }) => ({
        name, path, sizeBytes: Number(size) || 0, model: model?.trim() || null,
        transport: tran || null, partitions: (children || []).map(child => ({
          name: child.name, path: child.path, sizeBytes: Number(child.size) || 0,
          filesystem: child.fstype || null, mountPoint: child.mountpoint || null
        }))
      }));
  } catch {}

  if (inContainer) disks = [];

  const rootFilesystem = filesystems.find(item => item.mountPoint === '/');
  const rootDevice = rootFilesystem?.device || null;
  const explicitDataPath = mountPoint => /^(\/mnt|\/media|\/srv|\/data|\/storage)(\/|$)/.test(mountPoint);
  const attachedVolumes = filesystems
    .filter(item => !isSystemMount(item.mountPoint) && item.totalBytes > 0)
    // systemd may create writable bind mounts such as /var/lib/lightnas and
    // /var/tmp on the root filesystem. Do not present those as extra disks.
    .filter(item => item.device !== rootDevice || explicitDataPath(item.mountPoint))
    .map(item => ({
      id: item.id,
      device: item.device,
      mountPoint: item.mountPoint,
      type: item.type,
      readOnly: item.readOnly,
      writable: item.writable,
      totalBytes: item.totalBytes,
      availableBytes: item.availableBytes,
      usedBytes: item.usedBytes,
      usedPercent: item.usedPercent
    }));

  const dataPath = dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json'));
  let local = null;
  try {
    const stats = await statfs(dataPath, { bigint: true });
    const totalBytes = Number(stats.blocks * stats.bsize);
    const availableBytes = Number(stats.bavail * stats.bsize);
    const mounts = await readText('/proc/self/mountinfo');
    const mountPoints = mounts.split('\n').map(line => line.split(' - ')[0]?.split(' ')[4]?.replaceAll('\\040', ' ')).filter(Boolean);
    const coveringMount = mountPoints.filter(point => dataPath === point || dataPath.startsWith(`${point.replace(/\/$/, '')}/`)).sort((a, b) => b.length - a.length)[0] || '/';
    local = { path: dataPath, mountPoint: coveringMount, dedicated: coveringMount !== '/', totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
  } catch {}

  return {
    disks,
    local,
    attachedVolumes,
    environment: { container: inContainer, containerType: inContainer ? containerType : null },
    zfs: {
      available: pools !== null && datasets !== null,
      canManageDatasets: pools !== null && datasets !== null && process.env.LIGHTNAS_ZFS_ENABLED === '1',
      pools: pools ? pools.split('\n').map(row => {
        const [name, size, allocated, free, health] = row.split('\t');
        return { name, sizeBytes: Number(size), allocatedBytes: Number(allocated), freeBytes: Number(free), health };
      }) : [],
      datasets: datasets ? datasets.split('\n').map(row => {
        const [name, used, available, mountPoint, compression] = row.split('\t');
        return { name, usedBytes: Number(used), availableBytes: Number(available), mountPoint, compression };
      }) : []
    }
  };
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
      let writable = false;
      try { await access(mountPoint, constants.W_OK); writable = true; } catch {}
      const mountedReadOnly = options.split(',').includes('ro');
      entries.push({
        id: Buffer.from(`${device}:${mountPoint}`).toString('base64url'),
        device,
        mountPoint,
        type,
        writable: writable && !mountedReadOnly,
        readOnly: mountedReadOnly || !writable,
        totalBytes: total,
        availableBytes: available,
        usedBytes: Math.max(0, total - available),
        usedPercent: total ? Math.round(((total - available) / total) * 100) : 0
      });
    } catch {}
  }

  return entries.sort((a, b) => b.totalBytes - a.totalBytes);
}
