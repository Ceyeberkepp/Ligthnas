import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ContainerPublisher } from '../src/container-publish.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

test('system-container applications publish on the LightNAS address and survive inventory refreshes', async t => {
  const upstream = net.createServer(socket => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const probe = net.createServer();
  const hostPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));

  const store = { state: { containerPublications: [] }, saves: 0, async save() { this.saves += 1; } };
  const publisher = new ContainerPublisher(store);
  t.after(async () => {
    await publisher.remove('helpdesk').catch(() => {});
    await new Promise(resolve => upstream.close(resolve));
  });

  const record = await publisher.configure({ id: 'helpdesk', targetHost: '127.0.0.1', hostPort, targetPort: upstreamPort, scheme: 'https' });
  assert.equal(record.scheme, 'https');
  assert.equal(store.saves, 1);

  const inventory = publisher.decorate({ containers: [{ id: 'helpdesk', status: 'running' }] });
  assert.equal(inventory.containers[0].publication.hostPort, hostPort);

  const reply = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: hostPort }, () => socket.write('lightnas'));
    socket.once('data', data => { resolve(data.toString()); socket.destroy(); });
    socket.once('error', reject);
  });
  assert.equal(reply, 'lightnas');
});

test('container publication rejects the management port and invalid targets', async () => {
  const publisher = new ContainerPublisher({ state: {}, async save() {} });
  await assert.rejects(() => publisher.configure({ id: 'helpdesk', targetHost: '127.0.0.1', hostPort: 3080, targetPort: 443 }), /other than 3080/);
  await assert.rejects(() => publisher.configure({ id: 'helpdesk', targetHost: '', hostPort: 8443, targetPort: 443 }), /usable IPv4/);
});


test('direct container application access persists without opening a LightNAS listener', async () => {
  const store = { state: { containerPublications: [] }, saves: 0, async save() { this.saves += 1; } };
  const publisher = new ContainerPublisher(store);
  const record = await publisher.configure({
    id: 'faveo',
    mode: 'direct',
    targetHost: '10.15.2.129',
    targetPort: 443,
    scheme: 'https'
  });
  assert.equal(record.mode, 'direct');
  assert.equal(record.hostPort, null);
  assert.equal(record.targetHost, '10.15.2.129');
  assert.equal(store.saves, 1);
  const inventory = publisher.decorate({ containers: [{ id: 'faveo', status: 'running' }] });
  assert.equal(inventory.containers[0].publication.mode, 'direct');
  await publisher.remove('faveo');
});
