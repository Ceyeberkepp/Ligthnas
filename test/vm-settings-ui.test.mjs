import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('VM settings tabs use the styled LightNAS hardware navigation', async () => {
  const [dialog, css] = await Promise.all([
    readFile(new URL('../public/dialog-controls.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(dialog, /vsphere-settings-nav/);
  assert.match(dialog, /data-vm-settings-tab/);
  assert.match(css, /\.vsphere-hardware-dialog \.vsphere-settings-nav button/);
  assert.match(css, /\.vsphere-hardware-dialog \.vsphere-settings-nav button\.active::after/);
  assert.match(css, /\.vsphere-hardware-dialog \.vsphere-field-grid/);
  assert.match(css, /\.vsphere-hardware-dialog \.vsphere-dialog-actions/);
});
