const storageUi = { data: null };

function sEsc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]);
}
function sBytes(value) {
  const n0 = Number(value);
  if (!Number.isFinite(n0)) return '—';
  const units = ['B','KB','MB','GB','TB','PB'];
  let n=n0,u=0; while(n>=1024&&u<units.length-1){n/=1024;u+=1;}
  return `${n>=10||u===0?n.toFixed(0):n.toFixed(1)} ${units[u]}`;
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
function storageCard(pool) {
  const contents=(pool.contentLabels||[]).join(' · ')||'No content types';
  return `<article class="inventory-card storage-pool-card" data-storage-card="${sEsc(pool.id)}" role="button" tabindex="0" aria-label="Manage storage ${sEsc(pool.name)}">
    <div class="volume-title"><h3>${sEsc(pool.name)}</h3><span class="volume-state ${pool.online&&pool.writable?'writable':'readonly'}">${pool.online?(pool.writable?'ONLINE':'READ ONLY'):'OFFLINE'}</span></div>
    <p>${pool.local?'Local appliance storage · OS disk remainder':sEsc(pool.mountPoint||'Attached virtual storage')}</p>
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
  slot.innerHTML=`
    <section class="module-hero">
      <div class="panel-head"><div><span class="eyebrow">LIGHTNAS STORAGE MANAGER</span><h2>${sBytes(visible.totalBytes||0)} total usable storage</h2></div>
        <div class="head-actions"><button class="secondary" type="button" data-storage-refresh>Refresh</button>${unconfigured.length?'<button class="primary" type="button" data-create-storage>+ Create storage</button>':''}</div>
      </div>
      <p>${sBytes(visible.usedBytes||0)} used · ${sBytes(visible.availableBytes||0)} free across local storage and unique attached virtual volumes. The OS/root filesystem is counted once as <b>local</b>; duplicate bind mounts are not counted.</p>
    </section>
    <h2>Storage</h2>
    <div class="inventory-grid">${(data.pools||[]).map(storageCard).join('')||'<div class="empty"><p>No storage pools are online.</p></div>'}</div>
    ${unconfigured.length?`<h2>Available virtual storage</h2><div class="inventory-grid">${unconfigured.map(source=>`<article class="inventory-card"><h3>${sEsc(source.mountPoint)}</h3><p>${sEsc(source.device)} · ${sEsc(source.type)}</p><p><strong>${sBytes(source.availableBytes)} free</strong> of ${sBytes(source.totalBytes)}</p><button class="primary" type="button" data-create-storage-source="${sEsc(source.id)}">Create storage here</button></article>`).join('')}</div>`:''}
  `;
}
async function refreshStorageManager() {
  const slot=document.querySelector('#storage-manager');
  if(slot) slot.innerHTML='<div class="empty"><p>Loading LightNAS storage…</p></div>';
  try{await loadStoragePools();renderStorageManager();}
  catch(error){if(slot) slot.innerHTML=`<div class="module-note">Storage manager unavailable: ${sEsc(error.message)}</div>`;}
}
function openCreateStorage(sourceId='') {
  const data=storageUi.data;
  if(!data) return;
  const sources=(data.availableSources||[]).filter(item=>!item.configured&&item.writable);
  const dialog=ensureStorageDialog();
  dialog.querySelector('[data-storage-dialog-title]').textContent='Create storage';
  dialog.querySelector('[data-storage-dialog-error]').textContent='';
  dialog.querySelector('[data-storage-dialog-body]').innerHTML=`
    <form data-storage-create-form>
      <p class="muted">Create a file-level LightNAS storage on an attached virtual volume. Existing files outside the LightNAS storage directory are not formatted or deleted.</p>
      <label>Storage name<input name="name" required pattern="[A-Za-z][A-Za-z0-9_-]{1,31}" placeholder="fastssd"></label>
      <label>Virtual storage<select name="sourceId" required>${sources.map(item=>`<option value="${sEsc(item.id)}">${sEsc(item.mountPoint)} · ${sBytes(item.totalBytes)}</option>`).join('')}</select></label>
      <h3>Allowed content</h3><div class="content-policy-grid">${contentCheckboxes(data.contentTypes||[],['iso','vztmpl','images','rootdir','backup','snippets','files'])}</div>
      <div class="dialog-actions"><button class="primary" type="submit">Create storage</button></div>
    </form>`;
  const select=dialog.querySelector('select[name="sourceId"]');
  if(sourceId&&[...select.options].some(option=>option.value===sourceId)) select.value=sourceId;
  dialog.querySelector('[data-storage-create-form]').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent='Creating storage…';
    const content=[...form.querySelectorAll('.content-policy-grid input:checked')].map(input=>input.value);
    try{
      await sRequest('/api/storage/pools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.elements.name.value,sourceId:form.elements.sourceId.value,content})});
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
      <form data-storage-upload-form data-storage-id="${sEsc(pool.id)}" data-storage-type="${sEsc(selectedType)}">
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
  dialog.showModal();
}

document.addEventListener('click',async event=>{
  const refresh=event.target.closest('[data-storage-refresh]');
  if(refresh){await refreshStorageManager();return;}
  const create=event.target.closest('[data-create-storage]');
  if(create){openCreateStorage();return;}
  const source=event.target.closest('[data-create-storage-source]');
  if(source){openCreateStorage(source.dataset.createStorageSource);return;}
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
    try{
      await sRequest(`/api/storage/pools/${encodeURIComponent(id)}/upload?type=${encodeURIComponent(type)}&name=${encodeURIComponent(file.name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file});
      error.textContent='';await renderManageStorage(id,type);
    }catch(problem){error.textContent=problem.message;}
    return;
  }
  const importer=event.target.closest('[data-storage-import-form]');
  if(importer){
    event.preventDefault();
    const id=importer.dataset.storageId,type=importer.dataset.storageType;
    const dialog=ensureStorageDialog(),error=dialog.querySelector('[data-storage-dialog-error]');
    error.textContent='Downloading…';
    try{
      await sRequest(`/api/storage/pools/${encodeURIComponent(id)}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,url:importer.elements.url.value})});
      error.textContent='';await renderManageStorage(id,type);
    }catch(problem){error.textContent=problem.message;}
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

document.addEventListener('keydown',async event=>{
  const card=event.target.closest?.('[data-storage-card]');
  if(!card||!['Enter',' '].includes(event.key)) return;
  event.preventDefault();
  await renderManageStorage(card.dataset.storageCard);
});
