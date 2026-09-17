const previewExtensions = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']),
  audio: new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']),
  pdf: new Set(['pdf']),
  text: new Set(['txt', 'log', 'md', 'json', 'csv', 'xml', 'yaml', 'yml', 'ini', 'conf', 'sh', 'js', 'mjs', 'css', 'html'])
};

const permissionLabels = {
  'files.read': ['Read files', 'Browse, preview and download files.'],
  'files.write': ['Write files', 'Upload, create folders and delete file entries.'],
  'media.convert': ['Convert media', 'Run FFmpeg conversions from Files.'],
  'storage.view': ['View storage', 'See attached volumes, capacity and storage inventory.'],
  'storage.manage': ['Manage storage', 'Create file spaces and manage delegated datasets.'],
  'shares.manage': ['Manage shares', 'Create and remove share configurations.'],
  'apps.manage': ['Manage apps', 'Install, start, stop and remove catalog applications.'],
  'containers.manage': ['Manage containers', 'Create and control LightNAS Docker containers.'],
  'vms.manage': ['Manage VMs', 'Create and control virtual machines.'],
  'network.view': ['View networking', 'View network interfaces, routes and firewall inventory.'],
  'system.view': ['View system health', 'View monitoring, CPU, memory and system details.']
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let number = value;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number >= 10 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function currentFolder() {
  const crumbs = [...document.querySelectorAll('#content [data-folder]')];
  return crumbs.length ? (crumbs.at(-1).dataset.folder || '') : '';
}

function joinPath(folder, name) {
  return [folder, name].filter(Boolean).join('/');
}

function ensureFolderDialog() {
  let dialog = document.querySelector('#lightnas-folder-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-folder-dialog';
  dialog.className = 'lightnas-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="dialog-body" id="lightnas-folder-form">
      <div class="dialog-head"><div><span class="eyebrow">NEW FOLDER</span><h2>Create folder</h2></div><button class="dialog-close" type="button" data-close-folder aria-label="Close">×</button></div>
      <p class="muted">Create a folder in the current LightNAS location.</p>
      <label>Folder name<input name="name" maxlength="120" required autocomplete="off" placeholder="New folder"></label>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-close-folder>Cancel</button><button class="primary" type="submit">Create folder</button></div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close-folder]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get('name')?.toString().trim();
    const error = form.querySelector('.form-error');
    error.textContent = '';
    if (!name) return;
    try {
      await apiRequest(`/api/files?path=${encodeURIComponent(joinPath(dialog.dataset.folder || '', name))}`, { method: 'POST', body: '{}' });
      dialog.close();
      form.reset();
      document.querySelector('#content [data-action="refresh-files"]')?.click();
    } catch (problem) { error.textContent = problem.message; }
  });
  return dialog;
}

function ensureViewer() {
  let dialog = document.querySelector('#lightnas-viewer');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-viewer';
  dialog.className = 'lightnas-dialog lightnas-viewer';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-head"><div><span class="eyebrow">FILE VIEWER</span><h2 data-viewer-title>Preview</h2></div><button class="dialog-close" type="button" data-close-viewer aria-label="Close">×</button></div>
      <div class="viewer-stage" data-viewer-stage></div>
      <div class="viewer-meta" data-viewer-meta></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-viewer-download>Download</button><button class="primary" type="button" data-close-viewer>Close</button></div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close-viewer]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
    delete dialog.dataset.objectUrl;
    dialog.querySelector('[data-viewer-stage]').replaceChildren();
  });
  return dialog;
}

function previewKind(name) {
  const extension = name.toLowerCase().split('.').pop();
  return Object.entries(previewExtensions).find(([, list]) => list.has(extension))?.[0] || null;
}

