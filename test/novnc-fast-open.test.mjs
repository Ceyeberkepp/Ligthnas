import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('noVNC prewarms VM console targets and reconnects quickly', async () => {
  const [agent, local, viewer] = await Promise.all([
    read('scripts/lightnas-host-agent.py'),
    read('src/local-host.mjs'),
    read('public/vm-console.js')
  ]);
  assert.match(agent, /_VM_CONSOLE_CACHE_TTL = 30\.0/);
  assert.match(agent, /def warm_vm_console_cache/);
  assert.match(agent, /target=warm_vm_console_cache/);
  assert.match(agent, /time\.sleep\(8\)/);
  assert.match(agent, /_invalidate_vm_console\(name\)/);
  assert.match(local, /socket\.setTimeout\(3500/);
  assert.match(viewer, /let reconnectDelay = 200/);
  assert.match(viewer, /Math\.min\(1500/);
});
