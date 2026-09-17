// Proxmox integration for LightNAS installations running inside an LXC.
// Preferred mode is the one-click local Unix-socket host bridge installed by
// scripts/proxmox-lxc-install.sh. The older HTTPS API-token mode remains only
// as a compatibility fallback for remote Proxmox connections.

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
  const [machines, stores, bridges] = await Promise.all([
    api(settings, `nodes/${node}/qemu`),
    api(settings, `nodes/${node}/storage?content=images`),
    api(settings, `nodes/${node}/network`)
  ]);
  const poolDetails = stores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage)).map(item => ({
    name: item.storage,
    type: item.type || 'unknown',
    total: Number(item.total) || 0,
    available: Number(item.avail) || 0
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
  return {
    available: true, enabled: true, provider: 'proxmox', reason: null,
    machines: machineDetails.map(item => `${item.name} (${item.vmid}) · ${item.status}`), machineDetails,
    pools, poolDetails,
    networks: bridges.filter(item => item.type === 'bridge' && item.active !== 0 && /^[a-zA-Z0-9._-]+$/.test(item.iface)).map(item => item.iface),
    images, node: settings.node, proxmoxUrl: settings.url.origin, transport: 'api-token'
  };
}

export async function proxmoxCreateVm(input, inventory) {
  const bridge = hostBridgeConfig();
  if (bridge) {
    if (!inventory?.available) throw operationError('Proxmox host bridge is not available.');
    return await hostBridge(bridge, 'create-vm', {
      name: input.name,
      memoryMiB: input.memoryMiB,
      cpus: input.cpus,
      diskGiB: input.diskGiB,
      pool: input.pool,
      network: input.network,
      iso: input.iso
    });
  }

  const settings = apiConfig();
  if (!settings || !inventory?.available) throw operationError('Proxmox is not connected.');
  if (inventory.machines.some(name => name.startsWith(`${input.name} (`))) throw operationError('A VM with this name already exists on Proxmox.');
  if (!inventory.pools.includes(input.pool) || !inventory.networks.includes(input.network) || !inventory.images.includes(input.iso)) throw operationError('Choose a currently available Proxmox storage, bridge and ISO.');
  const node = encodeURIComponent(settings.node);
  const vmid = Number(await api(settings, 'cluster/nextid'));
  if (!Number.isInteger(vmid) || vmid < 100) throw operationError('Proxmox returned an invalid VM ID.');
  const task = await api(settings, `nodes/${node}/qemu`, {
    vmid: String(vmid), name: input.name, memory: String(input.memoryMiB), cores: String(input.cpus),
    scsihw: 'virtio-scsi-pci', scsi0: `${input.pool}:${input.diskGiB}`, ide2: `${input.iso},media=cdrom`,
    net0: `virtio,bridge=${input.network}`, boot: 'order=ide2;scsi0', ostype: 'l26'
  });
  if (typeof task !== 'string' || !task.startsWith('UPID:')) throw operationError('Proxmox did not return a VM creation task ID.');
  return { name: input.name, vmid, task, details: 'VM creation task submitted to Proxmox.' };
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
    try { await api(settings, `nodes/${node}/qemu/${numericId}/status/stop`, {}); } catch { /* already stopped */ }
    await api(settings, `nodes/${node}/qemu/${numericId}`, { purge: '1', 'destroy-unreferenced-disks': '1' }, 'DELETE');
    return { vmid: numericId, action, status: 'deleted' };
  }
  await api(settings, `nodes/${node}/qemu/${numericId}/status/${action}`, {});
  return { vmid: numericId, action, status: 'submitted' };
}
