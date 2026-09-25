const storageUi = { data: null };

const STORAGE_PROVIDERS = [
  { id: 'directory', label: 'Directory', group: 'Local storage', description: 'Use a mounted local or virtual disk directory.', available: true },
  { id: 'lvm', label: 'LVM', group: 'Local storage', description: 'Block storage from a mounted LVM logical volume.', available: true },
  { id: 'lvmthin', label: 'LVM-Thin', group: 'Local storage', description: 'Thin-provisioned storage exposed through a mounted volume.', available: true },
  { id: 'btrfs', label: 'BTRFS', group: 'Local storage', description: 'BTRFS filesystem or subvolume storage.', available: true },
  { id: 'zfs', label: 'ZFS', group: 'Local storage', description: 'An existing mounted ZFS pool or dataset.', available: true },
  { id: 'nfs', label: 'NFS', group: 'Network storage', description: 'Mounted Network File System export.', available: true },
  { id: 'cifs', label: 'SMB / CIFS', group: 'Network storage', description: 'Mounted Windows-compatible network share.', available: true },
  { id: 'glusterfs', label: 'GlusterFS', group: 'Network storage', description: 'Mounted distributed Gluster filesystem.', available: true },
  { id: 'iscsi', label: 'iSCSI', group: 'Block & clustered', description: 'Mounted filesystem backed by an iSCSI LUN.', available: true },
  { id: 'cephfs', label: 'CephFS', group: 'Block & clustered', description: 'Mounted Ceph distributed filesystem.', available: true },
  { id: 'rbd', label: 'RBD', group: 'Block & clustered', description: 'Mounted filesystem backed by a Ceph RBD.', available: true },
  { id: 'zfsiscsi', label: 'ZFS over iSCSI', group: 'Block & clustered', description: 'Mounted ZFS-backed remote iSCSI storage.', available: true },
  { id: 'pbs', label: 'Proxmox Backup Server', group: 'Backup & import', description: 'Mounted Proxmox backup repository.', available: true },
  { id: 'esxi', label: 'VMware ESXi', group: 'Backup & import', description: 'Mounted VMware import source.', available: true }
];

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
  return types.map(type=>`<label class="content-check"><input type="checkbox" value="${sEsc(type.id)}" ${selected.includes(type.id)?'checked':''}> <span><b>${sEsc(type.label)}</b><small>${sEsc(type.id)}</small></span></label>`).join('');
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
function storageRow(pool) {
  const contents=(pool.contentLabels||[]).join(', ')||'None';
  const target=pool.local?(pool.dedicated?'Local data partition':'Local OS filesystem'):pool.mountPoint||'Unavailable';
  return `<button class="storage-table-row" type="button" data-manage-storage="${sEsc(pool.id)}" aria-label="Open storage ${sEsc(pool.name)}">
    <span><b>${sEsc(pool.name)}</b><small>${sEsc(pool.provider||'directory')}</small></span>
    <span class="storage-table-content">${sEsc(contents)}</span>
    <span>${sEsc(target)}</span>
    <span><b>${sBytes(pool.availableBytes)}</b><small>of ${sBytes(pool.totalBytes)}</small></span>
    <span><i class="storage-status-dot ${pool.online&&pool.writable?'online':'warning'}"></i>${pool.online?(pool.writable?'Online':'Read only'):'Offline'}</span>
    <span aria-hidden="true">›</span>
  </button>`;
}
function renderStorageManager() {
  const slot=document.querySelector('#storage-manager');
  const data=storageUi.data;
  if(!slot||!data) return;
  const visible=data.visibleSummary||data.summary||{};
  const unconfigured=(data.availableSources||[]).filter(item=>!item.configured&&item.writable);
  const verified=visible.verified!==false;
  const sharedLocalExcluded=Boolean(visible.localExcludedBecauseSharedOs);
  slot.innerHTML=`
    <section class="storage-overview-strip">
      <div><span class="eyebrow">CONFIGURED STORAGE</span><strong>${(data.pools||[]).length}</strong><small>target${(data.pools||[]).length===1?'':'s'}</small></div>
      <div><span class="eyebrow">TOTAL CAPACITY</span><strong>${verified?sBytes(visible.totalBytes||0):'Unverified'}</strong><small>${verified?`${sBytes(visible.availableBytes||0)} available`:'host metadata required'}</small></div>
      <div class="storage-overview-copy"><p>${verified
        ? `${sBytes(visible.usedBytes||0)} used · ${sBytes(visible.availableBytes||0)} free across attached data volumes.${sharedLocalExcluded?' The OS/root-backed local storage is shown separately and is not included in this total.':''}`
        : 'This installation has not received authoritative virtual-disk sizes from its host.'}</p></div>
    </section>
    <div class="section-heading storage-section-heading"><div><span class="eyebrow">STORAGE DEFINITIONS</span><h2>Storage</h2></div><div class="head-actions"><button class="secondary" type="button" data-storage-refresh>Refresh</button><button class="secondary" type="button" data-view-link="pools">Pools & datasets</button></div></div>
    <section class="storage-table" aria-label="Configured storage">
      <div class="storage-table-head"><span>Name / type</span><span>Content</span><span>Path / target</span><span>Available</span><span>Status</span><span></span></div>
      ${(data.pools||[]).map(storageRow).join('')||'<div class="empty"><p>No storage definitions are configured.</p></div>'}
    </section>
    ${unconfigured.length?`<details class="panel available-storage-panel"><summary><b>${unconfigured.length} mounted source${unconfigured.length===1?'':'s'} available to add</b></summary><div class="storage-list">${unconfigured.map(source=>`<article class="storage-row"><div><h3>${sEsc(source.mountPoint)}</h3><p>${sEsc(source.device)} · ${sEsc(source.type)}</p></div><div><b>${sBytes(source.availableBytes)} free</b><p>of ${sBytes(source.totalBytes)}</p></div><button class="secondary" type="button" data-create-storage-source="${sEsc(source.id)}">Add</button></article>`).join('')}</div></details>`:''}
  `;
}
async function refreshStorageManager() {
  const slot=document.querySelector('#storage-manager');
  if(slot) slot.innerHTML='<div class="empty"><p>Loading LightNAS storage…</p></div>';
  try{await loadStoragePools();renderStorageManager();}
  catch(error){if(slot) slot.innerHTML=`<div class="module-note">Storage manager unavailable: ${sEsc(error.message)}</div>`;}
}
async function openCreateStorage(sourceId='') {
  const data=storageUi.data||await loadStoragePools();
  const sources=(data.availableSources||[]).filter(item=>item.writable);
  const dialog=ensureStorageDialog();
  dialog.querySelector('[data-storage-dialog-title]').textContent='Add storage';
  dialog.querySelector('[data-storage-dialog-error]').textContent='';
  dialog.querySelector('[data-storage-dialog-body]').innerHTML=`
    <form data-storage-create-form>
      <p class="muted">Choose the provider that backs this storage. Every choice is selectable; LightNAS then connects it to a real mounted source visible on this node.</p>
      <div class="storage-provider-grid">${STORAGE_PROVIDERS.map(provider=>`<label class="storage-provider-option"><input type="radio" name="provider" value="${sEsc(provider.id)}" ${provider.id==='directory'?'checked':''}><span><b>${sEsc(provider.label)}</b><small>${sEsc(provider.description)}</small><em>${sEsc(provider.group)}</em></span></label>`).join('')}</div>
      <div class="module-note" data-provider-guidance><b>Directory:</b> select a mounted source below. Existing files outside the LightNAS storage folder are preserved.</div>
      <label>Storage name<input name="name" required pattern="[A-Za-z][A-Za-z0-9_-]{1,31}" placeholder="fastssd"></label>
      <label>Mounted source<select name="sourceId" required>${sources.map(item=>`<option value="${sEsc(item.id)}">${sEsc(item.mountPoint)} · ${sBytes(item.totalBytes)} · ${sEsc(item.type)}${item.configured?' · already in use':''}</option>`).join('')}</select><small>${sources.length?'A separate LightNAS folder is created for this storage definition.':'No writable mounted source is available. Attach or mount storage first.'}</small></label>
      <h3>Allowed content</h3><div class="content-policy-grid">${contentCheckboxes(data.contentTypes||[],['iso','vztmpl','images','rootdir','backup','snippets','files'])}</div>
      <div class="dialog-actions"><button class="primary" type="submit" ${sources.length?'':'disabled'}>Add storage</button></div>
    </form>`;
  const select=dialog.querySelector('select[name="sourceId"]');
  if(sourceId&&[...select.options].some(option=>option.value===sourceId)) select.value=sourceId;
  dialog.querySelector('[data-storage-create-form]').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent='Creating storage…';
    const content=[...form.querySelectorAll('.content-policy-grid input:checked')].map(input=>input.value);
    try{
      await sRequest('/api/storage/pools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.elements.name.value,provider:form.elements.provider.value,sourceId:form.elements.sourceId.value,content})});
      dialog.close();await refreshStorageManager();
    }catch(problem){error.textContent=problem.message;}
  },{once:true});
  dialog.querySelectorAll('input[name="provider"]').forEach(input=>input.addEventListener('change',()=>{
    const provider=STORAGE_PROVIDERS.find(item=>item.id===input.value);
    dialog.querySelector('[data-provider-guidance]').innerHTML=`<b>${sEsc(provider.label)}:</b> ${sEsc(provider.description)} Choose the mounted source that provides this storage. LightNAS will not format or erase it.`;
  }));
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
  const contentTypes=pool.content.filter(type=>['iso','vztmpl','images','rootdir','backup','snippets','files'].includes(type));
  const fileTypes=contentTypes.filter(type=>['iso','vztmpl','backup','snippets','files'].includes(type));
  const selectedType=activeType&&contentTypes.includes(activeType)?activeType:null;
  let files={entries:[]};
  if(selectedType) {
    try{files=await loadStorageContent(pool.id,selectedType);}catch{}
  }
  dialog.querySelector('[data-storage-dialog-body]').innerHTML=`
    <div class="storage-detail-summary">
      <article class="monitor-card"><span>Total</span><strong>${sBytes(pool.totalBytes)}</strong></article>
      <article class="monitor-card"><span>Available</span><strong>${sBytes(pool.availableBytes)}</strong></article>
      <article class="monitor-card"><span>Used</span><strong>${pool.usedPercent||0}%</strong></article>
      <article class="monitor-card"><span>Status</span><strong style="font-size:1rem">${pool.online?(pool.writable?'Online':'Read only'):'Offline'}</strong></article>
    </div>
    <dl class="storage-detail-list"><div><dt>Type</dt><dd>${sEsc(STORAGE_PROVIDERS.find(item=>item.id===(pool.provider||'directory'))?.label||'Directory')}</dd></div><div><dt>Path / target</dt><dd>${sEsc(pool.root||pool.mountPoint||'—')}</dd></div><div><dt>Content</dt><dd>${sEsc((pool.contentLabels||[]).join(', '))}</dd></div></dl>
    <div class="section-heading storage-content-heading"><div><span class="eyebrow">CONTENT</span><h3>Select a library</h3></div></div>
    <div class="storage-content-tabs">${contentTypes.map(type=>`<button type="button" class="${type===selectedType?'active':''}" data-storage-content-tab="${sEsc(type)}" data-storage-id="${sEsc(pool.id)}"><b>${sEsc((data.contentTypes||[]).find(item=>item.id===type)?.label||type)}</b><small>${['images','rootdir'].includes(type)?'Managed by compute':'Open library'}</small></button>`).join('')}</div>
    ${!selectedType?'<div class="empty storage-select-prompt"><p>Select a content library above to view files, upload content, or open the container template catalog.</p></div>':''}
    ${selectedType&&['images','rootdir'].includes(selectedType)?`<div class="module-note">${selectedType==='images'?'VM disks are created and attached from Virtual machines.':'Container volumes are created and attached from Containers.'} This storage page reports the role without exposing active disk files for manual deletion.</div>`:''}
    ${selectedType&&fileTypes.includes(selectedType)?`<div class="storage-library-head"><div><h3>${sEsc((data.contentTypes||[]).find(item=>item.id===selectedType)?.label||selectedType)}</h3><p class="muted">Files stored only on ${sEsc(pool.name)}.</p></div></div>