async function openPreview(name) {
  const kind = previewKind(name);
  if (!kind) return false;
  const path = joinPath(currentFolder(), name);
  const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to open file.');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const dialog = ensureViewer();
  if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
  dialog.dataset.objectUrl = objectUrl;
  dialog.querySelector('[data-viewer-title]').textContent = name;
  dialog.querySelector('[data-viewer-meta]').textContent = `${bytes(blob.size)} · ${kind.toUpperCase()} preview`;
  const stage = dialog.querySelector('[data-viewer-stage]');
  stage.replaceChildren();
  let viewer;
  if (kind === 'image') { viewer = document.createElement('img'); viewer.src = objectUrl; viewer.alt = name; }
  else if (kind === 'video') { viewer = document.createElement('video'); viewer.src = objectUrl; viewer.controls = true; viewer.autoplay = true; }
  else if (kind === 'audio') { viewer = document.createElement('audio'); viewer.src = objectUrl; viewer.controls = true; viewer.autoplay = true; }
  else if (kind === 'pdf') { viewer = document.createElement('iframe'); viewer.src = objectUrl; viewer.title = name; }
  else { viewer = document.createElement('pre'); viewer.textContent = await blob.text(); }
  stage.append(viewer);
  dialog.querySelector('[data-viewer-download]').onclick = () => {
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = name; anchor.click();
  };
  dialog.showModal();
  return true;
}

function ensureRuntimeDialog() {
  let dialog = document.querySelector('#lightnas-runtime-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lightnas-runtime-dialog';
  dialog.className = 'lightnas-dialog runtime-dialog';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="dialog-head"><div><span class="eyebrow">RUNTIME CONSOLE</span><h2 data-runtime-title>Container</h2></div><button class="dialog-close" type="button" data-runtime-close>×</button></div>
      <pre class="runtime-output" data-runtime-output>Ready.</pre>
      <form data-runtime-command-form>
        <label>Command<input name="command" autocomplete="off" value="id; uname -a" placeholder="Enter a shell command"></label>
        <div class="dialog-actions"><button class="secondary" type="button" data-runtime-logs>Logs</button><button class="primary" type="submit">Run command</button></div>
      </form>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-runtime-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-runtime-command-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const name = dialog.dataset.container;
    const command = new FormData(event.currentTarget).get('command')?.toString() || '';
    const output = dialog.querySelector('[data-runtime-output]');
    output.textContent = 'Running…';
    try {
      const result = await apiRequest('/api/containers', { method: 'POST', body: JSON.stringify({ name, action: 'shell', command }) });
      output.textContent = result.output || '(command completed with no output)';
    } catch (error) { output.textContent = error.message; }
  });
  dialog.querySelector('[data-runtime-logs]').addEventListener('click', async () => {
    const output = dialog.querySelector('[data-runtime-output]');
    output.textContent = 'Loading logs…';
    try {
      const result = await apiRequest('/api/containers', { method: 'POST', body: JSON.stringify({ name: dialog.dataset.container, action: 'logs' }) });
      output.textContent = result.output || '(no logs)';
    } catch (error) { output.textContent = error.message; }
  });
  return dialog;
}

async function enhanceStorage() {
  const content = document.querySelector('#content');
  if (!content || !['#storage', '#pools'].includes(location.hash) || content.querySelector('.attached-storage')) return;
  try {
    const storage = await apiRequest('/api/storage');
    const volumes = storage.attachedVolumes || [];
    if (!volumes.length) return;
    const section = document.createElement('section');
    section.className = 'attached-storage';
    section.innerHTML = `<h2>Attached NAS storage</h2><p class="muted">Storage mounted into this LightNAS appliance. Raw Proxmox host disks stay hidden from the guest.</p><div class="attached-storage-grid">${volumes.map(volume => `
      <article class="attached-storage-card">
        <div class="volume-title"><h3>${escapeHtml(volume.mountPoint)}</h3><span class="volume-state ${volume.readOnly ? 'readonly' : 'writable'}">${volume.readOnly ? 'READ ONLY' : 'WRITABLE'}</span></div>
        <p>${escapeHtml(volume.device)} · ${escapeHtml(volume.type)}</p>
        <div class="track"><span style="width:${Math.min(100, volume.usedPercent || 0)}%"></span></div>
        <p><strong>${bytes(volume.availableBytes)} free</strong> of ${bytes(volume.totalBytes)} · ${volume.usedPercent}% used</p>
        <p class="muted">${volume.readOnly ? 'LightNAS can browse this volume but the service account cannot modify it. Fix guest ownership/ACL or mount permissions to enable editing.' : 'Available for folders, uploads and file management under Files → Attached storage.'}</p>
      </article>`).join('')}</div>`;
    const hero = content.querySelector('.module-hero');
    if (hero && location.hash === '#pools') {
      hero.innerHTML = `<h2>Attached storage is ready</h2><p>LightNAS is running in a container. Use the mounted NAS volumes below. Physical pool creation belongs on bare metal or a VM with directly attached data disks.</p>`;
      hero.insertAdjacentElement('afterend', section);
    } else content.querySelector('.page-head')?.insertAdjacentElement('afterend', section);
  } catch {}
}

