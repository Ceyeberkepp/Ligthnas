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
