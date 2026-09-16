import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
async function command(program, args) {
  try { return (await run(program, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { return null; }
}
function json(value) { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }

// Inventory only: networking and firewall changes can sever the management connection.
export async function networkInventory() {
  const [addresses, routes, dnsFile, ufw, nft] = await Promise.all([
    command('ip', ['-j', 'address', 'show']),
    command('ip', ['-j', 'route', 'show']),
    readFile('/etc/resolv.conf', 'utf8').catch(() => ''),
    command('ufw', ['status']),
    command('nft', ['list', 'tables'])
  ]);
  return {
    interfaces: json(addresses).map(({ ifname, operstate, address, addr_info }) => ({
      name: ifname, state: operstate, mac: address,
      addresses: (addr_info || []).map(({ family, local, prefixlen }) => ({ family, address: local, prefix: prefixlen }))
    })),
    routes: json(routes).map(({ dst, gateway, dev, metric }) => ({ destination: dst || 'default', gateway: gateway || '', device: dev || '', metric: metric ?? null })),
    dns: dnsFile.split('\n').map(line => line.match(/^\s*nameserver\s+(\S+)/)?.[1]).filter(Boolean),
    firewall: { backend: ufw !== null ? 'ufw' : nft !== null ? 'nftables' : 'not accessible', status: ufw?.match(/^Status:\s*(.+)/m)?.[1] || (nft !== null ? 'ruleset readable' : 'unknown'), tables: nft?.split('\n').filter(line => /^table\s/.test(line)).slice(0, 30) || [] }
  };
}
