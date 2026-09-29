import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const dataRoot = dirname(resolve(process.env.NAS_DATA_FILE || 'data/state.json'));
const shareRoot = resolve(process.env.LIGHTNAS_SHARE_ROOT || join(dataRoot, 'files', 'Shares'));
const sambaMain = process.env.LIGHTNAS_SAMBA_CONFIG || '/etc/samba/smb.conf';
const sambaFragment = '/etc/samba/smb.conf.d/lightnas-shares.conf';
const sshFragment = '/etc/ssh/sshd_config.d/90-lightnas-sftp.conf';

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
  return name;
}
function shareDirectory(share) {
  return join(shareRoot, share.id);
}
async function run(file, args, options = {}) {
  try {
    const { stdout = '', stderr = '' } = await execute(file, args, { encoding:'utf8', maxBuffer: 2 * 1024 * 1024, ...options });
    return { ok:true, stdout:String(stdout), stderr:String(stderr) };
  } catch (error) {
    return { ok:false, stdout:String(error.stdout || ''), stderr:String(error.stderr || error.message || ''), code:error.code };
  }
}
async function requireCommand(name) {
  const result = await run('sh', ['-lc', `command -v ${name}`]);
  if (!result.ok) throw Object.assign(new Error(`${name} is not installed. Rerun the LightNAS installer to provision network sharing.`), { status: 409 });
}
async function ensureUser(username, password) {
  const existing = await run('id', ['-u', username]);
  if (!existing.ok) {
    const created = await run('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', username]);
    if (!created.ok) throw Object.assign(new Error(`Could not create network account ${username}: ${created.stderr.trim()}`), { status: 500 });
  }
  const changed = await run('chpasswd', [], { input:`${username}:${password}\n` });
  if (!changed.ok) throw Object.assign(new Error('Could not set the network account password.'), { status: 500 });
}
async function ensureSambaInclude() {
  await mkdir('/etc/samba/smb.conf.d', { recursive:true, mode:0o755 });
  let main = '';
  try { main = await readFile(sambaMain, 'utf8'); } catch {}
  const includeLine = `include = ${sambaFragment}`;
  if (!main.includes(includeLine)) await appendFile(sambaMain, `\n# LightNAS managed shares\n${includeLine}\n`);
}
function usesSmb(protocol) {
  return protocol === 'SMB' || protocol === 'SMB+SFTP';
}
function usesSftp(protocol) {
  return protocol === 'SFTP' || protocol === 'SMB+SFTP';
}
export async function syncNetworkShareConfigs(shares = []) {
  const smbShares = shares.filter(share => usesSmb(share.protocol) && share.username);
  if (smbShares.length) {
    await requireCommand('smbd');
    await ensureSambaInclude();
    const body = smbShares.map(share => `
[${share.name}]
  path = ${shareDirectory(share)}
  browseable = yes
  read only = no
  guest ok = no
  valid users = ${share.username}
  create mask = 0660
  directory mask = 0770
  force user = ${share.username}
`).join('\n');
    await writeFile(sambaFragment, `# Managed by LightNAS. Do not edit manually.\n${body}`, { mode:0o644 });
    const checked = await run('testparm', ['-s', sambaMain]);
    if (!checked.ok) throw Object.assign(new Error(`Samba configuration validation failed: ${checked.stderr.trim()}`), { status:500 });
    await run('systemctl', ['reload-or-restart', 'smbd']);
  } else {
    await mkdir('/etc/samba/smb.conf.d', { recursive:true, mode:0o755 }).catch(()=>{});
    await writeFile(sambaFragment, '# Managed by LightNAS. No SMB shares configured.\n', { mode:0o644 }).catch(()=>{});
    await run('systemctl', ['reload', 'smbd']);
  }

  const sftpShares = shares.filter(share => usesSftp(share.protocol) && share.username);
  await mkdir('/etc/ssh/sshd_config.d', { recursive:true, mode:0o755 });
  const sshBody = sftpShares.map(share => `
Match User ${share.username}
  PasswordAuthentication yes
  ForceCommand internal-sftp -d ${shareDirectory(share)}
  PermitTunnel no
  AllowTcpForwarding no
  X11Forwarding no
`).join('\n');
  await writeFile(sshFragment, `# Managed by LightNAS. Do not edit manually.\n${sshBody}`, { mode:0o600 });
  if (sftpShares.length) {
    await requireCommand('sshd');
    const checked = await run('sshd', ['-t']);
    if (!checked.ok) throw Object.assign(new Error(`SSH/SFTP configuration validation failed: ${checked.stderr.trim()}`), { status:500 });
    await run('systemctl', ['reload-or-restart', 'ssh']);
  }
}

export async function provisionNetworkShare(input, existingShares = []) {
  const name = safeShareName(input.name);
  const protocol = ['SMB','SFTP','SMB+SFTP'].includes(input.protocol) ? input.protocol : 'SMB';
  const username = safeUser(input.username);
  const password = String(input.password || '');
  if (password.length < 8 || password.length > 128) throw Object.assign(new Error('Network password must contain 8–128 characters.'), { status:400 });

  const share = {
    id: crypto.randomUUID(),
    name,
    protocol,
    username,
    description: String(input.description || '').slice(0, 160),
    createdAt: new Date().toISOString()
  };
  const path = shareDirectory(share);
  await mkdir(path, { recursive:true, mode:0o770 });
  await ensureUser(username, password);
  const ownership = await run('chown', ['-R', `${username}:${username}`, path]);
  if (!ownership.ok) throw Object.assign(new Error('Could not assign network-share permissions.'), { status:500 });

  if (usesSmb(protocol)) {
    await requireCommand('smbpasswd');
    const smbPass = await run('smbpasswd', ['-s', '-a', username], { input:`${password}\n${password}\n` });
    if (!smbPass.ok) throw Object.assign(new Error(`Could not create SMB credentials: ${smbPass.stderr.trim()}`), { status:500 });
  }
  await syncNetworkShareConfigs([...existingShares, share]);
  return { ...share, path };
}

export async function removeNetworkShare(share, remainingShares = []) {
  await syncNetworkShareConfigs(remainingShares);
  return { preservedPath: shareDirectory(share) };
}

export function publicShare(share, host = '') {
  const smb = usesSmb(share.protocol) ? `\\\\${host}\\${share.name}` : null;
  const smbUrl = usesSmb(share.protocol) ? `smb://${host}/${encodeURIComponent(share.name)}` : null;
  const sftp = usesSftp(share.protocol) ? `sftp://${share.username}@${host}` : null;
  return { ...share, smb, smbUrl, sftp };
}
