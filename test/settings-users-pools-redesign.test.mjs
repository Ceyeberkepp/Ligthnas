import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Pools hides ZFS empty messaging when ZFS is unavailable', async () => {
  const app = await read('public/app.js');
  const pools = app.slice(app.indexOf('function poolsView()'), app.indexOf('async function loadSpaces()'));
  assert.doesNotMatch(pools, /ZFS dataset controls only appear/);
  assert.doesNotMatch(pools, /No ZFS datasets/);
  assert.match(pools, /dataset-workspace/);
});

test('general settings no longer require password confirmation', async () => {
  const [server, app] = await Promise.all([read('src/server.mjs'), read('public/app.js')]);
  const settingsApi = server.slice(server.indexOf("if (req.method === 'GET' && url.pathname === '/api/settings')"), server.indexOf("if (req.method === 'GET' && url.pathname === '/api/containers/inventory')"));
  assert.match(settingsApi, /if \(changedPassword\) \{/);
  assert.match(settingsApi, /Current administrator password is required to change the password/);
  const settingsView = app.slice(app.indexOf('function settingsView()'), app.indexOf('function adminView()'));
  assert.match(settingsView, /Save general settings/);
  assert.match(settingsView, /id="password-form"/);
  const general = settingsView.slice(settingsView.indexOf('id="settings-form"'), settingsView.indexOf('branding-card'));
  assert.doesNotMatch(general, /currentPassword/);
});

test('appliance branding accepts and exposes custom logos', async () => {
  const [server, app] = await Promise.all([read('src/server.mjs'), read('public/app.js')]);
  assert.match(server, /\/api\/branding\/logo/);
  assert.match(server, /logoExt/);
  assert.match(app, /id="logo-upload"/);
  assert.match(app, /applyApplianceBranding/);
  assert.match(app, /Upload logo/);
});

test('users page uses summary and card based management layout', async () => {
  const app = await read('public/app.js');
  const users = app.slice(app.indexOf('function usersView()'), app.indexOf('function permissionsView()'));
  assert.match(users, /user-summary-grid/);
  assert.match(users, /user-card-grid/);
  assert.match(users, /data-toggle-user-create/);
  assert.match(users, /Account settings/);
  assert.match(users, /effective permissions/);
});


test('NAS capabilities does not expose Hypervisor workspace control', async () => {
  const app = await read('public/app.js');
  const capabilities = app.slice(app.indexOf('function capabilitiesView()'), app.indexOf('function settingsSectionCollapsed'));
  assert.doesNotMatch(capabilities, /Hypervisor workspace/);
  assert.doesNotMatch(capabilities, /hypervisorWorkspace/);
});

test('sidebar modules are first-class permission scopes', async () => {
  const [server, app, admin] = await Promise.all([
    read('src/server.mjs'),
    read('public/app.js'),
    read('public/admin-security.js')
  ]);
  for (const permission of [
    'nav.home','nav.storage','nav.pools','nav.files','nav.shares','nav.backups',
    'nav.apps','nav.ai','nav.containers','nav.vms','nav.network','nav.firewall',
    'nav.integrations','nav.users','nav.permissions','nav.smtp','nav.settings',
    'nav.analytics','nav.capabilities','nav.admin'
  ]) {
    assert.ok(server.includes(`'${permission}'`), `missing server permission ${permission}`);
    assert.ok(admin.includes(`'${permission}'`), `missing permission label ${permission}`);
  }
  assert.match(app, /allowed\.has\(`nav\.\$\{view\}`\)/);
});

test('display time zone is applied to the host and reports synchronization state', async () => {
  const [server, host, app] = await Promise.all([
    read('src/server.mjs'),
    read('scripts/lightnas-host-agent.py'),
    read('public/app.js')
  ]);
  assert.match(server, /localSetTimezone\(requestedTimezone\)/);
  assert.match(server, /localTimeStatus/);
  assert.match(host, /timedatectl.*set-timezone/s);
  assert.match(host, /timedatectl.*set-ntp/s);
  assert.match(app, /Intl\.supportedValuesOf\('timeZone'\)/);
});

test('firewall provides policy, reset, and rule controls', async () => {
  const [app, dialogs, network, host] = await Promise.all([
    read('public/app.js'),
    read('public/dialog-controls.js'),
    read('src/network.mjs'),
    read('scripts/lightnas-host-agent.py')
  ]);
  assert.match(app, /data-firewall-defaults/);
  assert.match(app, /data-firewall-reset/);
  assert.match(dialogs, /firewall-defaults/);
  assert.match(dialogs, /firewall-reset/);
  assert.match(network, /defaultIncoming/);
  assert.match(host, /firewall-defaults/);
  assert.match(host, /firewall-reset/);
});
