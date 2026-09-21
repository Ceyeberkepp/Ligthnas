// Proxmox integration for LightNAS installations running inside an LXC.
// Preferred mode is the one-click local Unix-socket host bridge installed by
// scripts/proxmox-lxc-install.sh. The HTTPS API-token mode remains as a
// compatibility fallback for remote Proxmox connections.

import net from 'node:net';

function operationError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

function hostBridgeConfig() {
  const { LIGHTNAS_PVE_SOCKET: socketPath, LIGHTNAS_PVE_CLIENT_ID: client,
    LIGHTNAS_PVE_SECRET: secret } = process.env;
  if (![socketPath, client, secret].some(Boolean)) return null;
  if (![socketPath, client, secret].every(Boolean)) throw operationError('Proxmox host bridge configuration is incomplete.');
  if (!socketPath.startsWith('/') || socketPath.includes('\0')) throw operationError('Invalid Proxmox host bridge socket path.');
  if (!/^[1-9][0-9]{1,5}$/.test(client) || !/^[a-fA-F0-9]{32,128}$/.test(secret)) throw operationError('Invalid Proxmox host bridge credentials.');
  return { socketPath, client, secret };
}

function apiConfig() {
  const { LIGHTNAS_PVE_URL: address, LIGHTNAS_PVE_NODE: node,
    LIGHTNAS_PVE_TOKEN_ID: tokenId, LIGHTNAS_PVE_TOKEN_SECRET: tokenSecret } = process.env;
  if (![address, node, tokenId, tokenSecret].some(Boolean)) return null;
  if (![address, node, tokenId, tokenSecret].every(Boolean)) throw operationError('Legacy Proxmox connection needs URL, node, token ID and secret.');
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw operationError('Proxmox URL must be a bare HTTPS origin.');
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(node) || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$/.test(tokenId)) throw operationError('Invalid Proxmox node or token ID.');
  return { url, node, tokenId, tokenSecret };
}

export function proxmoxConfigured() { return Boolean(hostBridgeConfig() || apiConfig()); }
export function proxmoxHostBridgeConfigured() { return Boolean(hostBridgeConfig()); }

async function hostBridge(settings, action, data = undefined) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: settings.socketPath });
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(30000, () => finish(operationError('Proxmox host bridge timed out.')));
    socket.on('error', error => finish(operationError(`Proxmox host bridge is unavailable: ${error.message}`)));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ client: settings.client, secret: settings.secret, action, ...(data ? { data } : {}) })}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) return finish(operationError('Proxmox host bridge returned too much data.'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response?.ok) return finish(operationError(response?.error || 'Proxmox host bridge operation failed.', response?.code === 'forbidden' ? 403 : 409));
        finish(null, response.data);
      } catch (error) {
        finish(operationError(`Proxmox host bridge returned invalid data: ${error.message}`));
      }
    });
    socket.on('end', () => {
      if (!settled) finish(operationError('Proxmox host bridge closed before replying.'));
    });
  });
}

export async function proxmoxConsoleSocket(vmid) {
  const numericId = Number(vmid);
  if (!Number.isInteger(numericId) || numericId < 100 || numericId > 999999) throw Object.assign(new Error('Invalid VM ID.'), { status: 400 });
  const settings = hostBridgeConfig();
  if (!settings) throw operationError('Embedded noVNC currently requires the automatic Proxmox host bridge.');

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: settings.socketPath });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 128 * 1024) return fail(operationError('Proxmox console handshake was too large.'));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
      catch { return fail(operationError('Proxmox console bridge returned an invalid handshake.')); }
      if (!response?.ok) return fail(operationError(response?.error || 'Unable to open Proxmox console.', response?.code === 'forbidden' ? 403 : 409));
      const remaining = buffer.subarray(newline + 1);
      settled = true;
      socket.off('data', onData);
      socket.setTimeout(0);
      if (remaining.length) socket.unshift(remaining);
      resolve(socket);
    };
    socket.setTimeout(15000, () => fail(operationError('Proxmox console bridge timed out.')));
    socket.on('error', error => fail(operationError(`Proxmox console bridge is unavailable: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ client: settings.client, secret: settings.secret, action: 'vm-console', data: { vmid: numericId } })}\n`));
    socket.on('data', onData);
    socket.on('end', () => { if (!settled) fail(operationError('Proxmox console bridge closed before the console opened.')); });
  });
}


