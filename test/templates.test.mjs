import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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


test('container image pull retries transient upstream failures and honors redirect filenames', async () => {
  const templates = await read('src/templates.mjs');
  const ui = await read('public/templates.js');
  assert.match(templates, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(templates, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(templates, /safeFilename\(finalUrl\.pathname\)/);
  assert.match(templates, /await delay\(attempt \* 750\)/);
  assert.match(ui, />Pull image<\/button>/);
  assert.match(ui, />Pull selected<\/button>/);
  assert.match(ui, /Pulling container image/);
});
