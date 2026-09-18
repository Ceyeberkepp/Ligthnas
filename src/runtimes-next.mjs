import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { proxmoxInventory, proxmoxCreateVm, proxmoxManageVm, proxmoxUpdateVm } from './proxmox.mjs';
import { localContainerInventory, localCreateContainer, localManageContainer, localUpdateContainer } from './local-host.mjs';
import { listContainerTemplates, resolveContainerTemplate } from './templates.mjs';
import { listStoragePools, listContentAcrossPools, resolveStoragePool } from './storage-pools.mjs';

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


function parseDomInfo(text) {
  const values = {};
  for (const line of String(text || '').split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) values[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return values;
}

async function localVmDetails(names) {
  const details = [];
  for (const name of names.slice(0, 100)) {
    const info = await command('virsh', ['-c', 'qemu:///system', 'dominfo', name], 10000);
    if (!info.ok) continue;
    const parsed = parseDomInfo(info.output);
    details.push({
      id: name,
      name,
      uuid: parsed.uuid || null,
      status: parsed.state || 'unknown',
      cpus: Number(parsed['cpu(s)']) || 0,
      memory: (Number(String(parsed['max memory'] || '').split(/\s+/)[0]) || 0) * 1024,
      persistent: parsed.persistent === 'yes'
    });
  }
  return details;
}

async function localManageVm(id, action) {
  const name = String(id || '');
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Invalid VM name.'), { status: 400 });
  const allowed = new Set(['start', 'stop', 'shutdown', 'reboot', 'reset', 'delete']);
  if (!allowed.has(action)) throw Object.assign(new Error('Invalid VM action.'), { status: 400 });
  if (action === 'delete') {
    await command('virsh', ['-c', 'qemu:///system', 'destroy', name], 30000);
    const result = await command('virsh', ['-c', 'qemu:///system', 'undefine', name, '--remove-all-storage', '--nvram'], 120000);
    if (!result.ok) throw Object.assign(new Error(`VM delete failed: ${result.error}`), { status: 409 });
    return { id: name, action, status: 'deleted' };
  }
  const verb = action === 'stop' ? 'destroy' : action;
  const result = await command('virsh', ['-c', 'qemu:///system', verb, name], 60000);
  if (!result.ok) throw Object.assign(new Error(`VM ${action} failed: ${result.error}`), { status: 409 });
  return { id: name, action, status: 'submitted' };
}

async function localUpdateVm(input) {
  const id = String(input.id || input.name || '');
  const requestedName = String(input.name || id);
  const memory = Number(input.memoryMiB);
  const cpus = Number(input.cpus);
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(id) || !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(requestedName)) throw Object.assign(new Error('Invalid VM name.'), { status: 400 });
  if (!Number.isInteger(memory) || memory < 512 || memory > 262144 || !Number.isInteger(cpus) || cpus < 1 || cpus > 128) throw Object.assign(new Error('Invalid VM CPU or memory values.'), { status: 400 });

  if (requestedName !== id) {
    const state = await command('virsh', ['-c', 'qemu:///system', 'domstate', id], 10000);
    if (!state.ok || !/shut off|shutoff|inactive/i.test(state.output)) throw Object.assign(new Error('Shut down the VM before renaming it.'), { status: 409 });
    const rename = await command('virsh', ['-c', 'qemu:///system', 'domrename', id, requestedName], 30000);
    if (!rename.ok) throw Object.assign(new Error(`VM rename failed: ${rename.error}`), { status: 409 });
  }
  const target = requestedName;
  const mem = await command('virsh', ['-c', 'qemu:///system', 'setmaxmem', target, `${memory}MiB`, '--config'], 30000);
  if (!mem.ok) throw Object.assign(new Error(`Unable to change VM memory: ${mem.error}`), { status: 409 });
  await command('virsh', ['-c', 'qemu:///system', 'setmem', target, `${memory}MiB`, '--config'], 30000);
  const cpu = await command('virsh', ['-c', 'qemu:///system', 'setvcpus', target, String(cpus), '--config', '--maximum'], 30000);
  if (!cpu.ok) {
    const fallback = await command('virsh', ['-c', 'qemu:///system', 'setvcpus', target, String(cpus), '--config'], 30000);
    if (!fallback.ok) throw Object.assign(new Error(`Unable to change VM CPUs: ${fallback.error}`), { status: 409 });
  }
  await command('virsh', ['-c', 'qemu:///system', 'setvcpus', target, String(cpus), '--config'], 30000);
  return { id: target, name: target, memoryMiB: memory, cpus, status: 'updated' };
}
export async function runtimeInventory() {
  const [dockerInfo, vmInfo, vmNetworks, installer, hostBridges, lightnasStorage, storageIsos] = await Promise.all([
    command('docker', ['info', '--format', '{{.ServerVersion}}']),
    command('virsh', ['-c', 'qemu:///system', 'list', '--all', '--name']),
    command('virsh', ['-c', 'qemu:///system', 'net-list', '--name']),
    command('virt-install', ['--version']),
    command('ip', ['-j', 'link', 'show', 'type', 'bridge']),
    listStoragePools().catch(() => ({ pools: [] })),
    listContentAcrossPools('iso').catch(() => [])
  ]);
  const vmStoragePools = (lightnasStorage.pools || []).filter(pool => pool.online && pool.writable && pool.content.includes('images'));
  const images = storageIsos.map(item => item.id);
  const runtime = {
    docker: { available: dockerInfo.ok, enabled: process.env.LIGHTNAS_DOCKER_ENABLED === '1', reason: dockerInfo.ok ? null : 'Optional app runtime is not installed or not accessible.', containers: [], presets: containerImages },
    containers: { available: false, enabled: false, provider: 'local-lxc', reason: 'Native LXC is not available on this LightNAS host.', containers: [], images: [], networks: [], storageRoot: null },
    virtualization: { available: vmInfo.ok && installer.ok, enabled: process.env.LIGHTNAS_VM_ENABLED === '1', provider: 'libvirt', acceleration: process.env.LIGHTNAS_VM_ACCELERATION || 'auto', reason: vmInfo.ok && installer.ok ? null : 'QEMU/libvirt is unavailable on this LightNAS host.', warning: null, machines: [], machineDetails: [], pools: vmStoragePools.map(pool => pool.id), storageDetails: vmStoragePools, networks: [], networkDetails: [], images, isoDetails: storageIsos.map(item => ({ id: item.id, name: item.name, storageId: item.storageId, storageName: item.storageName, sizeBytes: item.sizeBytes })) }
  };
  try {
    runtime.containers = await localContainerInventory();
    const templateLibrary = await listContainerTemplates().catch(() => ({ templates: [] }));
    runtime.containers.images = [
      ...(runtime.containers.images || []),
      ...templateLibrary.templates.map(item => ({
        id: item.id,
        label: `${item.filename} · ${item.storageLabel}`,
        source: 'template-library',
        filename: item.filename,
        storageLabel: item.storageLabel,
        sizeBytes: item.sizeBytes
      }))
    ];
    runtime.containers.templateCount = templateLibrary.templates.length;
    runtime.virtualization.diagnostics = runtime.containers.diagnostics || null;
    if (runtime.containers.diagnostics?.nested) {
      const kvm = runtime.containers.diagnostics.kvm;
      if (!runtime.containers.diagnostics.tun) {
        runtime.virtualization.available = false;
        runtime.virtualization.enabled = false;
        runtime.virtualization.reason = 'VM networking requires /dev/net/tun inside this nested LightNAS instance.';
      } else if (kvm?.usable) {
        runtime.virtualization.acceleration = 'kvm';
      } else {
        runtime.virtualization.acceleration = 'tcg';
        runtime.virtualization.provider = 'libvirt-qemu';
        runtime.virtualization.warning = 'Hardware virtualization is unavailable, so LightNAS will use QEMU software emulation (TCG). VMs work, but they run slower than KVM.';
      }
    } else if (runtime.virtualization.acceleration === 'tcg') {
      runtime.virtualization.provider = 'libvirt-qemu';
      runtime.virtualization.warning = 'Hardware virtualization is unavailable, so LightNAS will use QEMU software emulation (TCG).';
    } else {
      runtime.virtualization.provider = 'libvirt-kvm';
    }
  } catch (error) {
    runtime.containers = { available: false, enabled: false, provider: 'local-lxc', reason: `Native LXC host agent unavailable: ${error.message}`, containers: [], images: [], networks: [], storageRoot: null, diagnostics: null };
  }

  if (runtime.virtualization.available) {
    const names = vmInfo.output ? vmInfo.output.split('\n').filter(Boolean) : [];
    runtime.virtualization.machineDetails = await localVmDetails(names);
    runtime.virtualization.machines = runtime.virtualization.machineDetails.map(item => `${item.name} · ${item.status}`);
    const libvirtNetworks = vmNetworks.ok && vmNetworks.output ? vmNetworks.output.split('\n').filter(Boolean) : [];
    let bridges = [];
    if (hostBridges.ok && hostBridges.output) {
      try {
        bridges = JSON.parse(hostBridges.output)
          .filter(item => item.ifname !== 'docker0' && (item.flags || []).includes('UP'))
          .map(item => item.ifname)
          .filter(name => /^[A-Za-z0-9_.:-]{1,32}$/.test(name || ''));
        if (bridges.includes('lightnas0')) bridges = ['lightnas0', ...bridges.filter(name => name !== 'lightnas0')];
      } catch {}
    }
    runtime.virtualization.networkDetails = [
      ...libvirtNetworks.map(name => ({ name, type: 'libvirt-network' })),
      ...bridges.filter(name => !libvirtNetworks.includes(name)).map(name => ({ name, type: 'host-bridge' }))
    ];
    runtime.virtualization.networks = runtime.virtualization.networkDetails.map(item => item.name);
  }

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
  const importedTemplate = String(input.image || '').startsWith('template:')
    ? await resolveContainerTemplate(input.image)
    : null;
  if (String(input.image || '').startsWith('template:') && !importedTemplate) {
    throw Object.assign(new Error('The selected container template is no longer available on storage.'), { status: 409 });
  }
  return await localCreateContainer({
    name: input.name,
    image: importedTemplate ? '' : input.image,
    templatePath: importedTemplate?.path || '',
    memoryMiB: Number(input.memoryMiB),
    cpus: Number(input.cpus),
    network: input.network
  });
}

