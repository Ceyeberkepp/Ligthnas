import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { proxmoxInventory, proxmoxCreateVm } from './proxmox.mjs';

const execute = promisify(execFile);
const dataRoot = dirname(process.env.NAS_DATA_FILE || 'data/state.json');
const vmIsoDirectory = process.env.LIGHTNAS_VM_ISO_DIR || '/var/lib/libvirt/images';
let operationRunning = false;

async function exclusive(operation) {
  if (operationRunning) throw Object.assign(new Error('Another runtime operation is in progress.'), { status: 409 });
  operationRunning = true;
  try { return await operation(); } finally { operationRunning = false; }
}

export const catalog = Object.freeze([
  { id: 'nginx', name: 'Nginx', category: 'Web server', image: 'nginx:stable-alpine', port: 8081, containerPort: 80, memory: '256m', description: 'Open-source web server with a default landing page.', source: 'https://hub.docker.com/_/nginx', volumes: [] },
  { id: 'jellyfin', name: 'Jellyfin', category: 'Media', image: 'jellyfin/jellyfin:latest', port: 8096, containerPort: 8096, memory: '2g', description: 'Open-source media server. Reads your LightNAS Files as a library.', source: 'https://jellyfin.org/docs/general/installation/container/', volumes: [['config', '/config'], ['cache', '/cache'], ['@files', '/media:ro']] },
  { id: 'uptime-kuma', name: 'Uptime Kuma', category: 'Monitoring', image: 'louislam/uptime-kuma:2', port: 3001, containerPort: 3001, memory: '1g', description: 'Self-hosted uptime and status monitoring.', source: 'https://github.com/louislam/uptime-kuma', volumes: [['data', '/app/data']] },
  { id: 'heimdall', name: 'Heimdall', category: 'Dashboard', image: 'lscr.io/linuxserver/heimdall:latest', port: 8083, containerPort: 80, memory: '512m', description: 'Personal dashboard for your hosted applications. Configure a password before exposing it publicly.', source: 'https://docs.linuxserver.io/images/docker-heimdall/', volumes: [['config', '/config']] },
  { id: 'openspeedtest', name: 'OpenSpeedTest', category: 'Network', image: 'openspeedtest/latest', port: 8082, containerPort: 3000, memory: '512m', description: 'Test LAN speed from your browser against this server.', source: 'https://github.com/openspeedtest/Docker-Image', volumes: [] }
]);

async function command(program, args, timeout = 4000) {
  try {
    const { stdout } = await execute(program, args, { timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().slice(0, 500) };
  }
}

export async function runtimeInventory() {
  const [dockerInfo, vmInfo, vmPools, vmNetworks, installer] = await Promise.all([
    command('docker', ['info', '--format', '{{.ServerVersion}}']),
    command('virsh', ['-c', 'qemu:///system', 'list', '--all', '--name']),
    command('virsh', ['-c', 'qemu:///system', 'pool-list', '--name']),
    command('virsh', ['-c', 'qemu:///system', 'net-list', '--name']),
    command('virt-install', ['--version'])
  ]);
  let images = [];
  try {
    const folder = vmIsoDirectory;
    images = (await readdir(folder)).filter(name => /^[a-zA-Z0-9._-]+\.iso$/.test(name));
    images = (await Promise.all(images.map(async name => (await lstat(join(folder, name))).isFile() ? name : null))).filter(Boolean);
  } catch { /* ISO directory might not be accessible to this service account. */ }
  const runtime = {
    docker: { available: dockerInfo.ok, enabled: process.env.LIGHTNAS_DOCKER_ENABLED === '1', reason: dockerInfo.ok ? null : 'Docker is not installed, running, or accessible to the lightnas service account.', containers: [] },
    virtualization: { available: vmInfo.ok && installer.ok, enabled: process.env.LIGHTNAS_VM_ENABLED === '1', reason: vmInfo.ok && installer.ok ? null : 'Libvirt/KVM and virt-install must be installed and accessible on bare metal or a VM with nested virtualization.', machines: vmInfo.ok && vmInfo.output ? vmInfo.output.split('\n').filter(Boolean) : [], pools: vmPools.ok && vmPools.output ? vmPools.output.split('\n').filter(Boolean) : [], networks: vmNetworks.ok && vmNetworks.output ? vmNetworks.output.split('\n').filter(Boolean) : [], images }
  };
  if (dockerInfo.ok) {
    const list = await command('docker', ['ps', '-a', '--format', '{{json .}}']);
    if (list.ok) runtime.docker.containers = list.output.split('\n').filter(Boolean).flatMap(row => {
      try { const item = JSON.parse(row); return [{ name: item.Names, image: item.Image, state: item.State, status: item.Status, ports: item.Ports }]; } catch { return []; }
    });
  }
  const setup = await readFile(join(dataRoot, 'runtime-status.txt'), 'utf8').catch(() => '');
  if (!runtime.docker.available && setup) runtime.docker.reason = setup.split('\n').find(line => line.startsWith('Containers: '))?.slice(12) || runtime.docker.reason;
  if (!runtime.virtualization.available && setup) runtime.virtualization.reason = setup.split('\n').find(line => line.startsWith('VMs: '))?.slice(5) || runtime.virtualization.reason;
  if (Object.keys(process.env).some(key => key.startsWith('LIGHTNAS_PVE_'))) {
    try { runtime.virtualization = await proxmoxInventory() || runtime.virtualization; }
    catch (error) {
      runtime.virtualization = { available: false, enabled: true, provider: 'proxmox',
        reason: `Proxmox integration failed: ${error.message}. Re-run the Proxmox LightNAS helper or verify the host bridge.`, machines: [], pools: [], networks: [], images: [] };
    }
  }
  return runtime;
}

async function runDocker(args) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker actions are disabled. The operator must explicitly enable them on a Docker host.'), { status: 409 });
  const response = await exclusive(() => command('docker', args, 180000));
  if (!response.ok) throw Object.assign(new Error(`Docker: ${response.error}`), { status: 409 });
  return response.output;
}

