    import RFB from '/novnc/core/rfb.js';

    const params = new URLSearchParams(location.search);
    const id = params.get('id') || '';
    const name = params.get('name') || id;
    const title = document.querySelector('#title');
    const status = document.querySelector('#status');
    const screen = document.querySelector('#screen');
    title.textContent = `${name} · console`;

    if (!/^(?:[A-Za-z][A-Za-z0-9-]{1,39}|[1-9][0-9]{1,5})$/.test(id)) {
      status.textContent = 'Invalid VM identifier';
      status.classList.add('error');
      throw new Error('Invalid VM identifier');
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${protocol}//${location.host}/api/console/vm/${encodeURIComponent(id)}`;
    const rfb = new RFB(screen, socketUrl, { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.viewOnly = false;
    rfb.background = '#000';

    rfb.addEventListener('connect', () => {
      status.textContent = 'Connected';
      status.classList.remove('error');
    });
    rfb.addEventListener('disconnect', event => {
      status.textContent = event.detail.clean ? 'Console closed' : 'Disconnected';
      status.classList.toggle('error', !event.detail.clean);
    });
    rfb.addEventListener('credentialsrequired', () => {
      status.textContent = 'Console authentication failed';
      status.classList.add('error');
    });

    document.querySelector('#cad').addEventListener('click', () => rfb.sendCtrlAltDel());
    document.querySelector('#fullscreen').addEventListener('click', async () => {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    });
    addEventListener('beforeunload', () => rfb.disconnect());
