const dialogApi = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-LightNAS-Request': '1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
};

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function showEditor({ eyebrow, title, description, fields, submitLabel = 'Save changes', danger = false, wide = false, onSubmit }) {
  const vmHardwareEditor = wide && eyebrow === 'VIRTUAL MACHINE SETTINGS';
  const dialog = document.createElement('dialog');
  dialog.className = `lightnas-dialog${wide ? ' runtime-dialog hardware-editor-dialog' : ''}${vmHardwareEditor ? ' vsphere-hardware-dialog' : ''}`;

  const vmGroups = [
    ['summary','Summary',['name','firmwareInfo','machineInfo','startOnBoot']],
    ['cpu','CPU',['cpus']],
    ['memory','Memory',['memoryMiB']],
    ['disks','Hard disks',['diskSizeGiB','existingDisks','addDiskPool','addDiskGiB','diskBus','scsiController']],
    ['network','Network adapters',['networkModel','existingNics','addNicNetwork','addNicModel']],
    ['media','CD/DVD drive',['iso','bootOrder']],
    ['video','Video card',['displayModel']],
    ['pci','PCI devices',['existingHostDevices','addPciDevice']]
  ];
  const groupFor = name => vmGroups.find(([, , names]) => names.includes(name))?.[0] || 'summary';

  dialog.innerHTML = vmHardwareEditor ? `
    <form class="dialog-body vsphere-settings-form">
      <div class="dialog-head vsphere-dialog-head">
        <div><span class="eyebrow">${eyebrow}</span><h2></h2><p class="muted" data-dialog-description></p></div>
        <button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="vsphere-settings-layout">
        <nav class="vsphere-settings-nav" aria-label="Virtual machine settings">
          ${vmGroups.map(([key,label],index)=>`<button type="button" class="vm-settings-tab ${index ? '' : 'active'}" data-vm-settings-tab="${key}">${label}</button>`).join('')}
        </nav>
        <div class="vsphere-settings-content" data-dialog-fields></div>
      </div>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions vsphere-dialog-actions">
        <button class="secondary" type="button" data-editor-revert>Revert</button>
        <span class="vsphere-action-spacer"></span>
        <button class="secondary" type="button" data-dialog-close>Cancel</button>
        <button class="${danger ? 'secondary danger-button' : 'primary'}" type="submit">${submitLabel}</button>
      </div>
    </form>` : `
    <form class="dialog-body">
      <div class="dialog-head">
        <div><span class="eyebrow">${eyebrow}</span><h2></h2></div>
        <button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <p class="muted" data-dialog-description></p>
      <div data-dialog-fields></div>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary" type="button" data-editor-revert>Revert changes</button>
        <button class="secondary" type="button" data-dialog-close>Cancel</button>
        <button class="${danger ? 'secondary danger-button' : 'primary'}" type="submit">${submitLabel}</button>
      </div>
    </form>`;

  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('[data-dialog-description]').textContent = description;
  const fieldRoot = dialog.querySelector('[data-dialog-fields]');

  if (vmHardwareEditor) {
    for (const [key,label] of vmGroups) {
      const section = document.createElement('section');
      section.className = 'vsphere-settings-panel';
      section.dataset.vmSettingsPanel = key;
      section.hidden = key !== 'summary';
      section.innerHTML = `<div class="vsphere-panel-title"><div><h3>${label}</h3><p class="muted">${({
        summary:'Virtual machine identity and startup behavior.',
        cpu:'Configure virtual processor resources.',
        memory:'Configure guest memory.',
        disks:'Review and change virtual disk and storage controller settings.',
        network:'Review the primary adapter and add another virtual NIC.',
        media:'Mount installation media and configure the first boot device.',
        video:'Select the virtual display adapter.',
        pci:'Review or add PCI / GPU passthrough hardware.'
      })[key]}</p></div></div><div class="vsphere-field-grid" data-vm-field-group="${key}"></div>`;
      fieldRoot.append(section);
    }
  }

  for (const field of fields) {
    const label = document.createElement('label');
    label.className = vmHardwareEditor ? 'vsphere-field' : '';
    const labelText = document.createElement('span');
    labelText.className = vmHardwareEditor ? 'vsphere-field-label' : '';
    labelText.textContent = field.label;
    label.append(labelText);

    const input = document.createElement(field.type === 'select' ? 'select' : 'input');
    input.name = field.name;
    if (field.type && field.type !== 'select') input.type = field.type;
    if (field.value !== undefined) input.value = field.value;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    if (field.required) input.required = true;
    if (field.readonly) {
      if (input.tagName === 'SELECT') input.disabled = true;
      else input.readOnly = true;
    }
    if (field.autocomplete) input.autocomplete = field.autocomplete;
    if (field.options) {
      for (const optionValue of field.options) {
        const option = document.createElement('option');
        option.value = typeof optionValue === 'string' ? optionValue : optionValue.value;
        option.textContent = typeof optionValue === 'string' ? optionValue : optionValue.label;
        input.append(option);
      }
      if (field.value !== undefined) input.value = field.value;
    }
    label.append(input);
    if (vmHardwareEditor) {
      dialog.querySelector(`[data-vm-field-group="${groupFor(field.name)}"]`)?.append(label);
    } else fieldRoot.append(label);
  }

  if (vmHardwareEditor) {
    const showPanel = key => {
      dialog.querySelectorAll('[data-vm-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.vmSettingsTab === key));
      dialog.querySelectorAll('[data-vm-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.vmSettingsPanel !== key; });
    };
    dialog.querySelectorAll('[data-vm-settings-tab]').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.vmSettingsTab)));
  }

  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => closeDialog(dialog)));
  dialog.querySelector('[data-editor-revert]')?.addEventListener('click', () => {
    dialog.querySelector('form')?.reset();
    window.LightNASToast?.show?.('Unsaved changes reverted.');
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.form-error');
    const submit = form.querySelector('button[type="submit"]');
    error.textContent = '';
    submit.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      dialog.close();
    } catch (problem) {
      error.textContent = problem.message;
      submit.disabled = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  setTimeout(() => dialog.querySelector('input:not([readonly]),select:not([disabled])')?.focus(), 0);
  return dialog;
}

function refreshRuntime() {
  document.querySelector('#content [data-action="refresh-runtime"]')?.click();
}

function refreshStorage() {
  document.querySelector('#content .unified-storage')?.remove();
  document.querySelector('[data-refresh-inventory]')?.click();
  if (!document.querySelector('[data-refresh-inventory]')) location.reload();
}


function dialogEsc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

const lightnasTasks = (() => {
  let items = [];
  const cancelHandlers = new Map();
  try { items = JSON.parse(localStorage.getItem('lightnas-tasks') || sessionStorage.getItem('lightnas-tasks') || '[]'); } catch {}
  if (!Array.isArray(items)) items = [];
  items = items.slice(-80).map(item => item?.status === 'running'
    ? { ...item, status:'canceled', detail:item.detail ? `${item.detail} · interrupted by page reload` : 'Interrupted by page reload' }
    : item);

  const save = () => {
    try { const saved = JSON.stringify(items.slice(-80)); localStorage.setItem('lightnas-tasks', saved); sessionStorage.setItem('lightnas-tasks', saved); } catch {}
  };
  const statusLabel = item => item.status === 'success' ? 'OK'
    : item.status === 'error' ? 'Error'
    : item.status === 'canceled' ? 'Canceled'
    : Number.isFinite(item.percent) ? item.percent + '%' : 'Running';
  const render = () => {
    const dock = document.getElementById('task-dock');
    const list = document.getElementById('task-dock-list');
    const count = document.getElementById('task-dock-count');
    const summary = document.getElementById('task-dock-summary');
    const cancelAllButton = document.getElementById('task-cancel-all');
    const clearAllButton = document.getElementById('task-clear-all');
    if (!dock || !list || !count || !summary) return;
    const active = items.filter(item => item.status === 'running').length;
    count.textContent = String(active);
    count.classList.toggle('active', active > 0);
    summary.textContent = active ? `${active} active task${active === 1 ? '' : 's'}` : (items.length ? 'Recent tasks complete' : 'No active tasks');
    if (cancelAllButton) cancelAllButton.disabled = active === 0;
    if (clearAllButton) clearAllButton.disabled = items.length === 0;
    list.innerHTML = items.length ? [...items].reverse().map(item => `
      <article class="task-row" data-task-id="${dialogEsc(item.id)}">
        <time>${dialogEsc(item.time || '')}</time>
        <div><b>${dialogEsc(item.title)}</b><small>${dialogEsc(item.detail || '')}</small>${item.status === 'running' ? `<div class="task-mini-progress"><span style="width:${Math.max(2, Number(item.percent) || 2)}%"></span></div>` : ''}</div>
        <span class="task-status ${item.status}">${statusLabel(item)}</span>
        <div class="task-row-actions">${item.status === 'running' ? `<button class="secondary" type="button" data-task-cancel="${dialogEsc(item.id)}">Cancel</button>` : ''}<button class="secondary" type="button" data-task-clear="${dialogEsc(item.id)}">Clear</button></div>
      </article>`).join('') : '<div class="task-empty">Uploads, installs, VM/container jobs, and transfers will appear here.</div>';
  };
  const cancel = id => {
    const task = items.find(item => item.id === id);
    if (!task || task.status !== 'running') return;
    try { cancelHandlers.get(id)?.(); } catch {}
    cancelHandlers.delete(id);
    task.status = 'canceled';
    task.detail = task.detail ? `${task.detail} · canceled` : 'Canceled';
    save(); render();
  };
  const clear = id => {
    cancelHandlers.delete(id);
    items = items.filter(item => item.id !== id);
    save(); render();
  };
  const cancelAll = () => {
    for (const item of items.filter(item => item.status === 'running')) cancel(item.id);
  };
  const clearAll = () => {
    cancelHandlers.clear();
    items = [];
    save(); render();
  };
  const create = (title, detail, options = {}) => {
    const task = { id: crypto.randomUUID?.() || String(Date.now() + Math.random()), title, detail, time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }), status:'running', percent:null };
    items.push(task);
    if (typeof options.cancel === 'function') cancelHandlers.set(task.id, options.cancel);
    save(); render();
    return {
      id: task.id,
      update(percent, message) { if (task.status !== 'running') return; task.percent = Math.max(0, Math.min(100, Number(percent) || 0)); if (message) task.detail = message; save(); render(); },
      success(message) { if (task.status !== 'running') return; cancelHandlers.delete(task.id); task.status='success'; task.percent=100; if (message) task.detail=message; save(); render(); },
      error(message) { if (task.status !== 'running') return; cancelHandlers.delete(task.id); task.status='error'; if (message) task.detail=message; save(); render(); },
      cancel() { cancel(task.id); }
    };
  };
  addEventListener('DOMContentLoaded', () => {
    const dock = document.getElementById('task-dock');
    const toggle = document.getElementById('task-dock-toggle');
    if (dock && toggle) {
      const collapsed = localStorage.getItem('lightnas-task-dock-collapsed') !== '0';
      dock.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.addEventListener('click', () => {
        const next = !dock.classList.contains('collapsed');
        dock.classList.toggle('collapsed', next);
        toggle.setAttribute('aria-expanded', next ? 'false' : 'true');
        localStorage.setItem('lightnas-task-dock-collapsed', next ? '1' : '0');
      });
    }
    document.getElementById('task-cancel-all')?.addEventListener('click', cancelAll);
    document.getElementById('task-clear-all')?.addEventListener('click', clearAll);
    document.getElementById('task-dock-list')?.addEventListener('click', event => {
      const cancelButton = event.target.closest('[data-task-cancel]');
      const clearButton = event.target.closest('[data-task-clear]');
      if (cancelButton) cancel(cancelButton.dataset.taskCancel);
      if (clearButton) clear(clearButton.dataset.taskClear);
    });
    save();
    render();
  });
  return { create, render, cancel, clear, cancelAll, clearAll };
})();

