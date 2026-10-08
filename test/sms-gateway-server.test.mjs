import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('central SMS gateway health and appliance authentication', async () => {
  process.env.LIGHTNAS_SMS_APPLIANCE_TOKENS = 'test-appliance-token';
  process.env.LIGHTNAS_SMS_PROVIDER = '';
  const { createSmsGatewayServer } = await import(new URL('../services/sms-gateway/server.mjs?auth-test', import.meta.url));
  const server = createSmsGatewayServer();
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.service, 'lightnas-sms-gateway');
    assert.equal(healthBody.authConfigured, true);

    const unauthorized = await fetch(`${base}/v1/sms/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: '+15551234567', message: 'test' })
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await close(server);
  }
});

test('central SMS gateway forwards an authenticated request to the configured provider', async () => {
  let forwarded = null;
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded = {
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'carrier-123' }));
  });
  const providerAddress = await listen(provider);

  process.env.LIGHTNAS_SMS_APPLIANCE_TOKENS = 'test-appliance-token';
  process.env.LIGHTNAS_SMS_PROVIDER = 'webhook';
  process.env.LIGHTNAS_SMS_PROVIDER_URL = `http://127.0.0.1:${providerAddress.port}/send`;
  process.env.LIGHTNAS_SMS_PROVIDER_TOKEN = 'provider-secret';

  const { createSmsGatewayServer } = await import(new URL('../services/sms-gateway/server.mjs?provider-test', import.meta.url));
  const gateway = createSmsGatewayServer();
  const gatewayAddress = await listen(gateway);
  const base = `http://127.0.0.1:${gatewayAddress.port}`;

  try {
    const response = await fetch(`${base}/v1/sms/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-appliance-token'
      },
      body: JSON.stringify({
        to: '+15551234567',
        message: 'Your LightNAS verification code is 123456.',
        purpose: 'login'
      })
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, 'accepted');
    assert.equal(forwarded.authorization, 'Bearer provider-secret');
    assert.deepEqual(forwarded.body, {
      to: '+15551234567',
      message: 'Your LightNAS verification code is 123456.',
      purpose: 'login'
    });
  } finally {
    await close(gateway);
    await close(provider);
  }
});
