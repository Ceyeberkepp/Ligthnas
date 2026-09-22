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

    let ansiCarry = '';

    function normalizeTerminalChunk(value) {
      let text = ansiCarry + String(value ?? '');
      ansiCarry = '';

      // Keep an incomplete escape sequence for the next WebSocket frame.
      const partial = text.match(/\x1b(?:\[[0-9;?]*[ -\/]*)?$/);
      if (partial) {
        ansiCarry = partial[0];
        text = text.slice(0, -partial[0].length);
      }

      // A terminal clear should discard everything before the final clear code.
      let clear = false;
      let clearEnd = -1;
      for (const match of text.matchAll(/\x1b\[(?:2|3)J/g)) {
        clear = true;
        clearEnd = match.index + match[0].length;
      }
      if (clearEnd >= 0) text = text.slice(clearEnd);

      // Remove color, cursor, title, mode and other ANSI/VT control sequences.
      text = text
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[()][0-2A-Z]/g, '')
        .replace(/\x1bc/g, '');

      return { text, clear };
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
    const ws = new WebSocket(`${protocol}//${location.host}/api/console/container/${encodeURIComponent(id)}`);
    ws.binaryType = 'arraybuffer';

    function enableCommandMode(reason = '') {
      if (commandMode) return;
      commandMode = true;
      status.textContent = 'Command mode';
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
      status.textContent = 'Connected';
      append(`Connected to ${name} as root\n`);
      input.focus();
    });
    ws.addEventListener('message', event => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      append(text);
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