window.LightNASTasks = lightnasTasks;

// Capture user-triggered API mutations even when a feature did not explicitly
// create a progress task. This keeps the bottom Tasks dock consistent across
// storage, networking, VM/container, backup and administration operations.
const lightnasOriginalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input?.url || '');
  const method = String(init.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
  const sameApi = url.startsWith('/api/') || url.startsWith(location.origin + '/api/');
  let action = '';
  try { if (typeof init.body === 'string' && init.body.startsWith('{')) action = String(JSON.parse(init.body)?.action || ''); } catch {}
  const headers = new Headers(init.headers || {});
  const managedTask = headers.get('X-LightNAS-Task-Managed') === '1';
  const background = managedTask || action === 'auto-publish' || /\/api\/(?:overview|storage\/scan|login\/options|console)\b/.test(url);
  const mutation = sameApi && ['POST','PATCH','PUT','DELETE'].includes(method) && !background;
  const labelPath = url.replace(location.origin,'').split('?')[0];
  const task = mutation ? lightnasTasks.create(action ? `${action} · ${labelPath}` : `${method} ${labelPath}`, 'Request submitted') : null;
  try {
    const response = await lightnasOriginalFetch(input, init);
    if (task) response.ok ? task.success(`Completed · HTTP ${response.status}`) : task.error(`Failed · HTTP ${response.status}`);
    return response;
  } catch (error) {
    task?.error(error?.message || 'Request failed');
    throw error;
  }
};