${selectedType==='vztmpl'? `<div class="head-actions"><button class="primary" type="button" data-template-browse data-template-storage="${sEsc(pool.id)}">Browse templates</button><button class="secondary" type="button" data-template-upload data-template-storage="${sEsc(pool.id)}">Upload template</button><button class="secondary" type="button" data-template-url data-template-storage="${sEsc(pool.id)}">Import URL</button></div><p class="muted">Choose a template from the upstream catalog, upload an archive from your computer, or import a public URL into this storage.</p>` : ''}
      <form data-storage-upload-form data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">
        ${selectedType==='iso'?'<p class="module-note">ISO uploads stream directly to storage in resumable chunks. LightNAS does not impose an application-level file-size ceiling; available storage is the limit.</p>':''}
        <label>Upload ${sEsc((data.contentTypes||[]).find(item=>item.id===selectedType)?.label||selectedType)}<input name="file" type="file" required ${selectedType==='iso'?'accept=".iso"':selectedType==='vztmpl'?'accept=".tar.zst,.tar.xz,.tar.gz,.tgz"':''}></label>
        <button class="secondary" type="submit">Upload</button>
      </form>
      <form data-storage-import-form data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">
        <label>Download from URL<input name="url" type="url" required placeholder="https://example.org/file"></label>
        <button class="secondary" type="submit">Download from URL</button>
      </form>
      <div class="storage-list">${files.entries?.length?files.entries.map(file=>`<article class="storage-row"><div><h3>${sEsc(file.name)}</h3><p>${sBytes(file.sizeBytes)} · ${sEsc(file.modifiedAt||'')}</p></div><button class="secondary danger-button" type="button" data-storage-file-delete="${sEsc(file.name)}" data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">Delete</button></article>`).join(''):'<div class="empty"><p>No files stored for this content type.</p></div>'}</div>
    `:''}
    <details class="panel storage-options-panel"><summary><b>Storage options & allowed content</b></summary><form data-storage-policy-form><div class="content-policy-grid">${contentCheckboxes(data.contentTypes||[],pool.content)}</div><button class="secondary" type="submit">Save options</button></form></details>
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
  const viewLink=event.target.closest('[data-view-link]');
  if(viewLink){location.hash=viewLink.dataset.viewLink;return;}
  const refresh=event.target.closest('[data-storage-refresh]');
  if(refresh){await refreshStorageManager();return;}
  const create=event.target.closest('[data-create-storage]');
  if(create){await openCreateStorage();return;}
  const source=event.target.closest('[data-create-storage-source]');
  if(source){await openCreateStorage(source.dataset.createStorageSource);return;}
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
    const progress=window.LightNASProgress?.open(type==='iso'?'Uploading VM installer image':'Uploading storage image',file.name);
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
        await sRequest(`/api/storage/pools/${encodeURIComponent(id)}/upload?type=${encodeURIComponent(type)}&name=${encodeURIComponent(file.name)}`,{
          method:'PUT',
          headers:{
            'Content-Type':'application/octet-stream',
            'Content-Range':`bytes ${offset}-${end-1}/${file.size}`,
            'X-LightNAS-Upload-Id':uploadId
          },
          body:chunk
        });
        offset=end;
        const percent=Math.round((offset/file.size)*100);
        const elapsed=Math.max(0.001,(performance.now()-startedAt)/1000);
        const rate=offset/elapsed;
        const remaining=Math.max(0,file.size-offset);
        const eta=rate>0?Math.ceil(remaining/rate):0;
        const transfer=`${sBytes(rate)}/s${eta? ` · about ${eta}s remaining`:''}`;
        error.textContent=`Uploading ${file.name}… ${percent}% · ${transfer}`;
        progress?.update(percent,`${sBytes(offset)} of ${sBytes(file.size)} · ${transfer}`);
      }
      error.textContent='';await renderManageStorage(id,type);
      progress?.succeed(`${file.name} uploaded successfully and is ready to use.`);
    }catch(problem){error.textContent=problem.message;progress?.fail(problem.message);}
    return;
  }
  const importer=event.target.closest('[data-storage-import-form]');
  if(importer){
    event.preventDefault();
    const id=importer.dataset.storageId,type=importer.dataset.storageType;
    const dialog=ensureStorageDialog(),error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent='Downloading…';
    const progress=window.LightNASProgress?.open(type==='iso'?'Downloading VM installer image':'Downloading storage image',importer.elements.url.value);
    try{
      await sRequest(`/api/storage/pools/${encodeURIComponent(id)}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,url:importer.elements.url.value})});
      error.textContent='';await renderManageStorage(id,type);
      progress?.succeed(type==='iso'?'The VM installer ISO downloaded successfully and is ready in the VM creation wizard.':'The image downloaded successfully and is ready to use.');
    }catch(problem){error.textContent=problem.message;progress?.fail(problem.message);}
  }
},true);

