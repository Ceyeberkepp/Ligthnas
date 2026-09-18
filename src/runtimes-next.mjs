import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { proxmoxInventory, proxmoxCreateVm, proxmoxManageVm, proxmoxUpdateVm } from './proxmox.mjs';
import { localContainerInventory, localCreateContainer, localManageContainer, localUpdateContainer } from './local-host.mjs';

const execute = promisify(execFile);
const dataRoot = dirname(process.env.NAS_DATA_FILE || 'data/state.json');
const vmIsoDirectory = process.env.LIGHTNAS_VM_ISO_DIR || '/var/lib/libvirt/images';
let operationRunning = false;

async function exclusive(operation) {
  if (operationRunning) throw Object.assign(new Error('Another runtime operation is in progress.'), { status: 409 });
  operationRunning = true;
  try { return await operation(); } finally { operationRunning = false; }
}

export const containerImages = Object.freeze([
  { id: 'debian', name: 'Debian 13', category: 'Linux', image: 'debian:13-slim', description: 'Current Debian base image for general-purpose containers.' },
  { id: 'ubuntu', name: 'Ubuntu 24.04 LTS', category: 'Linux', image: 'ubuntu:24.04', description: 'Ubuntu LTS base image.' },
  { id: 'alpine', name: 'Alpine Linux', category: 'Linux', image: 'alpine:latest', description: 'Very small Linux base image.' },
  { id: 'nginx', name: 'Nginx', category: 'Web', image: 'nginx:stable-alpine', description: 'Popular web server and reverse proxy.' },
  { id: 'apache', name: 'Apache HTTP Server', category: 'Web', image: 'httpd:2.4-alpine', description: 'Apache HTTP server.' },
  { id: 'redis', name: 'Redis', category: 'Database', image: 'redis:alpine', description: 'In-memory data store and cache.' },
  { id: 'postgres', name: 'PostgreSQL 17', category: 'Database', image: 'postgres:17-alpine', description: 'PostgreSQL relational database.' },
  { id: 'mariadb', name: 'MariaDB 11.4', category: 'Database', image: 'mariadb:11.4', description: 'MariaDB relational database.' },
  { id: 'node', name: 'Node.js LTS', category: 'Development', image: 'node:lts-slim', description: 'Node.js LTS runtime.' },
  { id: 'python', name: 'Python 3', category: 'Development', image: 'python:3-slim', description: 'Python runtime on a compact Debian base.' },
  { id: 'busybox', name: 'BusyBox', category: 'Utility', image: 'busybox:latest', description: 'Small utility image useful for testing and diagnostics.' }
]);

const persistentShellImages = new Set(['debian:13-slim', 'ubuntu:24.04', 'alpine:latest', 'busybox:latest']);

export const catalog = Object.freeze([
  { id: 'nginx', name: 'Nginx', category: 'Web server', image: 'nginx:stable-alpine', port: 8081, containerPort: 80, memory: '256m', description: 'Open-source web server with a default landing page.', source: 'https://hub.docker.com/_/nginx', volumes: [] },
  { id: 'jellyfin', name: 'Jellyfin', category: 'Media', image: 'jellyfin/jellyfin:latest', port: 8096, containerPort: 8096, memory: '2g', description: 'Open-source media server. Reads your LightNAS Files as a library.', source: 'https://jellyfin.org/docs/general/installation/container/', volumes: [['config', '/config'], ['cache', '/cache'], ['@files', '/media:ro']] },
  { id: 'uptime-kuma', name: 'Uptime Kuma', category: 'Monitoring', image: 'louislam/uptime-kuma:2', port: 3001, containerPort: 3001, memory: '1g', description: 'Self-hosted uptime and status monitoring.', source: 'https://github.com/louislam/uptime-kuma', volumes: [['data', '/app/data']] },
  { id: 'heimdall', name: 'Heimdall', category: 'Dashboard', image: 'lscr.io/linuxserver/heimdall:latest', port: 8083, containerPort: 80, memory: '512m', description: 'Personal dashboard for your hosted applications. Configure a password before exposing it publicly.', source: 'https://docs.linuxserver.io/images/docker-heimdall/', volumes: [['config', '/config']] },
  { id: 'openspeedtest', name: 'OpenSpeedTest', category: 'Network', image: 'openspeedtest/latest', port: 8082, containerPort: 3000, memory: '512m', description: 'Test LAN speed from your browser against this server.', source: 'https://github.com/openspeedtest/Docker-Image', volumes: [] }
]);

