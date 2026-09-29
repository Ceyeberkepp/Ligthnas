import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('container wizard defaults to DHCP and only enables static fields on manual selection', async () => {
  const controls = await read('public/dialog-controls.js');
  assert.match(controls, /<option value="dhcp">DHCP \/ automatic<\/option>/);
  assert.match(controls, /form\.elements\.ipv4Mode\.value = 'dhcp'/);
  assert.match(controls, /form\.elements\[name\]\.disabled = !manual/);
  assert.match(controls, /if \(!manual\) form\.elements\[name\]\.value = ''/);
});

test('networking can edit persistent and live gateway routes', async () => {
  const [app, controls, agent] = await Promise.all([
    read('public/app.js'),
    read('public/dialog-controls.js'),
    read('scripts/lightnas-host-agent.py')
  ]);
  assert.match(app, /const runtimeEditable = Boolean\(route\.device && route\.gateway\)/);
  assert.match(app, /data-route-runtime="true"/);
  assert.match(controls, /action: 'route-runtime-update'/);
  assert.match(agent, /if action == "route-runtime-update":/);
  assert.match(agent, /"ip", "-4", "route", "replace"/);
});


test('container settings save is not marked failed only because application discovery is pending', async () => {
  const controls = await read('public/dialog-controls.js');
  assert.match(controls, /Application discovery is secondary to saving container settings/);
  assert.match(controls, /publishWarning = problem\.message/);
  assert.match(controls, /DHCP was attempted first; this nested host required LightNAS managed automatic addressing/);
});


test('managed automatic fallback persists inside the guest network profile', async () => {
  const agent = await read('scripts/lightnas-host-agent.py');
  assert.match(agent, /Persist the managed fallback inside systemd-networkd/);
  assert.match(agent, /f"Address=\{address\}"/);
  assert.match(agent, /"Gateway=10\.77\.0\.1"/);
  assert.match(agent, /"DNS=10\.77\.0\.1"/);
  assert.match(agent, /10-lightnas-eth0\.network/);
});
