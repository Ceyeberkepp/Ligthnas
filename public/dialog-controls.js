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
  const finish = (kind, message) => {
    clearInterval(timer);
    const state = dialog.querySelector('[data-transfer-state]');
    state.classList.remove('is-running', 'is-success', 'is-error');
    state.classList.add(kind === 'success' ? 'is-success' : 'is-error');
    dialog.querySelector('[data-transfer-title]').textContent = kind === 'success' ? 'Download complete' : 'Download failed';
    dialog.querySelector('[data-transfer-detail]').textContent = message;
    dialog.querySelector('[data-transfer-elapsed]').textContent = kind === 'success' ? 'The image is ready to use.' : 'Nothing incomplete will be shown in the image library.';
    dialog.querySelector('[data-transfer-error]').textContent = kind === 'error' ? message : '';
    dialog.querySelector('[data-transfer-ok]').classList.remove('hidden');
  };
  dialog.querySelector('[data-transfer-ok]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return {
    succeed(message = 'The image finished downloading and is ready to use.') { finish('success', message); },
    fail(message = 'The transfer could not be completed.') { finish('error', message); },
    close() { closeDialog(dialog); }
  };
}

window.LightNASProgress = { open: openProgressDialog };

function wizardOption(value, label, selected = false) {
  return `<option value="${dialogEsc(value)}" ${selected ? 'selected' : ''}>${dialogEsc(label)}</option>`;
}

async function showRuntimeWizard(kind) {
  const inventory = await dialogApi('/api/runtimes');
  const runtime = inventory?.[kind];
  const isContainer = kind === 'containers';
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
          ${isContainer ? '<label>Root password<input name="password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required placeholder="At least 10 characters"></label><label>Confirm root password<input name="passwordConfirm" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label>' : ''}
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
      await dialogApi(isContainer ? '/api/containers' : '/api/vms', { method: 'POST', body: JSON.stringify(payload) });
      dialog.close();
      refreshRuntime();
      progress.succeed(`${name} was created successfully and is ready to use.`);
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

// Register before enhancements/admin-security so these native LightNAS dialogs
// replace the temporary browser prompt() implementations.
document.addEventListener('click', async event => {
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
    const id = containerEdit.dataset.containerEdit;
    const currentName = containerEdit.dataset.containerName || id;
    showEditor({
      eyebrow: 'SYSTEM CONTAINER SETTINGS',
      title: `Edit ${currentName}`,
      description: 'Change CPU and memory limits for this native LightNAS LXC container. Rename is intentionally blocked until LightNAS can safely migrate its rootfs path.',
      fields: [
        { name: 'name', label: 'Container name', value: currentName, required: true },
        { name: 'memoryMiB', label: 'Memory (MiB)', type: 'number', value: containerEdit.dataset.containerMemory || '2048', min: 256, max: 262144, step: 1, required: true },
        { name: 'cpus', label: 'Virtual CPUs', type: 'number', value: containerEdit.dataset.containerCpus || '2', min: 1, max: 128, step: 1, required: true }
      ],
      onSubmit: async values => {
        const memoryMiB = Number(values.memoryMiB);
        const cpus = Number(values.cpus);
        if (!Number.isInteger(memoryMiB) || !Number.isInteger(cpus)) throw new Error('Memory and CPU values must be whole numbers.');
        await dialogApi('/api/containers', { method: 'POST', body: JSON.stringify({ id, action: 'update', name: values.name, memoryMiB, cpus }) });
        refreshRuntime();
      }
    });
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
