import net from 'node:net';

const socketPath = process.env.LIGHTNAS_HOST_SOCKET || '/run/lightnas/host-agent.sock';

function operationError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

async function request(action, data = undefined, timeout = 30000) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeout, () => finish(operationError('Local LightNAS host agent timed out.')));
    socket.on('error', error => finish(operationError(`Local LightNAS host agent is unavailable: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ action, ...(data ? { data } : {}) })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) return finish(operationError('Local host agent returned too much data.'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response?.ok) return finish(operationError(response?.error || 'Local host operation failed.', response?.code === 'forbidden' ? 403 : 409));
        finish(null, response.data);
      } catch (error) {
        finish(operationError(`Local host agent returned invalid data: ${error.message}`));
      }
    });
    socket.on('end', () => { if (!settled) finish(operationError('Local host agent closed before replying.')); });
  });
}

export async function localContainerInventory() {
  return await request('container-inventory');
}

export async function localCreateContainer(input) {
  return await request('container-create', input, 15 * 60 * 1000);
}

export async function localManageContainer(id, action) {
  return await request('container-action', { id, action }, 2 * 60 * 1000);
}

export async function localUpdateContainer(input) {
  return await request('container-update', input, 60000);
}

export async function localNetworkInventory() {
  return await request('network-inventory');
}

export async function localNetworkAction(input) {
  return await request('network-action', input, 60000);
}

export async function localContainerConsoleSocket(id) {
  const name = String(id || '');
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Invalid system container name.'), { status: 400 });
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 128 * 1024) return fail(operationError('Local container console handshake was too large.'));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
      catch { return fail(operationError('Local container console returned an invalid handshake.')); }
      if (!response?.ok) return fail(operationError(response?.error || 'Unable to open container terminal.', response?.code === 'forbidden' ? 403 : 409));
      const remaining = buffer.subarray(newline + 1);
      settled = true;
      socket.off('data', onData);
      socket.setTimeout(0);
      if (remaining.length) socket.unshift(remaining);
      resolve(socket);
    };
    socket.setTimeout(15000, () => fail(operationError('Local container console timed out.')));
    socket.on('error', error => fail(operationError(`Local container console is unavailable: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ action: 'container-console', data: { id: name } })}\n`));
    socket.on('data', onData);
    socket.on('end', () => { if (!settled) fail(operationError('Local container console closed before the terminal opened.')); });
  });
}


export async function localVmConsoleSocket(id) {
  const name = String(id || '');
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Invalid VM name.'), { status: 400 });
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 128 * 1024) return fail(operationError('Local VM console handshake was too large.'));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
      catch { return fail(operationError('Local VM console returned an invalid handshake.')); }
      if (!response?.ok) return fail(operationError(response?.error || 'Unable to open local VM console.', response?.code === 'forbidden' ? 403 : 409));
      const remaining = buffer.subarray(newline + 1);
      settled = true;
      socket.off('data', onData);
      socket.setTimeout(0);
      if (remaining.length) socket.unshift(remaining);
      resolve(socket);
    };
    socket.setTimeout(15000, () => fail(operationError('Local VM console timed out.')));
    socket.on('error', error => fail(operationError(`Local VM console is unavailable: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ action: 'vm-console', data: { id: name } })}\n`));
    socket.on('data', onData);
    socket.on('end', () => { if (!settled) fail(operationError('Local VM console closed before the session opened.')); });
  });
}
