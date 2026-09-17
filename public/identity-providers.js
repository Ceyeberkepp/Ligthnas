const idpQ = (selector, root = document) => root.querySelector(selector);
const idpQa = (selector, root = document) => [...root.querySelectorAll(selector)];
const idpEscape = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]);

const idpPermissionNames = {
  'files.read':'Read files', 'files.write':'Write files', 'media.convert':'Convert media',
  'storage.view':'View storage', 'storage.manage':'Manage storage', 'shares.manage':'Manage shares',
  'apps.manage':'Manage apps', 'containers.manage':'Manage containers', 'vms.manage':'Manage virtual machines',
  'network.view':'View networking', 'network.manage':'Manage firewall / Wi-Fi', 'system.view':'View system health'
};

async function idpApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type':'application/json', 'X-LightNAS-Request':'1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function permissionMarkup(options, selected = []) {
  const chosen = new Set(selected);
  return `<fieldset class="policy-grid"><legend>Permissions granted to identities from this provider</legend>${options.map(value => `<label class="policy-option"><input type="checkbox" name="permissions" value="${idpEscape(value)}" ${chosen.has(value) ? 'checked' : ''}><span><b>${idpEscape(idpPermissionNames[value] || value)}</b></span></label>`).join('')}</fieldset>`;
}

function providerSummary(provider) {
  if (provider.type === 'ldaps') return `${provider.host}:${provider.port} · ${provider.principalTemplate || '{username}'}`;
  if (provider.type === 'saml') return provider.metadataUrl || provider.ssoUrl || provider.entityId || 'SAML profile';
  return provider.issuer || 'OIDC profile';
}

function fieldsFor(provider = {}) {
  const type = provider.type || 'ldaps';
  if (type === 'ldaps') {
    return `<label>LDAPS host<input name="host" value="${idpEscape(provider.host || '')}" required placeholder="dc01.example.com"></label>
      <label>Port<input name="port" type="number" min="1" max="65535" value="${Number(provider.port || 636)}" required></label>
      <label>TLS server name<input name="serverName" value="${idpEscape(provider.serverName || provider.host || '')}" placeholder="dc01.example.com"></label>
      <label>User principal template<input name="principalTemplate" value="${idpEscape(provider.principalTemplate || '{username}@example.com')}" required><small class="muted">Must include {username}.</small></label>
      <label>Base DN<input name="baseDn" value="${idpEscape(provider.baseDn || '')}" placeholder="DC=example,DC=com"></label>
      <label>Service bind DN (optional)<input name="bindDn" value="${idpEscape(provider.bindDn || '')}" placeholder="CN=LightNAS,OU=Service Accounts,DC=example,DC=com"></label>
      <label>Service bind password ${provider.hasBindPassword ? '<span class="muted">(saved; leave blank to keep)</span>' : ''}<input name="bindPassword" type="password" autocomplete="new-password"></label>
      <label>Trusted CA certificate (PEM)<textarea name="caPem" rows="6" placeholder="-----BEGIN CERTIFICATE-----">${idpEscape(provider.caPem || '')}</textarea></label>`;
  }
  if (type === 'saml') {
    return `<label>Metadata URL<input name="metadataUrl" type="url" value="${idpEscape(provider.metadataUrl || '')}" placeholder="https://idp.example.com/metadata"></label>
      <p class="muted">Use a metadata URL, or provide the fields below manually.</p>
      <label>Entity ID<input name="entityId" value="${idpEscape(provider.entityId || '')}" placeholder="https://idp.example.com/entity"></label>
      <label>SSO URL<input name="ssoUrl" type="url" value="${idpEscape(provider.ssoUrl || '')}" placeholder="https://idp.example.com/sso"></label>
      <label>Signing certificate (PEM)<textarea name="certificate" rows="6" placeholder="-----BEGIN CERTIFICATE-----">${idpEscape(provider.certificate || '')}</textarea></label>
      <label>NameID format<input name="nameIdFormat" value="${idpEscape(provider.nameIdFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress')}"></label>`;
  }
  return `<label>OIDC issuer<input name="issuer" type="url" value="${idpEscape(provider.issuer || '')}" required placeholder="https://login.example.com/tenant/v2.0"></label>
    <label>Client ID<input name="clientId" value="${idpEscape(provider.clientId || '')}" required></label>
    <label>Client secret ${provider.hasClientSecret ? '<span class="muted">(saved; leave blank to keep)</span>' : ''}<input name="clientSecret" type="password" autocomplete="new-password"></label>
    <label>Scopes<input name="scopes" value="${idpEscape(provider.scopes || 'openid profile email')}"></label>`;
}

