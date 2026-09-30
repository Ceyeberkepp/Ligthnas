import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SMB shares grant safe parent traversal ACLs and repair saved shares', async () => {
  const [agent, localHost, server] = await Promise.all([
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/local-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(agent, /def _grant_share_path_access\(username: str, path: Path\)/);
  assert.match(agent, /setfacl", "-m", f"u:\{username\}:--x"/);
  assert.match(agent, /setfacl", "-m", f"u:\{username\}:rwx"/);
  assert.match(agent, /setfacl", "-m", f"d:u:\{username\}:rwx"/);
  assert.match(agent, /smbpasswd", "-e", share\["username"\]/);
  assert.match(agent, /if action == "share-repair":/);
  assert.match(localHost, /localRepairNetworkShares/);
  assert.match(server, /await localRepairNetworkShares\(store\.state\.shares\.map/);
});


test('LightNAS administrator is synchronized as SMB admin for every share', async () => {
  const [agent, localHost, server, shares] = await Promise.all([
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/local-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/network-shares.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(agent, /def share_admin_sync\(data: dict\)/);
  assert.match(agent, /admin users = \{admin_username\}/);
  assert.match(agent, /if action == "share-admin-sync":/);
  assert.match(localHost, /localSyncShareAdministrator/);
  assert.match(server, /await localSyncShareAdministrator\(/);
  assert.match(server, /adminUsername: store\.state\.config\.username/);
  assert.match(shares, /adminUsername: String\(input\.adminUsername/);
  assert.match(shares, /removeNetworkShare\(share, remainingShares = \[\], adminUsername = ''\)/);
});


test('built-in Files SMB share is authenticated and uses the web library storage', async () => {
  const [agent, server, shares] = await Promise.all([
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/network-shares.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(agent, /LIBRARY_ROOT = Path\(os\.environ\.get\("LIGHTNAS_LIBRARY_ROOT", "\/var\/lib\/lightnas\/files"\)\)/);
  assert.match(agent, /"\[global\]"/);
  assert.match(agent, /"  restrict anonymous = 2"/);
  assert.match(agent, /"  map to guest = never"/);
  assert.match(agent, /"\[Files\]"/);
  assert.match(agent, /f"  path = \{LIBRARY_ROOT\}"/);
  assert.match(agent, /"  force user = lightnas"/);
  assert.match(agent, /"  veto files = \/Shares\/"/);
  assert.match(server, /publicLibraryShare/);
  assert.match(shares, /name: 'Files'/);
  assert.match(shares, /system: true/);
});
