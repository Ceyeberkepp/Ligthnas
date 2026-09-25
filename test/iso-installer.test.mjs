import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const iso = await readFile(new URL('../iso/build.sh', import.meta.url), 'utf8');

test('LightNAS ISO exposes and defaults to graphical installation', () => {
  assert.match(iso, /Install LightNAS \(Graphical\)/);
  assert.match(iso, /label\[\[:space:\]\]\+installgui/);
  assert.match(iso, /menu default/);
  assert.match(iso, /set default="Install LightNAS \(Graphical\)"/);
});

test('LightNAS ISO has a graphical fallback when LightDM does not create X display', () => {
  assert.match(iso, /lightnas-display-fallback\.service/);
  assert.match(iso, /\/usr\/bin\/xinit \/usr\/local\/bin\/lightnas-xsession/);
  assert.match(iso, /WantedBy=graphical\.target/);
});

test('LightNAS ISO is branded as LightNAS', () => {
  assert.match(iso, /LightNAS 1\.0/);
  assert.match(iso, /PRETTY_NAME="LightNAS 1\.0 \(Debian 13\)"/);
  assert.match(iso, /Name=LightNAS/);
  assert.match(iso, /plymouth-set-default-theme lightnas/);
});

test('LightNAS ISO keeps VM guest integration packages optional', () => {
  assert.match(iso, /qemu-guest-agent/);
  assert.match(iso, /open-vm-tools-desktop/);
  assert.match(iso, /virtualbox-guest-x11/);
  assert.match(iso, /Candidate:/);
});
