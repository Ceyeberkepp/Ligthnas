// Optional Proxmox VE VM connection for installations running inside an LXC.
// All network requests use the trusted OS CA store. No certificate bypass or shell execution.
function config() {
  const { LIGHTNAS_PVE_URL: address, LIGHTNAS_PVE_NODE: node,
    LIGHTNAS_PVE_TOKEN_ID: tokenId, LIGHTNAS_PVE_TOKEN_SECRET: tokenSecret } = process.env;
  if (![address, node, tokenId, tokenSecret].some(Boolean)) return null;
  if (![address, node, tokenId, tokenSecret].every(Boolean)) throw new Error('Proxmox connection needs URL, node, token ID and secret.');
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Proxmox URL must be a bare HTTPS origin.');
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(node) || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$/.test(tokenId)) throw new Error('Invalid Proxmox node or token ID.');
  return { url, node, tokenId, tokenSecret };
}
export function proxmoxConfigured() { return Boolean(config()); }

async function api(settings, path, form) {
  const url = new URL(`/api2/json/${path}`, settings.url);
  const response = await fetch(url, {
    method: form ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `PVEAPIToken=${settings.tokenId}=${settings.tokenSecret}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form) } : {})
  });
  if (!response.ok) throw new Error(`Proxmox API returned HTTP ${response.status} for ${path.split('?')[0]}. Check the token permissions, node, and storage.`);
  const data = await response.json();
  if (data.errors || data.data === undefined) throw new Error('Proxmox API returned an invalid response.');
  return data.data;
}

export async function proxmoxInventory() {
  const settings = config();
  if (!settings) return null;
  const node = encodeURIComponent(settings.node);
  const [machines, stores, bridges] = await Promise.all([
    api(settings, `nodes/${node}/qemu`),
    api(settings, `nodes/${node}/storage?content=images`),
    api(settings, `nodes/${node}/network`)
  ]);
  const pools = stores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage)).map(item => item.storage);
  // ISO content may reside on a different storage than VM disks.
  const isoStores = await api(settings, `nodes/${node}/storage?content=iso`);
  const images = (await Promise.all(isoStores.filter(item => item.enabled !== 0 && item.active !== 0 && /^[a-zA-Z0-9_-]+$/.test(item.storage)).slice(0, 20).map(async item => {
    const content = await api(settings, `nodes/${node}/storage/${encodeURIComponent(item.storage)}/content?content=iso`);
    return content.filter(entry => entry.content === 'iso' && typeof entry.volid === 'string').map(entry => entry.volid);
  }))).flat();
  return {
    available: true, enabled: true, provider: 'proxmox', reason: null,
    machines: machines.map(item => `${item.name || 'VM'} (${item.vmid}) · ${item.status || 'unknown'}`),
    pools, networks: bridges.filter(item => item.type === 'bridge' && item.active !== 0 && /^[a-zA-Z0-9._-]+$/.test(item.iface)).map(item => item.iface), images
  };
}

export async function proxmoxCreateVm(input, inventory) {
  const settings = config();
  if (!settings || !inventory?.available) throw Object.assign(new Error('Proxmox is not connected.'), { status: 409 });
  if (inventory.machines.some(name => name.startsWith(`${input.name} (`))) throw Object.assign(new Error('A VM with this name already exists on Proxmox.'), { status: 409 });
  if (!inventory.pools.includes(input.pool) || !inventory.networks.includes(input.network) || !inventory.images.includes(input.iso)) throw Object.assign(new Error('Choose a currently available Proxmox storage, bridge and ISO.'), { status: 409 });
  const node = encodeURIComponent(settings.node);
  const vmid = Number(await api(settings, 'cluster/nextid'));
  if (!Number.isInteger(vmid) || vmid < 100) throw new Error('Proxmox returned an invalid VM ID.');
  const task = await api(settings, `nodes/${node}/qemu`, {
    vmid: String(vmid), name: input.name, memory: String(input.memoryMiB), cores: String(input.cpus),
    scsihw: 'virtio-scsi-pci', scsi0: `${input.pool}:${input.diskGiB}`, ide2: `${input.iso},media=cdrom`,
    net0: `virtio,bridge=${input.network}`, boot: 'order=ide2;scsi0'
  });
  if (typeof task !== 'string' || !task.startsWith('UPID:')) throw new Error('Proxmox did not return a VM creation task ID. Check the VM inventory before retrying.');
  for (let attempt = 0; attempt < 20; attempt++) {
    let status;
    try { status = await api(settings, `nodes/${node}/tasks/${encodeURIComponent(task)}/status`); }
    catch { return { name: input.name, vmid, task, details: 'VM creation task submitted. Check its status in Proxmox before retrying.' }; }
    if (status.status === 'stopped') {
      if (status.exitstatus !== 'OK') throw Object.assign(new Error(`VM creation task failed: ${String(status.exitstatus || 'unknown').slice(0, 120)}. Check the Proxmox task log; the VM might be partially created.`), { status: 409 });
      try {
        const startTask = await api(settings, `nodes/${node}/qemu/${vmid}/status/start`, {});
        return { name: input.name, vmid, task, startTask, details: 'VM created and start task submitted. Open its console in Proxmox to complete ISO installation.' };
      } catch {
        return { name: input.name, vmid, task, details: 'VM created, but it could not be started. Check VM.PowerMgmt permission and start it from Proxmox.' };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { name: input.name, vmid, task, details: 'VM creation is still running. Check the task in Proxmox before retrying.' };
}
