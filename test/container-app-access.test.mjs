import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverContainerApplication, parseListeningPorts, containerApplicationUrl } from '../src/container-app-access.mjs';

test('listening-port parser removes duplicates and invalid values', () => {
  assert.deepEqual(parseListeningPorts('22\n443\n8080\n443\n0\n70000\n'), [22, 443, 8080]);
});

test('system-container web app discovery prefers direct HTTPS access on the container IP', async () => {
  const commands = [];
  const runCommand = async (_id, command) => {
    commands.push(command);
    return { output: '22\n80\n443\n3306\n' };
  };
  const probes = [];
  const probe = async (host, port, scheme) => {
    probes.push({ host, port, scheme });
    return host === '10.15.2.129' && port === 443 && scheme === 'https';
  };

  const record = await discoverContainerApplication({
    id: 'faveo',
    targetHost: '10.15.2.129',
    runCommand,
    probe
  });

  assert.equal(record.mode, 'direct');
  assert.equal(record.targetHost, '10.15.2.129');
  assert.equal(record.targetPort, 443);
  assert.equal(record.scheme, 'https');
  assert.equal(record.accessUrl, 'https://10.15.2.129/');
  assert.equal(containerApplicationUrl(record), 'https://10.15.2.129/');
  assert.ok(commands[0].includes('ss -H -lnt'));
  assert.deepEqual(probes[0], { host: '10.15.2.129', port: 443, scheme: 'https' });
});

test('discovery ignores infrastructure listeners when there is no web app', async () => {
  const record = await discoverContainerApplication({
    id: 'database',
    targetHost: '10.15.2.130',
    runCommand: async () => ({ output: '22\n3306\n5432\n6379\n' }),
    probe: async () => true
  });
  assert.equal(record, null);
});
