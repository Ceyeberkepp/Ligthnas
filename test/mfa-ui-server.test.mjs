import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('SMS MFA is configurable and usable from the login screen', async () => {
  const [server, app, admin, html] = await Promise.all([
    read('src/server.mjs'),
    read('public/app.js'),
    read('public/admin-security.js'),
    read('public/index.html')
  ]);
  for (const endpoint of [
    '/api/security/sms',
    '/api/security/sms/setup',
    '/api/security/sms/verify',
    '/api/security/sms/disable',
    '/api/login/sms/send'
  ]) assert.ok(server.includes(endpoint), `missing endpoint ${endpoint}`);
  assert.match(server, /sendTwilioSms/);
  assert.match(server, /verifyPendingSms\(pendingSmsLogins/);
  assert.match(app, /\/api\/login\/sms\/send/);
  assert.match(app, /mfaMethod/);
  assert.match(admin, /data-sms-setup/);
  assert.match(admin, /data-sms-verify/);
  assert.match(html, /id="login-sms-status"/);
});

test('WebAuthn passkeys can be registered, removed, and used to sign in', async () => {
  const [server, app, admin] = await Promise.all([
    read('src/server.mjs'),
    read('public/app.js'),
    read('public/admin-security.js')
  ]);
  for (const endpoint of [
    '/api/security/passkeys',
    '/api/security/passkeys/register/options',
    '/api/security/passkeys/register/verify',
    '/api/security/passkeys/remove',
    '/api/login/passkey/options',
    '/api/login/passkey/verify'
  ]) assert.ok(server.includes(endpoint), `missing endpoint ${endpoint}`);
  assert.match(server, /verifyRegistration/);
  assert.match(server, /verifyAssertion/);
  assert.match(app, /navigator\.credentials\.get/);
  assert.match(app, /serializePasskeyAssertion/);
  assert.match(admin, /navigator\.credentials\.create/);
  assert.match(admin, /serializePasskeyRegistration/);
  assert.match(admin, /window\.isSecureContext/);
});
