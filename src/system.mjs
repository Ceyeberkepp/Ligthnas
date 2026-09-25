import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

export function reconcileProxmoxMounts(filesystems, proxmoxStorage) {
  const normalizeMount = value => String(value || '').replace(/\/+$/, '') || '/';
  const filesystemByMount = new Map((filesystems || []).map(item => [normalizeMount(item.mountPoint), item]));
  return (proxmoxStorage?.mounts || []).map(declared => {
    const mountPoint = normalizeMount(declared.mountPoint);
    const item = filesystemByMount.get(mountPoint) || null;
    const totalBytes = Number(declared.sizeBytes) || 0;
    const filesystemUsed = item ? Math.max(0, Number(item.usedBytes) || 0) : 0;
    const usedBytes = Math.min(totalBytes, filesystemUsed);
    return {
      id: item?.id || Buffer.from(`${declared.volume || declared.slot}:${mountPoint}`).toString('base64url'),
      device: item?.device || declared.volume || declared.slot,
      mountPoint,
      type: item?.type || 'virtual',
      readOnly: item?.readOnly ?? false,
      writable: item?.writable ?? true,
      totalBytes,
      availableBytes: Math.max(0, totalBytes - usedBytes),
      usedBytes,
      usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0,
      capacitySource: 'proxmox-pct-config',
      configuredSize: declared.size || null,
      reportedFilesystemBytes: item?.totalBytes || null
    };
  }).filter(item => item.totalBytes > 0);
}

