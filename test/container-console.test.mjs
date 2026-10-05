import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('container console uses Xterm, keepalives and automatic reconnect', async () => {
  const [page, script, server, vmPage, vmScript] = await Promise.all([
    readFile(new URL('../public/container-console.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/container-console.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/vm-console.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/vm-console.js', import.meta.url), 'utf8')
  ]);
  assert.match(page, /src="\/container-console\.js\?v=20261005-1"/);
  assert.match(page, /href="\/xterm\/css\/xterm\.css"/);
  assert.match(page, /src="\/xterm\/lib\/xterm\.js"/);
  assert.match(page, /src="\/xterm-addon-fit\/lib\/addon-fit\.js"/);
  assert.match(page, /id="terminal" role="application"/);
  assert.doesNotMatch(page, /<script>\s*const/);
  assert.match(script, /new window\.Terminal/);
  assert.match(script, /new window\.FitAddon\.FitAddon/);
  assert.match(script, /terminal\.onData/);
  assert.match(script, /terminal\.onBinary/);
  assert.match(script, /Connected · interactive terminal/);
  assert.match(script, /convertEol: true/);
  assert.match(script, /ResizeObserver/);
  assert.match(script, /scheduleReconnect/);
  assert.match(script, /Reconnecting in/);
  assert.doesNotMatch(script, /Fallback command mode/);
  assert.doesNotMatch(script, /connectionTimer/);
  assert.match(server, /keepWebSocketAlive/);
  assert.match(server, /ws\.ping\(\)/);
  assert.match(vmPage, /src="\/vm-console\.js"/);
  assert.match(vmScript, /import RFB from '\/novnc\/core\/rfb\.js'/);
});

test('container manager exposes real resource and network controls', async () => {
  const [dialog, styles, runtime, agent, server] = await Promise.all([
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  ]);
  for (const tab of ['Resources','Network','DNS','Application access','Options','Task history','Backups','Replication','Snapshots','Firewall','Permissions']) {
    assert.match(dialog, new RegExp(tab));
  }
  assert.match(dialog, /showContainerManager/);
  assert.match(dialog, /ipv4Mode/);
  assert.match(dialog, /startOnBoot/);
  assert.match(dialog, /settingsChanged/);
  assert.match(dialog, /Saving container settings/);
  assert.match(dialog, /\/sav\|publish\|configur\/i/);
  assert.match(dialog, /action: 'auto-publish'/);
  assert.match(dialog, /Direct container IP/);
  assert.match(dialog, /Make this application accessible from the LightNAS network — automatic/);
  assert.match(server, /containerReadyForPublication/);
  assert.match(server, /automaticContainerApplication/);
  assert.match(server, /discoverContainerApplication/);
  assert.match(server, /10\\\.77\\\.0/);
  assert.match(server, /localManageContainer\(id, 'start'\)/);
  assert.match(styles, /container-manager-layout/);
  assert.match(runtime, /ipv4Address: input\.ipv4Address/);
  assert.match(runtime, /startOnBoot: input\.startOnBoot !== false/);
  assert.match(agent, /def container_settings/);
  assert.match(agent, /selected container network is not available/);
  assert.match(agent, /10-lightnas-eth0\.network/);
  assert.match(agent, /DHCP=ipv4/);
});

test('container console reaches the authenticated host-agent PTY', async () => {
  const [server, local, agent] = await Promise.all([
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/local-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  assert.match(server, /localContainerCommand/);
  assert.match(server, /containers\\\/\[A-Za-z\]/);
  assert.match(local, /request\('container-exec'/);
  assert.match(agent, /def execute_container_command/);
  assert.match(agent, /"container-exec"/);
  assert.match(agent, /termios\.TIOCSCTTY/);
  assert.match(agent, /preexec_fn=child_setup/);
  assert.match(agent, /\/bin\/bash --noprofile --norc -i/);
  assert.match(agent, /root@\{name\}:\\\\w# /);
  assert.match(agent, /export HOME=\/root USER=root LOGNAME=root/);
});

test('VM console connects before accepting the browser and remains open while idle', async () => {
  const [agent, local, server, viewer] = await Promise.all([
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/local-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/vm-console.js', import.meta.url), 'utf8')
  ]);
  assert.match(agent, /def open_vm_console/);
  assert.match(agent, /socket\.create_connection\(\(host, port\), timeout=1\)/);
  assert.match(agent, /backend\.setsockopt\(socket\.IPPROTO_TCP, socket\.TCP_NODELAY, 1\)/);
  assert.match(agent, /backend\.settimeout\(None\)/);
  assert.match(agent, /backend = open_vm_console[\s\S]+?\{"ok":true,"data":\{"mode":"raw-vnc"\}\}/);
  assert.match(agent, /VM display is not ready/);
  assert.match(local, /socket\.pause\(\)/);
  assert.match(server, /backend\.resume\(\)/);
  assert.match(viewer, /rfb\.resizeSession = false/);
  assert.match(viewer, /setTimeout\(redraw, 500\)/);
});


test('managed application terminal opens in a separate browser window and keeps an interactive Docker shell', async () => {
  const [app, runtime] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(app, /container-console\\.html\\?id=/);
  assert.match(app, /type=app/);
  assert.match(app, /popup=yes/);
  assert.match(app, /lightnas-terminal-/);
  assert.match(app, /terminalWindow\\.focus\\(\\)/);
  assert.doesNotMatch(app, /function openManagedAppTerminal/);
  assert.doesNotMatch(app, /managed-app-terminal-dialog/);
  assert.match(runtime, /docker[\\s\\S]*exec[\\s\\S]*--privileged[\\s\\S]*--user[\\s\\S]*0:0[\\s\\S]*'-i'[\\s\\S]*TERM=xterm-256color/);
  assert.match(runtime, /exec \\/bin\\/bash --noprofile --norc -i/);
  assert.match(runtime, /exec \\/bin\\/sh -i/);
});


test('managed app terminal bindings use the multi-element selector helper', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\$\('\[data-app-terminal\]', \$\('#content'\)\)\.forEach/);
  assert.doesNotMatch(app, /(^|[^$])\$\('\[data-app-terminal\]', \$\('#content'\)\)\.forEach/m);
});

test('embedded terminal page may be framed only by the same LightNAS origin', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const embeddedConsoleCsp = csp\.replace\("frame-ancestors 'none'", "frame-ancestors 'self'"\)/);
  assert.match(server, /url\.pathname === '\/container-console\.html' \? embeddedConsoleCsp : csp/);
  assert.match(server, /frame-ancestors 'none'/);
});

test('managed application settings support app credentials and container root password', async () => {
  const [app, dialog, runtime] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(app, /requiresAdminUsername/);
  assert.match(app, /setup\.adminUsername/);
  assert.match(app, /data-app-instance/);
  assert.match(dialog, /Application administrator username/);
  assert.match(dialog, /New application administrator password/);
  assert.match(dialog, /New container root password/);
  assert.match(dialog, /Privileged root · UID 0/);
  assert.match(runtime, /credentialManager: 'semaphore-cli'/);
  assert.match(runtime, /semaphore'[\s\S]*user[\s\S]*change-by-/);
  assert.match(runtime, /dockerExecWithInput/);
  assert.match(runtime, /rootPasswordConfigured/);
  assert.doesNotMatch(runtime, /appPasswordConfigured/);
});