async function command(program, args, timeout = 4000) {
  try {
    const { stdout } = await execute(program, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().slice(0, 1200) };
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
    images = (await readdir(vmIsoDirectory)).filter(name => /^[a-zA-Z0-9._-]+\.iso$/i.test(name));
    images = (await Promise.all(images.map(async name => (await lstat(join(vmIsoDirectory, name))).isFile() ? name : null))).filter(Boolean);
  } catch {}
  const runtime = {
    docker: { available: dockerInfo.ok, enabled: process.env.LIGHTNAS_DOCKER_ENABLED === '1', reason: dockerInfo.ok ? null : 'Optional app runtime is not installed or not accessible.', containers: [], presets: containerImages },
    containers: { available: false, enabled: false, provider: 'local-lxc', reason: 'Native LXC is not available on this LightNAS host.', containers: [], images: [], networks: [], storageRoot: null },
    virtualization: { available: vmInfo.ok && installer.ok, enabled: process.env.LIGHTNAS_VM_ENABLED === '1', reason: vmInfo.ok && installer.ok ? null : 'Libvirt/KVM and virt-install must be installed and accessible on bare metal or a VM with nested virtualization.', machines: vmInfo.ok && vmInfo.output ? vmInfo.output.split('\n').filter(Boolean) : [], machineDetails: [], pools: vmPools.ok && vmPools.output ? vmPools.output.split('\n').filter(Boolean) : [], networks: vmNetworks.ok && vmNetworks.output ? vmNetworks.output.split('\n').filter(Boolean) : [], images }
  };
  try { runtime.containers = await localContainerInventory(); }
  catch (error) { runtime.containers = { available: false, enabled: false, provider: 'local-lxc', reason: `Native LXC host agent unavailable: ${error.message}`, containers: [], images: [], networks: [], storageRoot: null }; }

  if (dockerInfo.ok) {
    const list = await command('docker', ['ps', '-a', '--format', '{{json .}}']);
    if (list.ok) runtime.docker.containers = list.output.split('\n').filter(Boolean).flatMap(row => {
      try {
        const item = JSON.parse(row);
        return [{ name: item.Names, image: item.Image, state: item.State, status: item.Status, ports: item.Ports, managed: item.Names?.startsWith('lightnas-') }];
      } catch { return []; }
    });
  }
  const setup = await readFile(join(dataRoot, 'runtime-status.txt'), 'utf8').catch(() => '');
  if (!runtime.docker.available && setup) runtime.docker.reason = setup.split('\n').find(line => line.startsWith('Apps: '))?.slice(6) || runtime.docker.reason;
  if (!runtime.virtualization.available && setup) runtime.virtualization.reason = setup.split('\n').find(line => line.startsWith('VMs: '))?.slice(5) || runtime.virtualization.reason;
  if (process.env.LIGHTNAS_ENABLE_PROXMOX_PROVIDER === '1' && Object.keys(process.env).some(key => key.startsWith('LIGHTNAS_PVE_'))) {
    try { runtime.virtualization = await proxmoxInventory() || runtime.virtualization; }
    catch (error) { runtime.virtualization = { available: false, enabled: true, provider: 'proxmox', reason: `Optional Proxmox provider failed: ${error.message}`, machines: [], machineDetails: [], pools: [], networks: [], images: [] }; }
  }
  return runtime;
}

async function runDocker(args, timeout = 180000) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker actions are disabled. The operator must explicitly enable them on a Docker host.'), { status: 409 });
  const response = await exclusive(() => command('docker', args, timeout));
  if (!response.ok) throw Object.assign(new Error(`Docker: ${response.error}`), { status: 409 });
  return response.output;
}

async function pullDockerImage(image) {
  try { return await runDocker(['pull', image], 600000); }
  catch (error) { throw Object.assign(new Error(`Unable to download Docker image ${image}: ${error.message.replace(/^Docker:\s*/, '')}`), { status: error.status || 409 }); }
}

export async function installCatalogApp(id) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker actions are disabled on this host.'), { status: 409 });
  const app = catalog.find(item => item.id === id);
  if (!app) throw Object.assign(new Error('Unknown catalog app.'), { status: 404 });
  const name = `lightnas-app-${app.id}`;
  await pullDockerImage(app.image);
  const args = ['run', '-d', '--name', name, '--label', `lightnas.catalog=${app.id}`, '--restart', 'unless-stopped', '--memory', app.memory, '--pids-limit', '256', '--security-opt', 'no-new-privileges', '-p', `${app.port}:${app.containerPort}`];
  for (const [folder, target] of app.volumes) {
    const hostPath = folder === '@files' ? join(dataRoot, 'files') : join(dataRoot, 'apps', id, folder);
    await mkdir(hostPath, { recursive: true, mode: 0o700 });
    args.push('-v', `${hostPath}:${target}`);
  }
  args.push(app.image);
  return { id: app.id, image: app.image, containerId: await runDocker(args), port: app.port };
}

