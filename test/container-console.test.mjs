import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('console pages use CSP-compatible external scripts', async () => {
  const [containerPage, containerScript, vmPage, vmScript, appScript, runtimes] = await Promise.all([
    readFile(new URL('../public/container-console.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/container-console.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/vm-console.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/vm-console.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(containerPage, /src="\/container-console\.js"/);
  assert.match(containerPage, /id="terminal" tabindex="0" role="application"/);
  assert.match(containerPage, /id="command-form"[^>]+hidden/);
  assert.doesNotMatch(containerPage, /<script>\s*const/);
  assert.match(vmPage, /src="\/vm-console\.js"/);
  assert.doesNotMatch(vmPage, /<script type="module">\s*import/);
  assert.match(containerScript, /Command mode/);
  assert.match(containerScript, /\/api\/containers\/\$\{encodeURIComponent\(id\)\}\/exec/);
  assert.match(containerScript, /setTimeout\(\(\) =>/);
  assert.match(containerScript, /ws\.send\(`\$\{command\}\\r`\)/);
  assert.match(containerScript, /terminal\.addEventListener\('keydown'/);
  assert.match(containerScript, /terminal\.addEventListener\('paste'/);
  assert.match(containerScript, /Ctrl\+C without Shift sends/);
  assert.match(containerScript, /Connected · click terminal and type/);
  assert.match(containerScript, /form\.hidden = false/);
  assert.match(containerScript, /normalizeTerminalChunk/);
  assert.match(containerScript, /terminalControlState/);
  assert.match(containerScript, /osc-escape/);
  assert.match(containerScript, /decoder\.decode\(event\.data, \{ stream: true \}\)/);
  assert.match(containerScript, /chunk\.clear \? '' : terminal\.textContent/);
  assert.match(containerScript, /output = output\.slice\(0, -1\)/);
  assert.match(vmScript, /import RFB from '\/novnc\/core\/rfb\.js'/);
  assert.match(appScript, /\$\$\('\[data-action="refresh-files"\]'/);
  assert.match(appScript, /\$\$\('\[data-library-tab\]'/);
  assert.match(appScript, /Files could not be loaded\./);
  assert.match(appScript, /Open application/);
  assert.match(appScript, /requiresAdminPassword/);
  assert.match(runtimes, /id: 'ansible-semaphore'/);
  assert.match(runtimes, /SEMAPHORE_DB_DIALECT/);
  assert.match(runtimes, /SEMAPHORE_ADMIN_PASSWORD/);
});

test('container console fallback reaches the authenticated host-agent path', async () => {
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
  assert.match(agent, /import termios/);
  assert.match(agent, /os\.setsid\(\)/);
  assert.match(agent, /termios\.TIOCSCTTY/);
  assert.match(agent, /preexec_fn=child_setup/);
  assert.match(agent, /\/bin\/bash --noprofile --norc -i/);
  assert.match(agent, /root@\{name\}:\\\\w# /);
  assert.match(agent, /export HOME=\/root USER=root LOGNAME=root/);
});
