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

// Register before enhancements/admin-security so these native LightNAS dialogs
// replace the temporary browser prompt() implementations.
document.addEventListener('click', async event => {
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

  const wifiConnect = event.target.closest('[data-wifi-connect]');
  if (wifiConnect) {
    event.preventDefault();
    event.stopImmediatePropagation();
    let info;
    try { info = await dialogApi('/api/network'); }
    catch (problem) { alert(problem.message); return; }
    const device = info.wifi?.devices?.[0]?.name;
    if (!device) { alert('No Wi-Fi device is available.'); return; }
    const ssid = wifiConnect.dataset.wifiConnect;
    showEditor({
      eyebrow: 'WI-FI',
      title: `Connect to ${ssid}`,
      description: `Connect ${device} to this wireless network. Leave the password blank only for an open network.`,
      fields: [{ name: 'password', label: 'Wi-Fi password', type: 'password', value: '', autocomplete: 'new-password' }],
      submitLabel: 'Connect',
      onSubmit: async values => {
        await dialogApi('/api/network', { method: 'POST', body: JSON.stringify({ action: 'wifi-connect', device, ssid, password: values.password || '' }) });
        location.reload();
      }
    });
  }
}, true);
