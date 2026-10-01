import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPublicKey, verify as verifySignature } from 'node:crypto';

const receiptFile = resolve(process.env.LIGHTNAS_LICENSE_RECEIPT || '/var/lib/lightnas/license-receipt.json');
const licenseServer = String(process.env.LIGHTNAS_LICENSE_SERVER_URL || '').trim();
const publicKeyPem = String(process.env.LIGHTNAS_LICENSE_PUBLIC_KEY_PEM || '').trim();
const publicKeyFile = String(process.env.LIGHTNAS_LICENSE_PUBLIC_KEY_FILE || '/etc/lightnas/license-public.pem').trim();

function validReceiptPayload(payload, instanceId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (String(payload.instanceId || '') !== String(instanceId || '')) return false;
  if (!['community', 'pro', 'enterprise'].includes(String(payload.edition || ''))) return false;
  if (payload.expiresAt && !Number.isFinite(Date.parse(payload.expiresAt))) return false;
  return true;
}

async function configuredPublicKey() {
  if (publicKeyPem) return publicKeyPem;
  try { return (await readFile(publicKeyFile, 'utf8')).trim(); } catch { return ''; }
}

export async function licenseStatus({ instanceId, version }) {
  let receipt = null;
  try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); } catch {}
  const payload = receipt?.payload && validReceiptPayload(receipt.payload, instanceId) ? receipt.payload : null;
  const expired = payload?.expiresAt ? Date.parse(payload.expiresAt) <= Date.now() : false;
  return {
    edition: payload && !expired ? payload.edition : 'community',
    verified: Boolean(payload && !expired),
    expiresAt: payload?.expiresAt || null,
    features: payload && !expired && payload.features && typeof payload.features === 'object' ? payload.features : {},
    serverConfigured: Boolean(licenseServer && await configuredPublicKey()),
    instanceId,
    version
  };
}

export async function verifyLicense({ licenseKey, instanceId, version }) {
  const verificationKey = await configuredPublicKey();
  if (!licenseServer || !verificationKey) {
    throw Object.assign(new Error('The LightNAS license server is not configured yet.'), { status: 409 });
  }
  if (!/^https:\/\//i.test(licenseServer)) {
    throw Object.assign(new Error('The LightNAS license server must use HTTPS.'), { status: 500 });
  }
  const key = String(licenseKey || '').trim();
  if (key.length < 8 || key.length > 512) {
    throw Object.assign(new Error('Enter a valid license key.'), { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(licenseServer, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': `LightNAS/${version}` },
      body: JSON.stringify({ licenseKey: key, instanceId, version })
    });
  } finally { clearTimeout(timer); }
  if (!response.ok) throw Object.assign(new Error(`License verification failed with HTTP ${response.status}.`), { status: 409 });

  const body = await response.json();
  const encodedPayload = String(body?.payload || '');
  const encodedSignature = String(body?.signature || '');
  if (!encodedPayload || !encodedSignature) throw Object.assign(new Error('The license server returned an incomplete signed response.'), { status: 409 });

  let payload;
  let payloadBytes;
  try {
    payloadBytes = Buffer.from(encodedPayload, 'base64url');
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw Object.assign(new Error('The license server returned an invalid payload.'), { status: 409 });
  }
  if (!validReceiptPayload(payload, instanceId)) throw Object.assign(new Error('The license response does not match this LightNAS appliance.'), { status: 409 });

  const publicKey = createPublicKey(verificationKey);
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (!verifySignature(null, payloadBytes, publicKey, signature)) {
    throw Object.assign(new Error('The license signature could not be verified.'), { status: 409 });
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
    throw Object.assign(new Error('The license has expired.'), { status: 409 });
  }

  await mkdir(dirname(receiptFile), { recursive: true, mode: 0o700 });
  await writeFile(receiptFile, JSON.stringify({ payload, verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return await licenseStatus({ instanceId, version });
}
