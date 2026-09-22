import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('VM and container creation use guided dialogs instead of inline forms', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const dialogs = await readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /id="container-form"/);
  assert.doesNotMatch(app, /id="vm-form"/);
  assert.match(dialogs, /showRuntimeWizard/);
  assert.match(dialogs, /Root password/);
  assert.match(dialogs, /diskGiB/);
  assert.match(dialogs, /firmware/);
  assert.match(dialogs, /LightNASProgress/);
});

test('image and ISO transfers use the progress dialog', async () => {
  const templates = await readFile(new URL('../public/templates.js', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../public/storage-manager.js', import.meta.url), 'utf8');
  assert.match(templates, /Downloading container image/);
  assert.match(storage, /Downloading VM installer image/);
  assert.match(storage, /uploaded successfully and is ready to use/);
});

test('container backend requires credentials and selected root storage', async () => {
  const [runtime, agent, dialogs] = await Promise.all([
    readFile(new URL('../src/runtimes-next.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/lightnas-host-agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8')
  ]);
  assert.match(runtime, /4–128 character root password/);
  assert.match(dialogs, /minlength="4"/);
  assert.match(runtime, /resolveStoragePool\(String\(input\.pool/);
  assert.match(runtime, /image: input\.image/);
  assert.match(agent, /chpasswd/);
  assert.match(agent, /managed_container_storage_root/);
  assert.match(agent, /lightnas\.json/);
  assert.match(agent, /"imageId": str\(data\.get\("image"\)/);
  assert.match(agent, /def verify_container_installation/);
  assert.match(agent, /etc" \/ "os-release/);
  assert.match(agent, /"verified": True/);
});

test('files and media share one tabbed library with sequential previews', async () => {
  const [page, app, enhancements] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8')
  ]);
  assert.match(page, />Files & media</);
  assert.doesNotMatch(page, /data-view="media"/);
  assert.match(app, /data-library-tab/);
  assert.match(app, /\['Photos', 'Photos'\]/);
  assert.match(app, /\['ISO', 'ISO images'\]/);
  assert.match(enhancements, /data-viewer-previous/);
  assert.match(enhancements, /data-viewer-next/);
  assert.match(enhancements, /ArrowLeft/);
  assert.match(enhancements, /ArrowRight/);
  assert.match(enhancements, /previewItems\(\)/);
});
