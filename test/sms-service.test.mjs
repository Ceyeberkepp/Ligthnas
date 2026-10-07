import test from 'node:test';
import assert from 'node:assert/strict';
import { smsGatewayStatus, sendLightNasSms } from '../src/sms-service.mjs';

test('centralized SMS gateway reports unavailable without appliance gateway configuration', () => {
  const previousUrl = process.env.LIGHTNAS_SMS_GATEWAY_URL;
  const previousToken = process.env.LIGHTNAS_SMS_GATEWAY_TOKEN;
  delete process.env.LIGHTNAS_SMS_GATEWAY_URL;
  delete process.env.LIGHTNAS_SMS_GATEWAY_TOKEN;
  try {
    const status = smsGatewayStatus();
    assert.equal(status.available, false);
    assert.equal(status.mode, 'centralized');
    assert.equal(status.backend, 'LightNAS SMS service');
  } finally {
    if (previousUrl === undefined) delete process.env.LIGHTNAS_SMS_GATEWAY_URL;
    else process.env.LIGHTNAS_SMS_GATEWAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LIGHTNAS_SMS_GATEWAY_TOKEN;
    else process.env.LIGHTNAS_SMS_GATEWAY_TOKEN = previousToken;
  }
});

test('centralized SMS gateway sends through the LightNAS service without exposing provider credentials', async () => {
  const previousUrl = process.env.LIGHTNAS_SMS_GATEWAY_URL;
  const previousToken = process.env.LIGHTNAS_SMS_GATEWAY_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.LIGHTNAS_SMS_GATEWAY_URL = 'https://sms.lightnas.test';
  process.env.LIGHTNAS_SMS_GATEWAY_TOKEN = 'appliance-secret';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: 'msg-123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await sendLightNasSms({
      phone: '+15551234567',
      message: 'Your LightNAS verification code is 123456.',
      purpose: 'login'
    });
    assert.equal(result.ok, true);
    assert.equal(result.id, 'msg-123');
    assert.equal(request.url, 'https://sms.lightnas.test/v1/sms/send');
    assert.equal(request.options.headers.authorization, 'Bearer appliance-secret');
    const body = JSON.parse(request.options.body);
    assert.deepEqual(body, {
      to: '+15551234567',
      message: 'Your LightNAS verification code is 123456.',
      purpose: 'login'
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.LIGHTNAS_SMS_GATEWAY_URL;
    else process.env.LIGHTNAS_SMS_GATEWAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LIGHTNAS_SMS_GATEWAY_TOKEN;
    else process.env.LIGHTNAS_SMS_GATEWAY_TOKEN = previousToken;
  }
});
