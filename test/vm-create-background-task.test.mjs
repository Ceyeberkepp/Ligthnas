import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('VM wizard closes immediately and reports creation through Tasks', async () => {
  const dialogs = await read('public/dialog-controls.js');

  assert.match(dialogs, /\{ taskOnly:true \}/);
  assert.match(dialogs, /dialog\.close\(\);\s*progress\.update\(10/);
  assert.match(dialogs, /X-LightNAS-Task-Managed/);
  assert.match(dialogs, /managedTask = headers\.get\('X-LightNAS-Task-Managed'\) === '1'/);
  assert.doesNotMatch(dialogs, /error\.textContent = problem\.message;\s*create\.disabled = false;/);
});

test('nested VM creation uses targeted libvirt repair instead of full appliance repair', async () => {
  const [host, local, runtimes] = await Promise.all([
    read('scripts/lightnas-host-agent.py'),
    read('src/local-host.mjs'),
    read('src/runtimes-next.mjs')
  ]);

  assert.match(host, /def nested_libvirt_repair\(\)/);
  assert.match(host, /if action == "nested-libvirt-repair"/);
  assert.match(host, /dynamic_ownership = 0/);
  assert.match(local, /export async function localRepairNestedLibvirt/);
  assert.match(runtimes, /if \(virtualization\.diagnostics\?\.nested\)/);
  assert.match(runtimes, /await localRepairNestedLibvirt\(\)/);
  assert.doesNotMatch(runtimes, /localApplianceRepair/);
});
