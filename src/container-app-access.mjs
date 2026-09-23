import net from 'node:net';
import tls from 'node:tls';

const WEB_PORT_PRIORITY = Object.freeze([
  443, 80, 8443, 8080, 8000, 3000, 5000, 8888, 9443, 9090,
  3001, 5001, 8008, 8081, 8082, 8083, 8096, 9000, 10000, 12320, 12321
]);

const HTTPS_FIRST = new Set([443, 8443, 9443, 10000, 12321]);
const NON_WEB_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 67, 68, 69, 110, 111, 123, 135, 137, 138, 139,
  143, 161, 162, 389, 445, 465, 514, 587, 631, 636, 873, 993, 995, 1433,
  1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 5985, 5986, 6379, 11211,
  27017
]);

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function parseListeningPorts(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(raw
    .map(item => Number(item))
    .filter(port => Number.isInteger(port) && port >= 1 && port <= 65535))]
    .sort((a, b) => a - b);
}

function urlFor(host, port, scheme) {
  const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  return `${scheme}://${host}${defaultPort ? '' : `:${port}`}/`;
}

function probeWebPort(host, port, scheme, timeoutMs = 900) {
  return new Promise(resolve => {
    let settled = false;
    let socket;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(value);
    };
    const options = { host, port };
    socket = scheme === 'https'
      ? tls.connect({ ...options, rejectUnauthorized: false })
      : net.createConnection(options);
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once(scheme === 'https' ? 'secureConnect' : 'connect', () => {
      socket.write(`GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: LightNAS/1.0\r\nConnection: close\r\n\r\n`);
    });
    socket.once('data', chunk => {
      const text = chunk.toString('latin1', 0, 1024);
      finish(/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/i.test(text) || /<html[\s>]/i.test(text));
    });
    socket.once('end', () => finish(false));
  });
}

function candidatePorts(discovered, preferredPort = 0) {
  const normalized = parseListeningPorts(discovered);
  const source = normalized.length ? normalized : WEB_PORT_PRIORITY;
  const priority = preferredPort ? [preferredPort, ...WEB_PORT_PRIORITY] : [...WEB_PORT_PRIORITY];
  const ordered = [
    ...priority.filter(port => source.includes(port)),
    ...source
  ];
  return [...new Set(ordered)]
    .filter(port => !NON_WEB_PORTS.has(port))
    .slice(0, 40);
}

export async function discoverContainerApplication({
  id,
  targetHost,
  listeningPorts = [],
  preferredPort = 0,
  probe = probeWebPort
}) {
  const name = String(id || '').trim();
  const host = String(targetHost || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw inputError('Invalid container ID.');
  if (net.isIP(host) !== 4) throw inputError('The container does not have a usable IPv4 address yet.', 409);

  for (const port of candidatePorts(listeningPorts, Number(preferredPort) || 0)) {
    const schemes = HTTPS_FIRST.has(port) ? ['https', 'http'] : ['http', 'https'];
    for (const scheme of schemes) {
      if (await probe(host, port, scheme)) {
        return {
          id: name,
          mode: 'direct',
          targetHost: host,
          hostPort: null,
          targetPort: port,
          scheme,
          accessUrl: urlFor(host, port, scheme),
          detected: true,
          managedBy: 'lightnas'
        };
      }
    }
  }
  return null;
}

export function containerApplicationUrl(record, lightnasHost = '') {
  if (!record) return '';
  if (record.mode === 'direct') return urlFor(record.targetHost, Number(record.targetPort), record.scheme === 'https' ? 'https' : 'http');
  const port = Number(record.hostPort);
  if (!lightnasHost || !Number.isInteger(port)) return '';
  return `${record.scheme === 'https' ? 'https' : 'http'}://${lightnasHost}:${port}/`;
}