export async function createVm(input) {
  const { virtualization } = await runtimeInventory();
  if (input?.action) {
    if (virtualization.provider?.startsWith('proxmox')) {
      if (input.action === 'update') return await proxmoxUpdateVm(input);
      return await proxmoxManageVm(input.vmid || input.id, input.action);
    }
    if (input.action === 'update') return await localUpdateVm(input);
    return await localManageVm(input.id || input.name, input.action);
  }

  if (!virtualization.available || !virtualization.enabled) throw Object.assign(new Error(virtualization.reason || 'QEMU/libvirt virtualization is disabled on this host.'), { status: 409 });
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,39}$/.test(input.name || '')) throw Object.assign(new Error('Use a 2–40 character VM name.'), { status: 400 });
  const memory = Number(input.memoryMiB), cpus = Number(input.cpus), disk = Number(input.diskGiB);
  if (!Number.isInteger(memory) || memory < 1024 || memory > 65536 || !Number.isInteger(cpus) || cpus < 1 || cpus > 32 || !Number.isInteger(disk) || disk < 10 || disk > 2048) throw Object.assign(new Error('Use 1024–65536 MiB RAM, 1–32 CPUs and 10–2048 GiB disk.'), { status: 400 });
  const iso = String(input.iso || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(input.pool || '') || !/^[a-zA-Z0-9._:-]{1,48}$/.test(input.network || '') || !virtualization.pools.includes(input.pool) || !virtualization.networks.includes(input.network) || (iso && !virtualization.images.includes(iso))) throw Object.assign(new Error('Select an accessible LightNAS VM storage/network and, optionally, an available installer ISO.'), { status: 409 });

  if (virtualization.provider?.startsWith('proxmox')) return proxmoxCreateVm(input, virtualization);
  if (virtualization.machineDetails.some(item => item.name === input.name)) throw Object.assign(new Error('A VM with this name already exists.'), { status: 409 });

  const vmStorage = await resolveStoragePool(input.pool, 'images', true);
  const diskDirectory = join(vmStorage.root, 'images', input.name);
  await mkdir(diskDirectory, { recursive: true });
  const diskPath = join(diskDirectory, `${input.name}.qcow2`);
  const isoEntry = iso ? (await listContentAcrossPools('iso')).find(item => item.id === iso) : null;
  if (iso && !isoEntry) throw Object.assign(new Error('Selected installer ISO is no longer available.'), { status: 409 });

  const networkDetail = virtualization.networkDetails?.find(item => item.name === input.network);
  const networkArg = networkDetail?.type === 'host-bridge' ? `bridge=${input.network},model=virtio` : `network=${input.network},model=virtio`;
  const virtType = virtualization.acceleration === 'kvm' ? 'kvm' : 'qemu';
  const args = ['--connect', 'qemu:///system', '--virt-type', virtType, '--name', input.name, '--memory', String(memory), '--vcpus', String(cpus), '--disk', `path=${diskPath},size=${disk},format=qcow2,bus=scsi`, '--controller', 'scsi,model=virtio-scsi', '--network', networkArg, '--graphics', 'vnc,listen=127.0.0.1', '--video', 'virtio', '--noautoconsole', '--wait', '0'];
  if (isoEntry) args.push('--cdrom', isoEntry.path, '--osinfo', 'detect=on,require=off');
  else args.push('--import', '--boot', 'hd,menu=on', '--osinfo', 'generic');
  const response = await exclusive(() => command('virt-install', args, 180000));
  if (!response.ok) throw Object.assign(new Error(`VM creation failed: ${response.error}`), { status: 409 });
  return { id: input.name, name: input.name, provider: virtualization.provider, acceleration: virtualization.acceleration, details: response.output || 'VM created and started.' };
}

