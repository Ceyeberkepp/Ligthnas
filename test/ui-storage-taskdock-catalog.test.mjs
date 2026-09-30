import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('overview storage exposes configured pools and sources', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /storage\.configuredPools = storagePools\.pools \|\| \[\]/);
  assert.match(server, /storage\.availableSources = storagePools\.availableSources \|\| \[\]/);
});

test('files UI removes attached-storage tab and simplifies upload label', async () => {
  const app = await read('public/app.js');
  assert.doesNotMatch(app, /\['Attached storage', 'Attached storage'\]/);
  assert.match(app, /id="file-upload" type="file"/);
  assert.match(app, /<option value="folder">Upload folder<\/option>/);
  assert.match(app, /id="folder-upload" type="file" webkitdirectory directory multiple hidden/);
});

test('bottom task dock records progress and is collapsible', async () => {
  const [html, dialogs] = await Promise.all([read('public/index.html'), read('public/dialog-controls.js')]);
  assert.match(html, /id="task-dock"/);
  assert.match(html, /id="task-dock-toggle"/);
  assert.match(dialogs, /lightnasTasks/);
  assert.match(dialogs, /sessionStorage\.setItem\('lightnas-tasks'/);
  assert.match(dialogs, /lightnas-task-dock-collapsed/);
});

test('compute inventory exposes manage actions and shell is named Bash', async () => {
  const [app, html] = await Promise.all([read('public/app.js'), read('public/index.html')]);
  assert.match(app, /data-container-edit=/);
  assert.match(app, /data-vm-edit=/);
  assert.match(app, /Bash Shell/);
  assert.match(html, /id="node-shell-top"/);
  assert.match(html, /<b>Shell<\/b>/);
});

test('App Store contains at least ninety unique one-click entries and host ports', async () => {
  const runtime = await read('src/runtimes-next.mjs');
  const entries = [...runtime.matchAll(/\{ id: '([^']+)', name: '([^']+)'[\s\S]*? port: (\d+), containerPort: (\d+)/g)]
    .map(match => ({ id:match[1], port:Number(match[3]) }));
  assert.ok(entries.length >= 90, `expected at least 90 apps, found ${entries.length}`);
  assert.equal(new Set(entries.map(item => item.id)).size, entries.length, 'app IDs must be unique');
  assert.equal(new Set(entries.map(item => item.port)).size, entries.length, 'host ports must be unique');
});


test('Containers inventory includes App Store managed Docker containers', async () => {
  const app = await read('public/app.js');
  assert.match(app, /APP STORE CONTAINERS/);
  assert.match(app, /lightnas-app-/);
  assert.match(app, /App Store managed/);
  assert.match(app, /Docker \/ OCI/);
  assert.match(app, /data-app-action="restart"/);
  assert.match(app, /Promise\.all\(\[loadContainers\(\), loadRuntimes\(\)\]\)/);
});

test('non-modal long running work uses the Tasks dock without creating a dialog', async () => {
  const dialogs = await read('public/dialog-controls.js');
  assert.match(dialogs, /options\.modal === false \|\| options\.taskOnly === true/);
  const taskOnlyIndex = dialogs.indexOf('options.modal === false || options.taskOnly === true');
  const dialogIndex = dialogs.indexOf("document.createElement('dialog')", taskOnlyIndex);
  assert.ok(taskOnlyIndex >= 0 && dialogIndex > taskOnlyIndex, 'task-only return must happen before dialog creation');
  assert.match(dialogs, /Creating system container[\s\S]*\{ modal:false \}/);
  assert.match(dialogs, /Deleting \$\{label\}[\s\S]*\{ modal:false \}/);
});

test('Settings and MFA have responsive structured layouts', async () => {
  const styles = await read('public/styles.css');
  assert.match(styles, /\.settings-dashboard \{/);
  assert.match(styles, /\.mfa-method-grid,/);
  assert.match(styles, /\.mfa-config-grid/);
  assert.match(styles, /@media \(max-width: 1050px\)[\s\S]*\.settings-dashboard/);
});


test('managed App Store containers show access address and terminal controls', async () => {
  const [app, server, system, runtime, terminal] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('src/system.mjs'),
    read('src/runtimes-next.mjs'),
    read('public/container-console.js')
  ]);
  assert.match(app, /data-app-terminal/);
  assert.match(app, /data-app-open/);
  assert.match(app, /primaryIpv4 \|\| location\.hostname/);
  assert.match(app, /http:\/\/\$\{hostAddress\}:\$\{app\.port\}/);
  assert.match(app, /Container IP:/);
  assert.match(runtime, /NetworkSettings\.Networks/);
  assert.match(runtime, /details\.get\(item\.name\)/);
  assert.match(server, /\/api\\\/console\\\/app\\\//);
  assert.match(server, /openContainerShell\(appContainer\[1\]\)/);
  assert.match(server, /apps\.manage/);
  assert.match(system, /network\.primaryIpv4 = primaryIpv4/);
  assert.match(terminal, /params\.get\('type'\) === 'app'/);
});

test('General settings owns exclusive text or picture branding', async () => {
  const [app, server, index, styles] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/index.html'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /Logo type/);
  assert.match(app, /Brand name/);
  assert.match(app, /Upload logo picture/);
  assert.doesNotMatch(app, /<span class="eyebrow">BRANDING<\/span>/);
  assert.match(server, /brandName: store\.state\.config\.brandName \|\| 'LightNAS'/);
  assert.match(index, /data-brand-name>LightNAS/);
  assert.match(styles, /\.general-branding-row/);
});


test('network shares provision SMB and SFTP instead of saving plans only', async () => {
  const [app, index, server, shares, agent, installer, securityCss] = await Promise.all([
    read('public/app.js'),
    read('public/index.html'),
    read('src/server.mjs'),
    read('src/network-shares.mjs'),
    read('scripts/lightnas-host-agent.py'),
    read('install.sh'),
    read('public/admin-security.css')
  ]);
  assert.match(index, /SMB \+ SFTP/);
  assert.match(index, /Network username/);
  assert.match(index, /Network password/);
  assert.match(app, /Network shares/);
  assert.match(app, /sftp user@LIGHTNAS-IP/);
  assert.match(app, /share\.smb/);
  assert.match(server, /provisionNetworkShare/);
  assert.match(server, /removeNetworkShare/);
  assert.match(shares, /localProvisionNetworkShare/);
  assert.match(agent, /smbpasswd/);
  assert.match(agent, /ForceCommand internal-sftp/);
  assert.match(agent, /testparm/);
  assert.match(installer, /samba openssh-server/);
  assert.match(securityCss, /align-items: start/);
  assert.doesNotMatch(app, /Saved configurations only\. No SMB, NFS, or SFTP service is changed/);
});


test('Settings and Security do not reserve empty grid space', async () => {
  const styles = await read('public/enhancements.css');
  assert.match(styles, /\.settings-dashboard \{[\s\S]*display: block !important/);
  assert.match(styles, /\.settings-general-card,[\s\S]*\.password-card,[\s\S]*\.totp-admin/);
  assert.match(styles, /\.totp-admin \.mfa-config-grid \{[\s\S]*display: flex !important/);
  assert.match(styles, /flex-direction: column/);
  assert.match(styles, /height: auto !important/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});


test('network share provisioning uses the privileged host agent', async () => {
  const [localHost, shares, agent] = await Promise.all([
    read('src/local-host.mjs'),
    read('src/network-shares.mjs'),
    read('scripts/lightnas-host-agent.py')
  ]);
  assert.match(localHost, /share-provision/);
  assert.match(localHost, /share-remove/);
  assert.match(shares, /localProvisionNetworkShare/);
  assert.match(shares, /localRemoveNetworkShare/);
  assert.doesNotMatch(shares, /useradd/);
  assert.doesNotMatch(shares, /smbpasswd/);
  assert.match(agent, /def share_provision\(data: dict\)/);
  assert.match(agent, /useradd/);
  assert.match(agent, /smbpasswd/);
  assert.match(agent, /ForceCommand internal-sftp/);
  assert.match(agent, /if action == "share-provision"/);
});


test('nested VM runtime remains usable with TCG and qemu user NAT when tun is missing', async () => {
  const [runtime, dialogs] = await Promise.all([
    read('src/runtimes-next.mjs'),
    read('public/dialog-controls.js')
  ]);
  assert.doesNotMatch(runtime, /VM networking requires \/dev\/net\/tun inside this nested LightNAS instance/);
  assert.match(runtime, /QEMU software emulation \(TCG\) with user-mode NAT/);
  assert.match(runtime, /qemu-user/);
  assert.match(runtime, /if \(setupVm && !\/\\bready\\b\/i\.test\(setupVm\)\)/);
  assert.doesNotMatch(dialogs, /catch \(problem\) \{ alert\(problem\.message\); \}\n    return;\n  \}\n\n  const containerEdit/);
});


test('overview graph tabs span the full chart width', async () => {
  const styles = await read('public/enhancements.css');
  assert.match(styles, /\.overview-graph-tabs \{[^}]*width:100%/s);
  assert.match(styles, /\.overview-graph-tabs button \{[^}]*flex:1 1 0/s);
  assert.doesNotMatch(styles, /\.overview-graph-tabs \{[^}]*width:max-content/s);
});


test('overview graphs expose CPU count and current resource context', async () => {
  const app = await read('public/app.js');
  assert.match(app, /logical CPUs/);
  assert.match(app, /Memory usage[\s\S]*used[\s\S]*total[\s\S]*free/);
  assert.match(app, /Storage usage[\s\S]*used[\s\S]*total[\s\S]*free/);
  assert.match(app, /RX \$\{bytes\(system\.network\?\.receivedBytes/);
  assert.match(app, /overview-chart-context/);
});

test('container summary counts native and App Store containers with resource details', async () => {
  const app = await read('public/app.js');
  assert.match(app, /runtimeResourceSummary\(\[\.\.\.containers, \.\.\.appContainers\], 'containers'\)/);
  assert.match(app, /Allocated vCPU/);
  assert.match(app, /container\$\{uncappedCpu===1\?'':'s'\} uncapped/);
  assert.match(app, /Host CPU use/);
});

test('managed applications expose real Docker limits and can be edited', async () => {
  const [app, dialogs, runtime, server] = await Promise.all([
    read('public/app.js'),
    read('public/dialog-controls.js'),
    read('src/runtimes-next.mjs'),
    read('src/server.mjs')
  ]);
  assert.match(runtime, /HostConfig\?\.NanoCpus/);
  assert.match(runtime, /HostConfig\?\.Memory/);
  assert.match(runtime, /RestartPolicy\?\.Name/);
  assert.match(runtime, /export async function updateCatalogApp/);
  assert.match(runtime, /docker[\s\S]*update/);
  assert.match(server, /\/update\$/.source ? /updateCatalogApp/ : /updateCatalogApp/);
  assert.match(app, /data-app-edit/);
  assert.match(app, /app-resource-cell/);
  assert.match(dialogs, /Edit \$\{app\.name\}/);
  assert.match(dialogs, /Memory limit \(MiB\)/);
  assert.match(dialogs, /CPU limit/);
  assert.match(dialogs, /Restart policy/);
});


test('managed applications expose live CPU and memory usage plus edit controls', async () => {
  const [runtime, app, dialogs] = await Promise.all([
    read('src/runtimes-next.mjs'),
    read('public/app.js'),
    read('public/dialog-controls.js')
  ]);
  assert.match(runtime, /docker', \['stats', '--no-stream'/);
  assert.match(runtime, /cpuPercent/);
  assert.match(runtime, /memoryUsage/);
  assert.match(runtime, /memoryPercent/);
  assert.match(app, /CPU now/);
  assert.match(app, /RAM now/);
  assert.match(app, /data-app-edit/);
  assert.match(app, /host \$\{hostCores/);
  assert.match(dialogs, /Current usage/);
  assert.match(dialogs, /Memory limit \(MiB\)/);
  assert.match(dialogs, /CPU limit/);
});


test('overview and container screens expose CPU count and live resource telemetry', async () => {
  const [app, runtime, dialogs, styles] = await Promise.all([
    read('public/app.js'),
    read('src/runtimes-next.mjs'),
    read('public/dialog-controls.js'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /logical CPUs · load/);
  assert.match(app, /overview-chart-detail-strip/);
  assert.match(app, /Container memory use/);
  assert.match(app, /Allocated vCPU/);
  assert.match(app, /Host capacity/);
  assert.match(app, /Edit resources/);
  assert.match(dialogs, /Current usage/);
  assert.match(runtime, /memoryUsageBytes/);
  assert.match(runtime, /docker', \['stats'/);
  assert.match(styles, /\.overview-chart-detail-strip/);
  assert.match(styles, /\.host-capacity-card/);
});


test('Overview replaces duplicate Monitoring navigation and shows installed compute', async () => {
  const [app, index, styles] = await Promise.all([
    read('public/app.js'),
    read('public/index.html'),
    read('public/enhancements.css')
  ]);
  assert.doesNotMatch(index, /data-view="monitoring"/);
  assert.match(app, /Installed compute/);
  assert.match(app, /overviewComputeInventory/);
  assert.match(app, /Virtual machines, native containers, and App Store applications/);
  assert.match(app, /if \(view === 'monitoring'\) view = 'home'/);
  assert.match(styles, /\.overview-compute-list/);
});

test('VM creation detects missing UEFI firmware and installer provisions OVMF', async () => {
  const [runtime, installer] = await Promise.all([
    read('src/runtimes-next.mjs'),
    read('install.sh')
  ]);
  assert.match(runtime, /async function findUefiFirmware\(\)/);
  assert.match(runtime, /OVMF_CODE/);
  assert.match(runtime, /firmwareFallback/);
  assert.match(runtime, /legacy BIOS because UEFI\/OVMF firmware is not installed/);
  assert.match(installer, /openssh-server ovmf/);
});


test('VM creation prepares libvirt ACLs and forces user NAT when tun is unavailable', async () => {
  const [runtime, localHost, agent] = await Promise.all([
    read('src/runtimes-next.mjs'),
    read('src/local-host.mjs'),
    read('scripts/lightnas-host-agent.py')
  ]);
  assert.match(runtime, /localPrepareVmStorageAccess/);
  assert.match(runtime, /forceUserNat = virtualization\.diagnostics\?\.tun === false/);
  assert.match(runtime, /type === 'qemu-user'/);
  assert.match(localHost, /vm-storage-access/);
  assert.match(agent, /def vm_storage_access\(data: dict\)/);
  assert.match(agent, /setfacl/);
  assert.match(agent, /libvirt-qemu/);
});

test('AI Quick Help panel stretches to the full chat height', async () => {
  const styles = await read('public/enhancements.css');
  assert.match(styles, /\.ai-agent-shell \{[\s\S]*align-items: stretch/);
  assert.match(styles, /\.ai-agent-context,[\s\S]*\.ai-agent-chat \{[\s\S]*height: 100%/);
  assert.match(styles, /\.ai-agent-context > \.primary \{[\s\S]*margin-top: auto/);
});


test('branding uses either text or picture logo and persists site accent color', async () => {
  const [app, server, styles] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /Logo type/);
  assert.match(app, /Text logo/);
  assert.match(app, /Picture logo/);
  assert.match(app, /Site accent color/);
  assert.match(app, /node\.hidden = logoMode === 'picture'/);
  assert.match(app, /mark\.hidden = logoMode === 'text'/);
  assert.match(app, /document\.documentElement\.style\.setProperty\('--accent'/);
  assert.match(server, /logoMode === 'picture'/);
  assert.match(server, /accentColor/);
  assert.match(server, /Upload a picture logo before switching to Picture logo/);
  assert.match(styles, /\.accent-color-control/);
  assert.match(styles, /branding-preview\.picture-only/);
});


test('branding follow-up keeps logo mode exclusive and propagates accent safely', async () => {
  const [app, server, styles] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /\$\$\('\.brand-mark'\)\.forEach/);
  assert.match(app, /\$\$\('\[data-brand-name\]'\)\.forEach/);
  assert.match(app, /--accent-contrast/);
  assert.match(app, /--accent-2/);
  assert.match(app, /brandName: state\.overview\.appliance\.brandName/);
  assert.match(server, /input\.logoMode === undefined/);
  assert.match(styles, /\.primary \{[\s\S]*var\(--accent-contrast/);
  assert.match(styles, /color-mix\(in srgb, var\(--accent\) 14%/);
});


test('branding controls sidebar, main content, and login with a larger picture logo', async () => {
  const [app, server, styles] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /Sidebar color/);
  assert.match(app, /Main content color/);
  assert.match(app, /--sidebar-text/);
  assert.match(app, /--brand-content-bg/);
  assert.match(app, /request\('\/api\/branding'\)/);
  assert.match(server, /url\.pathname === '\/api\/branding'/);
  assert.match(server, /sidebarColor/);
  assert.match(server, /contentColor/);
  assert.match(styles, /\.sidebar-brand \.brand-mark\.custom-logo/);
  assert.match(styles, /height: 72px/);
  assert.match(styles, /\.auth-story \.brand-mark\.custom-logo/);
  assert.match(styles, /height: 104px/);
  assert.match(styles, /\.auth-panel \{[\s\S]*--auth-panel-bg/);
});


test('branding supports sidebar and main font colors and themes topbar/cards', async () => {
  const [app, server, styles] = await Promise.all([
    read('public/app.js'),
    read('src/server.mjs'),
    read('public/enhancements.css')
  ]);
  assert.match(app, /Sidebar font color/);
  assert.match(app, /Main font color/);
  assert.match(app, /--topbar/);
  assert.match(app, /--panel/);
  assert.match(app, /--sidebar-text/);
  assert.match(server, /sidebarTextColor/);
  assert.match(server, /contentTextColor/);
  assert.match(styles, /\.topbar \{[\s\S]*var\(--topbar\)/);
  assert.match(styles, /\.panel,[\s\S]*background: var\(--panel\)/);
});

test('Files and media uses dropdowns for view and upload actions', async () => {
  const app = await read('public/app.js');
  const styles = await read('public/enhancements.css');
  assert.match(app, /data-file-view-select/);
  assert.match(app, /data-file-upload-select/);
  assert.match(app, /Upload files/);
  assert.match(app, /Upload folder/);
  assert.match(app, /const action = event\.target\.value/);
  assert.match(app, /if \(action === 'files'\)/);
  assert.match(app, /if \(action === 'folder'\)/);
  assert.match(styles, /\.file-toolbar-select/);
});


test('branding color preview preserves all current form colors and protects contrast', async () => {
  const app = await read('public/app.js');
  assert.match(app, /function readableBrandText\(/);
  assert.match(app, /colorContrast\(preferred, background\) >= 4\.5/);
  assert.match(app, /const previewBrandingFromForm = \(\) => applyApplianceBranding\(\{/);
  assert.match(app, /accentColor: color\?\.value/);
  assert.match(app, /sidebarColor: sidebarColor\?\.value/);
  assert.match(app, /contentColor: contentColor\?\.value/);
  assert.match(app, /sidebarTextColor: sidebarTextColor\?\.value/);
  assert.match(app, /contentTextColor: contentTextColor\?\.value/);
  assert.match(app, /bindBrandColor\(contentTextColor, contentTextHex\)/);
});


test('Files upload control renders as a single dropdown', async () => {
  const app = await read('public/app.js');
  assert.doesNotMatch(app, /<label class="file-toolbar-select">Upload\s*<select data-file-upload-select/);
  assert.match(app, /<label class="file-toolbar-select upload-select-only">\s*<select data-file-upload-select aria-label="Upload">\s*<option value="">Upload…<\/option>/);
  assert.match(app, /<option value="files">Upload files<\/option>/);
  assert.match(app, /<option value="folder">Upload folder<\/option>/);
});


test('compact Files toolbar combines library selector and removes Upload wording', async () => {
  const app = await read('public/app.js');
  const css = await read('public/enhancements.css');
  assert.doesNotMatch(app, /<div class="library-selector-row">/);
  assert.match(app, /file-toolbar-select select-only library-selector/);
  assert.match(app, /<option value="">Choose…<\/option>/);
  assert.doesNotMatch(app, />Upload\s*<select data-file-upload-select/);
  assert.match(css, /\.file-toolbar \{ padding:6px 0 8px; \}/);
  assert.match(css, /\.library-selector \{\s*min-width: 138px;/);
});