function portFromDocker(ports) {
  const match = String(ports || '').match(/(?:0\.0\.0\.0|\[::\]|:::|127\.0\.0\.1)?:(\d+)->/);
  return match ? Number(match[1]) : null;
}

async function enhanceRuntimeControls() {
  if (!['#containers', '#vms'].includes(location.hash)) return;
  const content = document.querySelector('#content');
  if (!content || content.dataset.runtimeEnhancing === '1') return;
  content.dataset.runtimeEnhancing = '1';
  try {
    const runtimes = await apiRequest('/api/runtimes');
    if (location.hash === '#containers') {
      for (const item of runtimes.docker?.containers || []) {
        const row = [...content.querySelectorAll('.storage-row')].find(candidate => candidate.querySelector('h3')?.textContent === item.name);
        if (!row || row.querySelector('.runtime-actions')) continue;
        const actions = document.createElement('div');
        actions.className = 'runtime-actions';
        const running = item.state === 'running';
        const webPort = portFromDocker(item.ports);
        actions.innerHTML = `${webPort ? `<button class="secondary" data-container-open="${webPort}">Open</button>` : ''}
          ${running ? `<button class="secondary" data-container-action="stop" data-container="${escapeHtml(item.name)}">Stop</button><button class="secondary" data-container-action="restart" data-container="${escapeHtml(item.name)}">Restart</button><button class="secondary" data-container-console="${escapeHtml(item.name)}">Console</button>` : `<button class="secondary" data-container-action="start" data-container="${escapeHtml(item.name)}">Start</button>`}
          <button class="secondary" data-container-logs="${escapeHtml(item.name)}">Logs</button>
          <button class="secondary danger-button" data-container-action="remove" data-container="${escapeHtml(item.name)}">Remove</button>`;
        row.append(actions);
      }
    } else {
      const vm = runtimes.virtualization || {};
      const form = content.querySelector('#vm-form');
      if (form && vm.poolDetails?.length) {
        const select = form.querySelector('select[name="pool"]');
        for (const detail of vm.poolDetails) {
          const option = [...select.options].find(item => item.value === detail.name);
          if (option) option.textContent = `${detail.name} · ${detail.type}${detail.available ? ` · ${bytes(detail.available)} free` : ''}`;
        }
      }
      if (vm.proxmoxUrl && !content.querySelector('[data-open-proxmox]')) {
        const button = document.createElement('button');
        button.className = 'secondary'; button.type = 'button'; button.dataset.openProxmox = vm.proxmoxUrl; button.textContent = 'Open Proxmox';
        content.querySelector('.page-head .head-actions')?.prepend(button);
      }
      for (const item of vm.machineDetails || []) {
        const row = [...content.querySelectorAll('.storage-row')].find(candidate => candidate.querySelector('h3')?.textContent.includes(`(${item.vmid})`));
        if (!row || row.querySelector('.runtime-actions')) continue;
        const actions = document.createElement('div');
        actions.className = 'runtime-actions';
        const running = item.status === 'running';
        actions.innerHTML = `${running ? `<button class="secondary" data-vm-action="shutdown" data-vmid="${item.vmid}">Shutdown</button><button class="secondary" data-vm-action="reboot" data-vmid="${item.vmid}">Reboot</button><button class="secondary" data-vm-action="stop" data-vmid="${item.vmid}">Stop</button>` : `<button class="secondary" data-vm-action="start" data-vmid="${item.vmid}">Start</button>`}
          <button class="secondary" data-vm-action="reset" data-vmid="${item.vmid}">Reset</button>
          ${vm.proxmoxUrl ? `<button class="secondary" data-open-proxmox="${escapeHtml(vm.proxmoxUrl)}">Console / Proxmox</button>` : ''}
          <button class="secondary danger-button" data-vm-action="delete" data-vmid="${item.vmid}">Delete</button>`;
        row.append(actions);
      }
    }
  } catch {} finally {
    delete content.dataset.runtimeEnhancing;
  }
}

