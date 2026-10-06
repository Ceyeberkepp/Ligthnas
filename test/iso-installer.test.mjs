import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const iso = await readFile(new URL('../iso/build.sh', import.meta.url), 'utf8');

test('LightNAS ISO exposes and defaults to graphical installation', () => {
  assert.match(iso, /Install LightNAS \(Graphical\)/);
  assert.match(iso, /label\[\[:space:\]\]\+installgui/);
  assert.match(iso, /menu default/);
  assert.match(iso, /set default="Install LightNAS \(Graphical\)"/);
});

test('LightNAS ISO boots its own kiosk instead of the Debian LightDM greeter', () => {
  assert.match(iso, /lightnas-display-console\.service/);
  assert.match(iso, /\/usr\/bin\/xinit \/usr\/local\/bin\/lightnas-xsession/);
  assert.match(iso, /systemctl mask lightdm\.service/);
  assert.match(iso, /Conflicts=display-manager\.service lightdm\.service getty@tty7\.service/);
  assert.match(iso, /WantedBy=graphical\.target/);
});



test('LightNAS installer provides graphics-independent compatibility modes', () => {
  assert.match(iso, /Install LightNAS \(VGA Safe Mode\)/);
  assert.match(iso, /Install LightNAS \(Terminal UI\)/);
  assert.match(iso, /Install LightNAS \(Serial Console\)/);
  assert.match(iso, /nomodeset vga=normal video=vesa:off/);
  assert.match(iso, /console=ttyS0,115200n8/);
  assert.match(iso, /xserver-xorg-video-vesa/);
  assert.match(iso, /xserver-xorg-video-fbdev/);
  assert.match(iso, /virtualbox-guest-x11/);
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

test('ISO build script remains valid shell after kiosk changes', async () => {
  await execute('bash', ['-n', new URL('../iso/build.sh', import.meta.url).pathname]);
});

test('LightNAS graphical console never relies on a silent Openbox autostart', () => {
  assert.match(iso, /Starting the local control center/);
  assert.match(iso, /file:\/\/\/usr\/share\/lightnas\/kiosk-start\.html/);
  assert.match(iso, /mode:'no-cors'/);
  assert.match(iso, /Launch Chromium directly/);
  assert.match(iso, /runuser -u lightnas-ui[\s\S]*\/usr\/local\/bin\/lightnas-kiosk/);
  assert.match(iso, /Restart=always/);
  assert.match(iso, /lightnas-display\.log/);
  assert.match(iso, /lightnas-openbox\.log/);
});

test('VirtualBox kiosk has a software rendering fallback instead of a black Chromium surface', () => {
  assert.match(iso, /oracle\|virtualbox/);
  assert.match(iso, /--disable-gpu/);
  assert.match(iso, /--disable-gpu-compositing/);
  assert.match(iso, /virtualbox-guest-x11/);
});