export async function manageCatalogApp(id, action) {
  if (!catalog.some(app => app.id === id)) throw Object.assign(new Error('Unknown catalog app.'), { status: 404 });
  if (!['start', 'stop', 'restart', 'remove'].includes(action)) throw Object.assign(new Error('Invalid app action.'), { status: 400 });
  const name = `lightnas-app-${id}`;
  await runDocker(action === 'remove' ? ['rm', '-f', name] : [action, name]);
  return { id, action, dataPreserved: action === 'remove' };
}

async function assertManagedContainer(name) {
  if (!/^lightnas-[a-z0-9][a-z0-9-]{0,60}$/.test(name || '')) throw Object.assign(new Error('Invalid LightNAS app container name.'), { status: 400 });
  const inspected = await runDocker(['inspect', '--format', '{{index .Config.Labels "lightnas.managed"}}|{{index .Config.Labels "lightnas.catalog"}}|{{.State.Running}}', name], 15000);
  const [managed, catalogId, running] = inspected.split('|');
  if (managed !== 'true' && !catalogId) throw Object.assign(new Error('Only LightNAS-managed app containers can be controlled here.'), { status: 403 });
  return { running: running === 'true' };
}

export async function openContainerShell(name) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('The optional Docker app engine is disabled.'), { status: 409 });
  const state = await assertManagedContainer(name);
  if (!state.running) throw Object.assign(new Error('Start the app container before opening its shell.'), { status: 409 });
  return spawn('docker', ['exec', '-i', name, 'sh'], { stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function createContainer(input) {
  const inventory = await localContainerInventory();
  if (!inventory?.available || !inventory.enabled) throw Object.assign(new Error(inventory?.reason || 'Native LXC is unavailable on this LightNAS host.'), { status: 409 });
  if (input?.action) {
    if (input.action === 'update') return await localUpdateContainer({
      id: input.id || input.name,
      name: input.name || input.id,
      memoryMiB: Number(input.memoryMiB),
      cpus: Number(input.cpus)
    });
    return await localManageContainer(input.id || input.name, input.action);
  }
  return await localCreateContainer({
    name: input.name,
    image: input.image,
    memoryMiB: Number(input.memoryMiB),
    cpus: Number(input.cpus),
    network: input.network
  });
}

export async function createVm(input) {
  if (input?.action) {
    const { virtualization } = await runtimeInventory();
    if (!virtualization.provider?.startsWith('proxmox')) throw Object.assign(new Error('VM lifecycle controls currently require the Proxmox integration.'), { status: 409 });
    if (input.action === 'update') return await proxmoxUpdateVm(input);
    return await proxmoxManageVm(input.vmid, input.action);
  }
  if (!Object.keys(process.env).some(key => key.startsWith('LIGHTNAS_PVE_')) && process.env.LIGHTNAS_VM_ENABLED !== '1') throw Object.assign(new Error('VM creation is disabled on this host. Run LightNAS on a KVM-capable host/VM, or use the one-click Proxmox LXC installer.'), { status: 409 });
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,39}$/.test(input.name || '')) throw Object.assign(new Error('Use a 2–40 character VM name.'), { status: 400 });
  const memory = Number(input.memoryMiB), cpus = Number(input.cpus), disk = Number(input.diskGiB);
  if (!Number.isInteger(memory) || memory < 1024 || memory > 65536 || !Number.isInteger(cpus) || cpus < 1 || cpus > 32 || !Number.isInteger(disk) || disk < 10 || disk > 2048) throw Object.assign(new Error('Use 1024–65536 MiB RAM, 1–32 CPUs and 10–2048 GiB disk.'), { status: 400 });
  const { virtualization } = await runtimeInventory();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(input.pool || '') || !/^[a-zA-Z0-9._-]{1,48}$/.test(input.network || '') || !virtualization.available || !virtualization.pools.includes(input.pool) || !virtualization.networks.includes(input.network) || !virtualization.images.includes(input.iso)) throw Object.assign(new Error('Select an accessible active VM storage, network bridge and existing ISO image.'), { status: 409 });
  if (virtualization.provider?.startsWith('proxmox')) return proxmoxCreateVm(input, virtualization);
  if (virtualization.machines.includes(input.name)) throw Object.assign(new Error('A VM with this name already exists.'), { status: 409 });
  const args = ['--connect', 'qemu:///system', '--name', input.name, '--memory', String(memory), '--vcpus', String(cpus), '--disk', `pool=${input.pool},size=${disk},format=qcow2`, '--cdrom', join(vmIsoDirectory, input.iso), '--network', `network=${input.network}`, '--osinfo', 'detect=on,require=off', '--graphics', 'vnc,listen=127.0.0.1', '--noautoconsole', '--wait', '0'];
  const response = await exclusive(() => command('virt-install', args, 120000));
  if (!response.ok) throw Object.assign(new Error(`VM creation failed: ${response.error}`), { status: 409 });
  return { name: input.name, details: response.output };
}