function openProgressDialog(title, detail, options = {}) {
  const task = lightnasTasks.create(title, detail || 'Starting…', { cancel: options.cancel });
  if (options.modal === false || options.taskOnly === true) {
    return {
      update(percent, message = '') {
        task.update(Math.max(0, Math.min(100, Number(percent) || 0)), message);
      },
      succeed(message = 'The operation completed successfully.') { task.success(message); },
      fail(message = 'The operation could not be completed.') { task.error(message); },
      close() {}
    };
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog transfer-dialog';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="transfer-state is-running" data-transfer-state>
        <div class="transfer-spinner" aria-hidden="true"></div>
        <div class="transfer-result-icon" aria-hidden="true">✓</div>
        <span class="eyebrow">TASK IN PROGRESS</span>
        <h2 data-transfer-title></h2>
        <p class="muted" data-transfer-detail></p>
        <div class="transfer-progress" aria-label="Task in progress"><span></span></div>
        <p class="transfer-elapsed" data-transfer-elapsed>Starting…</p>
        <div class="form-error" data-transfer-error role="alert"></div>
        <div class="dialog-actions"><button class="primary hidden" type="button" data-transfer-ok>OK</button></div>
      </div>
    </div>`;
  dialog.querySelector('[data-transfer-title]').textContent = title;
  dialog.querySelector('[data-transfer-detail]').textContent = detail || 'Working in the background.';
  const started = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.max(1, Math.floor((Date.now() - started) / 1000));
    const elapsed = dialog.querySelector('[data-transfer-elapsed]');
    if (elapsed) elapsed.textContent = `Working… ${seconds}s elapsed`;
  }, 1000);
  const progressBar = dialog.querySelector('.transfer-progress span');
  const initialTitle = title;
  const finish = (kind, message) => {
    clearInterval(timer);
    kind === 'success' ? task.success(message) : task.error(message);
    const state = dialog.querySelector('[data-transfer-state]');
    state.classList.remove('is-running', 'is-success', 'is-error');
    state.classList.add(kind === 'success' ? 'is-success' : 'is-error');
    const operation = /upload/i.test(initialTitle) ? 'Upload'
      : /creat/i.test(initialTitle) ? 'Creation'
      : /delet/i.test(initialTitle) ? 'Deletion'
      : /install/i.test(initialTitle) ? 'Installation'
      : /download/i.test(initialTitle) ? 'Download'
      : /sav|publish|configur/i.test(initialTitle) ? 'Save'
      : /open|load/i.test(initialTitle) ? 'Loading'
      : 'Operation';
    dialog.querySelector('[data-transfer-title]').textContent = kind === 'success' ? `${operation} complete` : `${operation} failed`;
    dialog.querySelector('[data-transfer-detail]').textContent = message;
    dialog.querySelector('[data-transfer-elapsed]').textContent = kind === 'success' ? 'Completed successfully.' : 'Task failed.';
    dialog.querySelector('[data-transfer-error]').textContent = kind === 'error' ? message : '';
    dialog.querySelector('[data-transfer-ok]').classList.remove('hidden');
    if (options.modal === false) setTimeout(() => { if (dialog.open) dialog.close(); }, kind === 'success' ? 900 : 5000);
  };
  dialog.querySelector('[data-transfer-ok]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  if (options.modal === false) dialog.show();
  else dialog.showModal();
  return {
    update(percent, message = '') {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
      task.update(value, message);
      progressBar.style.animation = 'none';
      progressBar.style.inset = '0 auto 0 0';
      progressBar.style.width = `${value}%`;
      progressBar.style.background = 'var(--accent)';
      dialog.querySelector('[data-transfer-elapsed]').textContent = `${value}% complete`;
      if (message) dialog.querySelector('[data-transfer-detail]').textContent = message;
    },
    succeed(message = 'The operation completed successfully.') { finish('success', message); },
    fail(message = 'The operation could not be completed.') { finish('error', message); },
    close() { closeDialog(dialog); }
  };
}

window.LightNASProgress = { open: openProgressDialog };

function wizardOption(value, label, selected = false) {
  return `<option value="${dialogEsc(value)}" ${selected ? 'selected' : ''}>${dialogEsc(label)}</option>`;
}

function looksLikeWindowsMedia(value) {
  const text = String(value || '').toLowerCase();
  return /(?:windows|win[-_. ]?(?:10|11)|win10|win11|windows10|windows11|windows[_ -]?server)/i.test(text);
}

async function showRuntimeWizard(kind) {
  const isContainer = kind === 'containers';
  let inventory;
  try {
    if (isContainer) {
      const containers = window.LightNASContainerInventory || await dialogApi('/api/containers/inventory');
      window.LightNASContainerInventory = containers;
      inventory = { containers };
    } else {
      // Creation does not need Docker status or per-VM inspection. Use the
      // small creation-options endpoint so clicking Create VM never waits on
      // the full runtime inventory path.
      inventory = await dialogApi('/api/vms/create-options');
      window.LightNASVmCreateOptions = inventory;
    }
  } catch (problem) {
    throw new Error(`Unable to open ${isContainer ? 'container' : 'VM'} wizard: ${problem.message || 'runtime choices could not be loaded.'}`);
  }
  const runtime = inventory?.[kind];
  if (!runtime?.available || !runtime?.enabled) throw new Error(runtime?.reason || `${isContainer ? 'Container' : 'VM'} runtime is unavailable.`);

  const storages = runtime.storageDetails || [];
  const networks = runtime.networkDetails?.length
    ? runtime.networkDetails.map(item => ({ value: item.name, label: item.label || `${item.name} · ${item.type || 'network'}` }))
    : (runtime.networks || []).map(item => ({ value: item, label: item }));
  if (!storages.length) throw new Error(`No writable storage is configured for ${isContainer ? 'container root disks' : 'VM disks'}.`);
  if (!networks.length) throw new Error('No usable virtual network or bridge is available.');

  const images = isContainer
    ? (runtime.images || []).map(item => ({ value: item.id, label: item.label || item.name || item.id }))
    : [{ value: '', label: 'No ISO — create a blank VM' }, ...(runtime.isoDetails || []).map(item => ({ value: item.id, label: `${item.name} · ${item.storageName}` }))];
  if (isContainer && !images.length) throw new Error('Download or upload a system-container image before creating a container.');

  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog runtime-create-dialog';
  const title = isContainer ? 'Create New Container' : 'Create New Virtual Machine';
  const imageLabel = isContainer ? 'Linux image / template' : 'Installer ISO';
  const defaultName = isContainer ? 'debian-services' : 'new-vm';
  dialog.innerHTML = `
    <form class="dialog-body runtime-wizard-form">
      <div class="dialog-head">
        <div><span class="eyebrow">${isContainer ? 'SYSTEM CONTAINER' : 'VIRTUAL MACHINE'} WIZARD</span><h2>${title}</h2></div>
        <button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="wizard-steps vsphere-wizard-steps" aria-label="Creation steps">
        <span class="active" data-step-indicator="0"><b>1</b><i>Guest OS</i><small>Name & media</small></span>
        <span data-step-indicator="1"><b>2</b><i>Virtual Hardware</i><small>CPU, memory & disk</small></span>
        <span data-step-indicator="2"><b>3</b><i>Network & Options</i><small>Adapter & boot</small></span>
        <span data-step-indicator="3"><b>4</b><i>Ready to Complete</i><small>Review configuration</small></span>
      </div>
      <section class="wizard-page active" data-wizard-page="0">
        <h3>Name and guest operating system</h3>
        <p class="muted">Choose a unique name and the image that will be installed.</p>
        <div class="wizard-grid">
          <label>${isContainer ? 'Container' : 'VM'} name<input name="name" value="${defaultName}" pattern="[A-Za-z][A-Za-z0-9-]{1,39}" required></label>
          <label>${imageLabel}<select name="${isContainer ? 'image' : 'iso'}" ${isContainer ? 'required' : ''}>${images.map(item => wizardOption(item.value, item.label)).join('')}</select></label>
          ${isContainer ? '<label>Root password<input name="password" type="password" minlength="4" maxlength="128" autocomplete="new-password" required placeholder="At least 4 characters"></label><label>Confirm root password<input name="passwordConfirm" type="password" minlength="4" maxlength="128" autocomplete="new-password" required></label>' : ''}
        </div>
        <p class="module-note">${isContainer ? 'The root password is sent only to the local privileged host agent and is not stored by the LightNAS web service.' : 'Upload or download ISO images from Storage → Pools & datasets → ISO images.'}</p>
      </section>
      <section class="wizard-page" data-wizard-page="1">
        <h3>Customize virtual hardware</h3>
        <p class="muted">Select where the guest lives and how many resources it can use.</p>
        <div class="wizard-grid">
          <label>Storage<select name="pool" required>${storages.map((item, index) => wizardOption(item.id, `${item.name || item.id}${item.availableBytes !== undefined ? ` · ${Math.round(item.availableBytes / 1073741824)} GiB free` : ''}`, index === 0)).join('')}</select></label>
          <label>${isContainer ? 'Root disk allocation' : 'Virtual disk size'} (GiB)<input name="diskGiB" type="number" min="${isContainer ? 2 : 10}" max="2048" value="${isContainer ? 8 : 32}" required></label>
          <label>Memory (MiB)<input name="memoryMiB" type="number" min="${isContainer ? 256 : 1024}" max="65536" value="2048" required></label>
          <label>Virtual CPUs<input name="cpus" type="number" min="1" max="32" value="2" required></label>
        </div>
      </section>
      <section class="wizard-page" data-wizard-page="2">
        <h3>Network and VM options</h3>
        <div class="wizard-grid">
          <label>Network / bridge<select name="network" required>${networks.map((item, index) => wizardOption(item.value, item.label, index === 0)).join('')}</select></label>
          ${isContainer ? `
            <label>IPv4 configuration<select name="ipv4Mode"><option value="dhcp">DHCP / automatic</option><option value="manual">Static / manual</option></select></label>
            <label>Static IPv4 address / CIDR<input name="ipv4Address" placeholder="192.168.1.50/24"></label>
            <label>Gateway<input name="gateway" placeholder="192.168.1.1"></label>
            <label>DNS servers<input name="dns" placeholder="1.1.1.1, 8.8.8.8"></label>
            <label>VLAN tag (optional)<input name="vlanTag" type="number" min="1" max="4094"></label>
            <label>MAC address (optional)<input name="macAddress" placeholder="02:00:00:00:00:10" pattern="[A-Fa-f0-9]{2}(:[A-Fa-f0-9]{2}){5}"></label>
          ` : `
            <label>Firmware<select name="firmware"><option value="bios">BIOS / legacy</option><option value="uefi">UEFI</option></select></label>
            <label>Disk controller<select name="diskBus"><option value="scsi">VirtIO SCSI · Linux/performance</option><option value="virtio">VirtIO block · Linux/performance</option><option value="sata">SATA · Windows/Linux installer compatible</option></select></label>
            <label>Network adapter<select name="networkModel"><option value="virtio">VirtIO · Linux/performance</option><option value="e1000">Intel E1000 · Windows compatible</option><option value="rtl8139">Realtek RTL8139</option></select></label>
            <p class="module-note" data-vm-guest-profile>LightNAS automatically selects Windows-compatible hardware when a Windows installer ISO is selected.</p>
            <label class="wizard-check"><input name="attachGuestDrivers" type="checkbox" checked> <span>Attach guest driver media automatically when needed</span></label>
          `}
          <label class="wizard-check"><input name="startOnBoot" type="checkbox" checked> <span>Start automatically when LightNAS boots</span></label>
        </div>
      </section>
      <section class="wizard-page" data-wizard-page="3">
        <h3>Ready to complete</h3>
        <p class="muted">Confirm the configuration. Creation may take several minutes while an image is unpacked or an operating system is installed.</p>
        <div class="wizard-review" data-wizard-review></div>
      </section>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary" type="button" data-dialog-close>Cancel</button>
        <button class="secondary hidden" type="button" data-wizard-back>Back</button>
        <button class="primary" type="button" data-wizard-next>Next</button>
        <button class="primary hidden" type="submit" data-wizard-create>Create & start</button>
      </div>
    </form>`;

  let step = 0;
  const form = dialog.querySelector('form');
  const error = form.querySelector('.form-error');
  const pages = [...form.querySelectorAll('[data-wizard-page]')];
  const indicators = [...form.querySelectorAll('[data-step-indicator]')];
  const back = form.querySelector('[data-wizard-back]');
  const next = form.querySelector('[data-wizard-next]');
  const create = form.querySelector('[data-wizard-create]');
  const showStep = value => {
    step = Math.max(0, Math.min(3, value));
    pages.forEach((page, index) => page.classList.toggle('active', index === step));
    indicators.forEach((indicator, index) => {
      indicator.classList.toggle('active', index === step);
      indicator.classList.toggle('complete', index < step);
    });
    back.classList.toggle('hidden', step === 0);
    next.classList.toggle('hidden', step === 3);
    create.classList.toggle('hidden', step !== 3);
    error.textContent = '';
    if (step === 3) {
      const values = Object.fromEntries(new FormData(form));
      const labels = [
        ['Name', values.name], [imageLabel, values.image || values.iso || 'No installation media'],
        ['Storage', values.pool], ['Disk', `${values.diskGiB} GiB`],
        ['Memory', `${values.memoryMiB} MiB`], ['CPU', `${values.cpus} vCPU`],
        ['Network', values.network], ['Start on boot', form.elements.startOnBoot.checked ? 'Yes' : 'No']
      ];
      form.querySelector('[data-wizard-review]').innerHTML = labels.map(([label, value]) => `<div><span>${dialogEsc(label)}</span><b>${dialogEsc(value)}</b></div>`).join('');
    }
    pages[step].querySelector('input,select')?.focus();
  };
  const validatePage = () => {
    for (const field of pages[step].querySelectorAll('input,select')) {
      if (!field.checkValidity()) { field.reportValidity(); return false; }
    }
    if (isContainer && step === 0 && form.elements.password.value !== form.elements.passwordConfirm.value) {
      error.textContent = 'The root passwords do not match.';
      form.elements.passwordConfirm.focus();
      return false;
    }
    if (isContainer && step === 2 && form.elements.ipv4Mode.value === 'manual' && !form.elements.ipv4Address.value.trim()) {
      error.textContent = 'Enter a static IPv4 address with CIDR prefix, for example 192.168.1.50/24.';
      form.elements.ipv4Address.focus();
      return false;
    }
    return true;
  };

  if (isContainer && form.elements.ipv4Mode) {
    const updateContainerNetworkFields = () => {
      const manual = form.elements.ipv4Mode.value === 'manual';
      for (const name of ['ipv4Address', 'gateway', 'dns']) {
        if (form.elements[name]) {
          form.elements[name].disabled = !manual;
          if (!manual) form.elements[name].value = '';
        }
      }
      if (form.elements.ipv4Address) form.elements.ipv4Address.required = manual;
    };
    form.elements.ipv4Mode.value = 'dhcp';
    form.elements.ipv4Mode.addEventListener('change', updateContainerNetworkFields);
    updateContainerNetworkFields();
  }

  if (!isContainer && form.elements.iso) {
    const applyVmGuestProfile = () => {
      const selected = images.find(item => item.value === form.elements.iso.value);
      const windows = looksLikeWindowsMedia(selected?.label || form.elements.iso.value);
      form.elements.firmware.value = windows ? 'uefi' : 'bios';
      form.elements.diskBus.value = windows ? 'sata' : 'scsi';
      form.elements.networkModel.value = windows ? 'e1000' : 'virtio';
      const note = form.querySelector('[data-vm-guest-profile]');
      if (note) note.textContent = windows
        ? 'Windows installer detected: LightNAS uses installer-compatible hardware and automatically attaches the VirtIO driver ISO as a second CD so optimized drivers are available during or after setup.'
        : 'Linux/generic installer profile: LightNAS uses VirtIO hardware for better performance. Modern Linux kernels include the required VirtIO drivers, so a separate driver ISO is not normally needed.';
    };
    form.elements.iso.addEventListener('change', applyVmGuestProfile);
    applyVmGuestProfile();
  }

  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  next.addEventListener('click', () => { if (validatePage()) showStep(step + 1); });
  back.addEventListener('click', () => showStep(step - 1));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!validatePage()) return;
    const values = Object.fromEntries(new FormData(form));
    const name = values.name;
    const payload = {
      ...values,
      memoryMiB: Number(values.memoryMiB),
      cpus: Number(values.cpus),
      diskGiB: Number(values.diskGiB),
      startOnBoot: form.elements.startOnBoot.checked,
      ...(!isContainer ? { attachGuestDrivers: Boolean(form.elements.attachGuestDrivers?.checked) } : {})
    };
    delete payload.passwordConfirm;
    create.disabled = true;

    // Once the operator confirms Create, get the wizard out of the way
    // immediately. The bottom Tasks dock becomes the source of truth for the
    // long-running operation so the rest of LightNAS remains usable.
    const progress = openProgressDialog(
      isContainer ? 'Creating system container' : 'Creating virtual machine',
      `Submitted ${name}. Waiting for the host runtime…`,
      { taskOnly:true }
    );
    dialog.close();
    progress.update(10, `Submitting ${name} to the host runtime…`);

    try {
      const result = await dialogApi(isContainer ? '/api/containers' : '/api/vms', {
        method: 'POST',
        headers: { 'X-LightNAS-Task-Managed': '1' },
        body: JSON.stringify(payload)
      });
      progress.update(90, `${name} was created. Refreshing runtime inventory…`);
      refreshRuntime();
      const selectedImage = images.find(item => item.value === (isContainer ? payload.image : payload.iso))?.label || payload.image || payload.iso || '';
      const createdApplication = result.application;
      const createdUrl = createdApplication
        ? (createdApplication.mode === 'direct'
          ? `${createdApplication.scheme || 'http'}://${createdApplication.targetHost}${((createdApplication.scheme || 'http') === 'https' && Number(createdApplication.targetPort) === 443) || ((createdApplication.scheme || 'http') === 'http' && Number(createdApplication.targetPort) === 80) ? '' : `:${createdApplication.targetPort}`}/`
          : `${createdApplication.scheme || 'http'}://${location.hostname}:${createdApplication.hostPort}/`)
        : '';
      const lanStatus = isContainer && result.ipv4
        ? ` LAN IP: ${result.ipv4}.${result.networkMode === 'direct-lan' ? ' Direct LAN networking is ready.' : ''}`
        : '';
      progress.succeed(isContainer
        ? `${name} was created, ${result.installedImage || selectedImage} was verified and installed, and the container is running.${lanStatus}${createdUrl ? ` Application access: ${createdUrl}` : ' LightNAS will detect any web application automatically.'}`
        : `${name} was created successfully and is ready to use.`);
    } catch (problem) {
      progress.fail(problem.message || `${name} could not be created.`);
      refreshRuntime();
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  showStep(0);
  return dialog;
}


