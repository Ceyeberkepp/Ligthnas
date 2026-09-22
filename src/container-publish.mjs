import net from 'node:net';

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalized(input) {
  const id = String(input.id || input.name || '').trim();
  const targetHost = String(input.targetHost || '').trim();
  const hostPort = Number(input.hostPort);
  const targetPort = Number(input.targetPort);
  const scheme = input.scheme === 'https' ? 'https' : 'http';
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(id)) throw inputError('Invalid container ID.');
  if (net.isIP(targetHost) !== 4) throw inputError('The container does not have a usable IPv4 address yet.', 409);
  if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535 || hostPort === 3080) throw inputError('Choose a LightNAS port from 1024–65535 other than 3080.');
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw inputError('Choose a valid container application port.');
  return { id, targetHost, hostPort, targetPort, scheme };
}

export class ContainerPublisher {
  constructor(store) {
    this.store = store;
    this.listeners = new Map();
    this.store.state.containerPublications ||= [];
  }

  list() {
    return this.store.state.containerPublications || [];
  }

  forContainer(id) {
    return this.list().find(item => item.id === id) || null;
  }

  decorate(inventory) {
    if (!inventory?.containers) return inventory;
    inventory.containers = inventory.containers.map(item => ({ ...item, publication: this.forContainer(String(item.id || item.name || '')) }));
    return inventory;
  }

  async listen(record) {
    const existing = this.listeners.get(record.hostPort);
    if (existing) {
      if (existing.record.id === record.id && existing.record.targetHost === record.targetHost && existing.record.targetPort === record.targetPort) return;
      throw inputError(`LightNAS port ${record.hostPort} is already published by ${existing.record.id}.`, 409);
    }
    const server = net.createServer(client => {
      const upstream = net.createConnection({ host: record.targetHost, port: record.targetPort });
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on('error', close);
      upstream.on('error', close);
      client.pipe(upstream).pipe(client);
    });
    await new Promise((resolve, reject) => {
      const fail = error => { server.close(); reject(inputError(error.code === 'EADDRINUSE' ? `LightNAS port ${record.hostPort} is already in use.` : `Application publishing failed: ${error.message}`, 409)); };
      server.once('error', fail);
      server.listen(record.hostPort, '0.0.0.0', () => { server.off('error', fail); resolve(); });
    });
    this.listeners.set(record.hostPort, { server, record });
  }

  async configure(input) {
    const record = normalized(input);
    await this.remove(record.id, false);
    await this.listen(record);
    this.store.state.containerPublications = [...this.list().filter(item => item.id !== record.id), record];
    await this.store.save();
    return record;
  }

  async remove(id, save = true) {
    const records = this.list().filter(item => item.id === id);
    for (const record of records) {
      const listener = this.listeners.get(record.hostPort);
      if (listener) {
        await new Promise(resolve => listener.server.close(resolve));
        this.listeners.delete(record.hostPort);
      }
    }
    this.store.state.containerPublications = this.list().filter(item => item.id !== id);
    if (save) await this.store.save();
  }

  async restore() {
    const records = [...this.list()];
    for (const raw of records) {
      try { await this.listen(normalized(raw)); }
      catch (error) { console.error(`Unable to restore container publication ${raw.id || 'unknown'}:`, error.message); }
    }
  }
}
