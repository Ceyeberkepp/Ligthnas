import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdir, mkdtemp, readdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { proxmoxInventory, proxmoxCreateVm, proxmoxManageVm, proxmoxUpdateVm } from './proxmox.mjs';
import { localContainerInventory, localCreateContainer, localManageContainer, localUpdateContainer } from './local-host.mjs';
import { listContainerTemplates, resolveContainerTemplate } from './templates.mjs';
import { listStoragePools, listContentAcrossPools, resolveStoragePool } from './storage-pools.mjs';

const execute = promisify(execFile);
const dataRoot = dirname(process.env.NAS_DATA_FILE || 'data/state.json');
const vmIsoDirectory = process.env.LIGHTNAS_VM_ISO_DIR || '/var/lib/libvirt/images';
let operationRunning = false;

async function exclusive(operation) {
  if (operationRunning) throw Object.assign(new Error('Another runtime operation is in progress.'), { status: 409 });
  operationRunning = true;
  try { return await operation(); } finally { operationRunning = false; }
}

export const containerImages = Object.freeze([
  { id: 'debian', name: 'Debian 13', category: 'Linux', image: 'debian:13-slim', description: 'Current Debian base image for general-purpose containers.' },
  { id: 'ubuntu', name: 'Ubuntu 24.04 LTS', category: 'Linux', image: 'ubuntu:24.04', description: 'Ubuntu LTS base image.' },
  { id: 'alpine', name: 'Alpine Linux', category: 'Linux', image: 'alpine:latest', description: 'Very small Linux base image.' },
  { id: 'nginx', name: 'Nginx', category: 'Web', image: 'nginx:stable-alpine', description: 'Popular web server and reverse proxy.' },
  { id: 'apache', name: 'Apache HTTP Server', category: 'Web', image: 'httpd:2.4-alpine', description: 'Apache HTTP server.' },
  { id: 'redis', name: 'Redis', category: 'Database', image: 'redis:alpine', description: 'In-memory data store and cache.' },
  { id: 'postgres', name: 'PostgreSQL 17', category: 'Database', image: 'postgres:17-alpine', description: 'PostgreSQL relational database.' },
  { id: 'mariadb', name: 'MariaDB 11.4', category: 'Database', image: 'mariadb:11.4', description: 'MariaDB relational database.' },
  { id: 'node', name: 'Node.js LTS', category: 'Development', image: 'node:lts-slim', description: 'Node.js LTS runtime.' },
  { id: 'python', name: 'Python 3', category: 'Development', image: 'python:3-slim', description: 'Python runtime on a compact Debian base.' },
  { id: 'busybox', name: 'BusyBox', category: 'Utility', image: 'busybox:latest', description: 'Small utility image useful for testing and diagnostics.' }
]);

const persistentShellImages = new Set(['debian:13-slim', 'ubuntu:24.04', 'alpine:latest', 'busybox:latest']);

