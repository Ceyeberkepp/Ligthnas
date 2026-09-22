const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const name = params.get('name') || id;
const title = document.querySelector('#title');
const status = document.querySelector('#status');
const terminalElement = document.querySelector('#terminal');
title.textContent = `${name || id} · root terminal`;

if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(id)) {
  status.textContent = 'Invalid container name';
  status.classList.add('error');
  throw new Error('Invalid container name');
}
if (!window.Terminal || !window.FitAddon?.FitAddon) {
  status.textContent = 'Interactive terminal component unavailable';
  status.classList.add('error');
  throw new Error('Xterm did not load');
}

const terminal = new window.Terminal({
  cursorBlink: true,
  convertEol: false,
  scrollback: 10000,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 14,
  lineHeight: 1.15,
  theme: {
    background: '#020608', foreground: '#baf7dc', cursor: '#e8fff7',
    cursorAccent: '#020608', selectionBackground: '#176f6280',
    black: '#071019', brightBlack: '#526773'
  }
});
const fitAddon = new window.FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);

const fit = () => {
  try { fitAddon.fit(); } catch {}
};
requestAnimationFrame(() => { fit(); terminal.focus(); });
new ResizeObserver(fit).observe(terminalElement);
terminalElement.addEventListener('pointerdown', () => terminal.focus());

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let socket = null;
let reconnectTimer = null;
let closing = false;
let attempts = 0;

function sendTerminalInput(data) {
  if (!data || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(data);
}
terminal.onData(sendTerminalInput);
terminal.onBinary(data => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 255;
  socket.send(bytes);
});

function scheduleReconnect() {
  if (closing || reconnectTimer) return;
  const delay = Math.min(5000, 750 + attempts * 500);
  status.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s…`;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (closing) return;
  attempts += 1;
  status.classList.remove('error');
  status.textContent = attempts === 1 ? 'Connecting…' : 'Reconnecting…';
  socket = new WebSocket(`${protocol}//${location.host}/api/console/container/${encodeURIComponent(id)}`);
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    attempts = 0;
    status.textContent = 'Connected · interactive terminal';
    terminal.focus();
  });
  socket.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
    else terminal.write(String(event.data ?? ''));
  });
  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    status.textContent = 'Connection interrupted · reconnecting';
    status.classList.add('error');
  });
}

window.addEventListener('beforeunload', () => {
  closing = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
});
connect();
