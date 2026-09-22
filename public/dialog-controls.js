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

function showEditor({ eyebrow, title, description, fields, submitLabel = 'Save changes', danger = false, onSubmit }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog';
  dialog.innerHTML = `
    <form class="dialog-body">
      <div class="dialog-head">
        <div><span class="eyebrow">${eyebrow}</span><h2></h2></div>
        <button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <p class="muted" data-dialog-description></p>
      <div data-dialog-fields></div>
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions">
        <button class="secondary" type="button" data-dialog-close>Cancel</button>
        <button class="${danger ? 'secondary danger-button' : 'primary'}" type="submit">${submitLabel}</button>
      </div>
    </form>`;

  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('[data-dialog-description]').textContent = description;
  const fieldRoot = dialog.querySelector('[data-dialog-fields]');
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement(field.type === 'select' ? 'select' : 'input');
    input.name = field.name;
    if (field.type && field.type !== 'select') input.type = field.type;
    if (field.value !== undefined) input.value = field.value;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    if (field.required) input.required = true;
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
    fieldRoot.append(label);
  }

  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => closeDialog(dialog)));
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
  setTimeout(() => dialog.querySelector('input,select')?.focus(), 0);
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

function openProgressDialog(title, detail) {
  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog transfer-dialog';
  dialog.innerHTML = `
    <div class="dialog-body">
      <div class="transfer-state is-running" data-transfer-state>
        <div class="transfer-spinner" aria-hidden="true"></div>
        <div class="transfer-result-icon" aria-hidden="true">✓</div>
        <span class="eyebrow">TRANSFER IN PROGRESS</span>
        <h2 data-transfer-title></h2>
        <p class="muted" data-transfer-detail></p>
        <div class="transfer-progress" aria-label="Transfer in progress"><span></span></div>
        <p class="transfer-elapsed" data-transfer-elapsed>Starting…</p>
        <div class="form-error" data-transfer-error role="alert"></div>
        <div class="dialog-actions"><button class="primary hidden" type="button" data-transfer-ok>OK</button></div>
      </div>
    </div>`;
  dialog.querySelector('[data-transfer-title]').textContent = title;
  dialog.querySelector('[data-transfer-detail]').textContent = detail || 'Please keep this page open.';
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
    dialog.querySelector('[data-transfer-elapsed]').textContent = kind === 'success'
      ? (/upload|download/i.test(initialTitle) ? 'The image is ready to use.' : 'The requested changes are active.')
      : (/upload|download/i.test(initialTitle) ? 'Nothing incomplete will be shown in the image library.' : 'The requested changes were not completed.');
    dialog.querySelector('[data-transfer-error]').textContent = kind === 'error' ? message : '';
    dialog.querySelector('[data-transfer-ok]').classList.remove('hidden');
  };
  dialog.querySelector('[data-transfer-ok]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return {
    update(percent, message = '') {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
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

async function showRuntimeWizard(kind) {
  const isContainer = kind === 'containers';
  const loading = openProgressDialog(isContainer ? 'Opening container wizard' : 'Opening VM wizard', 'Loading live storage, image, network, and runtime choices…');
  let inventory;
  try {
    if (isContainer) {
      const containers = window.LightNASContainerInventory || await dialogApi('/api/containers/inventory');
      window.LightNASContainerInventory = containers;
      inventory = { containers };
    } else {
      inventory = window.LightNASRuntimeInventory || await dialogApi('/api/runtimes');
      window.LightNASRuntimeInventory = inventory;
    }
  } finally {
    loading.close();
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
  const title = isContainer ? 'Create system container' : 'Create virtual machine';
  const imageLabel = isContainer ? 'Linux image / template' : 'Installer ISO';
  const defaultName = isContainer ? 'debian-services' : 'new-vm';
  dialog.innerHTML = `
    <form class="dialog-body runtime-wizard-form">
      <div class="dialog-head">
        <div><span class="eyebrow">${isContainer ? 'SYSTEM CONTAINER' : 'VIRTUAL MACHINE'} WIZARD</span><h2>${title}</h2></div>
        <button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="wizard-steps" aria-label="Creation steps">
        <span class="active" data-step-indicator="0"><b>1</b>Identity</span>
        <span data-step-indicator="1"><b>2</b>Resources</span>
        <span data-step-indicator="2"><b>3</b>Network</span>
        <span data-step-indicator="3"><b>4</b>Review</span>
      </div>
      <section class="wizard-page active" data-wizard-page="0">
        <h3>Identity and installation media</h3>
        <p class="muted">Choose a unique name and the image that will be installed.</p>
        <div class="wizard-grid">
          <label>${isContainer ? 'Container' : 'VM'} name<input name="name" value="${defaultName}" pattern="[A-Za-z][A-Za-z0-9-]{1,39}" required></label>
          <label>${imageLabel}<select name="${isContainer ? 'image' : 'iso'}" ${isContainer ? 'required' : ''}>${images.map(item => wizardOption(item.value, item.label)).join('')}</select></label>
          ${isContainer ? '<label>Root password<input name="password" type="password" minlength="4" maxlength="128" autocomplete="new-password" required placeholder="At least 4 characters"></label><label>Confirm root password<input name="passwordConfirm" type="password" minlength="4" maxlength="128" autocomplete="new-password" required></label>' : ''}
        </div>
        <p class="module-note">${isContainer ? 'The root password is sent only to the local privileged host agent and is not stored by the LightNAS web service.' : 'Upload or download ISO images from Storage → Pools & datasets → ISO images.'}</p>
      </section>
      <section class="wizard-page" data-wizard-page="1">
        <h3>Compute and storage</h3>
        <p class="muted">Select where the guest lives and how many resources it can use.</p>
        <div class="wizard-grid">
          <label>Storage<select name="pool" required>${storages.map((item, index) => wizardOption(item.id, `${item.name || item.id}${item.availableBytes !== undefined ? ` · ${Math.round(item.availableBytes / 1073741824)} GiB free` : ''}`, index === 0)).join('')}</select></label>
          <label>${isContainer ? 'Root disk allocation' : 'Virtual disk size'} (GiB)<input name="diskGiB" type="number" min="${isContainer ? 2 : 10}" max="2048" value="${isContainer ? 8 : 32}" required></label>
          <label>Memory (MiB)<input name="memoryMiB" type="number" min="${isContainer ? 256 : 1024}" max="65536" value="2048" required></label>
          <label>Virtual CPUs<input name="cpus" type="number" min="1" max="32" value="2" required></label>
        </div>
      </section>
      <section class="wizard-page" data-wizard-page="2">
        <h3>Network and advanced options</h3>
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
            <label>Disk controller<select name="diskBus"><option value="scsi">VirtIO SCSI</option><option value="virtio">VirtIO block</option><option value="sata">SATA</option></select></label>
            <label>Network adapter<select name="networkModel"><option value="virtio">VirtIO</option><option value="e1000">Intel E1000</option><option value="rtl8139">Realtek RTL8139</option></select></label>
          `}
          <label class="wizard-check"><input name="startOnBoot" type="checkbox" checked> <span>Start automatically when LightNAS boots</span></label>
        </div>
      </section>
      <section class="wizard-page" data-wizard-page="3">
        <h3>Review and create</h3>
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
      startOnBoot: form.elements.startOnBoot.checked
    };
    delete payload.passwordConfirm;
    create.disabled = true;
    const progress = openProgressDialog(isContainer ? 'Creating system container' : 'Creating virtual machine', `Preparing ${name}. This can take several minutes.`);
    try {
      const result = await dialogApi(isContainer ? '/api/containers' : '/api/vms', { method: 'POST', body: JSON.stringify(payload) });
      dialog.close();
      refreshRuntime();
      const selectedImage = images.find(item => item.value === (isContainer ? payload.image : payload.iso))?.label || payload.image || payload.iso || '';
      progress.succeed(isContainer
        ? `${name} was created, ${result.installedImage || selectedImage} was verified and installed, and the container is running.`
        : `${name} was created successfully and is ready to use.`);
    } catch (problem) {
      progress.fail(problem.message);
      error.textContent = problem.message;
      create.disabled = false;
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
    const progress = openProgressDialog(`Deleting ${label}`, `Removing ${id} and all managed files…`);
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
  const [runtime, overview] = await Promise.all([
    dialogApi('/api/containers/inventory'),
    dialogApi('/api/overview').catch(() => ({ activity: [], appliance: {} }))
  ]);
  const item = (runtime.containers || []).find(entry => String(entry.id || entry.name) === id);
  if (!item) throw new Error('Container is no longer available.');
  const networks = runtime.networks || [];
  const currentNetwork = item.network || networks[0] || '';
  const publication = item.publication || null;
  const memoryMiB = Math.max(256, Math.round(Number(item.memory || 0) / 1024 / 1024) || 2048);
  const tasks = (overview.activity || []).filter(entry =>
    JSON.stringify(entry).toLowerCase().includes(id.toLowerCase())
  );
  const taskRows = tasks.length
    ? tasks.map(entry => `<article class="manager-event"><b>${dialogEsc(entry.message || entry.detail || entry.type || 'Container task')}</b><span>${dialogEsc(entry.createdAt || entry.timestamp || '')}</span></article>`).join('')
    : '<p class="muted">No recorded LightNAS tasks for this container yet.</p>';

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
            ['resources','Resources'],['network','Network'],['dns','DNS'],['application','Application access'],['options','Options'],
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
          <section data-container-panel="network" hidden>
            <h3>Network</h3>
            <div class="form-grid">
              <label>Bridge / network<select name="network">${networks.map(value => `<option value="${dialogEsc(value)}" ${value === currentNetwork ? 'selected' : ''}>${dialogEsc(value)}</option>`).join('')}</select></label>
              <label>IPv4 configuration<select name="ipv4Mode"><option value="dhcp" ${item.ipv4Mode !== 'manual' ? 'selected' : ''}>DHCP</option><option value="manual" ${item.ipv4Mode === 'manual' ? 'selected' : ''}>Static</option></select></label>
              <label>IPv4 address / prefix<input name="ipv4Address" value="${dialogEsc(item.ipv4Address || '')}" placeholder="192.168.1.50/24"></label>
              <label>Gateway<input name="gateway" value="${dialogEsc(item.gateway || '')}" placeholder="192.168.1.1"></label>
              <label>MAC address<input value="${dialogEsc(item.macAddress || 'Automatically assigned')}" readonly></label>
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
            <p class="muted">Publish a web service running inside this private system container through the LightNAS LAN address.</p>
            <label class="check-line"><input name="publishApplication" type="checkbox" ${publication ? 'checked' : ''}> Make this application accessible from the LightNAS network</label>
            <div class="form-grid" data-publication-fields>
              <label>LightNAS port<input name="hostPort" type="number" min="1024" max="65535" value="${Number(publication?.hostPort) || 8443}"></label>
              <label>Container port<input name="targetPort" type="number" min="1" max="65535" value="${Number(publication?.targetPort) || 443}"></label>
              <label>Protocol<select name="scheme"><option value="https" ${publication?.scheme !== 'http' ? 'selected' : ''}>HTTPS</option><option value="http" ${publication?.scheme === 'http' ? 'selected' : ''}>HTTP</option></select></label>
              <label>Container address<input value="${dialogEsc(item.ipv4 || publication?.targetHost || 'Detected automatically when saved')}" readonly></label>
            </div>
            <p class="module-note">For TurnKey Faveo use container port <b>443</b>, protocol <b>HTTPS</b>. LightNAS will create and preserve the port publication automatically.</p>
          </section>
          <section data-container-panel="options" hidden>
            <h3>Options</h3>
            <label class="check-line"><input name="startOnBoot" type="checkbox" ${item.startOnBoot !== false ? 'checked' : ''}> Start container automatically when LightNAS starts</label>
            <div class="manager-summary">
              <div><span>Provider</span><b>${dialogEsc(item.provider || 'local-lxc')}</b></div>
              <div><span>Status</span><b>${dialogEsc(item.status || 'unknown')}</b></div>
              <div><span>PID</span><b>${dialogEsc(item.pid || 'Not running')}</b></div>
            </div>
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
  dialog.addEventListener('close', () => dialog.remove(), { once: true });

  const mode = dialog.querySelector('[name="ipv4Mode"]');
  const publishApplication = dialog.querySelector('[name="publishApplication"]');
  const updateNetworkFields = () => {
    const manual = mode.value === 'manual';
    dialog.querySelector('[name="ipv4Address"]').required = manual;
    dialog.querySelector('[name="ipv4Address"]').disabled = !manual;
    dialog.querySelector('[name="gateway"]').disabled = !manual;
  };
  mode.addEventListener('change', updateNetworkFields);
  updateNetworkFields();
  const updatePublicationFields = () => {
    dialog.querySelectorAll('[data-publication-fields] input, [data-publication-fields] select').forEach(field => { field.disabled = !publishApplication.checked; });
  };
  publishApplication.addEventListener('change', updatePublicationFields);
  updatePublicationFields();

  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.form-error');
    const submit = form.querySelector('button[type="submit"]');
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Saving…';
    const progress = openProgressDialog('Saving container settings', `Applying settings for ${item.name || id}…`);
    try {
      const values = Object.fromEntries(new FormData(form));
      const payload = {
        id, action: 'update', name: values.name,
        memoryMiB: Number(values.memoryMiB), cpus: Number(values.cpus),
        network: values.network, ipv4Mode: values.ipv4Mode,
        ipv4Address: values.ipv4Address || '', gateway: values.gateway || '',
        dns: values.dns || '', startOnBoot: form.elements.startOnBoot.checked
      };
      if (!Number.isInteger(payload.memoryMiB) || !Number.isInteger(payload.cpus)) throw new Error('Memory and CPU values must be whole numbers.');
      const settingsChanged = payload.memoryMiB !== memoryMiB
        || payload.cpus !== (Number(item.cpus) || 2)
        || payload.network !== currentNetwork
        || payload.ipv4Mode !== (item.ipv4Mode === 'manual' ? 'manual' : 'dhcp')
        || payload.ipv4Address.trim() !== String(item.ipv4Address || '').trim()
        || payload.gateway.trim() !== String(item.gateway || '').trim()
        || payload.dns.trim() !== String(item.dns || '').trim()
        || payload.startOnBoot !== (item.startOnBoot !== false);
      if (settingsChanged) await dialogApi('/api/containers', { method: 'POST', body: JSON.stringify(payload) });
      if (form.elements.publishApplication.checked) {
        await dialogApi('/api/containers', { method: 'POST', body: JSON.stringify({
          id, action: 'publish', hostPort: Number(values.hostPort), targetPort: Number(values.targetPort), scheme: values.scheme
        }) });
      } else if (publication) {
        await dialogApi('/api/containers', { method: 'POST', body: JSON.stringify({ id, action: 'unpublish' }) });
      }
      dialog.close();
      refreshRuntime();
      progress.succeed(`${item.name || id} was saved. Its application access is ${form.elements.publishApplication.checked ? `available on LightNAS port ${values.hostPort}` : 'not published'}.`);
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
    catch (problem) { alert(problem.message); }
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
    showEditor({
      eyebrow: 'VIRTUAL MACHINE SETTINGS',
      title: `Edit ${vmEdit.dataset.vmName || id}`,
      description: 'Change the native KVM/libvirt VM name, assigned memory, or vCPU count. A running VM must be shut down before rename.',
      fields: [
        { name: 'name', label: 'VM name', value: vmEdit.dataset.vmName || id, required: true },
        { name: 'memoryMiB', label: 'Memory (MiB)', type: 'number', value: vmEdit.dataset.vmMemory || '2048', min: 512, max: 262144, step: 1, required: true },
        { name: 'cpus', label: 'Virtual CPUs', type: 'number', value: vmEdit.dataset.vmCpus || '2', min: 1, max: 128, step: 1, required: true }
      ],
      onSubmit: async values => {
        const memoryMiB = Number(values.memoryMiB);
        const cpus = Number(values.cpus);
        if (!Number.isInteger(memoryMiB) || !Number.isInteger(cpus)) throw new Error('Memory and CPU values must be whole numbers.');
        await dialogApi('/api/vms', { method: 'POST', body: JSON.stringify({ id, action: 'update', name: values.name, memoryMiB, cpus }) });
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