export const catalog = Object.freeze([
  { id: 'nginx', name: 'Nginx', category: 'Web server', image: 'nginx:stable-alpine', port: 8081, containerPort: 80, memory: '256m', description: 'Open-source web server with a default landing page.', source: 'https://hub.docker.com/_/nginx', volumes: [] },
  { id: 'jellyfin', name: 'Jellyfin', category: 'Media', image: 'jellyfin/jellyfin:latest', port: 8096, containerPort: 8096, memory: '2g', description: 'Open-source media server. Reads your LightNAS Files as a library.', source: 'https://jellyfin.org/docs/general/installation/container/', volumes: [['config', '/config'], ['cache', '/cache'], ['@files', '/media:ro']] },
  { id: 'uptime-kuma', name: 'Uptime Kuma', category: 'Monitoring', image: 'louislam/uptime-kuma:2', port: 3001, containerPort: 3001, memory: '1g', description: 'Self-hosted uptime and status monitoring.', source: 'https://github.com/louislam/uptime-kuma', volumes: [['data', '/app/data']] },
  { id: 'heimdall', name: 'Heimdall', category: 'Dashboard', image: 'lscr.io/linuxserver/heimdall:latest', port: 8083, containerPort: 80, memory: '512m', description: 'Personal dashboard for your hosted applications. Configure a password before exposing it publicly.', source: 'https://docs.linuxserver.io/images/docker-heimdall/', volumes: [['config', '/config']] },
  { id: 'openspeedtest', name: 'OpenSpeedTest', category: 'Network', image: 'openspeedtest/latest', port: 8082, containerPort: 3000, memory: '512m', description: 'Test LAN speed from your browser against this server.', source: 'https://github.com/openspeedtest/Docker-Image', volumes: [] },
  { id: 'file-browser', name: 'File Browser', category: 'Files', image: 'filebrowser/filebrowser:s6', port: 8084, containerPort: 80, memory: '512m', description: 'A fast browser-based file manager for your LightNAS Files library.', source: 'https://filebrowser.org/installation', volumes: [['@files', '/srv'], ['database', '/database'], ['config', '/config']] },
  { id: 'vaultwarden', name: 'Vaultwarden', category: 'Security', image: 'vaultwarden/server:latest', port: 8085, containerPort: 80, memory: '512m', description: 'Community password-manager server compatible with Bitwarden clients. Configure an admin token after installation.', source: 'https://github.com/dani-garcia/vaultwarden', volumes: [['data', '/data']] },
  { id: 'freshrss', name: 'FreshRSS', category: 'News', image: 'freshrss/freshrss:latest', port: 8086, containerPort: 80, memory: '512m', description: 'Private, multi-user RSS and Atom feed reader.', source: 'https://github.com/FreshRSS/FreshRSS/tree/edge/Docker', volumes: [['data', '/var/www/FreshRSS/data'], ['extensions', '/var/www/FreshRSS/extensions']] },
  { id: 'home-assistant', name: 'Home Assistant', category: 'Home automation', image: 'ghcr.io/home-assistant/home-assistant:stable', port: 8123, containerPort: 8123, memory: '2g', description: 'Open-source home automation dashboard and integration hub.', source: 'https://www.home-assistant.io/installation/linux#install-home-assistant-container', volumes: [['config', '/config']] },
  { id: 'syncthing', name: 'Syncthing', category: 'Files', image: 'syncthing/syncthing:latest', port: 8384, containerPort: 8384, memory: '1g', description: 'Continuous peer-to-peer file synchronization with a local web console.', source: 'https://docs.syncthing.net/users/faq.html#how-do-i-run-syncthing-in-docker', volumes: [['data', '/var/syncthing']] },
  { id: 'mealie', name: 'Mealie', category: 'Home', image: 'ghcr.io/mealie-recipes/mealie:latest', port: 9925, containerPort: 9000, memory: '1g', description: 'Self-hosted recipe manager, meal planner, and shopping lists.', source: 'https://docs.mealie.io/documentation/getting-started/installation/backend-config/', volumes: [['data', '/app/data']] },
  { id: 'gitea', name: 'Gitea', category: 'Development', image: 'gitea/gitea:latest-rootless', port: 3002, containerPort: 3000, memory: '1g', description: 'Private Git hosting with issues, pull requests, packages, and actions.', source: 'https://docs.gitea.com/installation/install-with-docker-rootless', volumes: [['data', '/var/lib/gitea'], ['config', '/etc/gitea']] },
  { id: 'ansible-semaphore', name: 'Ansible Semaphore', category: 'Automation', image: 'semaphoreui/semaphore:latest', port: 3000, containerPort: 3000, memory: '1g', description: 'Browser-based Ansible automation, playbooks, inventories, schedules, and access control.', source: 'https://semaphoreui.com/docs/admin-guide/installation/docker', volumes: [['data', '/etc/semaphore']], namedVolumes: true, requiresAdminPassword: true, requiresAccessKeyEncryption: true, adminUsername: 'admin', environment: [['SEMAPHORE_DB_DIALECT', 'sqlite'], ['SEMAPHORE_DB', '/etc/semaphore/semaphore.sqlite'], ['SEMAPHORE_ADMIN', 'admin'], ['SEMAPHORE_ADMIN_NAME', 'LightNAS Administrator'], ['SEMAPHORE_ADMIN_EMAIL', 'admin@localhost']] },
  { id: 'it-tools', name: 'IT-Tools', category: 'Utilities', image: 'corentinth/it-tools:latest', port: 8090, containerPort: 80, memory: '512m', description: 'Offline-friendly collection of developer, networking, encoding, crypto, and text utilities.', source: 'https://github.com/CorentinTh/it-tools', volumes: [] },
  { id: 'cyberchef', name: 'CyberChef', category: 'Security', image: 'ghcr.io/gchq/cyberchef:latest', port: 8091, containerPort: 80, memory: '512m', description: 'Browser-based data transformation, decoding, parsing, and security analysis toolkit.', source: 'https://github.com/gchq/CyberChef', volumes: [] },
  { id: 'drawio', name: 'draw.io', category: 'Productivity', image: 'jgraph/drawio:latest', port: 8092, containerPort: 8080, memory: '1g', description: 'Self-hosted diagrams.net editor for network maps, flowcharts, architecture, and documentation.', source: 'https://github.com/jgraph/docker-drawio', volumes: [] },
  { id: 'stirling-pdf', name: 'Stirling PDF', category: 'Documents', image: 'stirlingtools/stirling-pdf:latest', port: 8093, containerPort: 8080, memory: '2g', description: 'Self-hosted PDF toolbox for merge, split, convert, OCR-related workflows, and document operations.', source: 'https://github.com/Stirling-Tools/Stirling-PDF', volumes: [['configs', '/configs']], namedVolumes: true },
  { id: 'changedetection', name: 'ChangeDetection.io', category: 'Monitoring', image: 'dgtlmoon/changedetection.io:latest', port: 5000, containerPort: 5000, memory: '1g', description: 'Monitor web pages for meaningful changes with a local dashboard and notification integrations.', source: 'https://github.com/dgtlmoon/changedetection.io', volumes: [['data', '/datastore']], namedVolumes: true },
  { id: 'grafana', name: 'Grafana', category: 'Monitoring', image: 'grafana/grafana-oss:latest', port: 3003, containerPort: 3000, memory: '1g', description: 'Dashboards and visualization for metrics, logs, infrastructure, and application telemetry.', source: 'https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/', volumes: [['data', '/var/lib/grafana']], namedVolumes: true },
  { id: 'navidrome', name: 'Navidrome', category: 'Media', image: 'deluan/navidrome:latest', port: 4533, containerPort: 4533, memory: '1g', description: 'Lightweight personal music server with Subsonic-compatible clients and a web player.', source: 'https://www.navidrome.org/docs/installation/docker/', volumes: [['data', '/data'], ['@files', '/music:ro']], namedVolumes: true },
  { id: 'audiobookshelf', name: 'Audiobookshelf', category: 'Media', image: 'ghcr.io/advplyr/audiobookshelf:latest', port: 13378, containerPort: 80, memory: '1g', description: 'Self-hosted audiobook and podcast server with mobile clients and progress synchronization.', source: 'https://www.audiobookshelf.org/docs/', volumes: [['config', '/config'], ['metadata', '/metadata'], ['@files', '/audiobooks:ro']], namedVolumes: true },
  { id: 'kavita', name: 'Kavita', category: 'Media', image: 'jvmilazz0/kavita:latest', port: 5001, containerPort: 5000, memory: '1g', description: 'Digital library server for comics, manga, ebooks, and reading lists.', source: 'https://www.kavitareader.com/', volumes: [['config', '/kavita/config'], ['@files', '/library:ro']], namedVolumes: true },
  { id: 'komga', name: 'Komga', category: 'Media', image: 'gotson/komga:latest', port: 25600, containerPort: 25600, memory: '1g', description: 'Media server for comics, manga, magazines, and ebooks with a responsive web reader.', source: 'https://komga.org/docs/installation/docker/', volumes: [['config', '/config'], ['@files', '/data:ro']], namedVolumes: true },
  { id: 'calibre-web', name: 'Calibre-Web', category: 'Media', image: 'lscr.io/linuxserver/calibre-web:latest', port: 8087, containerPort: 8083, memory: '1g', description: 'Web interface for browsing and reading a Calibre ebook library.', source: 'https://docs.linuxserver.io/images/docker-calibre-web/', volumes: [['config', '/config'], ['@files', '/books:ro']] },
  { id: 'sftpgo', name: 'SFTPGo', category: 'Files', image: 'drakkan/sftpgo:latest', port: 8088, containerPort: 8080, memory: '1g', description: 'Modern file-transfer server with a web administration interface and multiple storage backends.', source: 'https://github.com/drakkan/sftpgo', volumes: [['data', '/srv/sftpgo'], ['home', '/var/lib/sftpgo']], namedVolumes: true },
  { id: 'memos', name: 'Memos', category: 'Productivity', image: 'neosmemo/memos:stable', port: 5230, containerPort: 5230, memory: '512m', description: 'Private lightweight notes and knowledge capture with a clean web interface.', source: 'https://www.usememos.com/docs/install/self-hosting', volumes: [['data', '/var/opt/memos']], namedVolumes: true }
]);

