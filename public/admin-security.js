const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeText = value => String(value).replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]);

function b64urlBytes(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function bytesB64url(value) {
  const bytes = new Uint8Array(value);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function serializePasskeyRegistration(credential) {
  const response = credential?.response;
  const authenticatorData = response?.getAuthenticatorData?.();
  const publicKey = response?.getPublicKey?.();
  const algorithm = response?.getPublicKeyAlgorithm?.();
  if (!credential?.id || !response?.clientDataJSON || !authenticatorData || !publicKey || !Number.isInteger(algorithm)) {
    throw new Error('This browser cannot export the passkey registration data LightNAS needs. Update the browser and try again.');
  }
  return {
    id: credential.id,
    clientDataJSON: bytesB64url(response.clientDataJSON),
    authenticatorData: bytesB64url(authenticatorData),
    publicKey: bytesB64url(publicKey),
    algorithm
  };
}

const permissionNames = {
  'overview.view':'View overview',
  'files.read':'Read / preview files',
  'files.write':'Upload / create files',
  'files.download':'Download files & folders',
  'files.delete':'Delete files & folders',
  'media.convert':'Convert media',
  'storage.view':'View storage',
  'storage.manage':'Manage storage',
  'pools.view':'View pools & datasets',
  'shares.view':'View shares',
  'shares.manage':'Manage shares',
  'apps.view':'View App Store',
  'apps.manage':'Manage apps',
  'containers.view':'View containers',
  'containers.manage':'Manage containers',
  'containers.console':'Use container console',
  'vms.view':'View virtual machines',
  'vms.manage':'Manage virtual machines',
  'vms.console':'Use VM console',
  'network.view':'View networking',
  'network.manage':'Manage interfaces, bridges, VLANs & bonds',
  'firewall.view':'View firewall',
  'firewall.manage':'Manage firewall',
  'integrations.view':'View integrations',
  'integrations.manage':'Manage integrations',
  'backup.manage':'Manage backups',
  'audit.view':'View audit activity',
  'monitoring.view':'View monitoring',
  'capabilities.view':'View capabilities',
  'system.view':'View system information',
  'system.shell':'Use privileged node shell',
  'users.manage':'Manage users & permission groups',
  'smtp.manage':'Manage SMTP',
  'settings.manage':'Manage appliance settings',
  'admin.view':'View Admin Center'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type':'application/json', 'X-LightNAS-Request':'1', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function checkboxes(options, selected = [], prefix = '') {
  const chosen = new Set(selected);
  return `<div class="security-check-grid">${options.map(value => `<label><input type="checkbox" ${prefix ? `name="${prefix}"` : ''} value="${escapeText(value)}" ${chosen.has(value) ? 'checked' : ''}><span>${escapeText(permissionNames[value] || value)}</span></label>`).join('')}</div>`;
}

function memberCheckboxes(users, selected = []) {
  const chosen = new Set(selected);
  return `<div class="security-check-grid">${users.map(user => `<label><input type="checkbox" name="members" value="${escapeText(user.username)}" ${chosen.has(user.username) ? 'checked' : ''}><span>${escapeText(user.username)}</span></label>`).join('') || '<p class="muted">Create users first, then add them to this group.</p>'}</div>`;
}

async function renderGroups() {
  if (location.hash !== '#permissions') return;
  const content = q('#content');
  if (!content || q('.groups-admin', content)) return;
  let data;
  try { data = await api('/api/users'); } catch { return; }
  const permissions = data.permissionOptions || Object.keys(permissionNames);
  const groups = data.groups || [];
  const users = data.users || [];

  const section = document.createElement('section');
  section.className = 'groups-admin';
  section.innerHTML = `
    <div class="admin-section-head"><div><span class="eyebrow">USER POLICY</span><h2>Direct permissions</h2><p class="muted">Set permissions directly on an account. Effective access is the union of direct permissions and group permissions.</p></div></div>
    <div class="group-grid user-policy-grid">${users.map(user => `<article class="panel group-card">
      <div class="volume-title"><div><h3>${escapeText(user.username)}</h3><p>${user.disabled ? 'Disabled account' : 'Active account'} · ${(user.groups || []).map(group => escapeText(group.name)).join(', ') || 'No groups'}</p></div><span class="content-badge">${(user.effectivePermissions || []).length} effective</span></div>
      <details><summary>Manage direct policy</summary><form data-user-policy="${escapeText(user.username)}">
        <h4>Direct permissions</h4>${checkboxes(permissions, user.permissions || [], 'permissions')}
        <h4>Group memberships</h4>${groups.map(group => `<label class="security-member"><input type="checkbox" name="groups" value="${group.id}" ${(user.groups || []).some(item => item.id === group.id) ? 'checked' : ''}> <span>${escapeText(group.name)}</span></label>`).join('') || '<p class="muted">No groups created yet.</p>'}
        <label>Administrator password<input name="currentPassword" type="password" required autocomplete="current-password"></label>
        <button class="primary" type="submit">Save user policy</button>
        <div class="form-error" role="alert"></div>
      </form></details>
    </article>`).join('') || '<div class="empty"><p>No local users. Create accounts under Users first.</p></div>'}</div>

    <div class="admin-section-head"><div><span class="eyebrow">GROUP POLICY</span><h2>Groups & inherited permissions</h2><p class="muted">Users receive their direct permissions plus every permission granted by groups they belong to.</p></div><button class="primary" type="button" data-create-group>+ Create group</button></div>
    <div class="group-grid">${groups.map(group => `<article class="panel group-card" data-group-id="${group.id}">
      <div class="volume-title"><div><h3>${escapeText(group.name)}</h3><p>${escapeText(group.description || 'No description')}</p></div><span class="content-badge">${group.members.length} members</span></div>
      <details><summary>Manage group</summary><form data-group-form="${group.id}">
        <label>Name<input name="name" value="${escapeText(group.name)}" maxlength="64" required></label>
        <label>Description<input name="description" value="${escapeText(group.description || '')}" maxlength="160"></label>
        <h4>Permissions</h4>${checkboxes(permissions, group.permissions, 'permissions')}
        <h4>Members</h4>${memberCheckboxes(users, group.members)}
        <div class="head-actions"><button class="primary" type="submit">Save group</button><button class="secondary danger-button" type="button" data-delete-group="${group.id}">Delete</button></div>
        <div class="form-error" role="alert"></div>
      </form></details>
    </article>`).join('') || '<div class="empty"><p>No groups yet. Create one to assign permissions to multiple users together.</p></div>'}</div>
    <dialog class="lightnas-dialog" data-group-dialog><form class="dialog-body" data-new-group-form>
      <div class="dialog-head"><div><span class="eyebrow">NEW GROUP</span><h2>Create group</h2></div><button class="dialog-close" type="button" data-close-group>×</button></div>
      <label>Name<input name="name" maxlength="64" required placeholder="VM Operators"></label>
      <label>Description<input name="description" maxlength="160" placeholder="Users allowed to operate virtual machines"></label>
      <h4>Permissions</h4>${checkboxes(permissions, [], 'permissions')}
      <h4>Members</h4>${memberCheckboxes(users, [])}
      <div class="form-error" role="alert"></div>
      <div class="dialog-actions"><button class="secondary" type="button" data-close-group>Cancel</button><button class="primary" type="submit">Create group</button></div>
    </form></dialog>`;
  const root = q('[data-permissions-root]', content);
  if (root) root.replaceWith(section);
  else q('.page-head', content)?.insertAdjacentElement('afterend', section);
}

async function renderTotp() {
  if (location.hash !== '#settings') return;
  const content = q('#content');
  if (!content || q('.totp-admin', content)) return;

  let totp, sms, passkeys;
  try {
    [totp, sms, passkeys] = await Promise.all([
      api('/api/security/totp'),
      api('/api/security/sms'),
      api('/api/security/passkeys')
    ]);
  } catch { return; }

  const keys = passkeys.passkeys || [];
  const securePasskeys = Boolean(window.isSecureContext && navigator.credentials && window.PublicKeyCredential);
  const section = document.createElement('section');
  section.className = 'panel totp-admin';
  section.innerHTML = `
    <div class="admin-section-head">
      <div><span class="eyebrow">MULTI-FACTOR AUTHENTICATION</span><h2>Sign-in verification</h2><p class="muted">Enable an authenticator app, SMS verification, passkeys/security keys, or a combination. At sign-in, choose any enabled method.</p></div>
    </div>
    <div class="mfa-method-grid">
      <article class="panel mfa-method ${totp.enabled ? 'active' : ''}"><span class="mfa-icon">TOTP</span><div><h3>Authenticator</h3><p>Time-based 6-digit codes from Microsoft Authenticator, Google Authenticator, 1Password, Authy, and compatible apps.</p></div><span class="volume-state ${totp.enabled ? 'writable' : 'readonly'}">${totp.enabled ? 'ENABLED' : 'DISABLED'}</span></article>
      <article class="panel mfa-method ${sms.enabled ? 'active' : ''}"><span class="mfa-icon">SMS</span><div><h3>SMS code</h3><p>Send a one-time verification code through your Twilio account to the configured phone.</p></div><span class="volume-state ${sms.enabled ? 'writable' : 'readonly'}">${sms.enabled ? 'ENABLED' : 'DISABLED'}</span></article>
      <article class="panel mfa-method ${keys.length ? 'active' : ''}"><span class="mfa-icon">FIDO</span><div><h3>Passkeys & security keys</h3><p>Use WebAuthn/FIDO2 passkeys, Windows Hello, Touch ID, phone passkeys, or hardware security keys.</p></div><span class="volume-state ${keys.length ? 'writable' : 'readonly'}">${keys.length ? `${keys.length} REGISTERED` : 'DISABLED'}</span></article>
    </div>

    <div class="mfa-config-grid">
      <section class="mfa-config panel">
        <h3>Authenticator app</h3>
        ${totp.enabled
          ? `<form data-totp-disable class="security-stack-form"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><label>Current 6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></label><button class="secondary danger-button" type="submit">Disable authenticator</button><div class="form-error"></div></form>`
          : `<form data-totp-setup class="security-stack-form"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><button class="primary" type="submit">Set up authenticator</button><div class="form-error"></div></form><div data-totp-enrollment></div>`}
      </section>

      <section class="mfa-config panel">
        <h3>SMS verification</h3>
        ${sms.enabled
          ? `<p class="muted">Twilio · destination ${escapeText(sms.phone || 'configured')}</p><form data-sms-disable class="security-stack-form"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><button class="secondary danger-button" type="submit">Disable SMS verification</button><div class="form-error"></div></form>`
          : `<form data-sms-setup class="security-stack-form"><label>Twilio Account SID<input name="accountSid" required autocomplete="off" placeholder="AC…"></label><label>Twilio Auth Token<input name="authToken" type="password" required autocomplete="new-password"></label><label>Twilio From number<input name="fromNumber" required placeholder="+15551234567"></label><label>Your verification phone<input name="phone" required placeholder="+15557654321"></label><label>Current LightNAS password<input name="currentPassword" type="password" required autocomplete="current-password"></label><button class="primary" type="submit">Send setup code</button><div class="form-error"></div></form><div data-sms-enrollment></div>`}
      </section>

      <section class="mfa-config panel">
        <h3>Passkeys & security keys</h3>
        <p class="muted">${securePasskeys ? 'This browser is ready for WebAuthn.' : 'Passkeys require HTTPS (or localhost) and a WebAuthn-capable browser. Open LightNAS through HTTPS to register or use a passkey.'}</p>
        <form data-passkey-register class="security-stack-form">
          <label>Passkey name<input name="name" maxlength="64" value="My passkey" required></label>
          <label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label>
          <button class="primary" type="submit" ${securePasskeys ? '' : 'disabled'}>Register passkey / security key</button>
          <div class="form-error"></div>
        </form>
        <div class="security-key-list">
          ${keys.map(key => `<div><span><b>${escapeText(key.name)}</b><small>Created ${escapeText(key.createdAt || 'unknown')}${key.lastUsedAt ? ` · Last used ${escapeText(key.lastUsedAt)}` : ''}</small></span><button class="secondary danger-button" type="button" data-passkey-remove="${escapeText(key.id)}">Remove</button></div>`).join('') || '<p class="muted">No passkeys registered yet.</p>'}
        </div>
      </section>
    </div>`;
  q('#settings-form', content)?.insertAdjacentElement('afterend', section);
}

async function renderAutomation() {
  if (location.hash !== '#integrations') return;
  const content = q('#content');
  if (!content || q('.automation-admin', content)) return;
  let tokenData, hookData;
  try { [tokenData, hookData] = await Promise.all([api('/api/security/api-tokens'), api('/api/security/webhooks')]); } catch { return; }
  const permissions = tokenData.permissionOptions || Object.keys(permissionNames);
  const section = document.createElement('section');
  section.className = 'automation-admin';
  section.innerHTML = `
    <div class="admin-section-head"><div><span class="eyebrow">DEVELOPER & AUTOMATION</span><h2>API tokens</h2><p class="muted">Tokens use the same scoped permission model as users and never become the appliance owner.</p></div></div>
    <form class="panel creation-form" data-token-form><label>Token name<input name="name" required maxlength="64" placeholder="Backup automation"></label>${checkboxes(permissions, ['storage.view'], 'permissions')}<button class="primary" type="submit">Create token</button><div class="form-error"></div><pre class="secret-once hidden" data-token-secret></pre></form>
    <div class="storage-list">${(tokenData.tokens || []).map(token => `<article class="storage-row"><div><h3>${escapeText(token.name)}</h3><p>${token.disabled ? 'Disabled' : 'Active'} · ${(token.permissions || []).map(value => escapeText(permissionNames[value] || value)).join(', ') || 'No scopes'} · Last used ${escapeText(token.lastUsedAt || 'never')}</p></div><button class="secondary danger-button" type="button" data-delete-token="${token.id}">Delete</button></article>`).join('') || '<div class="empty"><p>No API tokens.</p></div>'}</div>
    <div class="admin-section-head"><div><span class="eyebrow">EVENT DELIVERY</span><h2>Webhooks</h2><p class="muted">LightNAS signs each JSON delivery with HMAC-SHA256 using the webhook secret.</p></div></div>
    <form class="panel creation-form" data-webhook-form><label>Name<input name="name" required maxlength="64" placeholder="Operations alerts"></label><label>HTTPS URL<input name="url" type="url" required placeholder="https://automation.example.com/lightnas"></label><label>Events<input name="events" placeholder="storage,vm,container or *" value="*"></label><button class="primary" type="submit">Create webhook</button><div class="form-error"></div><pre class="secret-once hidden" data-webhook-secret></pre></form>
    <div class="storage-list">${(hookData.webhooks || []).map(hook => `<article class="storage-row"><div><h3>${escapeText(hook.name)}</h3><p>${escapeText(hook.url)} · ${(hook.events || []).join(', ')} · Last status ${hook.lastStatus ?? 'never'}</p></div><div class="head-actions"><button class="secondary" type="button" data-test-webhook="${hook.id}">Test</button><button class="secondary danger-button" type="button" data-delete-webhook="${hook.id}">Delete</button></div></article>`).join('') || '<div class="empty"><p>No webhooks.</p></div>'}</div>`;
  q('.page-head', content)?.insertAdjacentElement('afterend', section);
}

async function renderEditableNetwork() {
  // Networking and firewall editing are rendered by app.js/dialog-controls.js.
  // Keep this compatibility stub so older extension calls do not duplicate UI.
  return;
}

function refreshCurrent() {
  const hash = location.hash;
  location.hash = '#home';
  requestAnimationFrame(() => { location.hash = hash; });
}

async function enhance() {
  await Promise.allSettled([renderGroups(), renderTotp(), renderAutomation()]);
  // Use cached FFmpeg thumbnails for images and videos rendered by the other enhancement layer.
  if (location.hash === '#files') {
    const folder = qa('#content [data-folder]').at(-1)?.dataset.folder || '';
    for (const thumb of qa('#content .file-thumb')) {
      const button = thumb.closest('[data-open]');
      if (!button) continue;
      const path = [folder, button.dataset.open].filter(Boolean).join('/');
      thumb.src = `/api/files/thumbnail?path=${encodeURIComponent(path)}`;
    }
  }
}

const observer = new MutationObserver(() => {
  clearTimeout(enhance.timer);
  enhance.timer = setTimeout(enhance, 140);
});
observer.observe(document.body, { childList:true, subtree:true });
addEventListener('hashchange', enhance);
addEventListener('load', enhance);

document.addEventListener('click', async event => {
  const createGroup = event.target.closest('[data-create-group]');
  if (createGroup) { q('[data-group-dialog]')?.showModal(); return; }
  if (event.target.closest('[data-close-group]')) { q('[data-group-dialog]')?.close(); return; }

  const deleteGroup = event.target.closest('[data-delete-group]');
  if (deleteGroup) {
    if (!confirm('Delete this group? Users keep their direct permissions.')) return;
    try { await api(`/api/groups/${deleteGroup.dataset.deleteGroup}`, { method:'DELETE' }); refreshCurrent(); } catch (error) { alert(error.message); }
    return;
  }

  const membership = event.target.closest('[data-save-memberships]');
  if (membership) {
    const form = membership.closest('form');
    const currentPassword = q('input[name="currentPassword"]', form)?.value || '';
    const groups = qa('.membership-policy input:checked', form).map(input => input.value);
    try { await api(`/api/users/${encodeURIComponent(membership.dataset.saveMemberships)}`, { method:'PATCH', body:JSON.stringify({ currentPassword, groups }) }); alert('Group memberships saved. The user must sign in again.'); refreshCurrent(); } catch (error) { alert(error.message); }
    return;
  }

  const deleteToken = event.target.closest('[data-delete-token]');
  if (deleteToken) { if (confirm('Delete this API token?')) { try { await api(`/api/security/api-tokens/${deleteToken.dataset.deleteToken}`, { method:'DELETE' }); refreshCurrent(); } catch (error) { alert(error.message); } } return; }
  const testHook = event.target.closest('[data-test-webhook]');
  if (testHook) { try { const result = await api(`/api/security/webhooks/${testHook.dataset.testWebhook}/test`, { method:'POST', body:'{}' }); alert(`Webhook test returned HTTP ${result.status}.`); } catch (error) { alert(error.message); } return; }
  const deleteHook = event.target.closest('[data-delete-webhook]');
  if (deleteHook) { if (confirm('Delete this webhook?')) { try { await api(`/api/security/webhooks/${deleteHook.dataset.deleteWebhook}`, { method:'DELETE' }); refreshCurrent(); } catch (error) { alert(error.message); } } return; }


}, true);

document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.matches('[data-user-policy]')) {
    event.preventDefault();
    const permissions = qa('input[name="permissions"]:checked', form).map(input => input.value);
    const groups = qa('input[name="groups"]:checked', form).map(input => input.value);
    const currentPassword = q('input[name="currentPassword"]', form)?.value || '';
    try {
      await api(`/api/users/${encodeURIComponent(form.dataset.userPolicy)}`, {
        method:'PATCH',
        body:JSON.stringify({ currentPassword, permissions, groups })
      });
      alert('User permission policy saved. Existing sessions for that user were ended.');
      refreshCurrent();
    } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-new-group-form]')) {
    event.preventDefault();
    const data = new FormData(form);
    const permissions = qa('input[name="permissions"]:checked', form).map(input => input.value);
    const members = qa('input[name="members"]:checked', form).map(input => input.value);
    try { await api('/api/groups', { method:'POST', body:JSON.stringify({ name:data.get('name'), description:data.get('description'), permissions, members }) }); q('[data-group-dialog]')?.close(); refreshCurrent(); } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-group-form]')) {
    event.preventDefault();
    const data = new FormData(form);
    const permissions = qa('input[name="permissions"]:checked', form).map(input => input.value);
    const members = qa('input[name="members"]:checked', form).map(input => input.value);
    try { await api(`/api/groups/${form.dataset.groupForm}`, { method:'PATCH', body:JSON.stringify({ name:data.get('name'), description:data.get('description'), permissions, members }) }); refreshCurrent(); } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-totp-setup]')) {
    event.preventDefault();
    const enrollment = q('[data-totp-enrollment]');
    try {
      const result = await api('/api/security/totp/setup', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) });
      enrollment.innerHTML = `<div class="security-enrollment"><p>Scan this QR code with Microsoft Authenticator, Google Authenticator, 1Password, Authy, or another TOTP app. You can also enter the secret manually.</p>${result.qrCode ? `<img class="totp-qr" src="${escapeText(result.qrCode)}" alt="Authenticator QR code">` : ''}<pre>${escapeText(result.secret)}</pre><details><summary>Manual setup URI</summary><code>${escapeText(result.uri)}</code></details><form data-totp-verify><label>6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button class="primary" type="submit">Verify & enable</button><div class="form-error"></div></form></div>`;
    } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-totp-verify]')) {
    event.preventDefault();
    try { await api('/api/security/totp/verify', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); alert('Authenticator 2FA is enabled.'); refreshCurrent(); } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-totp-disable]')) {
    event.preventDefault();
    try { await api('/api/security/totp/disable', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); alert('Authenticator 2FA disabled.'); refreshCurrent(); } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-token-form]')) {
    event.preventDefault();
    const data = new FormData(form);
    const permissions = qa('.security-check-grid input:checked', form).map(input => input.value);
    try { const result = await api('/api/security/api-tokens', { method:'POST', body:JSON.stringify({ name:data.get('name'), permissions }) }); const output = q('[data-token-secret]', form); output.textContent = `Copy this token now — it will not be shown again:\n${result.token}`; output.classList.remove('hidden'); } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-webhook-form]')) {
    event.preventDefault();
    const data = new FormData(form);
    const events = String(data.get('events') || '*').split(',').map(value => value.trim()).filter(Boolean);
    try { const result = await api('/api/security/webhooks', { method:'POST', body:JSON.stringify({ name:data.get('name'), url:data.get('url'), events }) }); const output = q('[data-webhook-secret]', form); output.textContent = `Signing secret — copy it now:\n${result.secret}`; output.classList.remove('hidden'); } catch (error) { q('.form-error', form).textContent = error.message; }
    return;
  }
  if (form.matches('[data-firewall-form]')) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try { await api('/api/network', { method:'POST', body:JSON.stringify({ action:'firewall-add', ...data, port:Number(data.port) }) }); refreshCurrent(); } catch (error) { q('.form-error', form).textContent = error.message; }
  }
}, true);
