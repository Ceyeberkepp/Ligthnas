import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('private file permission isolates normal users to their own library', async () => {
  const [server, files, app, security] = await Promise.all([
    read('src/server.mjs'),
    read('src/files.mjs'),
    read('public/app.js'),
    read('public/admin-security.js')
  ]);

  assert.match(server, /'files\.own'/);
  assert.match(server, /DEFAULT_USER_PERMISSIONS = Object\.freeze\(\['files\.own'\]\)/);
  assert.match(server, /return `Users\/\$\{context\.username\}`/);
  assert.match(server, /listAllFiles\(url\.searchParams\.get\('refresh'\) === '1', scope\)/);
  assert.match(files, /scopePrefix = ''/);
  assert.match(files, /physical prefix is never exposed to the browser/);
  assert.match(app, /files: \['files\.own', 'files\.read'\]/);
  assert.match(security, /'files\.own':'Manage only my own files'/);
});

test('container edit opens from cached summary and does not block on app probing', async () => {
  const dialogs = await read('public/dialog-controls.js');
  assert.match(dialogs, /window\.LightNASContainerInventory/);
  assert.match(dialogs, /\/api\/containers\/inventory\?summary=1/);
  assert.match(dialogs, /queueMicrotask\(\(\) =>/);
  assert.doesNotMatch(dialogs, /const detected = await dialogApi\('\/api\/containers'/);
});


test('container DNS is part of Network and live settings are refreshed from the guest', async () => {
  const [dialog, agent] = await Promise.all([
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(dialog, /\['dns','DNS'\]/);
  assert.match(dialog, /Configured gateway[\s\S]*?DNS servers[\s\S]*?MAC address/);
  assert.match(dialog, /const runtimePromise = dialogApi\('\/api\/containers\/inventory\?summary=1'\)/);
  assert.match(dialog, /DNS is allowed as an override for either DHCP or static IPv4/);
  assert.match(agent, /ip", "-4", "route", "show", "default"/);
  assert.match(agent, /resolvectl", "dns", live_device/);
  assert.match(agent, /ip", "-4", "addr", "flush"/);
  assert.match(agent, /ip", "addr", "add", address/);
  assert.match(agent, /liveGateway/);
  assert.match(agent, /liveDns/);
});
