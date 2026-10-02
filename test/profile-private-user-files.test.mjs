import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, app, styles] = await Promise.all([
  readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
]);

test('local files.own users stay scoped to their private library', () => {
  const start = server.indexOf('function privateFileScope');
  const end = server.indexOf('function scopedFilePath', start);
  const block = server.slice(start, end);
  assert.match(block, /context\.isAdmin\) return ''/);
  assert.match(block, /context\.permissions\.includes\('files\.own'\).*Users\/\$\{context\.username\}/s);
  assert.ok(block.indexOf("files.own") < block.indexOf('globalPermissions.some'));
});

test('administrator private-user browser requires the owner password and normal files hide Users', () => {
  assert.match(server, /\/api\/admin\/user-files\/list/);
  assert.match(server, /verifyPassword\(input\.currentPassword, store\.state\.config\.passwordHash\)/);
  assert.match(server, /entries\.filter\(entry => entry\.name !== 'Users'\)/);
  assert.match(server, /Private user libraries are protected/);
  assert.match(app, /data-action="private-user-files"/);
  assert.match(app, /Administrator password/);
});

test('server name is hidden from ordinary users unless explicitly granted', () => {
  assert.match(server, /showDeviceName: false/);
  assert.match(server, /showDeviceName: Boolean\(user\.showDeviceName\)/);
  assert.match(server, /deviceName: isAdmin \|\| account\.showDeviceName \?/);
  assert.match(app, /appliance\.deviceNameVisible.*'Online'/);
  assert.match(app, /name="showDeviceName"/);
});

test('new local users require at least ten password characters in API and UI', () => {
  assert.match(server, /input\.password\.length < 10/);
  assert.match(app, /minlength="10"/);
  assert.match(app, /password\.length < 10/);
});

test('profile image editor fits the whole image at default zoom and uses modern contained preview', () => {
  assert.match(app, /Math\.min\(512 \/ image\.naturalWidth, 512 \/ image\.naturalHeight\)/);
  assert.match(styles, /\.profile-crop-stage img[\s\S]*?object-fit:contain/);
  assert.match(styles, /\.profile-dialog[\s\S]*?border-radius:20px/);
});
