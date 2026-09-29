import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('main installer installs all archive tools used by imported templates', async () => {
  const installer = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /tar gzip xz-utils zstd/);
  assert.match(installer, /lxc lxc-templates lxcfs uidmap bridge-utils debootstrap/);
});

test('template extraction skips archived dev nodes in nested unprivileged LightNAS', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /--exclude=\.\/dev\/\*/);
  assert.match(agent, /--exclude=dev\/\*/);
  assert.match(agent, /\(rootfs \/ "dev"\)\.mkdir\(mode=0o755, exist_ok=True\)/);
  assert.match(agent, /LXC supplies the runtime \/dev mount/);
});


test('pulled template boot failures return actionable LXC diagnostics', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /lxc-\{name\}-start\.log/);
  assert.match(agent, /"lxc-start", "-n", name, "-F", "-l", "DEBUG", "-o"/);
  assert.match(agent, /Permission denied\|Operation not permitted\|No such file\|exec\|mount\|apparmor\|cgroup\|hook/);
});


test('nested pulled templates avoid host-side IPv4 gateway injection', async () => {
  const agent = await readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8');
  assert.match(agent, /def sanitize_nested_lxc_network/);
  assert.match(agent, /"lxc\.net\.0\.ipv4\.address"/);
  assert.match(agent, /"lxc\.net\.0\.ipv4\.gateway"/);
  const fallback = agent.slice(agent.indexOf('def apply_managed_automatic_address'), agent.indexOf('def sanitize_nested_lxc_network'));
  assert.doesNotMatch(fallback, /append_unique\(config, f"lxc\.net\.0\.ipv4\.address/);
  assert.doesNotMatch(fallback, /append_unique\(config, "lxc\.net\.0\.ipv4\.gateway/);
});
