import { createHash, randomBytes, verify as verifySignature } from 'node:crypto';
import { spawn } from 'node:child_process';

export const base64url = value => Buffer.from(value).toString('base64url');
export const fromBase64url = value => Buffer.from(String(value || ''), 'base64url');
export const challenge = () => base64url(randomBytes(32));

export async function qrCodeDataUrl(value) {
  return await new Promise(resolve => {
    const child = spawn('qrencode', ['-t', 'SVG', '-m', '2', '-s', '6', '-o', '-', String(value)], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= 1024 * 1024) chunks.push(chunk);
      else child.kill();
    });
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code === 0 && chunks.length ? `data:image/svg+xml;base64,${Buffer.concat(chunks).toString('base64')}` : null));
  });
}

export function relyingParty(req) {
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host || '').trim();
  return host.replace(/^\[/, '').replace(/\](?::\d+)?$/, '').replace(/:\d+$/, '').toLowerCase();
}

function validClientData(value, expectedType, expectedChallenge, rpId) {
  let client;
  try { client = JSON.parse(fromBase64url(value).toString('utf8')); } catch { return null; }
  if (client.type !== expectedType || client.challenge !== expectedChallenge) return null;
  let origin;
  try { origin = new URL(client.origin); } catch { return null; }
  if (origin.hostname.toLowerCase() !== rpId || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(rpId)))) return null;
  return { client, raw: fromBase64url(value) };
}

function validAuthenticatorData(value, rpId) {
  const data = fromBase64url(value);
  if (data.length < 37) return null;
  const expected = createHash('sha256').update(rpId).digest();
  if (!data.subarray(0, 32).equals(expected) || !(data[32] & 0x01)) return null;
  return { raw: data, signCount: data.readUInt32BE(33) };
}

export function verifyRegistration({ response, expectedChallenge, rpId }) {
  const client = validClientData(response?.clientDataJSON, 'webauthn.create', expectedChallenge, rpId);
  const auth = validAuthenticatorData(response?.authenticatorData, rpId);
  const publicKey = fromBase64url(response?.publicKey);
  const id = String(response?.id || '');
  const algorithm = Number(response?.algorithm);
  if (!client || !auth || !id || publicKey.length < 32 || ![-7, -257].includes(algorithm)) throw Object.assign(new Error('The security-key registration response was invalid.'), { status: 400 });
  return { id, publicKey: base64url(publicKey), algorithm, signCount: auth.signCount };
}

export function verifyAssertion({ response, credential, expectedChallenge, rpId }) {
  const client = validClientData(response?.clientDataJSON, 'webauthn.get', expectedChallenge, rpId);
  const auth = validAuthenticatorData(response?.authenticatorData, rpId);
  if (!client || !auth || String(response?.id || '') !== credential.id) return false;
  const signed = Buffer.concat([auth.raw, createHash('sha256').update(client.raw).digest()]);
  let valid = false;
  try { valid = verifySignature('sha256', signed, { key: fromBase64url(credential.publicKey), format: 'der', type: 'spki' }, fromBase64url(response?.signature)); }
  catch { return false; }
  if (!valid || (credential.signCount > 0 && auth.signCount > 0 && auth.signCount <= credential.signCount)) return false;
  credential.signCount = auth.signCount;
  credential.lastUsedAt = new Date().toISOString();
  return true;
}

export async function sendTwilioSms(settings, message) {
  const accountSid = String(settings?.accountSid || '');
  const authToken = String(settings?.authToken || '');
  const from = String(settings?.fromNumber || '');
  const to = String(settings?.phone || '');
  if (!/^AC[a-zA-Z0-9]{30,40}$/.test(accountSid) || !authToken || !/^\+[1-9]\d{7,14}$/.test(from) || !/^\+[1-9]\d{7,14}$/.test(to)) {
    throw Object.assign(new Error('Enter valid Twilio credentials and E.164 phone numbers.'), { status: 400 });
  }
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`SMS provider rejected the message${result.message ? `: ${result.message}` : ` (HTTP ${response.status})`}.`), { status: 409 });
  }
  return true;
}

export function smsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
