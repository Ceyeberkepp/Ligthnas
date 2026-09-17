import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotpSecret, totpCode, totpUri, verifyTotp } from '../src/totp.mjs';

test('TOTP codes verify in the current time window', () => {
  const secret = generateTotpSecret();
  const timestamp = 1_800_000_000_000;
  const code = totpCode(secret, timestamp);
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, timestamp), true);
  assert.equal(verifyTotp(secret, code, timestamp + 30_000), true);
  assert.match(totpUri({ secret, username: 'tester' }), /^otpauth:\/\/totp\//);
});