export async function installCatalogApp(id) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker actions are disabled on this host.'), { status: 409 });
  const app = catalog.find(item => item.id === id);
  if (!app) throw Object.assign(new Error('Unknown catalog app.'), { status: 404 });
  const name = `lightnas-app-${app.id}`;
  const args = ['run', '-d', '--name', name, '--label', `lightnas.catalog=${app.id}`, '--restart', 'unless-stopped', '--memory', app.memory, '--pids-limit', '256', '--security-opt', 'no-new-privileges', '-p', `${app.port}:${app.containerPort}`];
  for (const [folder, target] of app.volumes) {
    const hostPath = folder === '@files' ? join(dataRoot, 'files') : join(dataRoot, 'apps', id, folder);
    await mkdir(hostPath, { recursive: true, mode: 0o700 });
    args.push('-v', `${hostPath}:${target}`);
  }
  args.push(app.image);
  return { id: app.id, containerId: await runDocker(args), port: app.port };
}

export async function manageCatalogApp(id, action) {
  if (!catalog.some(app => app.id === id)) throw Object.assign(new Error('Unknown catalog app.'), { status: 404 });
  if (!['start', 'stop', 'restart', 'remove'].includes(action)) throw Object.assign(new Error('Invalid app action.'), { status: 400 });
  const name = `lightnas-app-${id}`;
  await runDocker(action === 'remove' ? ['rm', '-f', name] : [action, name]);
  return { id, action, dataPreserved: action === 'remove' };
}

export async function createContainer(input) {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(input.name || '')) throw Object.assign(new Error('Use a 2–40 character lowercase container name.'), { status: 400 });
  if (typeof input.image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]{0,159}$/.test(input.image) || input.image.includes('..') || input.image.includes('//')) throw Object.assign(new Error('Enter a valid Docker image name.'), { status: 400 });
  const memory = Number(input.memoryMiB);
  if (!Number.isInteger(memory) || memory < 128 || memory > 16384) throw Object.assign(new Error('Memory must be 128–16384 MiB.'), { status: 400 });
  const args = ['run', '-d', '--name', `lightnas-${input.name}`, '--label', 'lightnas.managed=true', '--restart', 'unless-stopped', '--memory', `${memory}m`, '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', input.image];
  return { name: `lightnas-${input.name}`, containerId: await runDocker(args) };
}

export async function createVm(input) {
  if (!Object.keys(process.env).some(key => key.startsWith('LIGHTNAS_PVE_')) && process.env.LIGHTNAS_VM_ENABLED !== '1') throw Object.assign(new Error('VM creation is disabled on this host. Run LightNAS on a KVM-capable host/VM, or use the one-click Proxmox LXC installer.'), { status: 409 });
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,39}$/.test(input.name || '')) throw Object.assign(new Error('Use a 2–40 character VM name.'), { status: 400 });
  const memory = Number(input.memoryMiB), cpus = Number(input.cpus), disk = Number(input.diskGiB);
  if (!Number.isInteger(memory) || memory < 1024 || memory > 65536 || !Number.isInteger(cpus) || cpus < 1 || cpus > 32 || !Number.isInteger(disk) || disk < 10 || disk > 2048) throw Object.assign(new Error('Use 1024–65536 MiB RAM, 1–32 CPUs and 10–2048 GiB disk.'), { status: 400 });
  const { virtualization } = await runtimeInventory();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(input.pool || '') || !/^[a-zA-Z0-9._-]{1,48}$/.test(input.network || '') || !virtualization.available || !virtualization.pools.includes(input.pool) || !virtualization.networks.includes(input.network) || !virtualization.images.includes(input.iso)) throw Object.assign(new Error('Select an accessible active pool, network and ISO image.'), { status: 409 });
  if (virtualization.provider?.startsWith('proxmox')) return proxmoxCreateVm(input, virtualization);
  if (virtualization.machines.includes(input.name)) throw Object.assign(new Error('A VM with this name already exists.'), { status: 409 });
  const args = ['--connect', 'qemu:///system', '--name', input.name, '--memory', String(memory), '--vcpus', String(cpus), '--disk', `pool=${input.pool},size=${disk},format=qcow2`, '--cdrom', join(vmIsoDirectory, input.iso), '--network', `network=${input.network}`, '--osinfo', 'detect=on,require=off', '--graphics', 'vnc,listen=127.0.0.1', '--noautoconsole', '--wait', '0'];
  const response = await exclusive(() => command('virt-install', args, 120000));
  if (!response.ok) throw Object.assign(new Error(`VM creation failed: ${response.error}`), { status: 409 });
  return { name: input.name, details: response.output };
}
