import { importStorageContent, listContentAcrossPools, listStoragePools } from './storage-pools.mjs';

export const WINDOWS_VIRTIO_STABLE_ISO =
  'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso';

function isVirtioWindowsIso(item) {
  return /(?:^|\/)virtio-win(?:[-_.].*)?\.iso$/i.test(String(item?.name || item?.path || ''));
}

export async function vmGuestToolsInventory() {
  const [isos, storage] = await Promise.all([
    listContentAcrossPools('iso').catch(() => []),
    listStoragePools().catch(() => ({ pools: [] }))
  ]);
  const windowsMedia = isos.find(isVirtioWindowsIso) || null;
  const writableIsoPools = (storage.pools || []).filter(pool => pool.online && pool.writable && pool.content.includes('iso'));
  return {
    windows: {
      kind: 'virtio',
      available: Boolean(windowsMedia),
      mediaId: windowsMedia?.id || '',
      name: windowsMedia?.name || '',
      storageId: windowsMedia?.storageId || '',
      storageName: windowsMedia?.storageName || '',
      canDownload: writableIsoPools.length > 0,
      description: 'Paravirtualized storage, network, balloon and guest drivers for Windows virtual machines.'
    },
    linux: {
      kind: 'virtio',
      available: true,
      builtIn: true,
      description: 'Linux uses the VirtIO drivers supplied by its kernel; no separate driver ISO is normally required.'
    }
  };
}

export async function ensureWindowsVirtioDrivers(preferredStorageId = '') {
  const existing = (await listContentAcrossPools('iso')).find(isVirtioWindowsIso);
  if (existing) return { ...existing, downloaded: false };

  const storage = await listStoragePools();
  const writable = (storage.pools || []).filter(pool => pool.online && pool.writable && pool.content.includes('iso'));
  const target = writable.find(pool => pool.id === preferredStorageId) ||
    writable.find(pool => pool.id === 'local') ||
    writable[0];
  if (!target) throw Object.assign(new Error('No writable ISO storage is available for Windows guest drivers.'), { status: 409 });

  const imported = await importStorageContent(target.id, 'iso', WINDOWS_VIRTIO_STABLE_ISO);
  const refreshed = (await listContentAcrossPools('iso')).find(item =>
    item.storageId === target.id && item.name === imported.name
  ) || (await listContentAcrossPools('iso')).find(isVirtioWindowsIso);
  if (!refreshed) throw Object.assign(new Error('Windows guest drivers downloaded but could not be added to the ISO library.'), { status: 500 });
  return { ...refreshed, downloaded: true };
}