let storageAutoRefreshTimer=null;
let storageSignature='';

function storageInventorySignature(data){
  return JSON.stringify({
    pools:(data?.pools||[]).map(item=>[item.id,item.mountPoint,item.totalBytes,item.availableBytes,item.online,item.writable]),
    sources:(data?.availableSources||[]).map(item=>[item.id,item.mountPoint,item.device,item.totalBytes,item.availableBytes,item.configured])
  });
}

async function autoRefreshStorageManager(){
  if(location.hash!=='#storage'||!document.querySelector('#storage-manager')) return;
  const dialog=document.querySelector('#lightnas-storage-dialog');
  if(dialog?.open) return;
  try{
    const data=await loadStoragePools();
    const next=storageInventorySignature(data);
    if(next!==storageSignature){
      storageSignature=next;
      renderStorageManager();
    }
  }catch{}
}

function maybeStorageManager(){
  const active=location.hash==='#storage'&&document.querySelector('#storage-manager');
  clearInterval(storageAutoRefreshTimer);
  storageAutoRefreshTimer=null;
  if(!active) return;
  const slot=document.querySelector('#storage-manager');
  if(slot.dataset.loaded!=='1'){
    slot.dataset.loaded='1';
    refreshStorageManager().then(()=>{storageSignature=storageInventorySignature(storageUi.data);});
  }
  storageAutoRefreshTimer=setInterval(autoRefreshStorageManager,8000);
}
new MutationObserver(maybeStorageManager).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('hashchange',maybeStorageManager);
window.addEventListener('focus',autoRefreshStorageManager);
maybeStorageManager();
