import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function normalizePermissions(value, allowed, defaults = []) {
  if (!Array.isArray(value)) return [...defaults];
  return [...new Set(value.filter(item => allowed.includes(item)))];
}

export function effectivePermissions({ state, username, account, isAdmin, allowed, defaults = [] }) {
  if (isAdmin) return [...allowed];
  const direct = normalizePermissions(account?.permissions, allowed, defaults);
  const inherited = (state.groups || [])
    .filter(group => Array.isArray(group.members) && group.members.includes(username))
    .flatMap(group => normalizePermissions(group.permissions, allowed, []));
  return [...new Set([...direct, ...inherited])];
}

export function groupsForUser(state, username) {
  return (state.groups || []).filter(group => Array.isArray(group.members) && group.members.includes(username));
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createApiTokenRecord({ name, permissions, allowed }) {
  const normalizedName = String(name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/.test(normalizedName)) throw Object.assign(new Error('API token name must contain 2–64 valid characters.'), { status: 400 });
  const secret = `ln_${randomBytes(32).toString('base64url')}`;
  const record = {
    id: crypto.randomUUID(),
    name: normalizedName,
    tokenHash: hashToken(secret),
    permissions: normalizePermissions(permissions, allowed, []),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    disabled: false
  };
  return { record, secret };
}

export function authenticateApiToken(state, authorization, allowed) {
  const match = String(authorization || '').match(/^Bearer\s+(ln_[A-Za-z0-9_-]{20,})$/i);
  if (!match) return null;
  const digest = hashToken(match[1]);
  const supplied = Buffer.from(digest, 'hex');
  const record = (state.security?.apiTokens || []).find(item => {
    if (item.disabled || typeof item.tokenHash !== 'string' || item.tokenHash.length !== digest.length) return false;
    const expected = Buffer.from(item.tokenHash, 'hex');
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  });
  if (!record) return null;
  record.lastUsedAt = new Date().toISOString();
  return {
    username: `api:${record.name}`,
    account: record,
    isAdmin: false,
    permissions: normalizePermissions(record.permissions, allowed, []),
    apiToken: record
  };
}

export function createWebhookRecord({ name, url, events }) {
  const normalizedName = String(name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/.test(normalizedName)) throw Object.assign(new Error('Webhook name must contain 2–64 valid characters.'), { status: 400 });
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw Object.assign(new Error('Enter a valid webhook URL.'), { status: 400 }); }
  const allowHttp = process.env.LIGHTNAS_ALLOW_HTTP_WEBHOOKS === '1';
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:'))) {
    throw Object.assign(new Error(allowHttp ? 'Webhook URL must use HTTP or HTTPS and must not contain credentials.' : 'Webhook URL must use HTTPS and must not contain credentials.'), { status: 400 });
  }
  const eventList = Array.isArray(events) ? [...new Set(events.map(value => String(value).trim()).filter(Boolean).slice(0, 30))] : ['*'];
  return {
    id: crypto.randomUUID(), name: normalizedName, url: parsed.toString(), events: eventList.length ? eventList : ['*'],
    secret: randomBytes(32).toString('hex'), enabled: true, createdAt: new Date().toISOString(),
    lastDeliveryAt: null, lastStatus: null
  };
}

export async function deliverWebhook(webhook, event) {
  if (!webhook?.enabled) return { skipped: true };
  if (!webhook.events?.includes('*') && !webhook.events?.includes(event.type)) return { skipped: true };
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    message: event.message,
    severity: event.severity,
    timestamp: event.timestamp,
    source: 'lightnas'
  });
  const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LightNAS-Webhook/1',
        'X-LightNAS-Event': event.type,
        'X-LightNAS-Delivery': event.id,
        'X-LightNAS-Signature-256': `sha256=${signature}`
      },
      body
    });
    webhook.lastDeliveryAt = new Date().toISOString();
    webhook.lastStatus = response.status;
    return { ok: response.ok, status: response.status };
  } catch (error) {
    webhook.lastDeliveryAt = new Date().toISOString();
    webhook.lastStatus = 0;
    return { ok: false, status: 0, error: error.message };
  }
}

export async function deliverEvent(state, event) {
  const hooks = (state.security?.webhooks || []).filter(webhook => webhook.enabled && (webhook.events?.includes('*') || webhook.events?.includes(event.type)));
  await Promise.allSettled(hooks.map(webhook => deliverWebhook(webhook, event)));
}