function permissionsMarkup(options, selected = []) {
  return `<fieldset class="policy-grid"><legend>Permissions</legend>${options.map(permission => {
    const [label, description] = permissionLabels[permission] || [permission, permission];
    return `<label class="policy-option"><input type="checkbox" value="${escapeHtml(permission)}" ${selected.includes(permission) ? 'checked' : ''}><span><b>${escapeHtml(label)}</b><small>${escapeHtml(description)}</small></span></label>`;
  }).join('')}</fieldset>`;
}

async function enhancePolicies() {
  if (location.hash !== '#users') return;
  const content = document.querySelector('#content');
  if (!content || content.dataset.policiesLoaded === '1') return;
  try {
    const result = await apiRequest('/api/users');
    content.dataset.policiesLoaded = '1';
    const options = result.permissionOptions || Object.keys(permissionLabels);
    for (const user of result.users || []) {
      const form = content.querySelector(`form[data-manage-user="${CSS.escape(user.username)}"]`);
      if (!form || form.querySelector('.policy-grid')) continue;
      form.insertAdjacentHTML('beforeend', `${permissionsMarkup(options, user.permissions || [])}<button class="primary save-policy" type="button" data-save-policy="${escapeHtml(user.username)}">Save permissions</button>`);
    }
    const create = content.querySelector('#user-form');
    if (create && !create.querySelector('.policy-grid')) create.querySelector('button[type="submit"]')?.insertAdjacentHTML('beforebegin', permissionsMarkup(options, ['files.read', 'files.write']));
  } catch {}
}

function enhanceAdminCenter() {
  if (location.hash !== '#admin') return;
  const content = document.querySelector('#content');
  if (!content || content.querySelector('.admin-tool-groups')) return;
  const groups = [
    ['Access & security', [['users','Users & policies'],['settings','Appliance settings'],['capabilities','Capabilities']]],
    ['Storage & data', [['storage','Storage'],['pools','Pools & datasets'],['files','File manager'],['shares','Shares']]],
    ['Compute & apps', [['apps','App Store'],['containers','Containers'],['vms','Virtual machines']]],
    ['Network & services', [['network','Networking'],['firewall','Firewall'],['integrations','Integrations'],['smtp','Email / SMTP']]],
    ['System operations', [['monitoring','Monitoring'],['home','Overview']]]
  ];
  const section = document.createElement('section');
  section.className = 'admin-tool-groups';
  section.innerHTML = groups.map(([title, tools]) => `<div class="admin-group"><h2>${title}</h2><div class="admin-group-grid">${tools.map(([view,label]) => `<button class="admin-tool-card" type="button" data-admin-view="${view}"><b>${label}</b><span>Open ${label.toLowerCase()}</span></button>`).join('')}</div></div>`).join('');
  content.querySelector('.page-head')?.insertAdjacentElement('afterend', section);
}

function scheduleEnhancements() {
  clearTimeout(scheduleEnhancements.timer);
  scheduleEnhancements.timer = setTimeout(() => {
    enhanceStorage();
    enhanceRuntimeControls();
    enhancePolicies();
    enhanceAdminCenter();
  }, 100);
}

const observer = new MutationObserver(scheduleEnhancements);
observer.observe(document.body, { subtree: true, childList: true });
window.addEventListener('hashchange', scheduleEnhancements);
window.addEventListener('load', scheduleEnhancements);

