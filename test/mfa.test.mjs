import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { base64url, smsCode, smsCodeDigest, verifySmsCode, verifyAssertion, verifyRegistration } from '../src/mfa.mjs';

test('WebAuthn registration and assertion validate RP, challenge and signature', () => {
  const rpId = 'nas.example.test';
  const expectedChallenge = base64url(Buffer.alloc(32, 7));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const authenticatorData = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(authenticatorData);
  authenticatorData[32] = 0x01;
  authenticatorData.writeUInt32BE(1, 33);
  const registrationClient = Buffer.from(JSON.stringify({ type:'webauthn.create', challenge:expectedChallenge, origin:`https://${rpId}` }));
  const registered = verifyRegistration({ response:{ id:'credential-one', clientDataJSON:base64url(registrationClient), authenticatorData:base64url(authenticatorData), publicKey:base64url(publicDer), algorithm:-7 }, expectedChallenge, rpId });
  assert.equal(registered.id, 'credential-one');

  const assertionClient = Buffer.from(JSON.stringify({ type:'webauthn.get', challenge:expectedChallenge, origin:`https://${rpId}` }));
  authenticatorData.writeUInt32BE(2, 33);
  const signed = Buffer.concat([authenticatorData, createHash('sha256').update(assertionClient).digest()]);
  const signature = sign('sha256', signed, privateKey);
  assert.equal(verifyAssertion({ response:{ id:'credential-one', clientDataJSON:base64url(assertionClient), authenticatorData:base64url(authenticatorData), signature:base64url(signature) }, credential:registered, expectedChallenge, rpId }), true);
  assert.equal(registered.signCount, 2);
});


test('SMS verification codes are six digits and digest verification is constant-time compatible', () => {
  const code = smsCode();
  assert.match(code, /^[0-9]{6}$/);
  const nonce = 'test-nonce';
  const digest = smsCodeDigest(code, nonce);
  assert.equal(verifySmsCode(code, nonce, digest), true);
  assert.equal(verifySmsCode(code === '999999' ? '888888' : '999999', nonce, digest), false);
  assert.equal(verifySmsCode(code, 'different-nonce', digest), false);
});
