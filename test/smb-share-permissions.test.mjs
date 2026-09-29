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
