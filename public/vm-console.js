import RFB from '/novnc/core/rfb.js';

const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const name = params.get('name') || id;
const title = document.querySelector('#title');
const status = document.querySelector('#status');
const screen = document.querySelector('#screen');
const cad = document.querySelector('#cad');
const fullscreen = document.querySelector('#fullscreen');
title.textContent = `${name} · console`;

if (!/^(?:[A-Za-z][A-Za-z0-9-]{1,39}|[1-9][0-9]{1,5})$/.test(id)) {
  status.textContent = 'Invalid VM identifier';
  status.classList.add('error');
  throw new Error('Invalid VM identifier');
}

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socketUrl = `${protocol}//${location.host}/api/console/vm/${encodeURIComponent(id)}`;
let rfb = null;
let reconnectTimer = null;
let reconnectDelay = 200;
let closing = false;

function fitConsole() {
  if (!rfb) return;
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  // Once an OS is running, allow noVNC/QEMU to negotiate a display size that
  // matches the actual browser viewport instead of leaving a small centered
  // framebuffer surrounded by black space.
  rfb.resizeSession = false;
  rfb.focus();
}

const redraw = fitConsole;

function scheduleReconnect() {
  if (closing || reconnectTimer) return;
  status.textContent = 'VM console reconnecting…';
  status.classList.remove('error');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectConsole();
  }, reconnectDelay);
  reconnectDelay = Math.min(1500, Math.round(reconnectDelay * 1.6));
}

function connectConsole() {
  if (closing) return;
  try { rfb?.disconnect(); } catch {}
  rfb = new RFB(screen, socketUrl, { shared:true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.viewOnly = false;
  rfb.background = '#000';
  // Favor interactive latency over maximum compression. On a LAN this avoids
  // extra CPU work on every framebuffer update while keeping image quality
  // high enough for Windows administration.
  if ('compressionLevel' in rfb) rfb.compressionLevel = 1;
  if ('qualityLevel' in rfb) rfb.qualityLevel = 7;
  if ('showDotCursor' in rfb) rfb.showDotCursor = true;

  rfb.addEventListener('connect', () => {
    reconnectDelay = 200;
    status.textContent = 'Connected';
    status.classList.remove('error');
    fitConsole();
    setTimeout(fitConsole, 250);
    setTimeout(redraw, 500);
    setTimeout(fitConsole, 1000);
  });

  rfb.addEventListener('disconnect', () => {
    rfb = null;
    if (closing) return;
    // A VM restart tears down QEMU's VNC socket. Keep this page open and
    // reconnect to the replacement socket automatically.
    scheduleReconnect();
  });

  rfb.addEventListener('credentialsrequired', () => {
    status.textContent = 'Console authentication failed';
    status.classList.add('error');
  });
}

cad.addEventListener('click', () => rfb?.sendCtrlAltDel());
fullscreen.addEventListener('click', async () => {
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  else await document.exitFullscreen();
  setTimeout(fitConsole, 50);
});
addEventListener('resize', () => requestAnimationFrame(fitConsole));
document.addEventListener('fullscreenchange', () => setTimeout(fitConsole, 50));
addEventListener('beforeunload', () => {
  closing = true;
  clearTimeout(reconnectTimer);
  try { rfb?.disconnect(); } catch {}
});

connectConsole();