export async function proxmoxContainerConsoleSocket(vmid) {
  const numericId = Number(vmid);
  if (!Number.isInteger(numericId) || numericId < 100 || numericId > 999999) throw Object.assign(new Error('Invalid container ID.'), { status: 400 });
  const settings = hostBridgeConfig();
  if (!settings) throw operationError('Embedded container terminal currently requires the automatic Proxmox host bridge.');

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: settings.socketPath });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 128 * 1024) return fail(operationError('Proxmox container console handshake was too large.'));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
      catch { return fail(operationError('Proxmox container console returned an invalid handshake.')); }
      if (!response?.ok) return fail(operationError(response?.error || 'Unable to open container terminal.', response?.code === 'forbidden' ? 403 : 409));
      const remaining = buffer.subarray(newline + 1);
      settled = true;
      socket.off('data', onData);
      socket.setTimeout(0);
      if (remaining.length) socket.unshift(remaining);
      resolve(socket);
    };
    socket.setTimeout(15000, () => fail(operationError('Proxmox container console timed out.')));
    socket.on('error', error => fail(operationError(`Proxmox container console is unavailable: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ client: settings.client, secret: settings.secret, action: 'container-console', data: { vmid: numericId } })}\n`));
    socket.on('data', onData);
    socket.on('end', () => { if (!settled) fail(operationError('Proxmox container console closed before the terminal opened.')); });
  });
}