function openProviderDialog(data, provider = null) {
  const options = data.permissionOptions || Object.keys(idpPermissionNames);
  const existing = provider || { type:'ldaps', enabled:false, permissions:['files.read'] };
  const dialog = document.createElement('dialog');
  dialog.className = 'lightnas-dialog identity-provider-dialog';
  dialog.innerHTML = `<form class="dialog-body" data-provider-form>
    <div class="dialog-head"><div><span class="eyebrow">IDENTITY & SSO</span><h2>${provider ? 'Edit identity provider' : 'Add identity provider'}</h2></div><button class="dialog-close" type="button" data-provider-close>×</button></div>
    <label>Provider name<input name="name" maxlength="64" value="${idpEscape(existing.name || '')}" required placeholder="Corporate directory"></label>
    <label>Type<select name="type"><option value="ldaps" ${existing.type === 'ldaps' ? 'selected' : ''}>LDAPS</option><option value="saml" ${existing.type === 'saml' ? 'selected' : ''}>SAML 2.0</option><option value="oidc" ${existing.type === 'oidc' ? 'selected' : ''}>OpenID Connect</option></select></label>
    <label class="policy-option"><input type="checkbox" name="enabled" ${existing.enabled ? 'checked' : ''}><span><b>Enable provider</b><small>Enabled profiles may be used by the authentication layer when that sign-in flow is activated.</small></span></label>
    <div data-provider-fields>${fieldsFor(existing)}</div>
    ${permissionMarkup(options, existing.permissions || [])}
    <div class="form-error" role="alert"></div>
    <div class="dialog-actions"><button class="secondary" type="button" data-provider-close>Cancel</button><button class="primary" type="submit">${provider ? 'Save provider' : 'Create provider'}</button></div>
  </form>`;
  document.body.append(dialog);
  const form = idpQ('[data-provider-form]', dialog);
  const select = idpQ('select[name="type"]', form);
  select.addEventListener('change', () => { idpQ('[data-provider-fields]', form).innerHTML = fieldsFor({ type:select.value }); });
  idpQa('[data-provider-close]', dialog).forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove(), { once:true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const permissions = idpQa('input[name="permissions"]:checked', form).map(input => input.value);
    const input = { ...values, type:select.value, enabled:idpQ('input[name="enabled"]', form).checked, permissions };
    if ('port' in input) input.port = Number(input.port);
    for (const key of ['bindPassword','clientSecret']) if (!input[key]) delete input[key];
    const error = idpQ('.form-error', form);
    error.textContent = '';
    try {
      await idpApi(provider ? `/api/security/identity-providers/${provider.id}` : '/api/security/identity-providers', { method:provider ? 'PATCH' : 'POST', body:JSON.stringify(input) });
      dialog.close();
      refreshProviders();
    } catch (problem) { error.textContent = problem.message; }
  });
  dialog.showModal();
}

async function renderProviders() {
  if (location.hash !== '#integrations') return;
  const content = idpQ('#content');
  if (!content || idpQ('.identity-provider-admin', content)) return;
  let data;
  try { data = await idpApi('/api/security/identity-providers'); } catch { return; }
  const section = document.createElement('section');
  section.className = 'identity-provider-admin';
  section.innerHTML = `<div class="admin-section-head"><div><span class="eyebrow">IDENTITY & SSO</span><h2>Authentication providers</h2><p class="muted">Configure and test LDAPS, SAML 2.0, and OpenID Connect profiles. Secrets are write-only and are never returned to the browser.</p></div><button class="primary" type="button" data-add-provider>+ Add provider</button></div>
    <div class="storage-list">${(data.providers || []).map(provider => `<article class="storage-row"><div><h3>${idpEscape(provider.name)}</h3><p>${provider.type.toUpperCase()} · ${idpEscape(providerSummary(provider))} · ${provider.enabled ? 'Enabled' : 'Disabled'}</p></div><div class="head-actions"><button class="secondary" type="button" data-test-provider="${provider.id}">Test</button><button class="secondary" type="button" data-edit-provider="${provider.id}">Edit</button><button class="secondary danger-button" type="button" data-delete-provider="${provider.id}">Delete</button></div></article>`).join('') || '<div class="empty"><p>No external identity providers configured.</p></div>'}</div>
    <div class="module-hero"><h3>Sign-in status</h3><p>LDAPS/SAML/OIDC profiles and connection tests are managed here. Local accounts and TOTP remain available. Full browser SAML/OIDC assertion/callback sign-in is not enabled until that authentication flow is configured and validated.</p></div>`;
  section.dataset.providerJson = JSON.stringify(data);
  idpQ('.page-head', content)?.insertAdjacentElement('afterend', section);
}

function refreshProviders() {
  idpQ('#content .identity-provider-admin')?.remove();
  renderProviders();
}

const idpObserver = new MutationObserver(() => {
  clearTimeout(renderProviders.timer);
  renderProviders.timer = setTimeout(renderProviders, 140);
});
idpObserver.observe(document.body, { childList:true, subtree:true });
addEventListener('hashchange', renderProviders);
addEventListener('load', renderProviders);

document.addEventListener('click', async event => {
  const section = event.target.closest('.identity-provider-admin');
  const add = event.target.closest('[data-add-provider]');
  const edit = event.target.closest('[data-edit-provider]');
  const test = event.target.closest('[data-test-provider]');
  const remove = event.target.closest('[data-delete-provider]');
  if (!add && !edit && !test && !remove) return;
  let data;
  try { data = JSON.parse((section || idpQ('.identity-provider-admin'))?.dataset.providerJson || '{}'); }
  catch { data = {}; }
  if (add) { openProviderDialog(data); return; }
  if (edit) {
    const provider = (data.providers || []).find(item => item.id === edit.dataset.editProvider);
    if (provider) openProviderDialog(data, provider);
    return;
  }
  if (test) {
    test.disabled = true;
    try {
      const result = await idpApi(`/api/security/identity-providers/${test.dataset.testProvider}/test`, { method:'POST', body:'{}' });
      alert(`Identity provider test succeeded.${result.subject ? ` TLS peer: ${result.subject}.` : ''}${result.issuer ? ` Issuer: ${result.issuer}.` : ''}`);
    } catch (problem) { alert(problem.message); }
    finally { test.disabled = false; }
    return;
  }
  if (remove) {
    if (!confirm('Delete this identity provider profile?')) return;
    try { await idpApi(`/api/security/identity-providers/${remove.dataset.deleteProvider}`, { method:'DELETE' }); refreshProviders(); }
    catch (problem) { alert(problem.message); }
  }
}, true);
