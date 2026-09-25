const status = document.querySelector('#status');
const terminalElement = document.querySelector('#terminal');

if (!window.Terminal || !window.FitAddon?.FitAddon) {
  status.textContent = 'Interactive terminal component unavailable';
  status.classList.add('error');
  throw new Error('Xterm did not load');
}

const terminal = new window.Terminal({
  cursorBlink: true,
  convertEol: false,
  scrollback: 20000,
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

const fit = () => { try { fitAddon.fit(); } catch {} };
requestAnimationFrame(() => { fit(); terminal.focus(); });
new ResizeObserver(fit).observe(terminalElement);
terminalElement.addEventListener('pointerdown', () => terminal.focus());

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let socket = null;
let reconnectTimer = null;
let closing = false;
let attempts = 0;

terminal.onData(data => {
  if (data && socket?.readyState === WebSocket.OPEN) socket.send(data);
});
terminal.onBinary(data => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 255;
  socket.send(bytes);
});

function reconnect() {
  if (closing || reconnectTimer) return;
  const delay = Math.min(5000, 750 + attempts * 500);
  status.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s…`;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function connect() {
  if (closing) return;
  attempts += 1;
  status.classList.remove('error');
  status.textContent = attempts === 1 ? 'Connecting…' : 'Reconnecting…';
  socket = new WebSocket(`${protocol}//${location.host}/api/console/node`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    attempts = 0;
    status.textContent = 'Connected · Bash shell';
    terminal.focus();
  });
  socket.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
    else terminal.write(String(event.data ?? ''));
  });
  socket.addEventListener('close', event => {
    socket = null;
    if (event.code === 1008 || event.code === 1003) {
      status.textContent = 'Bash shell access denied';
      status.classList.add('error');
      closing = true;
      return;
    }
    reconnect();
  });
  socket.addEventListener('error', () => {
    status.textContent = 'Connection interrupted';
    status.classList.add('error');
  });
}

window.addEventListener('beforeunload', () => {
  closing = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
});
connect();
