    const params = new URLSearchParams(location.search);
    const id = params.get('id') || '';
    const name = params.get('name') || id;
    const title = document.querySelector('#title');
    const status = document.querySelector('#status');
    const terminal = document.querySelector('#terminal');
    const input = document.querySelector('#command');
    const form = document.querySelector('#command-form');
    const submit = form.querySelector('button');
    title.textContent = `${name || id} · root terminal`;

    if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(id)) {
      status.textContent = 'Invalid container name';
      status.classList.add('error');
      throw new Error('Invalid container name');
    }

    let terminalControlState = 'text';
    let csiParameters = '';

    function normalizeTerminalChunk(value) {
      const visible = [];
      let clear = false;

      // Parse terminal control sequences as a stream because WebSocket frames
      // can split an OSC/CSI sequence at any byte. Regex-only cleanup leaks
      // fragments such as "?2004h" and systemd "3008;start=..." records.
      for (const character of String(value ?? '')) {
        if (terminalControlState === 'text') {
          if (character === '\x1b') terminalControlState = 'escape';
          else if (character === '\u009b') { terminalControlState = 'csi'; csiParameters = ''; }
          else if (character === '\u009d') terminalControlState = 'osc';
          else if (character !== '\u009c') visible.push(character);
          continue;
        }

        if (terminalControlState === 'escape') {
          if (character === '[') { terminalControlState = 'csi'; csiParameters = ''; }
          else if (character === ']' || character === 'P' || character === 'X' || character === '^' || character === '_') terminalControlState = 'osc';
          else terminalControlState = 'text';
          continue;
        }

        if (terminalControlState === 'csi') {
          if (character >= '@' && character <= '~') {
            if (character === 'J' && /(?:^|;)[23](?:;|$)/.test(csiParameters)) clear = true;
            terminalControlState = 'text';
            csiParameters = '';
          } else {
            csiParameters += character;
          }
          continue;
        }

        if (terminalControlState === 'osc') {
          if (character === '\x07' || character === '\u009c') terminalControlState = 'text';
          else if (character === '\x1b') terminalControlState = 'osc-escape';
          continue;
        }

        if (terminalControlState === 'osc-escape') {
          terminalControlState = character === '\\' ? 'text' : 'osc';
        }
      }

      return { text: visible.join(''), clear };
    }

    const append = value => {
      const chunk = normalizeTerminalChunk(value);
      let output = chunk.clear ? '' : terminal.textContent;
      for (let index = 0; index < chunk.text.length; index += 1) {
        const character = chunk.text[index];
        if (character === '\b') output = output.slice(0, -1);
        else if (character === '\r') {
          // CRLF is represented by the following LF. A bare CR means return
          // to the current line and does not need a visible glyph.
        } else if (character === '\n' || character === '\t' || character >= ' ') {
          output += character;
        }
      }
      terminal.textContent = output;
      terminal.scrollTop = terminal.scrollHeight;
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

    const terminalKeys = {
      Enter: '\r',
      Backspace: '\x7f',
      Tab: '\t',
      Escape: '\x1b',
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowRight: '\x1b[C',
      ArrowLeft: '\x1b[D',
      Home: '\x1b[H',
      End: '\x1b[F',
      Delete: '\x1b[3~',
      Insert: '\x1b[2~',
      PageUp: '\x1b[5~',
      PageDown: '\x1b[6~'
    };

    terminal.addEventListener('pointerdown', () => terminal.focus());
    terminal.addEventListener('keydown', event => {
      if (!socketOpen || ws.readyState !== WebSocket.OPEN || event.isComposing) return;
      // Keep the browser's normal copy shortcut. Ctrl+C without Shift sends
      // SIGINT to the process, matching a native Linux console.
      if ((event.ctrlKey || event.metaKey) && event.shiftKey) return;

      let data = terminalKeys[event.key] || '';
      if (event.ctrlKey && !event.altKey && !event.metaKey) {
        const key = event.key.toUpperCase();
        if (/^[A-Z]$/.test(key)) data = String.fromCharCode(key.charCodeAt(0) - 64);
        else if (event.key === '[') data = '\x1b';
        else if (event.key === '\\') data = '\x1c';
        else if (event.key === ']') data = '\x1d';
      } else if (!data && event.key.length === 1 && !event.metaKey) {
        data = `${event.altKey ? '\x1b' : ''}${event.key}`;
      }

      if (!data) return;
      event.preventDefault();
      sendTerminalInput(data);
    });
    terminal.addEventListener('paste', event => {
      if (!socketOpen || ws.readyState !== WebSocket.OPEN) return;
      const text = event.clipboardData?.getData('text');
      if (!text) return;
      event.preventDefault();
      sendTerminalInput(text.replace(/\r?\n/g, '\r'));
    });

    function enableCommandMode(reason = '') {
      if (commandMode) return;
      commandMode = true;
      terminal.classList.remove('interactive');
      form.hidden = false;
      status.textContent = 'Fallback command mode';
      status.classList.remove('error');
      append(`LightNAS command mode is ready for ${name} as root.\n`);
      if (reason) append(`${reason}\n`);
      append('Live terminal streaming is unavailable through this connection, but commands will still run normally.\n\n');
      input.focus();
    }

    const connectionTimer = setTimeout(() => {
      if (!socketOpen) {
        websocketFailed = true;
        enableCommandMode('The proxy did not complete the live WebSocket connection.');
      }
    }, 6000);

    ws.addEventListener('open', () => {
      clearTimeout(connectionTimer);
      if (websocketFailed || commandMode) {
        ws.close();
        return;
      }
      socketOpen = true;
      form.hidden = true;
      terminal.classList.add('interactive');
      status.textContent = 'Connected · click terminal and type';
      append(`Connected to ${name} as root\n`);
      terminal.focus();
    });
    ws.addEventListener('message', event => {
      const text = typeof event.data === 'string' ? event.data : decoder.decode(event.data, { stream: true });
      append(text);
    });
    ws.addEventListener('close', event => {
      clearTimeout(connectionTimer);
      socketOpen = false;
      terminal.classList.remove('interactive');
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
      append(`root@${name}:~# ${command}\n`);
      try {
        const response = await fetch(`/api/containers/${encodeURIComponent(id)}/exec`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1' },
          body: JSON.stringify({ command })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Command failed (HTTP ${response.status}).`);
        if (payload.output) append(payload.output.endsWith('\n') ? payload.output : `${payload.output}\n`);
        if (payload.truncated) append('[output truncated by LightNAS]\n');
        if (payload.exitCode) append(`[command exited with code ${payload.exitCode}]\n`);
      } catch (error) {
        append(`[command error: ${error.message}]\n`);
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
        // A terminal Enter key is carriage return; the PTY line discipline converts it to newline.
        ws.send(`${command}\r`);
        return;
      }
      enableCommandMode();
      await runCommand(command);
    });