function showRuntimeDeleteDialog(kind, id) {
  const isContainer = kind === 'container';
  const label = isContainer ? 'system container' : 'virtual machine';
  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog';
  dialog.innerHTML = `
    <form class="dialog-body">
      <div class="dialog-head">
        <div><span class="eyebrow">DESTRUCTIVE OPERATION</span><h2>Delete ${dialogEsc(id)}</h2></div>
        <button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <p class="module-note danger-note">This permanently deletes the ${label} configuration and its managed ${isContainer ? 'root filesystem' : 'virtual disks'}. Shared ISO and template-library files are not deleted.</p>
      <label class="wizard-check"><input name="deleteFiles" type="checkbox" required> <span>Delete all files belonging to this ${label}</span></label>
      <label>Type the exact ${isContainer ? 'container' : 'VM'} ID to verify deletion
        <input name="confirmation" autocomplete="off" placeholder="${dialogEsc(id)}" required>
      </label>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary" type="button" data-dialog-close>Cancel</button>
        <button class="secondary danger-button" type="submit">Permanently delete</button>
      </div>
    </form>`;
  const form = dialog.querySelector('form');
  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const error = form.querySelector('.form-error');
    const confirmation = form.elements.confirmation.value;
    if (!form.elements.deleteFiles.checked) { error.textContent = 'Select “Delete all files” before continuing.'; return; }
    if (confirmation !== id) { error.textContent = `Type exactly: ${id}`; form.elements.confirmation.focus(); return; }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const progress = openProgressDialog(`Deleting ${label}`, `Removing ${id} and all managed files…`, { modal:false });
    try {
      await dialogApi(isContainer ? '/api/containers' : '/api/vms', {
        method: 'POST',
        body: JSON.stringify({ id, action: 'delete', deleteFiles: true, confirmation })
      });
      dialog.close();
      window.LightNASRuntimeInventory = null;
      window.LightNASContainerInventory = null;
      refreshRuntime();
      progress.succeed(`${id} and its managed files were permanently deleted.`);
    } catch (problem) {
      progress.fail(problem.message);
      error.textContent = problem.message;
      submit.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  setTimeout(() => form.elements.confirmation.focus(), 0);
}

// Register before enhancements/admin-security so these native LightNAS dialogs
async function showContainerManager(id) {
  const cachedRuntime = window.LightNASContainerInventory;
  const cachedOverview = window.LightNASOverview;
  const runtimePromise = cachedRuntime ? Promise.resolve(cachedRuntime) : dialogApi('/api/containers/inventory?summary=1');
  const overviewPromise = cachedOverview ? Promise.resolve(cachedOverview) : dialogApi('/api/overview').catch(() => ({ activity: [], appliance: {} }));
  const [runtime, overview] = await Promise.all([runtimePromise, overviewPromise]);
  window.LightNASContainerInventory = runtime;
  window.LightNASOverview = overview;

  const item = (runtime.containers || []).find(entry => String(entry.id || entry.name) === id);
  if (!item) throw new Error('Container is no longer available.');
  const networks = [...new Set([...(runtime.networks || []), item.network].filter(Boolean))];
  const currentNetwork = item.network || networks[0] || '';
  let publication = item.publication || null;
  const privateNatAddress = /^10\.77\.0\.(?:\d{1,3})$/.test(String(item.ipv4 || publication?.targetHost || ''));

  // Never block the settings window on application probing. Discovery may
  // involve network timeouts and previously made Edit feel frozen for seconds.
  if (String(item.status || '').toLowerCase() === 'running' && (!publication || (privateNatAddress && publication.mode !== 'proxy'))) {
    queueMicrotask(() => {
      dialogApi('/api/containers', {
        method: 'POST',
        body: JSON.stringify({ id, action: 'auto-publish' })
      }).catch(() => null);
    });
  }
  const applicationUrl = publication
    ? (publication.mode === 'direct'
      ? `${publication.scheme || 'http'}://${publication.targetHost}${((publication.scheme || 'http') === 'https' && Number(publication.targetPort) === 443) || ((publication.scheme || 'http') === 'http' && Number(publication.targetPort) === 80) ? '' : `:${publication.targetPort}`}/`
      : `${publication.scheme || 'http'}://${location.hostname}:${publication.hostPort}/`)
    : '';
  const memoryMiB = Math.max(256, Math.round(Number(item.memory || 0) / 1024 / 1024) || 2048);
  const tasks = (overview.activity || []).filter(entry =>
    JSON.stringify(entry).toLowerCase().includes(id.toLowerCase())
  );
  const taskRows = tasks.length
    ? tasks.map(entry => `<article class="manager-event"><b>${dialogEsc(entry.message || entry.detail || entry.type || 'Container task')}</b><span>${dialogEsc(entry.createdAt || entry.timestamp || '')}</span></article>`).join('')
    : '<p class="muted">No recorded LightNAS tasks for this container yet.</p>';

  const extraNicRows = (item.extraNics || []).map((nic, index) => `
    <div class="hardware-row" data-extra-nic-row>
      <label>Network<select name="extraNicNetwork">${networks.map(value => `<option value="${dialogEsc(value)}" ${value === nic.network ? 'selected' : ''}>${dialogEsc(value)}</option>`).join('')}</select></label>
      <label>MAC address<input name="extraNicMac" value="${dialogEsc(nic.macAddress || '')}" placeholder="Automatically assigned"></label>
      <label>VLAN<input name="extraNicVlan" value="${dialogEsc(nic.vlanTag || '')}" type="number" min="1" max="4094" placeholder="None"></label>
      <button class="secondary danger-button compact-button" type="button" data-remove-hardware-row>Remove</button>
    </div>`).join('');

  const mountRows = (item.mountPoints || []).length
    ? (item.mountPoints || []).map(mount => `<div class="hardware-readout"><b>${dialogEsc(mount.source)}</b><span>→ /${dialogEsc(mount.target)}${mount.readOnly ? ' · read only' : ''}</span></div>`).join('')
    : '<p class="muted">No additional host storage is mounted into this container.</p>';
  const deviceRows = (item.devicePaths || []).length
    ? (item.devicePaths || []).map(device => `<div class="hardware-readout"><b>${dialogEsc(device.source)}</b><span>→ /${dialogEsc(device.target)}</span></div>`).join('')
    : '<p class="muted">No host devices are currently passed through.</p>';


  const unavailable = (title, detail) => `
    <div class="manager-capability">
      <h3>${title}</h3><p>${detail}</p>
      <button class="secondary" type="button" disabled>Not available on this storage provider</button>
    </div>`;

  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog container-manager-dialog';
  dialog.innerHTML = `
    <form class="dialog-body container-manager-form">
      <div class="dialog-head">
        <div><span class="eyebrow">SYSTEM CONTAINER</span><h2>Manage ${dialogEsc(item.name || id)}</h2></div>
        <button class="dialog-close" type="button" data-manager-close aria-label="Close">×</button>
      </div>
      <div class="container-manager-layout">
        <nav class="container-manager-tabs" aria-label="Container settings">
          ${[
            ['resources','Resources'],['storageDevices','Storage & devices'],['network','Network'],['dns','DNS'],['application','Application access'],['options','Options'],
            ['tasks','Task history'],['backups','Backups'],['replication','Replication'],
            ['snapshots','Snapshots'],['firewall','Firewall'],['permissions','Permissions']
          ].map(([key,label], index) => `<button type="button" class="${index ? '' : 'active'}" data-container-tab="${key}">${label}</button>`).join('')}
        </nav>
        <div class="container-manager-content">
          <section data-container-panel="resources">
            <h3>Resources</h3>
            <p class="muted">CPU and memory limits are applied immediately and persist after restart.</p>
            <div class="form-grid">
              <label>Container ID<input name="name" value="${dialogEsc(item.name || id)}" readonly></label>
              <label>Memory (MiB)<input name="memoryMiB" type="number" min="256" max="262144" value="${memoryMiB}" required></label>
              <label>Virtual CPUs<input name="cpus" type="number" min="1" max="128" value="${Number(item.cpus) || 2}" required></label>
              <label>Root disk allocation<input value="${Number(item.diskGiB) || '—'} GiB" readonly></label>
              <label>Storage<input value="${dialogEsc(item.storageId || 'Local container storage')}" readonly></label>
              <label>Image<input value="${dialogEsc(item.imageId || 'Installed system image')}" readonly></label>
            </div>
          </section>

          <section data-container-panel="storageDevices" hidden>
            <h3>Storage & device passthrough</h3>
            <p class="muted">This container uses a directory-backed root filesystem. Its usable space follows the selected storage pool; add mount points for dedicated data locations instead of resizing a virtual disk file.</p>
            <div class="manager-summary">
              <div><span>Root filesystem</span><b>${dialogEsc(item.rootfsPath || 'Directory-backed rootfs')}</b></div>
              <div><span>Configured allocation</span><b>${Number(item.diskGiB) ? `${Number(item.diskGiB)} GiB` : 'Pool-backed'}</b></div>
              <div><span>Storage</span><b>${dialogEsc(item.storageId || 'Local container storage')}</b></div>
            </div>
            <h4>Current mount points</h4>
            <div class="hardware-list">${mountRows}</div>
            <div class="form-grid manager-add-block">
              <label>Host path to mount<input name="addMountSource" placeholder="/mnt/storage/data"></label>
              <label>Container path<input name="addMountTarget" placeholder="/data"></label>
              <label class="check-line"><input name="addMountReadOnly" type="checkbox"> Read-only mount</label>
            </div>
            <h4>Current device passthrough</h4>
            <div class="hardware-list">${deviceRows}</div>
            <label>Pass through another host device<input name="addDevicePath" placeholder="/dev/dri/renderD128"></label>
            <p class="module-note">GPU acceleration for containers normally uses a device such as <code>/dev/dri/renderD128</code>. The device must already exist on the LightNAS host.</p>
          </section>
          <section data-container-panel="network" hidden>
            <h3>Network</h3>
            <div class="form-grid">
              <label>Bridge / network<select name="network">${networks.map(value => `<option value="${dialogEsc(value)}" ${value === currentNetwork ? 'selected' : ''}>${dialogEsc(value)}</option>`).join('')}</select></label>
              <label>IPv4 configuration<select name="ipv4Mode"><option value="dhcp" ${item.ipv4Mode !== 'manual' ? 'selected' : ''}>DHCP</option><option value="manual" ${item.ipv4Mode === 'manual' ? 'selected' : ''}>Static</option></select></label>
              <label>Configured IPv4 address / prefix<input name="ipv4Address" value="${dialogEsc(item.ipv4Address || '')}" placeholder="192.168.1.50/24"></label>
              <label>Configured gateway<input name="gateway" value="${dialogEsc(item.gateway || '')}" placeholder="192.168.1.1"></label>
              <label>MAC address<input value="${dialogEsc(item.macAddress || 'Automatically assigned')}" readonly></label>
            </div>
            <div class="manager-summary live-network-summary">
              <div><span>Current live IPv4</span><b>${dialogEsc(item.liveIpv4Address || item.ipv4 || (String(item.status || '').toLowerCase() === 'running' ? 'Not detected' : 'Container stopped'))}</b></div>
              <div><span>Current live gateway</span><b>${dialogEsc(item.liveGateway || (String(item.status || '').toLowerCase() === 'running' ? 'Not detected' : 'Container stopped'))}</b></div>
              <div><span>Current live DNS</span><b>${dialogEsc(item.liveDns || (String(item.status || '').toLowerCase() === 'running' ? 'Not detected' : 'Container stopped'))}</b></div>
              <div><span>Configuration source</span><b>${dialogEsc(item.networkSettingsSource || 'Detected configuration')}</b></div>
            </div>

            <div class="manager-subsection">
              <div class="subsection-head"><div><h4>Additional virtual NICs</h4><p class="muted">Existing adapters are loaded from the real LXC configuration.</p></div><button class="secondary" type="button" data-add-extra-nic>+ Add NIC</button></div>
              <div class="hardware-list" data-extra-nics>${extraNicRows || '<p class="muted" data-no-extra-nics>No additional NICs configured.</p>'}</div>
            </div>
<p class="module-note">Changing a running container’s address may temporarily interrupt its application connections. The LightNAS terminal uses the local host channel and remains available.</p>
          </section>
          <section data-container-panel="dns" hidden>
            <h3>DNS</h3>
            <label>DNS servers<input name="dns" value="${dialogEsc(item.dns || '')}" placeholder="1.1.1.1, 8.8.8.8"></label>
            <p class="muted">Enter comma-separated IPv4 or IPv6 DNS server addresses. DHCP may also supply DNS when this field is empty.</p>
          </section>
          <section data-container-panel="application" hidden>
            <h3>Application access</h3>
            <p class="muted">LightNAS automatically discovers HTTP/HTTPS applications running inside this container and makes them reachable from the LAN.</p>
            <label class="check-line"><input name="publishApplication" type="checkbox" checked disabled> Make this application accessible from the LightNAS network — automatic</label>
            <div class="manager-summary">
              <div><span>${privateNatAddress ? 'Internal container address' : 'Container address'}</span><b>${dialogEsc(publication?.targetHost || item.ipv4 || 'Detecting automatically')}</b></div>
              <div><span>Access mode</span><b>${publication?.mode === 'direct' ? 'Direct container IP' : publication?.mode === 'proxy' ? 'LightNAS NAT fallback' : 'Automatic detection'}</b></div>
              <div><span>Detected web service</span><b>${publication ? `${dialogEsc(String(publication.scheme || 'http').toUpperCase())} · port ${dialogEsc(publication.targetPort)}` : 'Not detected yet'}</b></div>
              <div><span>Open address</span><b>${applicationUrl ? `<a href="${dialogEsc(applicationUrl)}" target="_blank" rel="noopener">${dialogEsc(applicationUrl)}</a>` : 'Available automatically after the app starts'}</b></div>
            </div>
            <details class="manager-capability">
              <summary><b>Advanced detection hints</b></summary>
              <div class="form-grid">
                <label>Preferred container web port<input name="targetPort" type="number" min="1" max="65535" value="${Number(publication?.targetPort) || ''}" placeholder="Automatic"></label>
                <label>NAT fallback LightNAS port<input name="hostPort" type="number" min="1024" max="65535" value="${Number(publication?.hostPort) || ''}" placeholder="Automatic"></label>
              </div>
              <p class="muted">Normally leave these blank. On a bridged LAN, LightNAS opens the application directly using the container IP. A LightNAS host port is only used when the container is on a private NAT bridge.</p>
            </details>
            <p class="module-note">TurnKey appliances such as Faveo are detected automatically. On a bridged network, the application opens directly from the container IP instead of requiring a second LightNAS forwarding port.</p>
          </section>
          <section data-container-panel="options" hidden>
            <h3>Options</h3>
            <label class="check-line"><input name="startOnBoot" type="checkbox" ${item.startOnBoot !== false ? 'checked' : ''}> Start container automatically when LightNAS starts</label>
            <div class="manager-summary manager-options-grid">
              <div><span>Provider</span><b>${dialogEsc(item.provider || 'local-lxc')}</b></div>
              <div><span>Status</span><b>${dialogEsc(item.status || 'unknown')}</b></div>
              <div><span>PID</span><b>${dialogEsc(item.pid || 'Not running')}</b></div>
              <div><span>System image</span><b>${dialogEsc(item.imageId || 'Installed Linux system')}</b></div>
              <div><span>Unprivileged container</span><b>${item.unprivileged ? 'Yes' : 'No / not detected'}</b></div>
              <div><span>Nesting feature</span><b>${item.nesting ? 'Enabled' : 'Disabled'}</b></div>
              <div><span>TTY count</span><b>${dialogEsc(item.ttyCount || 'Default')}</b></div>
              <div><span>Console path</span><b>${dialogEsc(item.consolePath || 'Default LXC console')}</b></div>
              <div><span>Primary MAC</span><b>${dialogEsc(item.macAddress || 'Automatically assigned')}</b></div>
            </div>
            <p class="module-note">Start at boot is editable here. Security identity, nesting and console topology reflect the actual LXC configuration and are shown read-only so LightNAS does not silently weaken the container boundary.</p>
          </section>
          <section data-container-panel="tasks" hidden><h3>Task history</h3><div class="manager-events">${taskRows}</div></section>
          <section data-container-panel="backups" hidden>${unavailable('Backups', 'Backup jobs require a configured LightNAS backup target. The container root filesystem is not copied until that storage workflow is enabled.')}</section>
          <section data-container-panel="replication" hidden>${unavailable('Replication', 'Container replication requires a second LightNAS host and a paired replication target.')}</section>
          <section data-container-panel="snapshots" hidden>${unavailable('Snapshots', 'Snapshots require a snapshot-capable ZFS or Btrfs container storage pool. Directory-backed LXC storage cannot create atomic snapshots.')}</section>
          <section data-container-panel="firewall" hidden>${unavailable('Firewall', 'Per-container firewall rules require the LightNAS nftables container policy engine. Host firewall rules remain available under Connectivity → Firewall.')}</section>
          <section data-container-panel="permissions" hidden>
            <h3>Permissions</h3>
            <p>Managing this container requires the <code>containers.manage</code> permission. The appliance owner always retains access.</p>
            <p class="muted">Per-container user assignments will be enabled with container-scoped RBAC. Current permissions are enforced at the container-management service level.</p>
          </section>
        </div>
      </div>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary" type="button" data-manager-revert>Revert changes</button>
        <button class="secondary" type="button" data-manager-close>Cancel</button>
        <button class="primary" type="submit">Save changes</button>
      </div>
    </form>`;

  const showTab = key => {
    dialog.querySelectorAll('[data-container-tab]').forEach(button => button.classList.toggle('active', button.dataset.containerTab === key));
    dialog.querySelectorAll('[data-container-panel]').forEach(panel => { panel.hidden = panel.dataset.containerPanel !== key; });
  };
  dialog.querySelectorAll('[data-container-tab]').forEach(button => button.addEventListener('click', () => showTab(button.dataset.containerTab)));
  dialog.querySelectorAll('[data-manager-close]').forEach(button => button.addEventListener('click', () => dialog.close()));

  dialog.querySelector('[data-manager-revert]')?.addEventListener('click', async () => {
    dialog.close();
    try { await showContainerManager(id); } catch (problem) { alert(problem.message); }
  });
  dialog.querySelector('[data-add-extra-nic]')?.addEventListener('click', () => {
    const root = dialog.querySelector('[data-extra-nics]');
    root.querySelector('[data-no-extra-nics]')?.remove();
    const row = document.createElement('div');
    row.className = 'hardware-row';
    row.dataset.extraNicRow = '';
    row.innerHTML = `
      <label>Network<select name="extraNicNetwork">${networks.map(value => `<option value="${dialogEsc(value)}">${dialogEsc(value)}</option>`).join('')}</select></label>
      <label>MAC address<input name="extraNicMac" placeholder="Automatically assigned"></label>
      <label>VLAN<input name="extraNicVlan" type="number" min="1" max="4094" placeholder="None"></label>
      <button class="secondary danger-button compact-button" type="button" data-remove-hardware-row>Remove</button>`;
    root.append(row);
  });
  dialog.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-hardware-row]');
    if (remove) remove.closest('[data-extra-nic-row]')?.remove();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });

  const mode = dialog.querySelector('[name="ipv4Mode"]');
  const updateNetworkFields = () => {
    const manual = mode.value === 'manual';
    const addressField = dialog.querySelector('[name="ipv4Address"]');
    const gatewayField = dialog.querySelector('[name="gateway"]');
    const dnsField = dialog.querySelector('[name="dns"]');
    addressField.required = manual;
    addressField.disabled = !manual;
    gatewayField.disabled = !manual;
    dnsField.disabled = !manual;
  };
  mode.addEventListener('change', updateNetworkFields);
  updateNetworkFields();

  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.form-error');
    const submit = form.querySelector('button[type="submit"]');
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Saving…';
    const progress = openProgressDialog('Saving container settings', `Applying settings for ${item.name || id}…`, { modal:false });
    try {
      const values = Object.fromEntries(new FormData(form));
      const payload = {
        id, action: 'update', name: values.name,
        memoryMiB: Number(values.memoryMiB), cpus: Number(values.cpus),
        network: values.network, ipv4Mode: values.ipv4Mode,
        ipv4Address: values.ipv4Address || '', gateway: values.gateway || '',
        dns: values.dns || '', startOnBoot: form.elements.startOnBoot.checked,
        extraNics: [...form.querySelectorAll('[data-extra-nic-row]')].map(row => ({
          network: row.querySelector('[name="extraNicNetwork"]')?.value || '',
          macAddress: row.querySelector('[name="extraNicMac"]')?.value || '',
          vlanTag: row.querySelector('[name="extraNicVlan"]')?.value || ''
        })),
        addMountPoints: values.addMountSource && values.addMountTarget ? [{
          source:values.addMountSource, target:values.addMountTarget,
          readOnly:Boolean(form.elements.addMountReadOnly?.checked)
        }] : [],
        addDevicePaths: values.addDevicePath ? [{ path:values.addDevicePath }] : []
      };
      if (!Number.isInteger(payload.memoryMiB) || !Number.isInteger(payload.cpus)) throw new Error('Memory and CPU values must be whole numbers.');
      const settingsChanged = payload.memoryMiB !== memoryMiB
        || payload.cpus !== (Number(item.cpus) || 2)
        || payload.network !== currentNetwork
        || payload.ipv4Mode !== (item.ipv4Mode === 'manual' ? 'manual' : 'dhcp')
        || payload.ipv4Address.trim() !== String(item.ipv4Address || '').trim()
        || payload.gateway.trim() !== String(item.gateway || '').trim()
        || payload.dns.trim() !== String(item.dns || '').trim()
        || payload.startOnBoot !== (item.startOnBoot !== false)
        || JSON.stringify(payload.extraNics) !== JSON.stringify((item.extraNics || []).map(nic => ({network:nic.network || '',macAddress:nic.macAddress || '',vlanTag:String(nic.vlanTag || '')})))
        || payload.addMountPoints.length > 0
        || payload.addDevicePaths.length > 0;
      let updateResult = null;
      if (settingsChanged) {
        updateResult = await dialogApi('/api/containers', { method: 'POST', body: JSON.stringify(payload) });
      }

      let access = null;
      let publishWarning = '';
      try {
        access = await dialogApi('/api/containers', { method: 'POST', body: JSON.stringify({
          id,
          action: 'auto-publish',
          targetPort: Number(values.targetPort) || 0,
          hostPort: Number(values.hostPort) || 0
        }) });
      } catch (problem) {
        // Application discovery is secondary to saving container settings.
        // Do not report "Save failed" after networking/resources were already
        // saved successfully.
        publishWarning = problem.message || 'Application access is not ready yet.';
      }

      dialog.close();
      refreshRuntime();
      const detectedUrl = access?.accessUrl || (access?.mode === 'direct'
        ? `${access.scheme || 'http'}://${access.targetHost}${((access.scheme || 'http') === 'https' && Number(access.targetPort) === 443) || ((access.scheme || 'http') === 'http' && Number(access.targetPort) === 80) ? '' : `:${access.targetPort}`}/`
        : access?.mode === 'proxy' ? `${access.scheme || 'http'}://${location.hostname}:${access.hostPort}/` : '');
      const ipNote = updateResult?.ipv4 ? ` IPv4: ${updateResult.ipv4}.` : '';
      const fallbackNote = updateResult?.managedLanPool
        ? ' LightNAS assigned this container from the managed LAN pool.'
        : updateResult?.automaticFallback
          ? ' This host required LightNAS private fallback addressing.'
          : '';
      progress.succeed(detectedUrl
        ? `${item.name || id} was saved.${ipNote}${fallbackNote} Its application is available at ${detectedUrl}`
        : `${item.name || id} was saved.${ipNote}${fallbackNote}${publishWarning ? ` Application discovery is pending: ${publishWarning}` : ' LightNAS will detect any web application automatically after the service starts.'}`);
    } catch (problem) {
      progress.fail(problem.message);
      error.textContent = problem.message;
      submit.disabled = false;
      submit.textContent = 'Save changes';
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}