document.addEventListener('submit', async event => {
  if (event.target.id !== 'user-form' || !event.target.querySelector('.policy-grid')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const form = event.target;
  const error = form.querySelector('.form-error');
  error.textContent = '';
  const data = new FormData(form);
  const permissions = [...form.querySelectorAll('.policy-grid input:checked')].map(input => input.value);
  try {
    await apiRequest('/api/users', { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password'), permissions }) });
    location.reload();
  } catch (problem) { error.textContent = problem.message; }
}, true);

document.addEventListener('click', async event => {
  const folderButton = event.target.closest('#content [data-action="new-folder"]');
  if (folderButton) {
    event.preventDefault(); event.stopImmediatePropagation();
    const dialog = ensureFolderDialog();
    dialog.dataset.folder = currentFolder();
    dialog.querySelector('form').reset();
    dialog.querySelector('.form-error').textContent = '';
    dialog.showModal();
    setTimeout(() => dialog.querySelector('input[name="name"]')?.focus(), 0);
    return;
  }

  const fileButton = event.target.closest('#content .file-name[data-directory="false"]');
  if (fileButton && previewKind(fileButton.dataset.open || '')) {
    event.preventDefault(); event.stopImmediatePropagation();
    try { await openPreview(fileButton.dataset.open); }
    catch (problem) { alert(problem.message); }
    return;
  }

  const createPool = event.target.closest('#content [data-action="create-pool"]');
  if (createPool && document.querySelector('#content .attached-storage')) {
    event.preventDefault(); event.stopImmediatePropagation();
    alert('This LightNAS instance is running in an LXC. Its mounted storage is already attached and ready to use. Raw Proxmox host disks are intentionally not exposed for pool creation.');
    return;
  }

  const openPort = event.target.closest('[data-container-open]');
  if (openPort) { window.open(`${location.protocol}//${location.hostname}:${openPort.dataset.containerOpen}`, '_blank', 'noopener'); return; }

  const consoleButton = event.target.closest('[data-container-console]');
  if (consoleButton) {
    const dialog = ensureRuntimeDialog();
    dialog.dataset.container = consoleButton.dataset.containerConsole;
    dialog.querySelector('[data-runtime-title]').textContent = consoleButton.dataset.containerConsole;
    dialog.querySelector('[data-runtime-output]').textContent = 'Ready. Run a command or view logs.';
    dialog.showModal();
    return;
  }
  const logsButton = event.target.closest('[data-container-logs]');
  if (logsButton) {
    const dialog = ensureRuntimeDialog();
    dialog.dataset.container = logsButton.dataset.containerLogs;
    dialog.querySelector('[data-runtime-title]').textContent = `${logsButton.dataset.containerLogs} logs`;
    dialog.showModal();
    dialog.querySelector('[data-runtime-logs]').click();
    return;
  }
  const containerAction = event.target.closest('[data-container-action]');
  if (containerAction) {
    const action = containerAction.dataset.containerAction;
    const name = containerAction.dataset.container;
    if (action === 'remove' && !confirm(`Remove ${name}? This deletes the container.`)) return;
    containerAction.disabled = true;
    try {
      await apiRequest('/api/containers', { method: 'POST', body: JSON.stringify({ name, action }) });
      document.querySelector('#content [data-action="refresh-runtime"]')?.click();
    } catch (error) { alert(error.message); }
    finally { containerAction.disabled = false; }
    return;
  }

  const vmAction = event.target.closest('[data-vm-action]');
  if (vmAction) {
    const action = vmAction.dataset.vmAction;
    const vmid = Number(vmAction.dataset.vmid);
    if (action === 'delete' && !confirm(`Delete VM ${vmid} and its disks? This cannot be undone.`)) return;
    vmAction.disabled = true;
    try {
      await apiRequest('/api/vms', { method: 'POST', body: JSON.stringify({ vmid, action }) });
      document.querySelector('#content [data-action="refresh-runtime"]')?.click();
    } catch (error) { alert(error.message); }
    finally { vmAction.disabled = false; }
    return;
  }

  const proxmox = event.target.closest('[data-open-proxmox]');
  if (proxmox) { window.open(proxmox.dataset.openProxmox, '_blank', 'noopener'); return; }

  const policy = event.target.closest('[data-save-policy]');
  if (policy) {
    const form = policy.closest('form');
    const password = form.querySelector('input[name="currentPassword"]')?.value || '';
    const permissions = [...form.querySelectorAll('.policy-grid input:checked')].map(input => input.value);
    policy.disabled = true;
    try {
      await apiRequest(`/api/users/${encodeURIComponent(policy.dataset.savePolicy)}`, { method: 'PATCH', body: JSON.stringify({ currentPassword: password, permissions }) });
      policy.textContent = 'Saved';
      setTimeout(() => { policy.textContent = 'Save permissions'; policy.disabled = false; }, 1200);
    } catch (error) { alert(error.message); policy.disabled = false; }
    return;
  }

  const adminTool = event.target.closest('[data-admin-view]');
  if (adminTool) { location.hash = adminTool.dataset.adminView; }
}, true);
