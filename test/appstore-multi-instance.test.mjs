import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('catalog apps support multiple named instances with isolated storage and ports', async () => {
  const runtime = await read('src/runtimes-next.mjs');

  assert.match(runtime, /async function catalogInstances\(id\)/);
  assert.match(runtime, /lightnas\.instance=/);
  assert.match(runtime, /instanceName === 'default'/);
  assert.match(runtime, /0\.0\.0\.0::\$\{app\.containerPort\}/);
  assert.match(runtime, /containerPublishedPort\(name, app\.containerPort\)/);
  assert.match(runtime, /join\(dataRoot, 'apps', id, instanceName, folder\)/);
  assert.match(runtime, /manageCatalogApp\(id, action, instanceName = 'default'\)/);
});

test('App Store keeps install available and lists every installed instance', async () => {
  const app = await read('public/app.js');

  assert.match(app, /installed instance/);
  assert.match(app, /Install another instance/);
  assert.match(app, /data-app-instance=/);
  assert.match(app, /data-instance-count=/);
  assert.match(app, /setup\.instanceName/);
  assert.match(app, /setup\.hostPort = 0/);
});

test('instance-specific edit and actions are sent to backend', async () => {
  const [app, dialogs, server] = await Promise.all([
    read('public/app.js'),
    read('public/dialog-controls.js'),
    read('src/server.mjs')
  ]);

  assert.match(app, /JSON\.stringify\(\{ instanceName, hostPort:/);
  assert.match(dialogs, /instanceName = appEdit\.dataset\.appInstance/);
  assert.match(dialogs, /restartPolicy: values\.restartPolicy,[\s\S]*instanceName/);
  assert.match(server, /manageCatalogApp\(id, action, input\.instanceName \|\| 'default'\)/);
  assert.match(server, /installed\.instanceName/);
});
