import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);

async function command(program, args, timeout = 5000) {
  try {
    const result = await run(program, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || error.message).trim().slice(0, 1000) };
  }
}

function json(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function parseUfwRules(text) {
  return String(text || '').split('\n').flatMap(line => {
    const match = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?:\s+IN|\s+OUT)?\s{2,}(.+)$/i);
    if (!match) return [];
    return [{ number: Number(match[1]), target: match[2].trim(), action: match[3].toUpperCase(), source: match[4].trim() }];
  });
}

async function wifiInventory() {
  const deviceResult = await command('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);
  if (!deviceResult.ok) return { available: false, reason: 'NetworkManager/nmcli is not available.', devices: [], networks: [] };
  const devices = deviceResult.stdout.split('\n').filter(Boolean).flatMap(row => {
    const [name, type, state, ...connection] = row.split(':');
    if (type !== 'wifi') return [];
    return [{ name, state, connection: connection.join(':') || null }];
  });
  let networks = [];
  if (devices.length) {
    const scan = await command('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY,CHAN', 'device', 'wifi', 'list', '--rescan', 'auto'], 10000);
    if (scan.ok) networks = scan.stdout.split('\n').filter(Boolean).flatMap(row => {
      const fields = row.split(':');
      if (fields.length < 5) return [];
      const [inUse, ssid, signal, security, channel] = fields;
      if (!ssid) return [];
      return [{ ssid, signal: Number(signal) || 0, security: security || 'Open', channel: Number(channel) || null, connected: inUse === '*' }];
    });
  }
  return { available: true, reason: null, devices, networks };
}

export async function networkInventory() {
  const [addresses, routes, dnsFile, ufwStatus, ufwNumbered, nft, wifi] = await Promise.all([
    command('ip', ['-j', 'address', 'show']),
    command('ip', ['-j', 'route', 'show']),
    readFile('/etc/resolv.conf', 'utf8').catch(() => ''),
    command('ufw', ['status']),
    command('ufw', ['status', 'numbered']),
    command('nft', ['list', 'tables']),
    wifiInventory()
  ]);
  return {
    interfaces: json(addresses.stdout).map(({ ifname, operstate, address, addr_info, mtu, link_type }) => ({
      name: ifname, state: operstate, mac: address, mtu: mtu || null, type: link_type || null,
      addresses: (addr_info || []).map(({ family, local, prefixlen, scope }) => ({ family, address: local, prefix: prefixlen, scope }))
    })),
    routes: json(routes.stdout).map(({ dst, gateway, dev, metric, prefsrc, protocol }) => ({ destination: dst || 'default', gateway: gateway || '', device: dev || '', metric: metric ?? null, source: prefsrc || null, protocol: protocol || null })),
    dns: dnsFile.split('\n').map(line => line.match(/^\s*nameserver\s+(\S+)/)?.[1]).filter(Boolean),
    wifi,
    firewall: {
      backend: ufwStatus.ok ? 'ufw' : nft.ok ? 'nftables' : 'not accessible',
      editable: ufwStatus.ok,
      status: ufwStatus.stdout.match(/^Status:\s*(.+)/m)?.[1] || (nft.ok ? 'ruleset readable' : 'unknown'),
      rules: ufwNumbered.ok ? parseUfwRules(ufwNumbered.stdout) : [],
      tables: nft.ok ? nft.stdout.split('\n').filter(line => /^table\s/.test(line)).slice(0, 30) : []
    }
  };
}

function validInterface(value) {
  return /^[A-Za-z0-9_.:-]{1,32}$/.test(String(value || ''));
}

function validSource(value) {
  if (!value) return true;
  return /^[A-Fa-f0-9:.]+(?:\/\d{1,3})?$/.test(String(value));
}

export async function networkAction(input) {
  const action = String(input?.action || '');
  if (action === 'firewall-add') {
    const decision = String(input.decision || '').toLowerCase();
    const protocol = String(input.protocol || '').toLowerCase();
    const port = Number(input.port);
    const source = String(input.source || '').trim();
    if (!['allow', 'deny'].includes(decision) || !['tcp', 'udp'].includes(protocol) || !Number.isInteger(port) || port < 1 || port > 65535 || !validSource(source)) {
      throw Object.assign(new Error('Choose allow/deny, TCP/UDP, a valid port and optional IP/CIDR source.'), { status: 400 });
    }
    const args = [decision];
    if (source) args.push('from', source, 'to', 'any');
    args.push('port', String(port), 'proto', protocol);
    const result = await command('ufw', args, 15000);
    if (!result.ok) throw Object.assign(new Error(`UFW: ${result.stderr}`), { status: 409 });
    return { action, decision, protocol, port, source: source || 'any' };
  }
  if (action === 'firewall-delete') {
    const number = Number(input.number);
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw Object.assign(new Error('Choose a valid UFW rule number.'), { status: 400 });
    const result = await command('ufw', ['--force', 'delete', String(number)], 15000);
    if (!result.ok) throw Object.assign(new Error(`UFW: ${result.stderr}`), { status: 409 });
    return { action, number };
  }
  if (action === 'wifi-connect') {
    const device = String(input.device || '');
    const ssid = String(input.ssid || '');
    const password = String(input.password || '');
    if (!validInterface(device) || !ssid || ssid.length > 64 || password.length > 256) throw Object.assign(new Error('Choose a valid Wi-Fi device, SSID and password.'), { status: 400 });
    const args = ['device', 'wifi', 'connect', ssid, 'ifname', device];
    if (password) args.push('password', password);
    const result = await command('nmcli', args, 30000);
    if (!result.ok) throw Object.assign(new Error(`NetworkManager: ${result.stderr}`), { status: 409 });
    return { action, device, ssid, status: 'connected' };
  }
  if (action === 'wifi-disconnect') {
    const device = String(input.device || '');
    if (!validInterface(device)) throw Object.assign(new Error('Choose a valid Wi-Fi device.'), { status: 400 });
    const result = await command('nmcli', ['device', 'disconnect', device], 15000);
    if (!result.ok) throw Object.assign(new Error(`NetworkManager: ${result.stderr}`), { status: 409 });
    return { action, device, status: 'disconnected' };
  }
  throw Object.assign(new Error('Unsupported network action.'), { status: 400 });
}
