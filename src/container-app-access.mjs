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

const LISTENING_PORT_COMMAND = String.raw`
if command -v ss >/dev/null 2>&1; then
  ss -H -lnt 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\\1/'
elif command -v netstat >/dev/null 2>&1; then
  netstat -lnt 2>/dev/null | awk 'NR>2 {print $4}' | sed -E 's/.*:([0-9]+)$/\\1/'
else
  awk 'NR>1 {split($2,a,":"); print strtonum("0x" a[2])}' /proc/net/tcp 2>/dev/null
fi
`;

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function parseListeningPorts(output) {
  return [...new Set(String(output || '')
    .split(/\s+/)
    .map(value => Number(value))
    .filter(port => Number.isInteger(port) && port >= 1 && port <= 65535))]
    .sort((a, b) => a - b);
}

function urlFor(host, port, scheme) {
  const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  return `${scheme}://${host}${defaultPort ? '' : `:${port}`}/`;
}

function probeWebPort(host, port, scheme, timeoutMs = 1800) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(value);
    };
    const options = { host, port };
    const socket = scheme === 'https'
      ? tls.connect({ ...options, rejectUnauthorized: false })
      : net.createConnection(options);
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once(scheme === 'https' ? 'secureConnect' : 'connect', () => {
      socket.write(`GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: LightNAS/1.0\r\nConnection: close\r\n\r\n`);
    });
    socket.once('data', chunk => {
      const text = chunk.toString('latin1', 0, 512);
      finish(/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/i.test(text) || /<html[\s>]/i.test(text));
    });
    socket.once('end', () => finish(false));
  });
}

function candidatePorts(discovered, preferredPort = 0) {
  const priority = preferredPort ? [preferredPort, ...WEB_PORT_PRIORITY] : [...WEB_PORT_PRIORITY];
  const ordered = [...priority.filter(port => discovered.includes(port)), ...discovered];
  return [...new Set(ordered)]
    .filter(port => !NON_WEB_PORTS.has(port))
    .slice(0, 32);
}

async function openGuestWebFirewall(runCommand, id, port) {
  const command = [
    'set +e',
    `if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then ufw allow ${port}/tcp comment 'LightNAS web application' >/dev/null 2>&1 || ufw allow ${port}/tcp >/dev/null 2>&1 || true; fi`,
    `if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --permanent --add-port=${port}/tcp >/dev/null 2>&1 || true; firewall-cmd --reload >/dev/null 2>&1 || true; fi`,
    'exit 0'
  ].join('; ');
  await runCommand(id, command).catch(() => null);
}

export async function discoverContainerApplication({
  id,
  targetHost,
  runCommand,
  preferredPort = 0,
  probe = probeWebPort
}) {
  const name = String(id || '').trim();
  const host = String(targetHost || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw inputError('Invalid container ID.');
  if (net.isIP(host) !== 4) throw inputError('The container does not have a usable IPv4 address yet.', 409);
  if (typeof runCommand !== 'function') throw inputError('Container application detection is unavailable.', 500);

  const listeners = await runCommand(name, LISTENING_PORT_COMMAND);
  const discovered = parseListeningPorts(listeners?.output);
  if (!discovered.length) return null;

  for (const port of candidatePorts(discovered, Number(preferredPort) || 0)) {
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
          detected: true
        };
      }
    }

    // A guest firewall can hide an otherwise valid web service. Only open
    // ports that strongly resemble web endpoints; never expose SSH, databases,
    // mail, SMB, or other infrastructure listeners automatically.
    if (WEB_PORT_PRIORITY.includes(port)) {
      await openGuestWebFirewall(runCommand, name, port);
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
            detected: true
          };
        }
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
