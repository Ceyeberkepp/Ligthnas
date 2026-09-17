import tls from 'node:tls';

function operationError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function safeHttpsUrl(value, label) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw operationError(`${label} must be a valid URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw operationError(`${label} must use HTTPS and must not contain credentials.`);
  return url.toString();
}

function cleanName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/.test(name)) throw operationError('Identity provider name must contain 2–64 valid characters.');
  return name;
}

function cleanPem(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!text.includes('-----BEGIN CERTIFICATE-----') || !text.includes('-----END CERTIFICATE-----') || text.length > 32768) throw operationError('CA certificate must be PEM encoded.');
  return text;
}

export function normalizeIdentityProvider(input, previous = {}) {
  const type = String(input.type ?? previous.type ?? '').toLowerCase();
  if (!['ldaps', 'saml', 'oidc'].includes(type)) throw operationError('Identity provider type must be LDAPS, SAML, or OIDC.');
  const common = {
    id: previous.id || crypto.randomUUID(),
    name: cleanName(input.name ?? previous.name),
    type,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : Boolean(previous.enabled),
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissions: Array.isArray(input.permissions) ? input.permissions : (previous.permissions || [])
  };
  if (type === 'ldaps') {
    const host = String(input.host ?? previous.host ?? '').trim();
    const port = Number(input.port ?? previous.port ?? 636);
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw operationError('Enter a valid LDAPS host and port.');
    const principalTemplate = String(input.principalTemplate ?? previous.principalTemplate ?? '{username}').trim();
    if (!principalTemplate.includes('{username}') || principalTemplate.length > 256) throw operationError('LDAPS principal template must include {username}.');
    return {
      ...common,
      host,
      port,
      serverName: String(input.serverName ?? previous.serverName ?? host).trim(),
      caPem: cleanPem(input.caPem ?? previous.caPem ?? ''),
      bindDn: String(input.bindDn ?? previous.bindDn ?? '').trim().slice(0, 1024),
      bindPassword: input.bindPassword ? String(input.bindPassword).slice(0, 2048) : (previous.bindPassword || ''),
      principalTemplate,
      baseDn: String(input.baseDn ?? previous.baseDn ?? '').trim().slice(0, 1024)
    };
  }
  if (type === 'saml') {
    const metadataUrl = input.metadataUrl ?? previous.metadataUrl;
    const ssoUrl = input.ssoUrl ?? previous.ssoUrl;
    return {
      ...common,
      metadataUrl: metadataUrl ? safeHttpsUrl(metadataUrl, 'SAML metadata URL') : '',
      entityId: String(input.entityId ?? previous.entityId ?? '').trim().slice(0, 1024),
      ssoUrl: ssoUrl ? safeHttpsUrl(ssoUrl, 'SAML SSO URL') : '',
      certificate: cleanPem(input.certificate ?? previous.certificate ?? ''),
      nameIdFormat: String(input.nameIdFormat ?? previous.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress').trim().slice(0, 512)
    };
  }
  const issuer = safeHttpsUrl(input.issuer ?? previous.issuer, 'OIDC issuer');
  return {
    ...common,
    issuer: issuer.replace(/\/$/, ''),
    clientId: String(input.clientId ?? previous.clientId ?? '').trim().slice(0, 512),
    clientSecret: input.clientSecret ? String(input.clientSecret).slice(0, 2048) : (previous.clientSecret || ''),
    scopes: String(input.scopes ?? previous.scopes ?? 'openid profile email').trim().slice(0, 512)
  };
}

function providerPublic(provider) {
  const publicProvider = { ...provider };
  delete publicProvider.bindPassword;
  delete publicProvider.clientSecret;
  publicProvider.hasBindPassword = Boolean(provider.bindPassword);
  publicProvider.hasClientSecret = Boolean(provider.clientSecret);
  return publicProvider;
}

export function publicIdentityProvider(provider) {
  return providerPublic(provider);
}

function encodeLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function integer(value) {
  const bytes = [];
  let number = value;
  do { bytes.unshift(number & 0xff); number >>>= 8; } while (number > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function ldapBindRequest(principal, secret) {
  const bindContents = Buffer.concat([
    integer(3),
    tlv(0x04, Buffer.from(principal, 'utf8')),
    tlv(0x80, Buffer.from(secret, 'utf8'))
  ]);
  return tlv(0x30, Buffer.concat([integer(1), tlv(0x60, bindContents)]));
}

function parseLength(buffer, offset) {
  if (buffer.length <= offset) return null;
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  const count = first & 0x7f;
  if (!count || count > 4 || buffer.length < offset + 1 + count) return null;
  let length = 0;
  for (let index = 0; index < count; index++) length = (length << 8) | buffer[offset + 1 + index];
  return { length, bytes: 1 + count };
}

function ldapResultCode(message) {
  const bindTag = message.indexOf(0x61);
  if (bindTag < 0) throw operationError('LDAPS server returned an unexpected bind response.', 409);
  const bindLength = parseLength(message, bindTag + 1);
  if (!bindLength) throw operationError('LDAPS bind response was incomplete.', 409);
  let offset = bindTag + 1 + bindLength.bytes;
  if (message[offset] !== 0x0a) throw operationError('LDAPS bind response did not contain a result code.', 409);
  const codeLength = parseLength(message, offset + 1);
  if (!codeLength || codeLength.length < 1) throw operationError('LDAPS bind result was incomplete.', 409);
  offset += 1 + codeLength.bytes;
  return message[offset];
}

async function ldapsConnect(provider, principal = null, secret = null) {
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: provider.host,
      port: provider.port,
      servername: provider.serverName || provider.host,
      rejectUnauthorized: true,
      ca: provider.caPem ? [provider.caPem] : undefined
    });
    let buffer = Buffer.alloc(0);
    const fail = error => { socket.destroy(); reject(operationError(`LDAPS connection failed: ${error.message}`, 409)); };
    socket.setTimeout(10000, () => fail(new Error('connection timed out')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      if (!principal) {
        const cert = socket.getPeerCertificate();
        const cipher = socket.getCipher();
        socket.end();
        resolve({ ok: true, tls: true, authorized: socket.authorized, subject: cert.subject?.CN || null, cipher: cipher?.name || null });
        return;
      }
      socket.write(ldapBindRequest(principal, secret || ''));
    });
    socket.on('data', chunk => {
      if (!principal) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) return fail(new Error('bind response too large'));
      if (buffer[0] !== 0x30) return;
      const outer = parseLength(buffer, 1);
      if (!outer) return;
      const total = 1 + outer.bytes + outer.length;
      if (buffer.length < total) return;
      try {
        const resultCode = ldapResultCode(buffer.subarray(0, total));
        socket.end();
        if (resultCode === 0) resolve({ ok: true, tls: true, bind: true });
        else reject(operationError(`LDAPS bind was rejected with LDAP result code ${resultCode}.`, 409));
      } catch (error) { fail(error); }
    });
  });
}

export async function testIdentityProvider(provider) {
  if (provider.type === 'ldaps') {
    if (provider.bindDn && provider.bindPassword) return await ldapsConnect(provider, provider.bindDn, provider.bindPassword);
    return await ldapsConnect(provider);
  }
  if (provider.type === 'saml') {
    if (provider.metadataUrl) {
      const response = await fetch(provider.metadataUrl, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'LightNAS-Identity/1' } });
      if (!response.ok) throw operationError(`SAML metadata endpoint returned HTTP ${response.status}.`, 409);
      const body = await response.text();
      if (!/(EntityDescriptor|EntitiesDescriptor|IDPSSODescriptor)/.test(body) || body.length > 4 * 1024 * 1024) throw operationError('SAML metadata did not contain a recognizable identity-provider descriptor.', 409);
      return { ok: true, metadata: true, bytes: body.length };
    }
    if (!provider.entityId || !provider.ssoUrl || !provider.certificate) throw operationError('SAML provider needs metadata URL or entity ID, SSO URL and certificate.', 409);
    return { ok: true, configured: true };
  }
  const discoveryUrl = `${provider.issuer}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'LightNAS-Identity/1' } });
  if (!response.ok) throw operationError(`OIDC discovery endpoint returned HTTP ${response.status}.`, 409);
  const discovery = await response.json();
  if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri) throw operationError('OIDC discovery document is missing required endpoints.', 409);
  return { ok: true, issuer: discovery.issuer || provider.issuer, authorizationEndpoint: discovery.authorization_endpoint, tokenEndpoint: discovery.token_endpoint, jwksUri: discovery.jwks_uri };
}

export async function authenticateLdaps(provider, username, secret) {
  if (!provider?.enabled || provider.type !== 'ldaps') return false;
  if (!/^[^\x00\r\n]{1,128}$/.test(String(username || '')) || typeof secret !== 'string' || !secret) return false;
  const principal = provider.principalTemplate.replaceAll('{username}', username);
  try { await ldapsConnect(provider, principal, secret); return true; }
  catch { return false; }
}