async function command(program, args, timeout = 4000) {
  try {
    const { stdout } = await execute(program, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().slice(0, 1200) };
  }
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function pressInstallerBootKey(name) {
  // Windows installation media shows "Press any key to boot from CD/DVD" for
  // only a few seconds. Nested LightNAS installations may use QEMU software
  // emulation, where firmware can take considerably longer to reach that
  // prompt. Keep sending a harmless Space key across the complete boot window
  // so opening noVNC never depends on the operator winning that short race.
  for (const delay of [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7000, 8000, 9000, 10000]) {
    await wait(delay);
    const state = await command('virsh', ['-c', 'qemu:///system', 'domstate', name], 10000);
    if (!state.ok || !/running/i.test(state.output)) return;
    await command('virsh', ['-c', 'qemu:///system', 'send-key', name, '--holdtime', '80', 'KEY_SPACE'], 10000);
  }
}

function queueInstallerBootKey(name) {
  void pressInstallerBootKey(name).catch(() => {});
}

function hasInstallerMedia(output) {
  return String(output || '').split('\n').some(line => {
    const fields = line.trim().split(/\s+/);
    return fields[1]?.toLowerCase() === 'cdrom' && fields[3] && fields[3] !== '-';
  });
}

function installerMediaPath(output) {
  for (const line of String(output || '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[1]?.toLowerCase() === 'cdrom' && fields[3] && fields[3] !== '-') return fields.slice(3).join(' ');
  }
  return '';
}

export function configureVmBootXml(source, isoPath, bootOrder) {
  let xml = String(source || '').replace(/<boot\s+dev=(['"])[^'"]+\1\s*\/>\s*/g, '');
  const cdromPattern = /<disk\b[^>]*device=(['"])cdrom\1[^>]*>[\s\S]*?<\/disk>/i;
  let cdrom = xml.match(cdromPattern)?.[0] || '';
  if (!cdrom && isoPath) {
    const q35 = /<type\b[^>]*machine=(['"])[^'"]*q35[^'"]*\1/i.test(xml);
    cdrom = `<disk type='file' device='cdrom'><driver name='qemu' type='raw'/><target dev='${q35 ? 'sdb' : 'hda'}' bus='${q35 ? 'sata' : 'ide'}'/><readonly/></disk>`;
    xml = xml.replace('</devices>', `${cdrom}</devices>`);
  }
  const updatedCdrom = cdrom ? (isoPath
    ? (/<source\b[^>]*\/>/i.test(cdrom)
      ? cdrom.replace(/<source\b[^>]*\/>/i, `<source file='${String(isoPath).replaceAll('&', '&amp;').replaceAll("'", '&apos;').replaceAll('<', '&lt;')}'/>`)
      : cdrom.replace(/<target\b/i, `<source file='${String(isoPath).replaceAll('&', '&amp;').replaceAll("'", '&apos;').replaceAll('<', '&lt;')}'/><target`))
    : cdrom.replace(/\s*<source\b[^>]*\/>/i, '')).replace(/\s*<boot\s+order=(['"])[0-9]+\1\s*\/>/gi, '') : '';
  if (cdrom) xml = xml.replace(cdromPattern, updatedCdrom);

  const diskPattern = /<disk\b[^>]*device=(['"])disk\1[^>]*>[\s\S]*?<\/disk>/i;
  const disk = xml.match(diskPattern)?.[0];
  if (!disk) throw new Error('The VM does not have a bootable virtual disk.');
  const cleanDisk = disk.replace(/\s*<boot\s+order=(['"])[0-9]+\1\s*\/>/gi, '');
  const isoFirst = bootOrder === 'iso' && Boolean(isoPath);
  xml = xml.replace(diskPattern, cleanDisk.replace('</disk>', `<boot order='${isoFirst ? 2 : 1}'/></disk>`));
  if (isoPath) xml = xml.replace(cdromPattern, updatedCdrom.replace('</disk>', `<boot order='${isoFirst ? 1 : 2}'/></disk>`));
  return xml;
}

function vmBootOrder(source) {
  const cdrom = String(source || '').match(/<disk\b[^>]*device=(['"])cdrom\1[^>]*>[\s\S]*?<\/disk>/i)?.[0] || '';
  return /<boot\s+order=(['"])1\1/i.test(cdrom) ? 'iso' : 'disk';
}

function vmHardwareDetails(source) {
  const xml = String(source || '');
  return {
    firmware: /<loader\b/i.test(xml) || /firmware=(['"])efi\1/i.test(xml) ? 'uefi' : 'bios',
    machineType: xml.match(/<type\b[^>]*machine=(['"])([^'"]+)\1/i)?.[2] || 'default',
    displayModel: xml.match(/<video>[\s\S]*?<model\b[^>]*type=(['"])([^'"]+)\1/i)?.[2] || 'vga',
    networkModel: xml.match(/<interface\b[\s\S]*?<model\b[^>]*type=(['"])([^'"]+)\1/i)?.[2] || 'virtio',
    scsiController: xml.match(/<controller\b[^>]*type=(['"])scsi\1[^>]*model=(['"])([^'"]+)\2/i)?.[3] || 'virtio-scsi',
    diskBus: xml.match(/<disk\b[^>]*device=(['"])disk\1[^>]*>[\s\S]*?<target\b[^>]*bus=(['"])([^'"]+)\2/i)?.[3] || 'scsi'
  };
}

export function configureVmEditableHardware(source, settings = {}) {
  let xml = String(source || '');
  const existing = vmHardwareDetails(xml);
  const displayModel = ['vga', 'qxl', 'virtio'].includes(settings.displayModel) ? settings.displayModel : existing.displayModel;
  const networkModel = ['virtio', 'e1000', 'rtl8139'].includes(settings.networkModel) ? settings.networkModel : existing.networkModel;
  const scsiController = ['virtio-scsi', 'virtio-scsi-single', 'lsilogic'].includes(settings.scsiController) ? settings.scsiController : existing.scsiController;
  const diskBus = ['scsi', 'virtio', 'sata'].includes(settings.diskBus) ? settings.diskBus : existing.diskBus;
  // Video model attributes are not interchangeable. In particular, libvirt
  // rejects qxl's `ram` attribute after changing only type='qxl' to
  // type='vga'. Replace the complete model element so switching adapters in
  // the editor always produces a definition accepted by libvirt.
  const videoModel = displayModel === 'qxl'
    ? `<model type='qxl' ram='65536' vram='65536' vgamem='16384' heads='1' primary='yes'/>`
    : displayModel === 'virtio'
      ? `<model type='virtio' heads='1' primary='yes'/>`
      : `<model type='vga' vram='16384' heads='1' primary='yes'/>`;
  xml = xml.replace(/(<video>\s*)<model\b[^>]*(?:\/>|>[\s\S]*?<\/model>)/i, `$1${videoModel}`);
  xml = xml.replace(/(<interface\b[\s\S]*?<model\b[^>]*type=)(['"])[^'"]+\2/i, `$1'${networkModel}'`);
  xml = xml.replace(/(<controller\b[^>]*type=(['"])scsi\2[^>]*model=)(['"])[^'"]+\3/i, `$1'${scsiController}'`);
  const diskPattern = /<disk\b[^>]*device=(['"])disk\1[^>]*>[\s\S]*?<\/disk>/i;
  xml = xml.replace(diskPattern, block => {
    const device = diskBus === 'virtio' ? 'vda' : 'sda';
    return block
      .replace(/<target\b[^>]*\/>/i, `<target dev='${device}' bus='${diskBus}'/>`)
      .replace(/\s*<alias\b[^>]*\/>/gi, '')
      .replace(/\s*<address\b[^>]*type=(['"])drive\1[^>]*\/>/gi, '');
  });
  if (diskBus === 'scsi' && !/<controller\b[^>]*type=(['"])scsi\1/i.test(xml)) {
    xml = xml.replace('</devices>', `<controller type='scsi' model='${scsiController}'/></devices>`);
  }
  return xml;
}


function parseDomInfo(text) {
  const values = {};
  for (const line of String(text || '').split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) values[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return values;
}

async function localVmDetails(names) {
  const details = [];
  for (const name of names.slice(0, 100)) {
    const [info, blockDevices, domainXml, memoryStats] = await Promise.all([
      command('virsh', ['-c', 'qemu:///system', 'dominfo', name], 10000),
      command('virsh', ['-c', 'qemu:///system', 'domblklist', name, '--details'], 10000),
      command('virsh', ['-c', 'qemu:///system', 'dumpxml', name, '--inactive'], 10000),
      command('virsh', ['-c', 'qemu:///system', 'dommemstat', name], 10000)
    ]);
    if (!info.ok) continue;
    const parsed = parseDomInfo(info.output);
    const memory = memoryStats.ok ? Object.fromEntries(memoryStats.output.split('\n').map(line => line.trim().split(/\s+/, 2)).filter(parts => parts.length === 2)) : {};
    const memoryUsed = Math.max(0, ((Number(memory.actual) || 0) - (Number(memory.unused) || 0)) * 1024);
    details.push({
      id: name,
      name,
      uuid: parsed.uuid || null,
      status: parsed.state || 'unknown',
      cpus: Number(parsed['cpu(s)']) || 0,
      memory: (Number(String(parsed['max memory'] || '').split(/\s+/)[0]) || 0) * 1024,
      memoryUsed,
      persistent: parsed.persistent === 'yes',
      installationMedia: blockDevices.ok && hasInstallerMedia(blockDevices.output),
      installationMediaPath: blockDevices.ok ? installerMediaPath(blockDevices.output) : '',
      bootOrder: domainXml.ok ? vmBootOrder(domainXml.output) : 'disk',
      ...(domainXml.ok ? vmHardwareDetails(domainXml.output) : {}),
      startOnBoot: parsed.autostart === 'enable'
    });
  }
  return details;
}

async function localManageVm(id, action) {
  const name = String(id || '');
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(name)) throw Object.assign(new Error('Invalid VM name.'), { status: 400 });
  const allowed = new Set(['start', 'stop', 'shutdown', 'reboot', 'reset', 'delete']);
  if (!allowed.has(action)) throw Object.assign(new Error('Invalid VM action.'), { status: 400 });
  if (action === 'delete') {
    await command('virsh', ['-c', 'qemu:///system', 'destroy', name], 30000);
    const result = await command('virsh', ['-c', 'qemu:///system', 'undefine', name, '--remove-all-storage', '--nvram'], 120000);
    if (!result.ok) throw Object.assign(new Error(`VM delete failed: ${result.error}`), { status: 409 });
    return { id: name, action, status: 'deleted' };
  }
  const verb = action === 'stop' ? 'destroy' : action;
  const result = await command('virsh', ['-c', 'qemu:///system', verb, name], 60000);
  if (!result.ok) throw Object.assign(new Error(`VM ${action} failed: ${result.error}`), { status: 409 });
  return { id: name, action, status: 'submitted' };
}

async function localUpdateVm(input) {
  const id = String(input.id || input.name || '');
  const requestedName = String(input.name || id);
  const memory = Number(input.memoryMiB);
  const cpus = Number(input.cpus);
  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(id) || !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(requestedName)) throw Object.assign(new Error('Invalid VM name.'), { status: 400 });
  if (!Number.isInteger(memory) || memory < 512 || memory > 262144 || !Number.isInteger(cpus) || cpus < 1 || cpus > 128) throw Object.assign(new Error('Invalid VM CPU or memory values.'), { status: 400 });

  if (requestedName !== id) {
    const state = await command('virsh', ['-c', 'qemu:///system', 'domstate', id], 10000);
    if (!state.ok || !/shut off|shutoff|inactive/i.test(state.output)) throw Object.assign(new Error('Shut down the VM before renaming it.'), { status: 409 });
    const rename = await command('virsh', ['-c', 'qemu:///system', 'domrename', id, requestedName], 30000);
    if (!rename.ok) throw Object.assign(new Error(`VM rename failed: ${rename.error}`), { status: 409 });
  }
  const target = requestedName;
  const mem = await command('virsh', ['-c', 'qemu:///system', 'setmaxmem', target, `${memory}MiB`, '--config'], 30000);
  if (!mem.ok) throw Object.assign(new Error(`Unable to change VM memory: ${mem.error}`), { status: 409 });
  await command('virsh', ['-c', 'qemu:///system', 'setmem', target, `${memory}MiB`, '--config'], 30000);
  const cpu = await command('virsh', ['-c', 'qemu:///system', 'setvcpus', target, String(cpus), '--config', '--maximum'], 30000);
  if (!cpu.ok) {
    const fallback = await command('virsh', ['-c', 'qemu:///system', 'setvcpus', target, String(cpus), '--config'], 30000);
    if (!fallback.ok) throw Object.assign(new Error(`Unable to change VM CPUs: ${fallback.error}`), { status: 409 });
  }
  await command('virsh', ['-c', 'qemu:///system', 'setvcpus', target, String(cpus), '--config'], 30000);

  const isoId = String(input.iso || '');
  const bootOrder = input.bootOrder === 'iso' ? 'iso' : 'disk';
  const availableIsos = await listContentAcrossPools('iso').catch(() => []);
  const isoEntry = isoId ? availableIsos.find(item => item.id === isoId) : null;
  if (isoId && !isoEntry) throw Object.assign(new Error('The selected installer ISO is incomplete or no longer available. Upload it again and wait for the transfer to finish.'), { status: 409 });
  const [xmlResult, stateResult] = await Promise.all([
    command('virsh', ['-c', 'qemu:///system', 'dumpxml', target, '--inactive'], 10000),
    command('virsh', ['-c', 'qemu:///system', 'domstate', target], 10000)
  ]);
  if (!xmlResult.ok) throw Object.assign(new Error(`Unable to read VM hardware: ${xmlResult.error}`), { status: 409 });
  const currentMedia = installerMediaPath((await command('virsh', ['-c', 'qemu:///system', 'domblklist', target, '--details'], 10000)).output);
  const bootXml = configureVmBootXml(xmlResult.output, isoEntry?.path || '', bootOrder);
  const updatedXml = configureVmEditableHardware(bootXml, input);
  const hardwareChanged = currentMedia !== (isoEntry?.path || '') || updatedXml !== xmlResult.output;
  if (hardwareChanged) {
    const directory = await mkdtemp(join(tmpdir(), 'lightnas-vm-'));
    const definition = join(directory, `${target}.xml`);
    try {
      await writeFile(definition, updatedXml, { mode: 0o600 });
      const define = await command('virsh', ['-c', 'qemu:///system', 'define', definition], 30000);
      if (!define.ok) throw Object.assign(new Error(`Unable to update VM boot hardware: ${define.error}`), { status: 409 });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    if (/running/i.test(stateResult.output || '')) {
      await command('virsh', ['-c', 'qemu:///system', 'destroy', target], 30000);
      const start = await command('virsh', ['-c', 'qemu:///system', 'start', target], 60000);
      if (!start.ok) throw Object.assign(new Error(`VM settings were saved, but it could not restart: ${start.error}`), { status: 409 });
    }
  }
  // Saving ISO-first is also the supported recovery path when a slow guest
  // previously missed the optical-media boot prompt. Restart even when the
  // selected hardware is unchanged, then cover the whole firmware boot window.
  if (isoEntry && bootOrder === 'iso') {
    if (!hardwareChanged && /running/i.test(stateResult.output || '')) {
      const reset = await command('virsh', ['-c', 'qemu:///system', 'reset', target], 30000);
      if (!reset.ok) throw Object.assign(new Error(`VM settings were saved, but installer boot could not restart: ${reset.error}`), { status: 409 });
    } else if (!/running/i.test(stateResult.output || '')) {
      const start = await command('virsh', ['-c', 'qemu:///system', 'start', target], 60000);
      if (!start.ok && !/already active/i.test(start.error || '')) throw Object.assign(new Error(`VM settings were saved, but it could not start: ${start.error}`), { status: 409 });
    }
    queueInstallerBootKey(target);
  }
  const autostart = input.startOnBoot === false || input.startOnBoot === 'false' ? 'disable' : 'enable';
  const autostartResult = await command('virsh', ['-c', 'qemu:///system', 'autostart', target, ...(autostart === 'disable' ? ['--disable'] : [])], 30000);
  if (!autostartResult.ok) throw Object.assign(new Error(`VM settings were saved, but autostart could not be updated: ${autostartResult.error}`), { status: 409 });
  return { id: target, name: target, memoryMiB: memory, cpus, iso: isoId, bootOrder, status: hardwareChanged ? 'updated and restarted' : 'updated' };
}
function requireDeletionConfirmation(input, id, label) {
  if (input?.deleteFiles !== true || String(input?.confirmation || '') !== id) {
    throw Object.assign(new Error(`Deleting this ${label} requires “delete all files” and its exact ID.`), { status: 400 });
  }
}

export async function runtimeInventory() {
  const [dockerInfo, vmInfo, vmNetworks, installer, hostBridges, lightnasStorage, storageIsos] = await Promise.all([
    command('docker', ['info', '--format', '{{.ServerVersion}}']),
    command('virsh', ['-c', 'qemu:///system', 'list', '--all', '--name']),
    command('virsh', ['-c', 'qemu:///system', 'net-list', '--name']),
    command('virt-install', ['--version']),
    command('ip', ['-j', 'link', 'show', 'type', 'bridge']),
    listStoragePools().catch(() => ({ pools: [] })),
    listContentAcrossPools('iso').catch(() => [])
  ]);
  const vmStoragePools = (lightnasStorage.pools || []).filter(pool => pool.online && pool.writable && pool.content.includes('images'));
  const containerStoragePools = (lightnasStorage.pools || []).filter(pool => pool.online && pool.writable && pool.content.includes('rootdir'));
  const images = storageIsos.map(item => item.id);
  const runtime = {
    docker: { available: dockerInfo.ok, enabled: process.env.LIGHTNAS_DOCKER_ENABLED === '1', reason: dockerInfo.ok ? null : 'Optional app runtime is not installed or not accessible.', containers: [], presets: containerImages },
    containers: { available: false, enabled: false, provider: 'local-lxc', reason: 'Native LXC is not available on this LightNAS host.', containers: [], images: [], networks: [], pools: containerStoragePools.map(pool => pool.id), storageDetails: containerStoragePools, storageRoot: null },
    virtualization: { available: vmInfo.ok && installer.ok, enabled: process.env.LIGHTNAS_VM_ENABLED === '1', provider: 'libvirt', acceleration: process.env.LIGHTNAS_VM_ACCELERATION || 'auto', reason: vmInfo.ok && installer.ok ? null : 'QEMU/libvirt is unavailable on this LightNAS host.', warning: null, machines: [], machineDetails: [], pools: vmStoragePools.map(pool => pool.id), storageDetails: vmStoragePools, networks: [], networkDetails: [], images, isoDetails: storageIsos.map(item => ({ id: item.id, name: item.name, storageId: item.storageId, storageName: item.storageName, sizeBytes: item.sizeBytes })) }
  };
  try {
    runtime.containers = await localContainerInventory();
    runtime.containers.pools = containerStoragePools.map(pool => pool.id);
    runtime.containers.storageDetails = containerStoragePools;
    const templateLibrary = await listContainerTemplates().catch(() => ({ templates: [] }));
    runtime.containers.images = [
      ...templateLibrary.templates.map(item => ({
        id: item.id,
        label: `${item.filename} · ${item.storageLabel}`,
        source: 'template-library',
        filename: item.filename,
        storageLabel: item.storageLabel,
        sizeBytes: item.sizeBytes
      })),
      ...(runtime.containers.images || [])
    ];
    runtime.containers.templateCount = templateLibrary.templates.length;
    runtime.virtualization.diagnostics = runtime.containers.diagnostics || null;
    if (runtime.containers.diagnostics?.nested) {
      const kvm = runtime.containers.diagnostics.kvm;
      if (!runtime.containers.diagnostics.tun) {
        runtime.virtualization.available = false;
        runtime.virtualization.enabled = false;
        runtime.virtualization.reason = 'VM networking requires /dev/net/tun inside this nested LightNAS instance.';
      } else if (kvm?.usable) {
        runtime.virtualization.acceleration = 'kvm';
      } else {
        runtime.virtualization.acceleration = 'tcg';
        runtime.virtualization.provider = 'libvirt-qemu';
        runtime.virtualization.warning = 'Hardware virtualization is unavailable, so LightNAS will use QEMU software emulation (TCG). VMs work, but they run slower than KVM.';
      }
    } else if (runtime.virtualization.acceleration === 'tcg') {
      runtime.virtualization.provider = 'libvirt-qemu';
      runtime.virtualization.warning = 'Hardware virtualization is unavailable, so LightNAS will use QEMU software emulation (TCG).';
    } else {
      runtime.virtualization.provider = 'libvirt-kvm';
    }
  } catch (error) {
    runtime.containers = { available: false, enabled: false, provider: 'local-lxc', reason: `Native LXC host agent unavailable: ${error.message}`, containers: [], images: [], networks: [], storageRoot: null, diagnostics: null };
  }

  if (runtime.virtualization.available) {
    const names = vmInfo.output ? vmInfo.output.split('\n').filter(Boolean) : [];
    runtime.virtualization.machineDetails = await localVmDetails(names);
    runtime.virtualization.machineDetails = runtime.virtualization.machineDetails.map(item => {
      const media = storageIsos.find(iso => iso.path === item.installationMediaPath);
      const { installationMediaPath: _privatePath, ...visible } = item;
      return { ...visible, installationMediaId: media?.id || '', installationMediaName: media?.name || '' };
    });
    runtime.virtualization.machines = runtime.virtualization.machineDetails.map(item => `${item.name} · ${item.status}`);
    const libvirtNetworks = vmNetworks.ok && vmNetworks.output ? vmNetworks.output.split('\n').filter(Boolean) : [];
    let bridges = [];
    if (hostBridges.ok && hostBridges.output) {
      try {
        bridges = JSON.parse(hostBridges.output)
          .filter(item => item.ifname !== 'docker0' && (item.flags || []).includes('UP'))
          .map(item => item.ifname)
          .filter(name => /^[A-Za-z0-9_.:-]{1,32}$/.test(name || ''));
        const defaultRoute = await command('ip', ['-j', '-4', 'route', 'show', 'default']);
        let defaultBridge = '';
        if (defaultRoute.ok && defaultRoute.output) {
          try { defaultBridge = String((JSON.parse(defaultRoute.output)[0] || {}).dev || ''); } catch {}
        }
        if (defaultBridge && bridges.includes(defaultBridge)) bridges = [defaultBridge, ...bridges.filter(name => name !== defaultBridge)];
        else if (bridges.includes('virbr0')) bridges = ['virbr0', ...bridges.filter(name => name !== 'virbr0')];
        else if (bridges.includes('lightnas0')) bridges = ['lightnas0', ...bridges.filter(name => name !== 'lightnas0')];
      } catch {}
    }
    const networkState = await readFile('/etc/lightnas/network.env', 'utf8').catch(() => '');
    const lxcNatMode = /^LIGHTNAS_NETWORK_MODE=lxc-nat$/m.test(networkState);
    const bridged = bridges.filter(name => !libvirtNetworks.includes(name)).map(name => ({
      name,
      type: 'host-bridge',
      label: name === bridges[0] ? `${name} · appliance LAN bridge` : `${name} · host bridge`
    }));
    runtime.virtualization.networkDetails = [
      ...(lxcNatMode ? [] : bridged),
      ...libvirtNetworks.map(name => ({ name, type: 'libvirt-network', label: `${name} · LightNAS managed NAT` })),
      { name: 'qemu-user', type: 'qemu-user', label: 'QEMU user NAT fallback' }
    ].filter((item, index, all) => all.findIndex(other => other.name === item.name) === index);
    runtime.virtualization.networks = runtime.virtualization.networkDetails.map(item => item.name);
  }

  if (dockerInfo.ok) {
    const list = await command('docker', ['ps', '-a', '--format', '{{json .}}']);
    if (list.ok) runtime.docker.containers = list.output.split('\n').filter(Boolean).flatMap(row => {
      try {
        const item = JSON.parse(row);
        return [{ name: item.Names, image: item.Image, state: item.State, status: item.Status, ports: item.Ports, managed: item.Names?.startsWith('lightnas-') }];
      } catch { return []; }
    });
  }
  const setup = await readFile(join(dataRoot, 'runtime-status.txt'), 'utf8').catch(() => '');
  if (!runtime.docker.available && setup) runtime.docker.reason = setup.split('\n').find(line => line.startsWith('Apps: '))?.slice(6) || runtime.docker.reason;
  if (!runtime.virtualization.available && setup) runtime.virtualization.reason = setup.split('\n').find(line => line.startsWith('VMs: '))?.slice(5) || runtime.virtualization.reason;
  if (process.env.LIGHTNAS_ENABLE_PROXMOX_PROVIDER === '1' && Object.keys(process.env).some(key => key.startsWith('LIGHTNAS_PVE_'))) {
    try { runtime.virtualization = await proxmoxInventory() || runtime.virtualization; }
    catch (error) { runtime.virtualization = { available: false, enabled: true, provider: 'proxmox', reason: `Optional Proxmox provider failed: ${error.message}`, machines: [], machineDetails: [], pools: [], networks: [], images: [] }; }
  }
  return runtime;
}

async function runDocker(args, timeout = 180000) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker actions are disabled. The operator must explicitly enable them on a Docker host.'), { status: 409 });
  const response = await exclusive(() => command('docker', args, timeout));
  if (!response.ok) throw Object.assign(new Error(`Docker: ${response.error}`), { status: 409 });
  return response.output;
}

async function pullDockerImage(image) {
  try { return await runDocker(['pull', image], 600000); }
  catch (error) { throw Object.assign(new Error(`Unable to download Docker image ${image}: ${error.message.replace(/^Docker:\s*/, '')}`), { status: error.status || 409 }); }
}

async function waitForAppPort(port, timeoutMs = 90000) {
  if (process.env.LIGHTNAS_SKIP_APP_READINESS === '1') return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = value => { socket.destroy(); resolve(value); };
      socket.setTimeout(1500, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (ready) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

export async function installCatalogApp(id, input = {}) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker actions are disabled on this host.'), { status: 409 });
  const app = catalog.find(item => item.id === id);
  if (!app) throw Object.assign(new Error('Unknown catalog app.'), { status: 404 });
  const name = `lightnas-app-${app.id}`;
  await pullDockerImage(app.image);
  const args = ['run', '-d', '--name', name,
    '--label', `lightnas.catalog=${app.id}`,
    '--label', `lightnas.web.port=${app.port}`,
    '--restart', 'unless-stopped', '--memory', app.memory, '--pids-limit', '256',
    '--security-opt', 'no-new-privileges', '-p', `0.0.0.0:${app.port}:${app.containerPort}`];
  const environment = [...(app.environment || [])];
  if (app.requiresAdminPassword) {
    const adminPassword = String(input.adminPassword || '');
    if (adminPassword.length < 8 || adminPassword.length > 128) {
      throw Object.assign(new Error('Create an application administrator password containing 8–128 characters.'), { status: 400 });
    }
    environment.push(['SEMAPHORE_ADMIN_PASSWORD', adminPassword]);
  }
  if (app.requiresAccessKeyEncryption) environment.push(['SEMAPHORE_ACCESS_KEY_ENCRYPTION', randomBytes(32).toString('base64')]);
  for (const [key, value] of environment) args.push('-e', `${key}=${value}`);
  for (const [folder, target] of app.volumes) {
    if (app.namedVolumes && folder !== '@files') {
      args.push('-v', `lightnas-app-${id}-${folder}:${target}`);
      continue;
    }
    const hostPath = folder === '@files' ? join(dataRoot, 'files') : join(dataRoot, 'apps', id, folder);
    await mkdir(hostPath, { recursive: true, mode: 0o700 });
    args.push('-v', `${hostPath}:${target}`);
  }
  args.push(app.image);
  const containerId = await runDocker(args);
  const ready = await waitForAppPort(app.port);
  return {
    id: app.id,
    image: app.image,
    containerId,
    port: app.port,
    ready,
    access: { scheme: 'http', port: app.port, path: '/' },
    message: ready ? 'Application installed and reachable through LightNAS.' : 'Application was started but is still initializing. LightNAS will keep it running; refresh Installed Apps shortly.'
  };
}

export async function manageCatalogApp(id, action) {
  if (!catalog.some(app => app.id === id)) throw Object.assign(new Error('Unknown catalog app.'), { status: 404 });
  if (!['start', 'stop', 'restart', 'remove'].includes(action)) throw Object.assign(new Error('Invalid app action.'), { status: 400 });
  const name = `lightnas-app-${id}`;
  await runDocker(action === 'remove' ? ['rm', '-f', name] : [action, name]);
  return { id, action, dataPreserved: action === 'remove' };
}

async function assertManagedContainer(name) {
  if (!/^lightnas-[a-z0-9][a-z0-9-]{0,60}$/.test(name || '')) throw Object.assign(new Error('Invalid LightNAS app container name.'), { status: 400 });
  const inspected = await runDocker(['inspect', '--format', '{{index .Config.Labels "lightnas.managed"}}|{{index .Config.Labels "lightnas.catalog"}}|{{.State.Running}}', name], 15000);
  const [managed, catalogId, running] = inspected.split('|');
  if (managed !== 'true' && !catalogId) throw Object.assign(new Error('Only LightNAS-managed app containers can be controlled here.'), { status: 403 });
  return { running: running === 'true' };
}

export async function openContainerShell(name) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('The optional Docker app engine is disabled.'), { status: 409 });
  const state = await assertManagedContainer(name);
  if (!state.running) throw Object.assign(new Error('Start the app container before opening its shell.'), { status: 409 });
  return spawn('docker', ['exec', '-i', name, 'sh'], { stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function createContainer(input) {
  const inventory = await localContainerInventory();
  if (!inventory?.available || !inventory.enabled) throw Object.assign(new Error(inventory?.reason || 'Native LXC is unavailable on this LightNAS host.'), { status: 409 });
  if (input?.action) {
    const id = String(input.id || input.name || '');
    if (input.action === 'update') return await localUpdateContainer({
      id,
      name: input.name || input.id,
      memoryMiB: Number(input.memoryMiB),
      cpus: Number(input.cpus),
      network: input.network,
      ipv4Mode: input.ipv4Mode,
      ipv4Address: input.ipv4Address,
      gateway: input.gateway,
      dns: input.dns,
      startOnBoot: input.startOnBoot !== false
    });
    if (input.action === 'delete') requireDeletionConfirmation(input, id, 'container');
    return await localManageContainer(id, input.action, { deleteFiles: input.deleteFiles === true, confirmation: input.confirmation });
  }

  if (!/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(input.name || '')) throw Object.assign(new Error('Use a 2–40 character container name.'), { status: 400 });
  const password = String(input.password || '');
  if (password.length < 4 || password.length > 128 || /[\r\n:]/.test(password)) {
    throw Object.assign(new Error('Set a 4–128 character root password without colons or line breaks.'), { status: 400 });
  }
  const memory = Number(input.memoryMiB), cpus = Number(input.cpus), disk = Number(input.diskGiB);
  if (!Number.isInteger(memory) || memory < 256 || memory > 65536 || !Number.isInteger(cpus) || cpus < 1 || cpus > 32 || !Number.isInteger(disk) || disk < 2 || disk > 2048) {
    throw Object.assign(new Error('Use 256–65536 MiB RAM, 1–32 CPUs and a 2–2048 GiB root disk allocation.'), { status: 400 });
  }
  const storage = await resolveStoragePool(String(input.pool || ''), 'rootdir', true);
  if (storage.availableBytes > 0 && disk * 1024 ** 3 > storage.availableBytes) {
    throw Object.assign(new Error('The selected storage does not have enough free space for this container disk allocation.'), { status: 507 });
  }

  const importedTemplate = String(input.image || '').startsWith('template:')
    ? await resolveContainerTemplate(input.image)
    : null;
  if (String(input.image || '').startsWith('template:') && !importedTemplate) {
    throw Object.assign(new Error('The selected container template is no longer available on storage.'), { status: 409 });
  }
  return await localCreateContainer({
    name: input.name,
    image: input.image,
    templatePath: importedTemplate?.path || '',
    storageRoot: join(storage.root, 'rootdir'),
    storageId: storage.id,
    diskGiB: disk,
    password,
    memoryMiB: memory,
    cpus,
    network: input.network,
    startOnBoot: input.startOnBoot !== false && input.startOnBoot !== 'false',
    ipv4Mode: input.ipv4Mode === 'manual' ? 'manual' : 'dhcp',
    ipv4Address: String(input.ipv4Address || ''),
    gateway: String(input.gateway || ''),
    dns: String(input.dns || ''),
    vlanTag: input.vlanTag ? Number(input.vlanTag) : null,
    macAddress: String(input.macAddress || '')
  });
}

export async function createVm(input) {
  const { virtualization } = await runtimeInventory();
  if (input?.action) {
    const id = String(input.vmid || input.id || input.name || '');
    if (input.action === 'delete') requireDeletionConfirmation(input, id, 'virtual machine');
    if (virtualization.provider?.startsWith('proxmox')) {
      if (input.action === 'update') return await proxmoxUpdateVm(input);
      return await proxmoxManageVm(id, input.action);
    }
    if (input.action === 'update') return await localUpdateVm(input);
    return await localManageVm(id, input.action);
  }

  if (!virtualization.available || !virtualization.enabled) throw Object.assign(new Error(virtualization.reason || 'QEMU/libvirt virtualization is disabled on this host.'), { status: 409 });
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,39}$/.test(input.name || '')) throw Object.assign(new Error('Use a 2–40 character VM name.'), { status: 400 });
  const memory = Number(input.memoryMiB), cpus = Number(input.cpus), disk = Number(input.diskGiB);
  if (!Number.isInteger(memory) || memory < 1024 || memory > 65536 || !Number.isInteger(cpus) || cpus < 1 || cpus > 32 || !Number.isInteger(disk) || disk < 10 || disk > 2048) throw Object.assign(new Error('Use 1024–65536 MiB RAM, 1–32 CPUs and 10–2048 GiB disk.'), { status: 400 });
  const iso = String(input.iso || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(input.pool || '') || !/^[a-zA-Z0-9._:-]{1,48}$/.test(input.network || '') || !virtualization.pools.includes(input.pool) || !virtualization.networks.includes(input.network) || (iso && !virtualization.images.includes(iso))) throw Object.assign(new Error('Select an accessible LightNAS VM storage/network and, optionally, an available installer ISO.'), { status: 409 });

  if (virtualization.provider?.startsWith('proxmox')) return proxmoxCreateVm(input, virtualization);
  if (virtualization.machineDetails.some(item => item.name === input.name)) throw Object.assign(new Error('A VM with this name already exists.'), { status: 409 });

  const vmStorage = await resolveStoragePool(input.pool, 'images', true);
  const diskDirectory = join(vmStorage.root, 'images', input.name);
  await mkdir(diskDirectory, { recursive: true });
  const diskPath = join(diskDirectory, `${input.name}.qcow2`);
  const isoEntry = iso ? (await listContentAcrossPools('iso')).find(item => item.id === iso) : null;
  if (iso && !isoEntry) throw Object.assign(new Error('Selected installer ISO is incomplete or no longer available. Upload it again and wait for the transfer to finish.'), { status: 409 });

  const networkDetail = virtualization.networkDetails?.find(item => item.name === input.network);
  const firmware = ['bios', 'uefi'].includes(input.firmware) ? input.firmware : 'bios';
  // SATA and E1000 work in Windows and Linux installers without a separate
  // VirtIO driver ISO. Users can switch to VirtIO after the guest drivers are
  // installed when they prefer its performance.
  const diskBus = ['scsi', 'virtio', 'sata'].includes(input.diskBus) ? input.diskBus : 'sata';
  const networkModel = ['virtio', 'e1000', 'rtl8139'].includes(input.networkModel) ? input.networkModel : 'e1000';
  const networkArg = networkDetail?.type === 'qemu-user'
    ? `user,model=${networkModel}`
    : networkDetail?.type === 'host-bridge'
      ? `bridge=${input.network},model=${networkModel}`
      : `network=${input.network},model=${networkModel}`;
  const virtType = virtualization.acceleration === 'kvm' ? 'kvm' : 'qemu';
  const diskController = diskBus === 'scsi' ? ['--controller', 'scsi,model=virtio-scsi'] : [];
  const args = ['--connect', 'qemu:///system', '--virt-type', virtType, '--name', input.name, '--memory', String(memory), '--vcpus', String(cpus), '--disk', `path=${diskPath},size=${disk},format=qcow2,bus=${diskBus}`, ...diskController, '--network', networkArg, '--graphics', 'vnc,listen=127.0.0.1', '--video', 'vga', '--noautoconsole', '--wait', '0'];
  if (isoEntry) args.push('--cdrom', isoEntry.path, '--osinfo', 'detect=on,require=off');
  else args.push('--import', '--osinfo', 'generic');
  args.push('--boot', firmware === 'uefi' ? (isoEntry ? 'uefi,cdrom,hd,menu=on' : 'uefi,hd,menu=on') : (isoEntry ? 'cdrom,hd,menu=on' : 'hd,menu=on'));
  const response = await exclusive(() => command('virt-install', args, 180000));
  if (!response.ok) {
    // virt-install may define a domain and create its qcow2 before libvirt
    // reports a startup failure. Remove only the domain/path created by this
    // request so the same VM name can be retried after the cause is repaired.
    await command('virsh', ['-c', 'qemu:///system', 'destroy', input.name], 30000).catch(() => {});
    await command('virsh', ['-c', 'qemu:///system', 'undefine', input.name, '--nvram'], 30000).catch(() => {});
    await rm(diskDirectory, { recursive: true, force: true }).catch(() => {});
    const nestedHint = /trusted\.libvirt\.security\.dac|Operation not permitted/i.test(response.error || '')
      ? ' LightNAS detected a nested-libvirt ownership restriction; rerun the one-click installer to apply the automatic compatibility setting.'
      : '';
    throw Object.assign(new Error(`VM creation failed: ${response.error}${nestedHint}`), { status: 409 });
  }
  if (input.startOnBoot !== false && input.startOnBoot !== 'false') {
    const autostart = await command('virsh', ['-c', 'qemu:///system', 'autostart', input.name], 30000);
    if (!autostart.ok) throw Object.assign(new Error(`VM was created, but autostart could not be enabled: ${autostart.error}`), { status: 409 });
  }
  if (isoEntry) queueInstallerBootKey(input.name);
  return { id: input.name, name: input.name, provider: virtualization.provider, acceleration: virtualization.acceleration, firmware, diskBus, networkModel, details: response.output || 'VM created and started.' };
}