// replace the temporary browser prompt() implementations.
document.addEventListener('click', async event => {
  const containerDelete = event.target.closest('[data-container-action="delete"]');
  const vmDelete = event.target.closest('[data-vm-action="delete"]');
  if (containerDelete || vmDelete) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showRuntimeDeleteDialog(containerDelete ? 'container' : 'vm', (containerDelete || vmDelete).dataset[containerDelete ? 'containerId' : 'vmId']);
    return;
  }

  const createContainerButton = event.target.closest('[data-action="create-container"]');
  const createVmButton = event.target.closest('[data-action="create-vm"]');
  if (createContainerButton || createVmButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try { await showRuntimeWizard(createContainerButton ? 'containers' : 'virtualization'); }
    catch (problem) {
      const message = problem.message || 'Unable to open creation wizard.';
      window.LightNASToast?.show?.(message);
      if (typeof window.toast === 'function') window.toast(message);
      else {
        console.error(message);
        window.alert(message);
      }
    }
    return;
  }


  const appEdit = event.target.closest('[data-app-edit]');
  if (appEdit) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const inventory = window.LightNASRuntimeInventory || await dialogApi('/api/runtimes');
      window.LightNASRuntimeInventory = inventory;
      const id = appEdit.dataset.appEdit;
      const containerName = appEdit.dataset.appContainer || `lightnas-app-${id}`;
      const item = (inventory.docker?.containers || []).find(candidate => candidate.name === containerName);
      const app = (inventory.catalog || []).find(candidate => candidate.id === id);
      if (!item || !app) throw new Error('Managed application is no longer available.');

      const memoryMiB = Math.max(128, Math.round(Number(item.memory || 0) / 1048576) || parseInt(String(app.memory || '512'), 10) || 512);
      showEditor({
        eyebrow: 'MANAGED APPLICATION',
        title: `Edit ${app.name}`,
        description: 'Change Docker CPU, memory, and restart limits without reinstalling the application. CPU 0 means no CPU cap.',
        fields: [
          { name:'container', label:'Container', value:item.name, readonly:true },
          { name:'image', label:'Image', value:item.image || app.image, readonly:true },
          { name:'currentUsage', label:'Current usage', value:item.liveStats ? `${Number(item.cpuPercent || 0).toFixed(1)}% CPU · ${item.memoryUsage || '—'} RAM` : 'Live usage unavailable', readonly:true },
          { name:'memoryMiB', label:'Memory limit (MiB)', type:'number', value:memoryMiB, min:128, max:262144, step:1, required:true },
          { name:'cpus', label:'CPU limit', type:'number', value:item.cpuUnlimited ? 0 : Number(item.cpus || 0), min:0, max:128, step:.25, required:true },
          { name:'restartPolicy', label:'Restart policy', type:'select', value:item.restartPolicy || 'unless-stopped', options:[
            { value:'unless-stopped', label:'Unless stopped' },
            { value:'always', label:'Always' },
            { value:'on-failure', label:'On failure' },
            { value:'no', label:'Never' }
          ]},
          { name:'publishedPort', label:'Published app port', value:String(app.port || ''), readonly:true }
        ],
        submitLabel: 'Save application',
        onSubmit: async values => {
          const memoryMiBValue = Number(values.memoryMiB);
          const cpuValue = Number(values.cpus);
          if (!Number.isInteger(memoryMiBValue)) throw new Error('Memory must be a whole number of MiB.');
          if (!Number.isFinite(cpuValue)) throw new Error('CPU limit must be a number.');
          await dialogApi(`/api/catalog/${encodeURIComponent(id)}/update`, {
            method:'POST',
            body:JSON.stringify({
              memoryMiB: memoryMiBValue,
              cpus: cpuValue,
              restartPolicy: values.restartPolicy
            })
          });
          refreshRuntime();
          window.LightNASToast?.show?.(`${app.name} resource settings saved.`);
        }
      });
    } catch (problem) {
      window.LightNASToast?.show?.(problem.message) || console.warn(problem.message);
    }
    return;
  }

  const containerEdit = event.target.closest('[data-container-edit]');
  if (containerEdit) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try { await showContainerManager(containerEdit.dataset.containerEdit); }
    catch (problem) { alert(problem.message); }
    return;
  }

  const vmEdit = event.target.closest('[data-vm-edit]');
  if (vmEdit) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = vmEdit.dataset.vmEdit;
    let inventory;
    try {
      const cached = window.LightNASRuntimeInventory;
      const cachedItem = (cached?.virtualization?.machineDetails || []).find(candidate => String(candidate.id || candidate.vmid || candidate.name) === String(id));
      inventory = cachedItem ? cached : await dialogApi(`/api/vms/editor?id=${encodeURIComponent(id)}`);
      if (!cachedItem) {
        window.LightNASRuntimeInventory = {
          ...(cached || {}),
          virtualization: {
            ...(cached?.virtualization || {}),
            ...(inventory.virtualization || {})
          }
        };
        inventory = window.LightNASRuntimeInventory;
      }
    } catch (problem) {
      alert(problem.message);
      return;
    }
    const virtualization = inventory.virtualization || {};
    const item = (virtualization.machineDetails || []).find(candidate => String(candidate.id || candidate.vmid || candidate.name) === String(id)) || {};
    const isoOptions = [
      { value: '', label: 'No ISO — empty CD-ROM drive' },
      ...(virtualization.isoDetails || []).map(iso => ({ value: iso.id, label: `${iso.name} · ${iso.storageName}` }))
    ];

    const vmNetworkNames = [...new Set([...(virtualization.networks || []), ...(virtualization.networkDetails || []).map(entry => entry.name || entry.bridge).filter(Boolean)])];
    const vmNetworkOptions = [{ value:'', label:'Do not add a NIC' }, ...vmNetworkNames.map(value => ({ value, label:value }))];
    const vmPoolOptions = [{ value:'', label:'Do not add a disk' }, ...(virtualization.storageDetails || []).map(pool => ({ value:pool.id, label:pool.name || pool.id }))];
    const existingDisks = (item.disks || []).map(disk => `${disk.target || '?'} · ${disk.bus || '?'} · ${disk.source || 'unknown source'}`).join(' | ') || 'No disks reported';
    const existingNics = (item.interfaces || []).map(nic => `${nic.macAddress || 'auto'} · ${nic.model || 'virtio'} · ${nic.network || 'default'}`).join(' | ') || 'No NICs reported';
    const existingHostDevices = (item.hostDevices || []).join(', ') || 'None';
    const recommendedDisplay = item.installationMediaId && item.displayModel === 'virtio' ? 'vga' : (item.displayModel || 'vga');
    const windowsMedia = looksLikeWindowsMedia(item.installationMediaName || '');
    const recommendedDiskBus = windowsMedia && ['scsi', 'virtio'].includes(item.diskBus) ? 'sata' : (item.diskBus || 'scsi');
    const recommendedNetworkModel = windowsMedia && item.networkModel === 'virtio' ? 'e1000' : (item.networkModel || 'virtio');
    showEditor({
      eyebrow: 'VIRTUAL MACHINE SETTINGS',
      wide: true,
      title: `Edit ${vmEdit.dataset.vmName || id}`,
      description: 'Manage VM hardware, installation media, and boot priority. Changing the ISO or boot drive automatically restarts a running VM so noVNC opens the selected boot media.',
      fields: [
        { name: 'name', label: 'VM name', value: item.name || vmEdit.dataset.vmName || id, required: true },
        { name: 'memoryMiB', label: 'Memory (MiB)', type: 'number', value: Math.max(512, Math.round((item.memory || 0) / 1048576) || Number(vmEdit.dataset.vmMemory) || 2048), min: 512, max: 262144, step: 1, required: true },
        { name: 'cpus', label: 'Virtual CPUs', type: 'number', value: item.cpus || vmEdit.dataset.vmCpus || '2', min: 1, max: 128, step: 1, required: true },
        { name: 'diskSizeGiB', label: 'Primary disk size (GiB) · grow only', type:'number', value:item.primaryDiskSizeGiB || '', min:1, max:16384, step:1 },
        { name: 'existingDisks', label: 'Current virtual disks', value:existingDisks, readonly:true },
        { name: 'addDiskPool', label: 'Add data disk · storage', type:'select', value:'', options:vmPoolOptions },
        { name: 'addDiskGiB', label: 'Add data disk · size (GiB)', type:'number', value:'', min:1, max:16384, step:1, placeholder:'Leave blank unless adding a disk' },
        { name: 'firmwareInfo', label: 'BIOS / firmware', value: item.firmware === 'uefi' ? 'UEFI' : 'SeaBIOS', readonly: true },
        { name: 'machineInfo', label: 'Machine type', value: item.machineType || 'Default', readonly: true },
        { name: 'displayModel', label: 'Display adapter', type: 'select', value: recommendedDisplay, options: [{ value: 'vga', label: 'Standard VGA · recommended for installers' }, { value: 'qxl', label: 'QXL display' }, { value: 'virtio', label: 'VirtIO GPU · requires guest drivers' }] },
        { name: 'scsiController', label: 'SCSI controller', type: 'select', value: item.scsiController || 'virtio-scsi', options: [{ value: 'virtio-scsi', label: 'VirtIO SCSI' }, { value: 'virtio-scsi-single', label: 'VirtIO SCSI single' }, { value: 'lsilogic', label: 'LSI Logic' }] },
        { name: 'diskBus', label: 'Virtual disk bus', type: 'select', value: recommendedDiskBus, options: [{ value: 'sata', label: 'SATA / AHCI · Windows compatible' }, { value: 'scsi', label: 'VirtIO SCSI · Linux/performance' }, { value: 'virtio', label: 'VirtIO block · Linux/performance' }] },
        { name: 'networkModel', label: 'Network adapter model · primary', type: 'select', value: recommendedNetworkModel, options: [{ value: 'e1000', label: 'Intel E1000 · Windows compatible' }, { value: 'virtio', label: 'VirtIO · Linux/performance' }, { value: 'rtl8139', label: 'Realtek RTL8139' }] },
        { name:'existingNics', label:'Current virtual NICs', value:existingNics, readonly:true },
        { name:'addNicNetwork', label:'Add virtual NIC · network / bridge', type:'select', value:'', options:vmNetworkOptions },
        { name:'addNicModel', label:'Add virtual NIC · model', type:'select', value:'virtio', options:[{value:'virtio',label:'VirtIO'},{value:'e1000',label:'Intel E1000'},{value:'rtl8139',label:'Realtek RTL8139'}] },
        { name:'existingHostDevices', label:'Current PCI / GPU passthrough', value:existingHostDevices, readonly:true },
        { name:'addPciDevice', label:'Add PCI / GPU passthrough', value:'', placeholder:'0000:65:00.0 · VM must be stopped' },
        { name: 'iso', label: 'CD/DVD drive · installer ISO', type: 'select', value: item.installationMediaId || '', options: isoOptions },
        { name: 'bootOrder', label: 'First boot drive', type: 'select', value: item.bootOrder || (item.installationMediaId ? 'iso' : 'disk'), options: [{ value: 'iso', label: 'CD/DVD installer ISO' }, { value: 'disk', label: 'Virtual hard disk' }] },
        { name: 'startOnBoot', label: 'Start automatically with LightNAS', type: 'select', value: String(item.startOnBoot !== false), options: [{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }] }
      ],
      onSubmit: async values => {
        const memoryMiB = Number(values.memoryMiB);
        const cpus = Number(values.cpus);
        if (!Number.isInteger(memoryMiB) || !Number.isInteger(cpus)) throw new Error('Memory and CPU values must be whole numbers.');
        if (values.bootOrder === 'iso' && !values.iso) throw new Error('Select an installer ISO before choosing the CD/DVD drive as the first boot drive.');
        await dialogApi('/api/vms', { method: 'POST', body: JSON.stringify({
          id, vmid:id, action:'update', name:values.name, memoryMiB, cpus,
          displayModel:values.displayModel, scsiController:values.scsiController, diskBus: values.diskBus, networkModel: values.networkModel,
          iso:values.iso || '', bootOrder: values.bootOrder, startOnBoot:values.startOnBoot === 'true',
          diskSizeGiB:Number(values.diskSizeGiB) || 0, addDiskPool:values.addDiskPool || '', addDiskGiB:Number(values.addDiskGiB) || 0,
          addNicNetwork:values.addNicNetwork || '', addNicModel:values.addNicModel || 'virtio', addPciDevice:values.addPciDevice || ''
        }) });
        refreshRuntime();
      }
    });
    return;
  }

  const cleanDisk = event.target.closest('[data-clean-disk]');
  if (cleanDisk) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = cleanDisk.dataset.cleanDisk;
    const phrase = `CLEAN ${path}`;
    showEditor({
      eyebrow: 'DESTRUCTIVE STORAGE OPERATION',
      title: `Clean ${path}`,
      description: `LightNAS will remove partition/filesystem signatures from this disk. The host agent will refuse OS, mounted, LVM, ZFS, or otherwise in-use disks. Type exactly: ${phrase}`,
      fields: [{ name: 'confirm', label: 'Confirmation', placeholder: phrase, required: true, autocomplete: 'off' }],
      submitLabel: 'Clean disk',
      danger: true,
      onSubmit: async values => {
        if (values.confirm !== phrase) throw new Error(`Type exactly: ${phrase}`);
        await dialogApi('/api/proxmox/disk-clean', { method: 'POST', body: JSON.stringify({ path, confirm: values.confirm }) });
        refreshStorage();
      }
    });
    return;
  }

  const preferredUplink = event.target.closest('[data-uplink-prefer]');
  if (preferredUplink) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const device = preferredUplink.dataset.uplinkPrefer;
    preferredUplink.disabled = true;
    try {
      await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'uplink-prefer', device }) });
      location.reload();
    } catch (problem) {
      alert(problem.message);
      preferredUplink.disabled = false;
    }
    return;
  }

  const networkDevice = event.target.closest('[data-network-device]');
  if (networkDevice) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const device = networkDevice.dataset.networkDevice;
    const action = networkDevice.dataset.networkDeviceAction === 'disconnect' ? 'device-disconnect' : 'device-connect';
    try {
      await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action, device }) });
      location.reload();
    } catch (problem) { alert(problem.message); }
    return;
  }

  const networkEdit = event.target.closest('[data-network-edit]');
  if (networkEdit) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = networkEdit.dataset.networkEdit;
    showEditor({
      eyebrow: 'NETWORK CONNECTION',
      title: `Edit ${name}`,
      description: 'Configure IPv4, gateway and DNS for this NetworkManager profile. Apply can interrupt the current management session if you change the active uplink.',
      fields: [
        { name: 'method', label: 'IPv4 method', type: 'select', value: 'auto', options: [{ value: 'auto', label: 'DHCP / automatic' }, { value: 'manual', label: 'Static / manual' }] },
        { name: 'address', label: 'Static address / CIDR', placeholder: '192.168.1.20/24' },
        { name: 'gateway', label: 'Gateway', placeholder: '192.168.1.1' },
        { name: 'dns', label: 'DNS servers', placeholder: '1.1.1.1,8.8.8.8' },
        { name: 'activate', label: 'Apply immediately', type: 'select', value: 'no', options: [{ value: 'no', label: 'Save only' }, { value: 'yes', label: 'Save and activate now' }] }
      ],
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({
          action: 'connection-update', name,
          method: values.method,
          address: values.address || '',
          gateway: values.gateway || '',
          dns: values.dns || '',
          activate: values.activate === 'yes',
          autoconnect: true
        }) });
        location.reload();
      }
    });
    return;
  }

  const networkDelete = event.target.closest('[data-network-delete]');
  if (networkDelete) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = networkDelete.dataset.networkDelete;
    if (!confirm(`Delete network connection profile "${name}"? Active management connectivity may be interrupted.`)) return;
    try {
      await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'connection-delete', name }) });
      location.reload();
    } catch (problem) { alert(problem.message); }
    return;
  }

  const addBridge = event.target.closest('[data-network-add-bridge]');
  if (addBridge) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let info;
    try { info = await dialogApi('/api/network'); } catch (problem) { alert(problem.message); return; }
    const uplinks = (info.control?.devices || []).filter(item => item.type === 'ethernet').map(item => ({ value: item.name, label: `${item.name} · ${item.state}` }));
    if (!uplinks.length) { alert('No wired Ethernet interface is available for a transparent bridge. Wi-Fi can still be used as the host uplink with routed/NAT guest networking.'); return; }
    showEditor({
      eyebrow: 'NETWORK BRIDGE',
      title: 'Create bridge',
      description: 'Create a local Linux bridge for VMs and system containers and attach a wired Ethernet uplink.',
      fields: [
        { name: 'name', label: 'Bridge name', value: 'lightnas0', required: true },
        { name: 'uplink', label: 'Ethernet uplink', type: 'select', options: uplinks, required: true }
      ],
      submitLabel: 'Create bridge',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'bridge-create', name: values.name, uplink: values.uplink }) });
        location.reload();
      }
    });
    return;
  }

  const addVlan = event.target.closest('[data-network-add-vlan]');
  if (addVlan) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let info;
    try { info = await dialogApi('/api/network'); } catch (problem) { alert(problem.message); return; }
    const parents = (info.control?.devices || []).filter(item => item.type !== 'loopback').map(item => ({ value: item.name, label: `${item.name} · ${item.type}` }));
    if (!parents.length) { alert('No network interface is available for a VLAN.'); return; }
    showEditor({
      eyebrow: 'VLAN',
      title: 'Create VLAN interface',
      description: 'Create a tagged VLAN connection on an existing interface or bridge.',
      fields: [
        { name: 'name', label: 'Connection/interface name', placeholder: 'vlan20', required: true },
        { name: 'parent', label: 'Parent interface', type: 'select', options: parents, required: true },
        { name: 'vlanId', label: 'VLAN ID', type: 'number', min: 1, max: 4094, value: '20', required: true }
      ],
      submitLabel: 'Create VLAN',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'vlan-create', name: values.name, parent: values.parent, vlanId: Number(values.vlanId) }) });
        location.reload();
      }
    });
    return;
  }

  const addBond = event.target.closest('[data-network-add-bond]');
  if (addBond) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let info;
    try { info = await dialogApi('/api/network'); } catch (problem) { alert(problem.message); return; }
    const ethernet = (info.control?.devices || []).filter(item => item.type === 'ethernet').map(item => item.name);
    if (!ethernet.length) { alert('No Ethernet interfaces are available for a bond.'); return; }
    showEditor({
      eyebrow: 'NETWORK BOND',
      title: 'Create bond',
      description: 'Create a bond profile without activating it. Review the configuration before bringing it up so the management connection is not interrupted unexpectedly.',
      fields: [
        { name: 'name', label: 'Bond interface name', value: 'bond0', required: true },
        { name: 'mode', label: 'Bond mode', type: 'select', value: 'active-backup', options: [
          { value: 'active-backup', label: 'Active backup · safest default' },
          { value: '802.3ad', label: '802.3ad / LACP' },
          { value: 'balance-xor', label: 'Balance XOR' },
          { value: 'balance-rr', label: 'Round robin' }
        ] },
        { name: 'members', label: 'Member interfaces (comma separated)', value: ethernet.join(','), placeholder: 'enp1s0,enp2s0', required: true }
      ],
      submitLabel: 'Create bond profile',
      onSubmit: async values => {
        const members = String(values.members || '').split(',').map(item => item.trim()).filter(Boolean);
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'bond-create', name: values.name, mode: values.mode, members }) });
        location.reload();
      }
    });
    return;
  }

  const editRoute = event.target.closest('[data-network-edit-route]');
  if (editRoute) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const runtimeOnly = editRoute.dataset.routeRuntime === 'true';
    showEditor({
      eyebrow: runtimeOnly ? 'ACTIVE ROUTE' : 'STATIC ROUTE',
      title: 'Edit IPv4 route',
      description: runtimeOnly
        ? 'This route comes from the live system/DHCP table. Changes apply immediately and last until the owning connection refreshes or the system reboots.'
        : 'Update this persistent NetworkManager route. Save only is safest; applying immediately can interrupt management connectivity.',
      fields: [
        { name: 'destination', label: 'Destination', value: editRoute.dataset.routeDestination || '', placeholder: '10.20.0.0/16 or default', required: true },
        { name: 'gateway', label: 'Gateway', value: editRoute.dataset.routeGateway || '', placeholder: '10.5.5.1', required: true },
        { name: 'metric', label: 'Metric', type: 'number', min: 0, max: 65535, value: editRoute.dataset.routeMetric || '100', required: true },
        ...(runtimeOnly ? [] : [{ name: 'activate', label: 'Apply immediately', type: 'select', value: 'no', options: [{ value: 'no', label: 'Save only' }, { value: 'yes', label: 'Save and activate profile now' }] }])
      ],
      submitLabel: runtimeOnly ? 'Apply route' : 'Save route',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify(runtimeOnly ? {
          action: 'route-runtime-update',
          oldDestination: editRoute.dataset.routeDestination,
          oldGateway: editRoute.dataset.routeGateway,
          oldMetric: Number(editRoute.dataset.routeMetric || 0),
          device: editRoute.dataset.routeDevice,
          destination: values.destination,
          gateway: values.gateway,
          metric: Number(values.metric)
        } : {
          action: 'route-update',
          connection: editRoute.dataset.routeConnection,
          oldRoute: editRoute.dataset.routeOld,
          destination: values.destination,
          gateway: values.gateway,
          metric: Number(values.metric),
          activate: values.activate === 'yes'
        }) });
        location.reload();
      }
    });
    return;
  }

  const deleteRoute = event.target.closest('[data-network-delete-route]');
  if (deleteRoute) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!confirm('Delete this persistent static route?')) return;
    try {
      await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({
        action: 'route-delete',
        connection: deleteRoute.dataset.routeConnection,
        route: deleteRoute.dataset.routeOld,
        activate: false
      }) });
      location.reload();
    } catch (problem) { alert(problem.message); }
    return;
  }

  const addRoute = event.target.closest('[data-network-add-route]');
  if (addRoute) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let info;
    try { info = await dialogApi('/api/network'); } catch (problem) { alert(problem.message); return; }
    const connections = (info.control?.connections || []).map(item => ({ value: item.name, label: `${item.name} · ${item.device || item.type}` }));
    if (!connections.length) { alert('Create or activate a NetworkManager connection profile before adding a persistent route.'); return; }
    showEditor({
      eyebrow: 'STATIC ROUTE',
      title: 'Add IPv4 route',
      description: 'Save a persistent route on a NetworkManager profile. Choose Save only to avoid interrupting the active management connection.',
      fields: [
        { name: 'connection', label: 'Connection profile', type: 'select', options: connections, required: true },
        { name: 'destination', label: 'Destination', placeholder: '10.20.0.0/16 or default', required: true },
        { name: 'gateway', label: 'Gateway', placeholder: '10.5.5.1', required: true },
        { name: 'metric', label: 'Metric', type: 'number', min: 0, max: 65535, value: '100', required: true },
        { name: 'activate', label: 'Apply immediately', type: 'select', value: 'no', options: [{ value: 'no', label: 'Save only' }, { value: 'yes', label: 'Save and activate profile now' }] }
      ],
      submitLabel: 'Add route',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({
          action: 'route-create',
          connection: values.connection,
          destination: values.destination,
          gateway: values.gateway,
          metric: Number(values.metric),
          activate: values.activate === 'yes'
        }) });
        location.reload();
      }
    });
    return;
  }

  const firewallAdd = event.target.closest('[data-firewall-add]');
  if (firewallAdd) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showEditor({
      eyebrow: 'FIREWALL RULE',
      title: 'Add firewall rule',
      description: 'Add a local UFW rule to the LightNAS host.',
      fields: [
        { name: 'decision', label: 'Action', type: 'select', value: 'allow', options: ['allow', 'deny'] },
        { name: 'protocol', label: 'Protocol', type: 'select', value: 'tcp', options: ['tcp', 'udp'] },
        { name: 'port', label: 'Port', type: 'number', min: 1, max: 65535, required: true },
        { name: 'source', label: 'Source IP/CIDR (optional)', placeholder: '10.0.0.0/24' }
      ],
      submitLabel: 'Add rule',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'firewall-add', decision: values.decision, protocol: values.protocol, port: Number(values.port), source: values.source || '' }) });
        location.reload();
      }
    });
    return;
  }

  const firewallDelete = event.target.closest('[data-firewall-delete]');
  if (firewallDelete) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!confirm(`Delete firewall rule #${firewallDelete.dataset.firewallDelete}?`)) return;
    try {
      await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'firewall-delete', number: Number(firewallDelete.dataset.firewallDelete) }) });
      location.reload();
    } catch (problem) { alert(problem.message); }
    return;
  }

  const firewallToggle = event.target.closest('[data-firewall-toggle]');
  if (firewallToggle) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const action = firewallToggle.dataset.firewallToggle === 'disable' ? 'firewall-disable' : 'firewall-enable';
    if (action === 'firewall-disable' && !confirm('Disable the LightNAS host firewall?')) return;
    try {
      await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action }) });
      location.reload();
    } catch (problem) { alert(problem.message); }
    return;
  }

  const wifiConnect = event.target.closest('[data-wifi-connect]');
  if (wifiConnect) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let info;
    try { info = await dialogApi('/api/network'); }
    catch (problem) { alert(problem.message); return; }
    const wifiDevices = (info.control?.devices || []).filter(item => item.type === 'wifi');
    if (!wifiDevices.length) { alert('No Wi-Fi device is available.'); return; }
    const ssid = wifiConnect.dataset.wifiConnect;
    showEditor({
      eyebrow: 'WI-FI',
      title: `Connect to ${ssid}`,
      description: 'Use Wi-Fi as the LightNAS management/uplink connection. VMs and containers can use a routed/NAT virtual network when Wi-Fi cannot be transparently bridged.',
      fields: [
        { name: 'device', label: 'Wi-Fi adapter', type: 'select', options: wifiDevices.map(item => ({ value: item.name, label: `${item.name} · ${item.state}` })), required: true },
        { name: 'password', label: 'Wi-Fi password', type: 'password', value: '', autocomplete: 'new-password' }
      ],
      submitLabel: 'Connect',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'wifi-connect', device: values.device, ssid, password: values.password || '' }) });
        location.reload();
      }
    });
    return;
  }

}, true);
