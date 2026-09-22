import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('appliance setup self-configures and Admin Center exposes repair', async () => {
  const [server, agent, ui] = await Promise.all([
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(server, /localApplianceRepair/);
  assert.match(server, /\/api\/appliance\/health/);
  assert.match(server, /\/api\/appliance\/repair/);
  assert.match(agent, /def appliance_health\(\)/);
  assert.match(agent, /def appliance_repair\(\)/);
  assert.match(agent, /"appliance-health"/);
  assert.match(agent, /"appliance-repair"/);
  assert.match(ui, /data-appliance-health/);
  assert.match(ui, /data-appliance-repair/);
});
