import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('large ISO uploads are chunked and limited to 50 GiB', async () => {
  const [storage, ui] = await Promise.all([
    readFile(new URL('../src/storage-pools.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/storage-manager.js', import.meta.url), 'utf8')
  ]);
  assert.match(storage, /50 \* 1024 \*\* 3/);
  assert.match(storage, /parseContentRange/);
  assert.match(storage, /x-lightnas-upload-id/);
  assert.match(ui, /\(type==='iso'\?64:32\)\*1024\*\*2/);
  assert.match(ui, /Content-Range/);
  assert.match(ui, /progress\?\.update/);
});

test('runtime deletion requires exact ID and delete-all-files selection', async () => {
  const [dialog, runtime, agent] = await Promise.all([
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  assert.match(dialog, /showRuntimeDeleteDialog/);
  assert.match(dialog, /deleteFiles/);
  assert.match(dialog, /confirmation !== id/);
  assert.match(runtime, /requireDeletionConfirmation/);
  assert.match(agent, /cleanup_container_path\(name\)/);
});

test('container bootstrap does not require optional systemd-resolved package', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  const includeBlock = agent.match(/include = ","\.join\(\[[\s\S]*?\]\)/)?.[0] || '';
  assert.doesNotMatch(includeBlock, /systemd-resolved/);
});
