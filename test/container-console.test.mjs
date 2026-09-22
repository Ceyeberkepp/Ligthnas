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
  assert.match(page, /src="\/container-console\.js\?v=20260922-5"/);
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
  const [dialog, styles, runtime, agent] = await Promise.all([
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8')
  ]);
  for (const tab of ['Resources','Network','DNS','Options','Task history','Backups','Replication','Snapshots','Firewall','Permissions']) {
    assert.match(dialog, new RegExp(tab));
  }
  assert.match(dialog, /showContainerManager/);
  assert.match(dialog, /ipv4Mode/);
  assert.match(dialog, /startOnBoot/);
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
