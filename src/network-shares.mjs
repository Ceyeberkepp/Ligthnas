import { localProvisionNetworkShare, localRemoveNetworkShare } from './local-host.mjs';

function safeUser(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_-]{1,30}$/.test(username)) {
    throw Object.assign(new Error('Network username must contain 2–31 lowercase letters, numbers, dashes, or underscores and start with a letter/underscore.'), { status: 400 });
  }
  return username;
}

function safeShareName(value) {
  const name = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,63}$/.test(name)) {
    throw Object.assign(new Error('Share name must contain 2–64 valid characters.'), { status: 400 });
  }
  if (name.toLowerCase() === 'files') {
    throw Object.assign(new Error('Files is reserved for the built-in LightNAS Files & media SMB share.'), { status: 400 });
  }
  return name;
}

export async function provisionNetworkShare(input, existingShares = []) {
  const name = safeShareName(input.name);
  const protocol = ['SMB','SFTP','SMB+SFTP'].includes(input.protocol) ? input.protocol : 'SMB';
  const username = safeUser(input.username);
  const password = String(input.password || '');
  if (password.length < 8 || password.length > 128) {
    throw Object.assign(new Error('Network password must contain 8–128 characters.'), { status: 400 });
  }

  const share = {
    id: crypto.randomUUID(),
    name,
    protocol,
    username,
    description: String(input.description || '').slice(0, 160),
    createdAt: new Date().toISOString()
  };

  await localProvisionNetworkShare({
    share,
    password,
    adminUsername: String(input.adminUsername || '').trim().toLowerCase(),
    existingShares: existingShares.map(item => ({
      id:String(item.id || ''),
      name:String(item.name || ''),
      protocol:String(item.protocol || ''),
      username:String(item.username || '')
    }))
  });
  return share;
}

export async function removeNetworkShare(share, remainingShares = [], adminUsername = '') {
  return await localRemoveNetworkShare({
    adminUsername: String(adminUsername || '').trim().toLowerCase(),
    share: {
      id:String(share.id || ''),
      name:String(share.name || ''),
      protocol:String(share.protocol || ''),
      username:String(share.username || '')
    },
    remainingShares: remainingShares.map(item => ({
      id:String(item.id || ''),
      name:String(item.name || ''),
      protocol:String(item.protocol || ''),
      username:String(item.username || '')
    }))
  });
}

export function publicShare(share, host = '') {
  const smbEnabled = share.protocol === 'SMB' || share.protocol === 'SMB+SFTP';
  const sftpEnabled = share.protocol === 'SFTP' || share.protocol === 'SMB+SFTP';
  const smb = smbEnabled ? `\\\\${host}\\${share.name}` : null;
  const smbUrl = smbEnabled ? `smb://${host}/${encodeURIComponent(share.name)}` : null;
  const sftp = sftpEnabled ? `sftp://${share.username}@${host}` : null;
  return { ...share, smb, smbUrl, sftp };
}


export function publicLibraryShare(host = '', adminUsername = '') {
  const username = String(adminUsername || '').trim().toLowerCase();
  return {
    id: 'lightnas-files',
    name: 'Files',
    protocol: 'SMB',
    username,
    description: 'Built-in Files & media library: Documents, Photos, Videos, and Audio.',
    createdAt: null,
    system: true,
    smb: `\\\\${host}\\Files`,
    smbUrl: `smb://${host}/Files`,
    sftp: null
  };
}
