import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTemplateTransferError } from '../src/templates.mjs';

test('template transfer errors are safe and actionable', () => {
  const timeout = normalizeTemplateTransferError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
  assert.equal(timeout.status, 504);
  assert.match(timeout.message, /timed out/i);

  const full = normalizeTemplateTransferError(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  assert.equal(full.status, 507);
  assert.match(full.message, /free space/i);

  const permissions = normalizeTemplateTransferError(Object.assign(new Error('denied'), { code: 'EACCES' }));
  assert.equal(permissions.status, 403);
  assert.match(permissions.message, /cannot write/i);

  const socket = normalizeTemplateTransferError(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }));
  assert.equal(socket.status, 502);
  assert.match(socket.message, /closed the transfer/i);
});

test('template transfer errors preserve deliberate HTTP status', () => {
  const expected = Object.assign(new Error('checksum failed'), { status: 502 });
  assert.equal(normalizeTemplateTransferError(expected), expected);
});
