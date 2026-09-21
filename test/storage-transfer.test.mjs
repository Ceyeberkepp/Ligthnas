import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStorageTransferError } from '../src/storage-pools.mjs';

test('large image transfer errors remain actionable', () => {
  const timeout = normalizeStorageTransferError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
  assert.equal(timeout.status, 504);
  assert.match(timeout.message, /timed out/i);

  const full = normalizeStorageTransferError(Object.assign(new Error('full'), { code: 'ENOSPC' }));
  assert.equal(full.status, 507);
  assert.match(full.message, /free space/i);

  const socket = normalizeStorageTransferError(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }));
  assert.equal(socket.status, 502);
  assert.match(socket.message, /closed the transfer/i);
});
