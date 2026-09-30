const storageUi = { data: null };

const STORAGE_ADD_TYPES = [
  ['directory','Directory'],
  ['lvm','LVM'],
  ['lvm-thin','LVM-Thin'],
  ['btrfs','BTRFS'],
  ['nfs','NFS'],
  ['smb-cifs','SMB/CIFS'],
  ['glusterfs','GlusterFS'],
  ['iscsi','iSCSI'],
  ['cephfs','CephFS'],
  ['rbd','RBD'],
  ['zfs-over-iscsi','ZFS over iSCSI'],
  ['zfs','ZFS'],
  ['proxmox-backup-server','Proxmox Backup Server'],
  ['esxi','ESXi']
];

function storageAddMenu() {
  return '<div class="storage-add-menu" data-storage-add-menu>' +
    '<button class="secondary storage-add-toggle" type="button" data-storage-add-toggle aria-haspopup="menu" aria-expanded="false">Add <span aria-hidden="true">⌄</span></button>' +
    '<div class="storage-add-dropdown" role="menu" hidden>' +
      STORAGE_ADD_TYPES.map(([id,label]) =>
        '<button type="button" role="menuitem" data-storage-add-type="' + sEsc(id) + '">' +
          '<span class="storage-type-icon" aria-hidden="true">▣</span><span>' + sEsc(label) + '</span>' +
        '</button>'
      ).join('') +
    '</div>' +
  '</div>';
}


