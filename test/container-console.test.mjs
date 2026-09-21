import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('container console falls back to authenticated HTTP command execution', async () => {
  const [page, server, local, agent] = await Promise.all([
    readFile(new URL('../public/container-console.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/local-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  assert.match(page, /Command mode/);
  assert.match(page, /\/api\/containers\/\$\{encodeURIComponent\(id\)\}\/exec/);
  assert.match(page, /setTimeout\(\(\) =>/);
  assert.match(server, /localContainerCommand/);
  assert.match(server, /containers\\\/\[A-Za-z\]/);
  assert.match(local, /request\('container-exec'/);
  assert.match(agent, /def execute_container_command/);
  assert.match(agent, /"container-exec"/);
});