async function api(settings, path, form, method = 'POST') {
  const url = new URL(`/api2/json/${path}`, settings.url);
  const response = await fetch(url, {
    method: form ? method : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `PVEAPIToken=${settings.tokenId}=${settings.tokenSecret}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form) } : {})
  });
  if (!response.ok) throw operationError(`Proxmox API returned HTTP ${response.status} for ${path.split('?')[0]}. Check permissions, node, and storage.`);
  const data = await response.json();
  if (data.errors || data.data === undefined) throw operationError('Proxmox API returned an invalid response.');
  return data.data;
}

export async function proxmoxInventory() {
  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'inventory');

  const settings = apiConfig();
  if (!settings) return null;
  const node = encodeURIComponent(settings.node);
  const [machines, stores, bridges, nodeStatus, storageConfigs] = await Promise.all([
    api(settings, `nodes/${node}/qemu`),
    api(settings, `nodes/${node}/storage?content=images`),
    api(settings, `nodes/${node}/network`),
    api(settings, `nodes/${node}/status`).catch(() => ({})),
    api(settings, 'storage').catch(() => [])
  ]);
  const poolDetails = stores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage)).map(item => ({
    name: item.storage, type: item.type || 'unknown', total: Number(item.total) || 0, available: Number(item.avail) || 0
  }));
  const pools = poolDetails.map(item => item.name);
  const isoStores = await api(settings, `nodes/${node}/storage?content=iso`);
  const images = [...new Set((await Promise.all(isoStores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage)).slice(0, 20).map(async item => {
    const content = await api(settings, `nodes/${node}/storage/${encodeURIComponent(item.storage)}/content?content=iso`);
    return content.filter(entry => entry.content === 'iso' && typeof entry.volid === 'string' && entry.volid.toLowerCase().endsWith('.iso')).map(entry => entry.volid);
  }))).flat())].sort();
  const machineDetails = machines.filter(item => Number.isInteger(Number(item.vmid))).map(item => ({
    vmid: Number(item.vmid), name: item.name || `VM-${item.vmid}`, status: item.status || 'unknown',
    memory: Number(item.maxmem) || 0, disk: Number(item.maxdisk) || 0, cpus: Number(item.cpus) || 0
  }));
  const liveStorage = Object.fromEntries(stores.map(item => [item.storage, item]));
  const hostStorages = storageConfigs.filter(item => /^[a-zA-Z0-9_-]+$/.test(item.storage || '')).map(item => {
    const live = liveStorage[item.storage] || {};
    return {
      name: item.storage, type: item.type || live.type || 'unknown',
      content: Array.isArray(item.content) ? item.content : String(item.content || '').split(',').filter(Boolean),
      enabled: item.disable !== 1, active: live.active !== 0,
      totalBytes: Number(live.total) || 0, availableBytes: Number(live.avail) || 0, usedBytes: Number(live.used) || 0
    };
  });
  return {
    available: true, enabled: true, provider: 'proxmox', reason: null,
    machines: machineDetails.map(item => `${item.name} (${item.vmid}) · ${item.status}`), machineDetails,
    pools, poolDetails,
    networks: bridges.filter(item => item.type === 'bridge' && item.active !== 0 && /^[a-zA-Z0-9._-]+$/.test(item.iface)).map(item => item.iface),
    images, node: settings.node, proxmoxUrl: settings.url.origin, transport: 'api-token',
    host: {
      node: settings.node,
      status: {
        uptimeSeconds: Number(nodeStatus.uptime) || 0,
        cpuPercent: Math.round((Number(nodeStatus.cpu) || 0) * 1000) / 10,
        memory: {
          totalBytes: Number(nodeStatus.memory?.total) || 0,
          usedBytes: Number(nodeStatus.memory?.used) || 0,
          freeBytes: Number(nodeStatus.memory?.free) || 0
        }
      },
      disks: [], storages: hostStorages, zfs: { available: false, pools: [], datasets: [] }, networks: bridges, wifi: [], containers: []
    }
  };
}


export async function proxmoxContainerInventory() {
  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'container-inventory');

  const settings = apiConfig();
  if (!settings) return null;
  const node = encodeURIComponent(settings.node);
  const [containers, rootStores, templateStores, bridges] = await Promise.all([
    api(settings, `nodes/${node}/lxc`),
    api(settings, `nodes/${node}/storage?content=rootdir`),
    api(settings, `nodes/${node}/storage?content=vztmpl`),
    api(settings, `nodes/${node}/network`)
  ]);
  const pools = rootStores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage || '')).map(item => ({
    name: item.storage, type: item.type || 'unknown', total: Number(item.total) || 0, available: Number(item.avail) || 0
  }));
  const templates = [...new Set((await Promise.all(templateStores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage || '')).slice(0, 20).map(async item => {
    const content = await api(settings, `nodes/${node}/storage/${encodeURIComponent(item.storage)}/content?content=vztmpl`);
    return content.filter(entry => entry.content === 'vztmpl' && typeof entry.volid === 'string').map(entry => entry.volid);
  }))).flat())].sort();
  return {
    available: true,
    enabled: true,
    provider: 'proxmox-lxc',
    reason: null,
    containers: containers.filter(item => Number.isInteger(Number(item.vmid))).map(item => ({
      vmid: Number(item.vmid),
      name: item.name || `CT-${item.vmid}`,
      status: item.status || 'unknown',
      memory: Number(item.maxmem) || 0,
      disk: Number(item.maxdisk) || 0,
      cpus: Number(item.cpus) || 0,
      uptime: Number(item.uptime) || 0,
      protected: false
    })),
    pools: pools.map(item => item.name),
    poolDetails: pools,
    networks: bridges.filter(item => item.type === 'bridge' && item.active !== 0 && /^[a-zA-Z0-9._-]{1,64}$/.test(item.iface || '')).map(item => item.iface),
    templates,
    node: settings.node
  };
}

export async function proxmoxCreateContainer(input, inventory) {
  const name = String(input.name || '').trim();
  const memory = Number(input.memoryMiB);
  const cpus = Number(input.cpus);
  const disk = Number(input.diskGiB);
  const pool = String(input.pool || '');
  const network = String(input.network || '');
  const template = String(input.template || '');
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Use a 2–40 character container name.'), { status: 400 });
  if (!Number.isInteger(memory) || memory < 256 || memory > 65536 || !Number.isInteger(cpus) || cpus < 1 || cpus > 64 || !Number.isInteger(disk) || disk < 2 || disk > 2048) throw Object.assign(new Error('Use 256–65536 MiB RAM, 1–64 CPUs and 2–2048 GiB disk.'), { status: 400 });
  if (!inventory?.available || !inventory.pools.includes(pool) || !inventory.networks.includes(network) || !inventory.templates.includes(template)) throw operationError('Select an available Proxmox container storage, bridge and LXC template.');

  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'create-container', { name, memoryMiB: memory, cpus, diskGiB: disk, pool, network, template });

  const settings = apiConfig();
  if (!settings) throw operationError('Proxmox is not connected.');
  const node = encodeURIComponent(settings.node);
  const vmid = Number(await api(settings, 'cluster/nextid'));
  if (!Number.isInteger(vmid) || vmid < 100) throw operationError('Proxmox returned an invalid container ID.');
  await api(settings, `nodes/${node}/lxc`, {
    vmid: String(vmid), hostname: name, ostemplate: template, memory: String(memory), cores: String(cpus),
    rootfs: `${pool}:${disk}`, net0: `name=eth0,bridge=${network},ip=dhcp,type=veth`, unprivileged: '1', onboot: '1'
  });
  await api(settings, `nodes/${node}/lxc/${vmid}/status/start`, {});
  return { vmid, name, provider: 'proxmox-lxc', status: 'running' };
}

export async function proxmoxManageContainer(vmid, action) {
  const numericId = Number(vmid);
  if (!Number.isInteger(numericId) || numericId < 100 || numericId > 999999) throw Object.assign(new Error('Invalid container ID.'), { status: 400 });
  if (!['start', 'stop', 'shutdown', 'reboot', 'delete'].includes(action)) throw Object.assign(new Error('Invalid container action.'), { status: 400 });
  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'container-action', { vmid: numericId, action });
  const settings = apiConfig();
  if (!settings) throw operationError('Proxmox is not connected.');
  const node = encodeURIComponent(settings.node);
  if (action === 'delete') {
    try { await api(settings, `nodes/${node}/lxc/${numericId}/status/stop`, {}); } catch {}
    await api(settings, `nodes/${node}/lxc/${numericId}`, { purge: '1' }, 'DELETE');
    return { vmid: numericId, action, status: 'deleted' };
  }
  await api(settings, `nodes/${node}/lxc/${numericId}/status/${action}`, {});
  return { vmid: numericId, action, status: 'submitted' };
}

export async function proxmoxUpdateContainer(input) {
  const vmid = Number(input.vmid);
  const memory = Number(input.memoryMiB);
  const cpus = Number(input.cpus);
  const name = String(input.name || '').trim();
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999 || !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Invalid container ID or name.'), { status: 400 });
  if (!Number.isInteger(memory) || memory < 256 || memory > 262144 || !Number.isInteger(cpus) || cpus < 1 || cpus > 128) throw Object.assign(new Error('Invalid container CPU or memory values.'), { status: 400 });
  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'container-update', { vmid, name, memoryMiB: memory, cpus });
  const settings = apiConfig();
  if (!settings) throw operationError('Proxmox is not connected.');
  await api(settings, `nodes/${encodeURIComponent(settings.node)}/lxc/${vmid}/config`, { hostname: name, memory: String(memory), cores: String(cpus) }, 'PUT');
  return { vmid, name, memoryMiB: memory, cpus, status: 'updated' };
}

export async function proxmoxCreateVm(input, inventory) {
  const firmware = ['bios', 'uefi'].includes(input.firmware) ? input.firmware : 'bios';
  const diskBus = ['scsi', 'virtio', 'sata'].includes(input.diskBus) ? input.diskBus : 'scsi';
  const networkModel = ['virtio', 'e1000', 'rtl8139'].includes(input.networkModel) ? input.networkModel : 'virtio';
  const startOnBoot = input.startOnBoot !== false && input.startOnBoot !== 'false';
  const bridge = hostBridgeConfig();
  if (bridge) {
    if (!inventory?.available) throw operationError('Proxmox host bridge is not available.');
    return await hostBridge(bridge, 'create-vm', {
      name: input.name, memoryMiB: input.memoryMiB, cpus: input.cpus, diskGiB: input.diskGiB,
      pool: input.pool, network: input.network, iso: input.iso,
      firmware, diskBus, networkModel, startOnBoot
    });
  }

  const settings = apiConfig();
  if (!settings || !inventory?.available) throw operationError('Proxmox is not connected.');
  if (inventory.machines.some(name => name.startsWith(`${input.name} (`))) throw operationError('A VM with this name already exists on Proxmox.');
  if (!inventory.pools.includes(input.pool) || !inventory.networks.includes(input.network) || (input.iso && !inventory.images.includes(input.iso))) throw operationError('Choose a currently available Proxmox storage, bridge and optional ISO.');
  const node = encodeURIComponent(settings.node);
  const vmid = Number(await api(settings, 'cluster/nextid'));
  if (!Number.isInteger(vmid) || vmid < 100) throw operationError('Proxmox returned an invalid VM ID.');
  const task = await api(settings, `nodes/${node}/qemu`, {
    vmid: String(vmid), name: input.name, memory: String(input.memoryMiB), cores: String(input.cpus),
    bios: firmware === 'uefi' ? 'ovmf' : 'seabios',
    scsihw: 'virtio-scsi-pci',
    [diskBus === 'scsi' ? 'scsi0' : diskBus === 'virtio' ? 'virtio0' : 'sata0']: `${input.pool}:${input.diskGiB}`,
    ...(input.iso ? { ide2: `${input.iso},media=cdrom`, boot: `order=ide2;${diskBus === 'scsi' ? 'scsi0' : diskBus === 'virtio' ? 'virtio0' : 'sata0'}` } : { boot: `order=${diskBus === 'scsi' ? 'scsi0' : diskBus === 'virtio' ? 'virtio0' : 'sata0'}` }),
    net0: `${networkModel},bridge=${input.network}`, onboot: startOnBoot ? '1' : '0', ostype: 'l26'
  });
  if (typeof task !== 'string' || !task.startsWith('UPID:')) throw operationError('Proxmox did not return a VM creation task ID.');

  for (let attempt = 0; attempt < 20; attempt++) {
    let taskStatus;
    try { taskStatus = await api(settings, `nodes/${node}/tasks/${encodeURIComponent(task)}/status`); }
    catch { return { name: input.name, vmid, task, details: 'VM creation task submitted. Check its status in Proxmox.' }; }
    if (taskStatus.status === 'stopped') {
      if (taskStatus.exitstatus !== 'OK') throw operationError(`VM creation task failed: ${String(taskStatus.exitstatus || 'unknown').slice(0, 120)}.`);
      try {
        const startTask = await api(settings, `nodes/${node}/qemu/${vmid}/status/start`, {});
        return { name: input.name, vmid, task, startTask, details: 'VM created and start task submitted.' };
      } catch {
        return { name: input.name, vmid, task, details: 'VM created, but automatic start failed. Start it from Proxmox.' };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { name: input.name, vmid, task, details: 'VM creation is still running. Check its Proxmox task.' };
}

export async function proxmoxManageVm(vmid, action) {
  const numericId = Number(vmid);
  if (!Number.isInteger(numericId) || numericId < 100 || numericId > 999999) throw Object.assign(new Error('Invalid VM ID.'), { status: 400 });
  if (!['start', 'stop', 'shutdown', 'reboot', 'reset', 'delete'].includes(action)) throw Object.assign(new Error('Invalid VM action.'), { status: 400 });

  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'vm-action', { vmid: numericId, action });

  const settings = apiConfig();
  if (!settings) throw operationError('Proxmox is not connected.');
  const node = encodeURIComponent(settings.node);
  if (action === 'delete') {
    try { await api(settings, `nodes/${node}/qemu/${numericId}/status/stop`, {}); } catch {}
    await api(settings, `nodes/${node}/qemu/${numericId}`, { purge: '1', 'destroy-unreferenced-disks': '1' }, 'DELETE');
    return { vmid: numericId, action, status: 'deleted' };
  }
  await api(settings, `nodes/${node}/qemu/${numericId}/status/${action}`, {});
  return { vmid: numericId, action, status: 'submitted' };
}

export async function proxmoxUpdateVm(input) {
  const numericId = Number(input.vmid);
  const memory = Number(input.memoryMiB);
  const cpus = Number(input.cpus);
  const name = String(input.name || '');
  if (!Number.isInteger(numericId) || numericId < 100 || numericId > 999999 || !/^[a-zA-Z][a-zA-Z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Invalid VM ID or name.'), { status: 400 });
  if (!Number.isInteger(memory) || memory < 512 || memory > 262144 || !Number.isInteger(cpus) || cpus < 1 || cpus > 128) throw Object.assign(new Error('Invalid VM CPU or memory values.'), { status: 400 });
  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'vm-update', { vmid: numericId, name, memoryMiB: memory, cpus });
  const settings = apiConfig();
  if (!settings) throw operationError('Proxmox is not connected.');
  await api(settings, `nodes/${encodeURIComponent(settings.node)}/qemu/${numericId}/config`, { name, memory: String(memory), cores: String(cpus) }, 'PUT');
  return { vmid: numericId, name, memoryMiB: memory, cpus, status: 'updated' };
}

export async function proxmoxUpdateStorage(storage, content) {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(storage || '') || !Array.isArray(content)) throw Object.assign(new Error('Invalid Proxmox storage update.'), { status: 400 });
  const allowed = new Set(['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import']);
  const normalized = [...new Set(content.filter(item => allowed.has(item)))].sort();
  if (!normalized.length) throw Object.assign(new Error('Select at least one storage content type.'), { status: 400 });
  const bridge = hostBridgeConfig();
  if (bridge) return await hostBridge(bridge, 'storage-update', { storage, content: normalized });
  const settings = apiConfig();
  if (!settings) throw operationError('Proxmox is not connected.');
  await api(settings, `storage/${encodeURIComponent(storage)}`, { content: normalized.join(',') }, 'PUT');
  return { storage, content: normalized, status: 'updated' };
}

export async function proxmoxCleanDisk(path, confirm) {
  const bridge = hostBridgeConfig();
  if (!bridge) throw operationError('Disk cleaning requires the automatic local Proxmox host bridge.');
  return await hostBridge(bridge, 'disk-clean', { path, confirm });
}
