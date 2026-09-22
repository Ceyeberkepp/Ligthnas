const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const name = params.get('name') || id;
const title = document.querySelector('#title');
const status = document.querySelector('#status');
const terminalElement = document.querySelector('#terminal');
const input = document.querySelector('#command');
const form = document.querySelector('#command-form');
const submit = form.querySelector('button');
title.textContent = `${name || id} · root terminal`;

if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(id)) {
  status.textContent = 'Invalid container name';
  status.classList.add('error');
  throw new Error('Invalid container name');
}

let terminal = null;
let fitAddon = null;
if (window.Terminal && window.FitAddon?.FitAddon) {
  terminal = new window.Terminal({
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.15,
    theme: {
      background: '#020608',
      foreground: '#baf7dc',
      cursor: '#e8fff7',
      cursorAccent: '#020608',
      selectionBackground: '#176f6280',
      black: '#071019',
      brightBlack: '#526773'
    }
  });
  fitAddon = new window.FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalElement);
  requestAnimationFrame(() => {
    fitAddon.fit();
    terminal.focus();
  });
  new ResizeObserver(() => {
    try { fitAddon.fit(); } catch {}
  }).observe(terminalElement);
}

const write = value => {
  const text = String(value ?? '');
  if (terminal) terminal.write(text);
  else terminalElement.textContent += text.replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '');
};

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let socketOpen = false;
let commandMode = false;
let websocketFailed = false;
const decoder = new TextDecoder();
const ws = new WebSocket(`${protocol}//${location.host}/api/console/container/${encodeURIComponent(id)}`);
ws.binaryType = 'arraybuffer';

function sendTerminalInput(data) {
  if (!socketOpen || ws.readyState !== WebSocket.OPEN || !data) return false;
  ws.send(data);
  return true;
}

terminal?.onData(data => sendTerminalInput(data));
terminal?.onBinary(data => {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 255;
  if (socketOpen && ws.readyState === WebSocket.OPEN) ws.send(bytes);
});
terminalElement.addEventListener('pointerdown', () => terminal?.focus());

function enableCommandMode(reason = '') {
  if (commandMode) return;
  commandMode = true;
  form.hidden = false;
  status.textContent = 'Fallback command mode';
  status.classList.remove('error');
  write(`\r\nLightNAS command mode is ready for ${name} as root.\r\n`);
  if (reason) write(`${reason}\r\n`);
  write('Live terminal streaming is unavailable through this connection, but commands will still run normally.\r\n\r\n');
  input.focus();
}

if (!terminal) {
  websocketFailed = true;
  enableCommandMode('The interactive terminal component did not load.');
}

const connectionTimer = setTimeout(() => {
  if (!socketOpen) {
    websocketFailed = true;
    enableCommandMode('The proxy did not complete the live WebSocket connection.');
  }
}, 6000);

ws.addEventListener('open', () => {
  clearTimeout(connectionTimer);
  if (websocketFailed || commandMode || !terminal) {
    ws.close();
    return;
  }
  socketOpen = true;
  form.hidden = true;
  status.textContent = 'Connected · interactive terminal';
  write(`Connected to ${name} as root\r\n`);
  terminal.focus();
});

ws.addEventListener('message', event => {
  if (event.data instanceof ArrayBuffer) terminal?.write(new Uint8Array(event.data));
  else write(event.data);
});

ws.addEventListener('close', event => {
  clearTimeout(connectionTimer);
  socketOpen = false;
  if (!commandMode) enableCommandMode(`Live terminal closed: ${event.reason || event.code}.`);
});

ws.addEventListener('error', () => {
  clearTimeout(connectionTimer);
  websocketFailed = true;
  enableCommandMode('The live terminal connection could not be established.');
});

async function runCommand(command) {
  submit.disabled = true;
  input.disabled = true;
  write(`root@${name}:~# ${command}\r\n`);
  try {
    const response = await fetch(`/api/containers/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1' },
      body: JSON.stringify({ command })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Command failed (HTTP ${response.status}).`);
    if (payload.output) write(payload.output.replace(/\r?\n/g, '\r\n'));
    if (payload.truncated) write('\r\n[output truncated by LightNAS]\r\n');
    if (payload.exitCode) write(`\r\n[command exited with code ${payload.exitCode}]\r\n`);
  } catch (error) {
    write(`\r\n[command error: ${error.message}]\r\n`);
    status.textContent = 'Command failed';
    status.classList.add('error');
  } finally {
    submit.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const command = input.value.trim();
  if (!command) return;
  input.value = '';
  if (socketOpen && ws.readyState === WebSocket.OPEN) {
    ws.send(`${command}\r`);
    return;
  }
  enableCommandMode();
  await runCommand(command);
});