function sEsc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]);
}
function sBytes(value) {
  const n0 = Number(value);
  if (!Number.isFinite(n0)) return '—';
  const units = ['B','KiB','MiB','GiB','TiB','PiB'];
  let n=n0,u=0; while(n>=1024&&u<units.length-1){n/=1024;u+=1;}
  const decimals=u>=4?2:n>=100?0:n>=10?1:u===0?0:2;
  const rendered=n.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0+$/g,'');
  return `${rendered} ${units[u]}`;
}
async function sRequest(path, options={}) {
  const response=await fetch(path,{...options,headers:{'X-LightNAS-Request':'1',...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(body.error||'Storage operation failed.');
  return body;
}
function contentCheckboxes(types, selected=[]) {
  const descriptions = {
    iso:'Operating-system installation media',
    vztmpl:'Linux system-container images',
    images:'Virtual-machine disks',
    rootdir:'Native container root volumes',
    backup:'VM and container backups',
    snippets:'Scripts and configuration snippets',
    files:'General files and media'
  };
  return types.map(type=>`<label class="content-check"><input type="checkbox" value="${sEsc(type.id)}" ${selected.includes(type.id)?'checked':''}> <span><b>${sEsc(type.label)}</b><small>${sEsc(descriptions[type.id] || type.id)}</small></span></label>`).join('');
}

function sourceLabel(source) {
  const capacity = source.capacitySource === 'proxmox-pct-config'
    ? sBytes(source.totalBytes)
    : (source.totalBytes ? `${sBytes(source.totalBytes)} visible` : 'size reported by host');
  return `${source.mountPoint} · ${source.device || source.type || 'volume'} · ${capacity}`;
}

function ensureStorageDialog() {
  let dialog=document.querySelector('#lightnas-storage-dialog');
  if(dialog) return dialog;
  dialog=document.createElement('dialog');
  dialog.id='lightnas-storage-dialog';
  dialog.className='lightnas-dialog runtime-dialog';
  dialog.innerHTML=`
    <div class="dialog-body">
      <div class="dialog-head"><div><span class="eyebrow">LIGHTNAS STORAGE</span><h2 data-storage-dialog-title>Storage</h2></div><button type="button" class="dialog-close" data-storage-dialog-close>×</button></div>
      <div data-storage-dialog-body></div>
      <div class="form-error" data-storage-dialog-error role="alert"></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-storage-dialog-close>Close</button></div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-storage-dialog-close]').forEach(button=>button.addEventListener('click',()=>dialog.close()));
  return dialog;
}
async function loadStoragePools() {
  storageUi.data=await sRequest('/api/storage/pools');
  return storageUi.data;
}
function storageCard(pool) {
  const contents=(pool.contentLabels||[]).join(' · ')||'No content types';
  return `<article class="inventory-card storage-pool-card" data-storage-card="${sEsc(pool.id)}" role="button" tabindex="0" aria-label="Manage storage ${sEsc(pool.name)}">
    <div class="volume-title"><h3>${sEsc(pool.name)}</h3><span class="volume-state ${pool.online&&pool.writable?'writable':'readonly'}">${pool.online?(pool.writable?'ONLINE':'READ ONLY'):'OFFLINE'}</span></div>
    <p>${pool.local?(pool.dedicated?'Local appliance storage · dedicated post-OS data partition':'Local appliance storage · shared with the OS filesystem'):sEsc(pool.mountPoint||'Attached virtual storage')}</p>
    <div class="track"><span style="width:${Math.min(100,pool.usedPercent||0)}%"></span></div>
    <p><strong>${sBytes(pool.availableBytes)} free</strong> of ${sBytes(pool.totalBytes)} · ${pool.usedPercent||0}% used</p>
    <p class="muted">${sEsc(contents)}</p>
    <button class="secondary" type="button" data-manage-storage="${sEsc(pool.id)}">Manage storage</button>
  </article>`;
}
function renderStorageManager() {
  const slot=document.querySelector('#storage-manager');
  const data=storageUi.data;
  if(!slot||!data) return;
  const visible=data.visibleSummary||data.summary||{};
  const unconfigured=(data.availableSources||[]).filter(item=>!item.configured);
  const verified=visible.verified!==false;
  const sharedLocalExcluded=Boolean(visible.localExcludedBecauseSharedOs);
  const dataSources=(data.availableSources||[]);
  slot.innerHTML=`
    <section class="module-hero storage-manager-hero">
      <div class="panel-head"><div><span class="eyebrow">LIGHTNAS STORAGE MANAGER</span><h2>${verified ? `${sBytes(visible.totalBytes||0)} data capacity` : `${dataSources.length} attached volume${dataSources.length===1?'':'s'} detected`}</h2></div>

      </div>
      <p>${verified
        ? `${sBytes(visible.usedBytes||0)} used · ${sBytes(visible.availableBytes||0)} free across attached data volumes.${sharedLocalExcluded?' The OS/root-backed local storage is shown separately and is not included in this total.':''}`
        : `LightNAS can use the mounted volumes below now. Exact host-provisioned capacity is not available inside this container, so displayed capacity is based on what the guest can currently see.`}</p>
      <div class="storage-volume-chips">${dataSources.map(source=>`<span class="${source.configured?'configured':''}"><b>${sEsc(source.mountPoint)}</b><small>${sEsc(source.device||source.type||'volume')} · ${source.capacitySource==='proxmox-pct-config'?sBytes(source.totalBytes):sBytes(source.availableBytes)+' free'}${source.configured?' · already in use':''}</small></span>`).join('')}</div>
    </section>
    <div class="storage-section-heading"><div><span class="eyebrow">CONFIGURED STORAGE</span><h2>Storage pools</h2></div><small>${(data.pools||[]).length} configured</small></div>
    <div class="inventory-grid">${(data.pools||[]).map(storageCard).join('')||'<div class="empty"><p>No storage pools are online.</p></div>'}</div>
    ${unconfigured.length?`<div class="storage-section-heading"><div><span class="eyebrow">AVAILABLE VOLUMES</span><h2>Ready to add</h2></div><small>${unconfigured.length} available</small></div><div class="inventory-grid">${unconfigured.map(source=>`<article class="inventory-card available-volume-card"><div class="volume-title"><h3>${sEsc(source.mountPoint)}</h3><span class="volume-state ${source.mountedReadOnly?'readonly':'writable'}">${source.mountedReadOnly?'READ ONLY':source.writable?'AVAILABLE':'READY TO CLAIM'}</span></div><p>${sEsc(source.device)} · ${sEsc(source.type)}</p><div class="storage-volume-capacity"><strong>${sBytes(source.availableBytes)} free</strong><span>${source.capacitySource==='proxmox-pct-config'?`of ${sBytes(source.totalBytes)}`:'guest-visible capacity'}</span></div>${source.capacitySource==='proxmox-pct-config'?`<p class="muted">Host-provisioned size: <b>${sEsc(source.configuredSize||sBytes(source.totalBytes))}</b></p>`:''}${!source.mountedReadOnly?`<button class="primary" type="button" data-create-storage-source="${sEsc(source.id)}">Use this volume</button>`:'<p class="muted">This mount is genuinely read-only at the host level and must be remounted read/write before LightNAS can use it.</p>'}</article>`).join('')}</div>`:''}
    ${(data.detectedDisks||[]).length?`<h2>Detected drives</h2><p class="muted">LightNAS automatically detects new physical and virtual disks. It never formats a drive automatically; destructive initialization stays an explicit administrator action.</p><div class="inventory-grid">${data.detectedDisks.map(disk=>`<article class="inventory-card detected-disk-card"><div class="volume-title"><h3>${sEsc(disk.model||disk.name||disk.path)}</h3><span class="volume-state ${disk.system?'readonly':disk.blank?'writable':''}">${disk.system?'SYSTEM':disk.blank?'NEW DRIVE':disk.mounted?'MOUNTED':'DETECTED'}</span></div><p>${sEsc(disk.path||disk.name)} · ${sBytes(disk.sizeBytes)}${disk.transport?` · ${sEsc(disk.transport)}`:''}</p><p class="muted">${disk.system?'Contains the LightNAS operating system and is protected from storage initialization.':disk.blank?'Blank drive detected. It is visible immediately and ready for an explicit storage initialization workflow.':'Partitions: '+((disk.partitions||[]).map(part=>sEsc(part.path)+(part.filesystem?` (${sEsc(part.filesystem)})`:'')).join(' · ')||'none')}</p></article>`).join('')}</div>`:''}
  `;
}
async function refreshStorageManager() {
  const slot=document.querySelector('#storage-manager');
  if(slot) slot.innerHTML='<div class="empty"><p>Loading LightNAS storage…</p></div>';
  try{await loadStoragePools();renderStorageManager();}
  catch(error){if(slot) slot.innerHTML=`<div class="module-note">Storage manager unavailable: ${sEsc(error.message)}</div>`;}
}
function openCreateStorage(sourceId='', provider='directory') {
  const data=storageUi.data;
  if(!data) return;
  const providerEntry=STORAGE_ADD_TYPES.find(([id])=>id===provider)||STORAGE_ADD_TYPES[0];
  provider=providerEntry[0];
  const providerLabel=providerEntry[1];
  const sources=(data.availableSources||[]).filter(item=>!item.configured);
  const writableSources=sources.filter(item=>!item.mountedReadOnly);
  const dialog=ensureStorageDialog();
  dialog.querySelector('[data-storage-dialog-title]').textContent=`Add ${providerLabel} storage`;
  dialog.querySelector('[data-storage-dialog-error]').textContent='';

  const localTypes=new Set(['directory','lvm','lvm-thin','btrfs','zfs']);
  const providerFields={
    directory:'',
    lvm:`<label>Volume group<input name="vgName" placeholder="vg-data"><small>Optional label for the LVM volume group behind this mounted source.</small></label>`,
    'lvm-thin':`<label>Volume group<input name="vgName" placeholder="vg-data"></label><label>Thin pool<input name="thinPool" placeholder="thinpool"></label>`,
    btrfs:`<label>BTRFS subvolume<input name="subvolume" placeholder="@lightnas"><small>Optional subvolume name for this mounted BTRFS source.</small></label>`,
    zfs:`<label>ZFS pool / dataset<input name="dataset" placeholder="tank/lightnas"><small>Optional dataset label for this mounted ZFS source.</small></label>`,
    nfs:`<label>NFS server<input name="server" placeholder="192.168.1.20" required></label><label>NFS export<input name="exportPath" placeholder="/exports/lightnas" required></label><label>Mount options<input name="mountOptions" placeholder="vers=4.2"></label>`,
    'smb-cifs':`<label>SMB server<input name="server" placeholder="fileserver.local" required></label><label>Share<input name="share" placeholder="LightNAS" required></label><label>Username<input name="username" autocomplete="off"></label><label>Password<input name="password" type="password" autocomplete="new-password"></label><label>Domain / workgroup<input name="domain" placeholder="WORKGROUP"></label>`,
    glusterfs:`<label>Gluster server<input name="server" placeholder="gluster01.local" required></label><label>Volume name<input name="volume" placeholder="gv0" required></label>`,
    iscsi:`<label>Portal<input name="portal" placeholder="192.168.1.30:3260" required></label><label>Target IQN<input name="target" placeholder="iqn.2026-01.local.storage:target1" required></label><label>CHAP username<input name="username"></label><label>CHAP password<input name="password" type="password"></label>`,
    cephfs:`<label>Monitor hosts<input name="monitors" placeholder="10.0.0.11,10.0.0.12" required></label><label>Filesystem name<input name="filesystem" placeholder="cephfs" required></label><label>Ceph user<input name="username" placeholder="admin"></label><label>Secret / key<input name="secret" type="password"></label>`,
    rbd:`<label>Monitor hosts<input name="monitors" placeholder="10.0.0.11,10.0.0.12" required></label><label>RBD pool<input name="rbdPool" placeholder="rbd" required></label><label>Ceph user<input name="username" placeholder="admin"></label><label>Secret / key<input name="secret" type="password"></label>`,
    'zfs-over-iscsi':`<label>iSCSI portal<input name="portal" placeholder="192.168.1.30:3260" required></label><label>ZFS pool<input name="zfsPool" placeholder="tank" required></label><label>Target IQN<input name="target" placeholder="iqn.2026-01.local.zfs:lightnas"></label>`,
    'proxmox-backup-server':`<label>Server<input name="server" placeholder="pbs.local:8007" required></label><label>Datastore<input name="datastore" placeholder="backup" required></label><label>User / API token ID<input name="username" placeholder="lightnas@pbs!token"></label><label>Token secret<input name="secret" type="password"></label><label>Fingerprint<input name="fingerprint" placeholder="AA:BB:CC:..."></label>`,
    esxi:`<label>ESXi / vCenter server<input name="server" placeholder="vcenter.local" required></label><label>Datastore<input name="datastore" placeholder="datastore1" required></label><label>Username<input name="username" autocomplete="off"></label><label>Password<input name="password" type="password" autocomplete="new-password"></label>`
  }[provider] || '';

  const providerHelp={
    directory:'Use a mounted directory or attached volume already visible to LightNAS.',
    lvm:'Register a mounted LVM-backed volume and record its volume-group metadata.',
    'lvm-thin':'Register a mounted LVM-Thin source and record its VG/thin-pool metadata.',
    btrfs:'Register a mounted BTRFS filesystem or subvolume.',
    zfs:'Register a mounted ZFS pool or dataset.',
    nfs:'Enter the NFS endpoint and select the mounted NFS volume LightNAS should manage.',
    'smb-cifs':'Enter the SMB/CIFS endpoint and select the mounted share LightNAS should manage.',
    glusterfs:'Enter the GlusterFS endpoint and select its mounted volume.',
    iscsi:'Enter the iSCSI target details and select the mounted filesystem exposed from that target.',
    cephfs:'Enter the CephFS cluster details and select its mounted filesystem.',
    rbd:'Enter the Ceph RBD details and select the mounted RBD-backed filesystem.',
    'zfs-over-iscsi':'Enter the iSCSI/ZFS target details and select its mounted filesystem.',
    'proxmox-backup-server':'Enter the backup server details and select the mounted datastore path LightNAS should manage.',
    esxi:'Enter the ESXi/vCenter datastore details and select the mounted datastore path LightNAS should manage.'
  }[provider] || 'Configure this storage provider.';

  dialog.querySelector('[data-storage-dialog-body]').innerHTML=`
    <form data-storage-create-form class="storage-create-form">
      <p class="muted storage-create-intro"><b>${sEsc(providerLabel)}</b> · ${sEsc(providerHelp)}</p>
      <input type="hidden" name="provider" value="${sEsc(provider)}">
      <div class="storage-create-grid">
        <label>Storage name<input name="name" required pattern="[A-Za-z][A-Za-z0-9_-]{1,31}" placeholder="fastssd" autocomplete="off"><small>2–32 letters, numbers, dashes, or underscores.</small></label>
        ${providerFields}
        <label>${localTypes.has(provider)?'Volume':'Mounted backing path'}<select name="sourceId" required ${writableSources.length?'':'disabled'}>
          ${writableSources.length?'<option value="">Select a volume…</option>':'<option value="">No writable volumes available</option>'}
          ${sources.map(item=>`<option value="${sEsc(item.id)}" ${item.mountedReadOnly?'disabled':''}>${sEsc(sourceLabel(item))}${item.mountedReadOnly?' · read only':item.writable?'':' · ready to claim'}</option>`).join('')}
        </select><small>${writableSources.length?'Choose the mounted source LightNAS will use for actual data. Provider connection details are saved with the storage definition.':'Expose or mount this storage to the LightNAS OS first, then rescan.'}</small></label>
      </div>
      <div class="storage-content-heading"><div><h3>What can this storage hold?</h3><p class="muted">Choose the content types you want available on this pool.</p></div><button class="secondary storage-select-all" type="button" data-storage-toggle-content>Select all</button></div>
      <div class="content-policy-grid storage-content-policy">${contentCheckboxes(data.contentTypes||[],['iso','vztmpl','images','rootdir','backup','snippets','files'])}</div>
      ${writableSources.length?'': '<div class="module-note storage-volume-warning"><b>No usable mounted source detected.</b> Mount or expose the selected provider to LightNAS read/write, then rescan.</div>'}
      <div class="dialog-actions storage-create-actions"><button class="secondary" type="button" data-storage-dialog-close>Cancel</button><button class="primary" type="submit" ${writableSources.length?'':'disabled'}>Create storage</button></div>
    </form>`;

  const select=dialog.querySelector('select[name="sourceId"]');
  if(sourceId&&select&&[...select.options].some(option=>option.value===sourceId&&!option.disabled)) select.value=sourceId;
  else if(select&&writableSources.length===1) select.value=writableSources[0].id;

  dialog.querySelector('[data-storage-toggle-content]')?.addEventListener('click', event => {
    const boxes=[...dialog.querySelectorAll('.storage-content-policy input[type="checkbox"]')];
    const shouldCheck=boxes.some(box=>!box.checked);
    boxes.forEach(box=>{ box.checked=shouldCheck; });
    event.currentTarget.textContent=shouldCheck?'Clear all':'Select all';
  });

  dialog.querySelector('[data-storage-create-form]').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent='Creating storage…';
    const content=[...form.querySelectorAll('.content-policy-grid input:checked')].map(input=>input.value);
    const formData=new FormData(form);
    const providerConfig={};
    for(const [key,value] of formData.entries()){
      if(['name','sourceId','provider'].includes(key)) continue;
      if(key==='content') continue;
      if(String(value).trim()) providerConfig[key]=String(value).trim();
    }
    // Never persist plaintext passwords in the storage config. They are used
    // only for the current setup flow until a secure credential store is wired.
    delete providerConfig.password;
    delete providerConfig.secret;
    try{
      await sRequest('/api/storage/pools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        name:form.elements.name.value,
        sourceId:form.elements.sourceId.value,
        provider:form.elements.provider.value,
        providerConfig,
        content
      })});
      dialog.close();await refreshStorageManager();
    }catch(problem){error.textContent=problem.message;}
  },{once:true});
  dialog.showModal();
}

async function loadStorageContent(poolId,type) {
  return await sRequest(`/api/storage/pools/${encodeURIComponent(poolId)}/content?type=${encodeURIComponent(type)}`);
}
async function renderManageStorage(poolId,activeType=null) {
  const data=storageUi.data||await loadStoragePools();
  const pool=(data.pools||[]).find(item=>item.id===poolId);
  if(!pool) return;
  const dialog=ensureStorageDialog();
  dialog.querySelector('[data-storage-dialog-title]').textContent=`Storage · ${pool.name}`;
  dialog.querySelector('[data-storage-dialog-error]').textContent='';
  const fileTypes=pool.content.filter(type=>['iso','vztmpl','backup','snippets'].includes(type));
  const selectedType=activeType&&fileTypes.includes(activeType)?activeType:(fileTypes[0]||null);
  let files={entries:[]};
  if(selectedType) {
    try{files=await loadStorageContent(pool.id,selectedType);}catch{}
  }
  dialog.querySelector('[data-storage-dialog-body]').innerHTML=`
    <div class="host-monitor-grid">
      <article class="monitor-card"><span>Total</span><strong>${sBytes(pool.totalBytes)}</strong></article>
      <article class="monitor-card"><span>Available</span><strong>${sBytes(pool.availableBytes)}</strong></article>
      <article class="monitor-card"><span>Source</span><strong style="font-size:1rem">${sEsc(pool.local?'local':pool.mountPoint)}</strong></article>
    </div>
    <form data-storage-policy-form>
      <h3>Allowed content</h3><div class="content-policy-grid">${contentCheckboxes(data.contentTypes||[],pool.content)}</div>
      <button class="secondary" type="submit">Save content policy</button>
    </form>
    ${selectedType?`<hr><div class="panel-head"><div><h3>Stored content</h3><p class="muted">Upload files or import them directly from a public URL.</p></div></div>
      <div class="head-actions">${fileTypes.map(type=>`<button type="button" class="${type===selectedType?'primary':'secondary'}" data-storage-content-tab="${sEsc(type)}" data-storage-id="${sEsc(pool.id)}">${sEsc((data.contentTypes||[]).find(item=>item.id===type)?.label||type)}</button>`).join('')}</div>
${selectedType==='vztmpl'? `<div class="head-actions"><button class="primary" type="button" data-template-browse data-template-storage="${sEsc(pool.id)}">Browse templates</button><button class="secondary" type="button" data-template-upload data-template-storage="${sEsc(pool.id)}">Upload template</button><button class="secondary" type="button" data-template-url data-template-storage="${sEsc(pool.id)}">Import URL</button></div><p class="muted">Choose a template from the upstream catalog, upload an archive from your computer, or import a public URL into this storage.</p>` : ''}
      <form data-storage-upload-form data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">
        ${selectedType==='iso'?'<p class="module-note">ISO uploads stream directly to storage in resumable chunks with no LightNAS application-level size ceiling. Available disk space is the limit.</p>':''}
        <label>Upload ${sEsc((data.contentTypes||[]).find(item=>item.id===selectedType)?.label||selectedType)}<input name="file" type="file" required ${selectedType==='iso'?'accept=".iso"':selectedType==='vztmpl'?'accept=".tar.zst,.tar.xz,.tar.gz,.tgz"':''}></label>
        <button class="secondary" type="submit">Upload</button>
      </form>
      <form data-storage-import-form data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">
        <label>Download from URL<input name="url" type="url" required placeholder="https://example.org/file"></label>
        <button class="secondary" type="submit">Download from URL</button>
      </form>
      <div class="storage-list">${files.entries?.length?files.entries.map(file=>`<article class="storage-row"><div><h3>${sEsc(file.name)}</h3><p>${sBytes(file.sizeBytes)} · ${sEsc(file.modifiedAt||'')}</p></div><button class="secondary danger-button" type="button" data-storage-file-delete="${sEsc(file.name)}" data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">Delete</button></article>`).join(''):'<div class="empty"><p>No files stored for this content type.</p></div>'}</div>
    `:''}
    ${!pool.local?'<hr><button class="secondary danger-button" type="button" data-storage-remove-definition>Remove storage definition</button><p class="muted">This removes the LightNAS storage definition only. Existing files are preserved.</p>':''}
  `;
  dialog.dataset.storageId=pool.id;
  dialog.querySelector('[data-storage-policy-form]').addEventListener('submit',async event=>{
    event.preventDefault();
    const error=dialog.querySelector('[data-storage-dialog-error]');
    const content=[...event.currentTarget.querySelectorAll('input:checked')].map(input=>input.value);
    error.textContent='Saving…';
    try{
      await sRequest(`/api/storage/pools/${encodeURIComponent(pool.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
      await refreshStorageManager();await renderManageStorage(pool.id,selectedType);
    }catch(problem){error.textContent=problem.message;}
  },{once:true});
  if (!dialog.open) dialog.showModal();
}

document.addEventListener('click',async event=>{
  const refresh=event.target.closest('[data-storage-refresh]');
  if(refresh){await refreshStorageManager();return;}
  const addToggle=event.target.closest('[data-storage-add-toggle]');
  if(addToggle){
    const menu=addToggle.closest('[data-storage-add-menu]');
    const dropdown=menu?.querySelector('.storage-add-dropdown');
    if(dropdown){
      dropdown.hidden=!dropdown.hidden;
      addToggle.setAttribute('aria-expanded', dropdown.hidden?'false':'true');
    }
    return;
  }
  const addType=event.target.closest('[data-storage-add-type]');
  if(addType){
    const dropdown=addType.closest('.storage-add-dropdown');
    if(dropdown) dropdown.hidden=true;
    openCreateStorage('',addType.dataset.storageAddType);
    return;
  }
  const create=event.target.closest('[data-create-storage]');
  if(create){openCreateStorage();return;}
  const source=event.target.closest('[data-create-storage-source]');
  if(source){openCreateStorage(source.dataset.createStorageSource,'directory');return;}
  const manage=event.target.closest('[data-manage-storage]');
  if(manage){await renderManageStorage(manage.dataset.manageStorage);return;}
  const card=event.target.closest('[data-storage-card]');
  if(card&&!event.target.closest('button,input,select,a')){await renderManageStorage(card.dataset.storageCard);return;}
  const tab=event.target.closest('[data-storage-content-tab]');
  if(tab){await renderManageStorage(tab.dataset.storageId,tab.dataset.storageContentTab);return;}
  const remove=event.target.closest('[data-storage-remove-definition]');
  if(remove){
    const dialog=ensureStorageDialog(),id=dialog.dataset.storageId;
    if(!id||!confirm(`Remove storage definition ${id}? Files will be preserved.`)) return;
    try{await sRequest(`/api/storage/pools/${encodeURIComponent(id)}`,{method:'DELETE'});dialog.close();await refreshStorageManager();}
    catch(problem){dialog.querySelector('[data-storage-dialog-error]').textContent=problem.message;}
    return;
  }
  const fileDelete=event.target.closest('[data-storage-file-delete]');
  if(fileDelete){
    if(!confirm(`Delete ${fileDelete.dataset.storageFileDelete}?`)) return;
    try{
      await sRequest(`/api/storage/pools/${encodeURIComponent(fileDelete.dataset.storageId)}/content?type=${encodeURIComponent(fileDelete.dataset.storageType)}&name=${encodeURIComponent(fileDelete.dataset.storageFileDelete)}`,{method:'DELETE'});
      await renderManageStorage(fileDelete.dataset.storageId,fileDelete.dataset.storageType);
    }catch(problem){ensureStorageDialog().querySelector('[data-storage-dialog-error]').textContent=problem.message;}
  }
},true);

document.addEventListener('submit',async event=>{
  const upload=event.target.closest('[data-storage-upload-form]');
  if(upload){
    event.preventDefault();
    const file=upload.elements.file.files?.[0]; if(!file)return;
    const id=upload.dataset.storageId,type=upload.dataset.storageType;
    const dialog=ensureStorageDialog(),error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent=`Uploading ${file.name}…`;
    const controller=new AbortController();
    let canceled=false;
    const progress=window.LightNASProgress?.open(
      type==='iso'?'Uploading VM installer image':'Uploading storage image',
      file.name,
      { modal:false, cancel:()=>{ canceled=true; controller.abort(); } }
    );
    try{
      // Blob.slice() is lazy, so a larger chunk reduces HTTP round trips
      // without buffering the whole ISO in browser or server memory.
      const chunkSize=(type==='iso'?64:32)*1024**2;
      const uploadId=crypto.randomUUID();
      const startedAt=performance.now();
      let offset=0;
      while(offset<file.size){
        const end=Math.min(file.size,offset+chunkSize);
        const chunk=file.slice(offset,end);
        let uploaded=false;
        let lastProblem=null;
        for(let attempt=1;attempt<=3&&!uploaded;attempt+=1){
          if(canceled) throw Object.assign(new Error('Upload canceled.'),{name:'AbortError'});
          try{
            await sRequest(`/api/storage/pools/${encodeURIComponent(id)}/upload?type=${encodeURIComponent(type)}&name=${encodeURIComponent(file.name)}`,{
              method:'PUT',
              headers:{
                'Content-Type':'application/octet-stream',
                'Content-Range':`bytes ${offset}-${end-1}/${file.size}`,
                'X-LightNAS-Upload-Id':uploadId
              },
              body:chunk,
              signal:controller.signal
            });
            uploaded=true;
          }catch(problem){
            lastProblem=problem;
            if(canceled||problem?.name==='AbortError') throw problem;
            if(attempt<3){
              const retryMessage=`Chunk retry ${attempt}/2 · ${sBytes(offset)} of ${sBytes(file.size)} uploaded`;
              error.textContent=retryMessage;
              progress?.update(Math.round((offset/file.size)*100),retryMessage);
              await new Promise(resolve=>setTimeout(resolve,attempt*750));
            }
          }
        }
        if(!uploaded) throw lastProblem||new Error('Upload chunk failed after retries.');
        offset=end;
        const percent=Math.round((offset/file.size)*100);
        const elapsed=Math.max(0.001,(performance.now()-startedAt)/1000);
        const rate=offset/elapsed;
        const remaining=Math.max(0,file.size-offset);
        const eta=rate>0?Math.ceil(remaining/rate):0;
        const elapsedText=elapsed>=60?`${Math.floor(elapsed/60)}m ${Math.floor(elapsed%60)}s`:`${Math.floor(elapsed)}s`;
        const transfer=`${sBytes(rate)}/s · ${elapsedText} elapsed${eta? ` · about ${eta}s remaining`:''}`;
        error.textContent=`Uploading ${file.name}… ${percent}% · ${transfer}`;
        progress?.update(percent,`${sBytes(offset)} of ${sBytes(file.size)} · ${transfer}`);
      }
      error.textContent='';await renderManageStorage(id,type);
      progress?.succeed(`${file.name} uploaded successfully and is ready to use.`);
    }catch(problem){
      const message=canceled||problem?.name==='AbortError'?'Upload canceled.':problem.message;
      error.textContent=message;
      if(!canceled) progress?.fail(message);
    }
    return;
  }
  const importer=event.target.closest('[data-storage-import-form]');
  if(importer){
    event.preventDefault();
    const id=importer.dataset.storageId,type=importer.dataset.storageType;
    const dialog=ensureStorageDialog(),error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent='Downloading…';
    const progress=window.LightNASProgress?.open(type==='iso'?'Downloading VM installer image':'Downloading storage image',importer.elements.url.value,{modal:false});
    try{
      await sRequest(`/api/storage/pools/${encodeURIComponent(id)}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,url:importer.elements.url.value})});
      error.textContent='';await renderManageStorage(id,type);
      progress?.succeed(type==='iso'?'The VM installer ISO downloaded successfully and is ready in the VM creation wizard.':'The image downloaded successfully and is ready to use.');
    }catch(problem){error.textContent=problem.message;progress?.fail(problem.message);}
  }
},true);

function maybeStorageManager(){
  if(!['#storage','#pools'].includes(location.hash)||!document.querySelector('#storage-manager')) return;
  const slot=document.querySelector('#storage-manager');
  if(slot.dataset.loaded==='1') return;
  slot.dataset.loaded='1';
  refreshStorageManager();
}
new MutationObserver(maybeStorageManager).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('hashchange',maybeStorageManager);
maybeStorageManager();

let storageInventorySignature='';
setInterval(async()=>{
  if(!['#storage','#pools'].includes(location.hash)) return;
  try{
    const next=await sRequest('/api/storage/pools');
    const signature=JSON.stringify({
      sources:(next.availableSources||[]).map(item=>[item.id,item.totalBytes,item.configured]),
      disks:(next.detectedDisks||[]).map(item=>[item.path,item.sizeBytes,item.system,item.blank])
    });
    if(storageInventorySignature && signature!==storageInventorySignature){
      storageUi.data=next;
      renderStorageManager();
    }else if(!storageUi.data){
      storageUi.data=next;
      renderStorageManager();
    }
    storageInventorySignature=signature;
  }catch{}
},8000);

document.addEventListener('keydown',async event=>{
  const card=event.target.closest?.('[data-storage-card]');
  if(!card||!['Enter',' '].includes(event.key)) return;
  event.preventDefault();
  await renderManageStorage(card.dataset.storageCard);
});

document.addEventListener('click', event => {
  if (event.target.closest('[data-storage-add-menu]')) return;
  document.querySelectorAll('.storage-add-dropdown:not([hidden])').forEach(menu => {
    menu.hidden = true;
    menu.closest('[data-storage-add-menu]')?.querySelector('[data-storage-add-toggle]')?.setAttribute('aria-expanded','false');
  });
});