export async function getStorageInventory() {
  const [blockDevices, pools, datasets, containerType, filesystems, proxmoxManifestText] = await Promise.all([
    command('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,MODEL,TRAN']),
    command('zpool', ['list', '-H', '-p', '-o', 'name,size,alloc,free,health']),
    command('zfs', ['list', '-H', '-p', '-o', 'name,used,available,mountpoint,compression']),
    command('systemd-detect-virt', ['--container']),
    getFilesystems(),
    readText(process.env.LIGHTNAS_PROXMOX_STORAGE_MANIFEST || '/etc/lightnas/proxmox-storage.json')
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

  const dataRoot = dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json'));
  const localStoragePath = resolve(process.env.LIGHTNAS_LOCAL_STORAGE_ROOT || join(dataRoot, 'storage', 'local'));
  const rootFilesystem = filesystems.find(item => item.mountPoint === '/');
  const rootDevice = rootFilesystem?.device || null;

  let proxmoxStorage = null;
  try {
    const parsed = JSON.parse(proxmoxManifestText || 'null');
    if (parsed?.source === 'proxmox-pct-config' && Array.isArray(parsed.mounts)) proxmoxStorage = parsed;
  } catch {}
  const proxmoxMounts = new Map(
    (proxmoxStorage?.mounts || [])
      .filter(item => item?.mountPoint && Number(item?.sizeBytes) > 0)
      .map(item => [item.mountPoint, item])
  );

  // In an LXC, filesystem geometry can reflect the backing filesystem or raw
  // image rather than the virtual size assigned by the hypervisor. When the
  // Proxmox helper provides pct config metadata, that manifest is authoritative:
  // only declared mpN mounts are treated as attached data volumes and their
  // size= values are used for capacity accounting.
  let attachedVolumes = [];
  if (inContainer && proxmoxStorage) {
    attachedVolumes = reconcileProxmoxMounts(filesystems, proxmoxStorage);
  } else {
    const volumeCandidates = filesystems
      .filter(item => !isSystemMount(item.mountPoint) && item.totalBytes > 0)
      .filter(item => item.device !== rootDevice)
      .filter(item => item.mountPoint !== localStoragePath)
      .filter(item => !/^\/(?:proc|sys|dev|run)(?:\/|$)/.test(item.mountPoint));

    const uniqueVolumes = new Map();
    for (const item of volumeCandidates) {
      const key = `${item.device}:${item.type}:${item.totalBytes}`;
      const existing = uniqueVolumes.get(key);
      if (!existing || item.mountPoint.length < existing.mountPoint.length) uniqueVolumes.set(key, item);
    }

    attachedVolumes = [...uniqueVolumes.values()].map(item => ({
      id: item.id,
      device: item.device,
      mountPoint: item.mountPoint,
      type: item.type,
      readOnly: item.readOnly,
      writable: item.writable,
      totalBytes: item.totalBytes,
      availableBytes: item.availableBytes,
      usedBytes: item.usedBytes,
      usedPercent: item.usedPercent,
      capacitySource: inContainer ? 'guest-filesystem-unverified' : 'filesystem',
      configuredSize: null,
      reportedFilesystemBytes: item.totalBytes
    }));
  }

  const virtualStorage = attachedVolumes.reduce((summary, item) => {
    summary.totalBytes += item.totalBytes;
    summary.availableBytes += item.availableBytes;
    summary.usedBytes += item.usedBytes;
    return summary;
  }, { totalBytes: 0, availableBytes: 0, usedBytes: 0 });
  virtualStorage.usedPercent = virtualStorage.totalBytes
    ? Math.round((virtualStorage.usedBytes / virtualStorage.totalBytes) * 100)
    : 0;
  virtualStorage.count = attachedVolumes.length;

  let local = null;
  try {
    const stats = await statfs(localStoragePath, { bigint: true });
    const totalBytes = Number(stats.blocks * stats.bsize);
    const availableBytes = Number(stats.bavail * stats.bsize);
    const mounts = await readText('/proc/self/mountinfo');
    const mountPoints = mounts.split('\n').map(line => line.split(' - ')[0]?.split(' ')[4]?.replaceAll('\\040', ' ')).filter(Boolean);
    const coveringMount = mountPoints.filter(point => localStoragePath === point || localStoragePath.startsWith(`${point.replace(/\/$/, '')}/`)).sort((a, b) => b.length - a.length)[0] || '/';
    const declaredLocalMount = inContainer && proxmoxStorage
      ? [...proxmoxMounts.keys()].find(point => localStoragePath === point || localStoragePath.startsWith(`${point.replace(/\/$/, '')}/`))
      : null;
    const dedicated = inContainer ? Boolean(declaredLocalMount) : coveringMount !== '/';
    local = { path: localStoragePath, mountPoint: coveringMount, dedicated, totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
  } catch {}

  // In container installs, the headline represents attached NAS data volumes.
  // The OS/root-backed local target remains usable for metadata/ISOs but is not
  // added to the data-capacity total when attached volumes exist.
  const capacityVerified = !inContainer || Boolean(proxmoxStorage);
  const includeLocalInUsable = Boolean(
    local && (
      (!inContainer && (local.dedicated || virtualStorage.count === 0)) ||
      (inContainer && virtualStorage.count === 0)
    )
  );
  const usableStorage = {
    totalBytes: capacityVerified ? (includeLocalInUsable ? local?.totalBytes || 0 : 0) + virtualStorage.totalBytes : 0,
    availableBytes: capacityVerified ? (includeLocalInUsable ? local?.availableBytes || 0 : 0) + virtualStorage.availableBytes : 0,
    usedBytes: capacityVerified ? (includeLocalInUsable ? local?.usedBytes || 0 : 0) + virtualStorage.usedBytes : 0,
    count: capacityVerified ? (includeLocalInUsable ? 1 : 0) + virtualStorage.count : 0,
    verified: capacityVerified,
    source: proxmoxStorage ? 'proxmox-pct-config' : (inContainer ? 'unverified-container' : 'local-filesystem'),
    includesSharedOsLocal: includeLocalInUsable && !local?.dedicated,
    localExcludedBecauseSharedOs: Boolean(local && !local.dedicated && virtualStorage.count > 0)
  };
  usableStorage.usedPercent = usableStorage.totalBytes
    ? Math.round((usableStorage.usedBytes / usableStorage.totalBytes) * 100)
    : 0;

  return {
    disks,
    local,
    attachedVolumes,
    virtualStorage,
    usableStorage,
    proxmoxStorage,
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
  const loadAverages = os.loadavg();
  const load = loadAverages[0];
  const loadPercent = Math.min(100, Math.round((load / Math.max(cores.length, 1)) * 100));
  const networkText = await readText('/proc/net/dev');
  const network = networkText.split('\n').slice(2).reduce((result, line) => {
    const [namePart, countersPart] = line.split(':');
    const name = String(namePart || '').trim();
    const counters = String(countersPart || '').trim().split(/\s+/).map(Number);
    if (!name || name === 'lo' || counters.length < 9) return result;
    result.receivedBytes += Number.isFinite(counters[0]) ? counters[0] : 0;
    result.transmittedBytes += Number.isFinite(counters[8]) ? counters[8] : 0;
    result.interfaces += 1;
    return result;
  }, { receivedBytes: 0, transmittedBytes: 0, interfaces: 0 });

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
      loadAverage: loadAverages.map(value => Number(value.toFixed(2))),
      ...cpu
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: totalMemory - freeMemory,
      usedPercent: Math.round(((totalMemory - freeMemory) / totalMemory) * 100)
    },
    network,
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
