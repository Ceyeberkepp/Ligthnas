import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const HOST = process.env.LIGHTNAS_SMS_BIND || '0.0.0.0';
const PORT = Number(process.env.LIGHTNAS_SMS_PORT || 3091);
const TOKENS = String(process.env.LIGHTNAS_SMS_APPLIANCE_TOKENS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const PROVIDER = String(process.env.LIGHTNAS_SMS_PROVIDER || '').trim().toLowerCase();
const RATE_WINDOW_MS = Number(process.env.LIGHTNAS_SMS_RATE_WINDOW_MS || 60000);
const RATE_PER_TOKEN = Number(process.env.LIGHTNAS_SMS_RATE_PER_TOKEN || 20);
const RATE_PER_DESTINATION = Number(process.env.LIGHTNAS_SMS_RATE_PER_DESTINATION || 5);
const MAX_BODY_BYTES = 32 * 1024;
const rateBuckets = new Map();

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function authenticate(req) {
  const token = bearer(req);
  if (!token || !TOKENS.some(expected => secureEqual(token, expected))) return null;
  return token;
}

function rateAllowed(key, limit) {
  const now = Date.now();
  const item = rateBuckets.get(key);
  if (!item || now - item.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (item.count >= limit) return false;
  item.count += 1;
  return true;
}

function execFile(command, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${command} timed out.`), { status: 504 }));
    }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}.`), { status: 502 }));
    });
  });
}

async function listModems() {
  const { stdout } = await execFile('mmcli', ['-L']);
  return [...stdout.matchAll(/\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)/g)].map(match => match[1]);
}

async function sendWithModemManager(to, message) {
  const configured = String(process.env.LIGHTNAS_SMS_MODEM || '').trim();
  const modems = configured ? [configured] : await listModems();
  if (!modems.length) throw Object.assign(new Error('No cellular modem is available on the central SMS gateway.'), { status: 503 });
  const modem = modems[0];
  const payload = `text='${message.replace(/'/g, '')}',number='${to}'`;
  const created = await execFile('mmcli', ['-m', modem, `--messaging-create-sms=${payload}`]);
  const match = created.stdout.match(/\/org\/freedesktop\/ModemManager1\/SMS\/(\d+)/);
  if (!match) throw Object.assign(new Error('ModemManager did not return an SMS object.'), { status: 502 });
  const smsId = match[1];
  try {
    await execFile('mmcli', ['-s', smsId, '--send']);
  } finally {
    await execFile('mmcli', ['-m', modem, `--messaging-delete-sms=${smsId}`]).catch(() => null);
  }
  return { provider: 'modemmanager', providerId: smsId };
}

async function sendWithWebhook(to, message, purpose) {
  const url = String(process.env.LIGHTNAS_SMS_PROVIDER_URL || '').trim();
  const token = String(process.env.LIGHTNAS_SMS_PROVIDER_TOKEN || '').trim();
  if (!url) throw Object.assign(new Error('LIGHTNAS_SMS_PROVIDER_URL is not configured.'), { status: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ to, message, purpose }),
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      throw Object.assign(new Error(String(body.error || body.message || `Provider returned HTTP ${response.status}.`)), { status: 502 });
    }
    return { provider: 'webhook', providerId: body.id || body.messageId || null };
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('SMS provider timed out.'), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(to, message, purpose) {
  if (PROVIDER === 'modemmanager') return sendWithModemManager(to, message);
  if (PROVIDER === 'webhook') return sendWithWebhook(to, message, purpose);
  throw Object.assign(new Error('No SMS delivery provider is configured on the central gateway.'), { status: 503 });
}

function providerStatus() {
  return {
    configured: ['modemmanager', 'webhook'].includes(PROVIDER),
    provider: PROVIDER || 'unconfigured'
  };
}

export function createSmsGatewayServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          service: 'lightnas-sms-gateway',
          status: 'ok',
          authConfigured: TOKENS.length > 0,
          ...providerStatus()
        });
      }

      if (req.method !== 'POST' || url.pathname !== '/v1/sms/send') {
        return json(res, 404, { error: 'Not found.' });
      }

      const token = authenticate(req);
      if (!token) return json(res, 401, { error: 'Invalid appliance token.' });

      const input = await readBody(req);
      const to = String(input.to || '').trim();
      const message = String(input.message || '').trim();
      const purpose = String(input.purpose || 'verification').trim().slice(0, 64);

      if (!/^\+[1-9]\d{7,14}$/.test(to)) return json(res, 400, { error: 'Destination must be an E.164 phone number.' });
      if (!message || message.length > 480) return json(res, 400, { error: 'Message is empty or too long.' });

      const tokenKey = `token:${token}`;
      const destinationKey = `to:${to}`;
      if (!rateAllowed(tokenKey, RATE_PER_TOKEN) || !rateAllowed(destinationKey, RATE_PER_DESTINATION)) {
        return json(res, 429, { error: 'SMS rate limit exceeded. Try again later.' }, { 'retry-after': String(Math.ceil(RATE_WINDOW_MS / 1000)) });
      }

      const delivered = await deliver(to, message, purpose);
      const id = randomUUID();
      console.info(JSON.stringify({
        event: 'sms.sent',
        id,
        provider: delivered.provider,
        providerId: delivered.providerId || null,
        purpose,
        destinationSuffix: to.slice(-4),
        at: new Date().toISOString()
      }));
      return json(res, 202, { id, status: 'accepted' });
    } catch (error) {
      const status = Number(error?.status) || 500;
      console.error(JSON.stringify({
        event: 'sms.error',
        message: error?.message || 'Unknown SMS gateway error',
        status,
        at: new Date().toISOString()
      }));
      return json(res, status, { error: status >= 500 ? 'SMS delivery failed.' : error.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createSmsGatewayServer();
  server.listen(PORT, HOST, () => {
    console.log(`LightNAS SMS gateway listening on http://${HOST}:${PORT}`);
  });
}
