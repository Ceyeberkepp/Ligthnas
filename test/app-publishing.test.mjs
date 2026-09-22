import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('catalog apps publish and verify their LightNAS endpoint automatically', async () => {
  const [runtime, installer, app, agent, network] = await Promise.all([
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/provision-runtimes.sh', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/network.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(runtime, /lightnas\.web\.port=/);
  assert.match(runtime, /0\.0\.0\.0:\$\{app\.port\}:\$\{app\.containerPort\}/);
  assert.match(runtime, /waitForAppPort\(app\.port\)/);
  assert.match(runtime, /access: \{ scheme: 'http', port: app\.port, path: '\/' \}/);
  for (const port of [3000, 3001, 8081, 8082, 8083, 8096]) assert.match(installer, new RegExp(`\\b${port}\\b`));
  assert.match(installer, /LightNAS managed app/);
  assert.match(app, /Open application/);
  assert.match(app, /No Proxmox configuration or manual port forwarding is required/);
  assert.match(agent, /args \+= \["to", "any"\]/);
  assert.match(agent, /"delete", "allow", "to", "any", "port"/);
  assert.match(network, /else args\.push\('to', 'any'\)/);
});
