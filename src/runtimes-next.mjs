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
  { id: 'nginx', name: 'Nginx', category: 'Web', image: 'nginx:stable-alpine', port: 8081, containerPort: 80, memory: '256m', description: 'Open-source web server and reverse proxy.', source: 'Docker Official Image', volumes: [] },
  { id: 'jellyfin', name: 'Jellyfin', category: 'Media', image: 'jellyfin/jellyfin:latest', port: 8096, containerPort: 8096, memory: '2g', description: 'Free software media server for movies, TV, music and photos.', source: 'Jellyfin', volumes: [['config', '/config'], ['cache', '/cache'], ['@files', '/media:ro']] },
  { id: 'navidrome', name: 'Navidrome', category: 'Media', image: 'deluan/navidrome:latest', port: 4533, containerPort: 4533, memory: '1g', description: 'Lightweight music server compatible with Subsonic clients.', source: 'Navidrome', volumes: [['data', '/data'], ['@files', '/music:ro']] },
  { id: 'audiobookshelf', name: 'Audiobookshelf', category: 'Media', image: 'ghcr.io/advplyr/audiobookshelf:latest', port: 13378, containerPort: 80, memory: '1g', description: 'Self-hosted audiobook and podcast server.', source: 'Audiobookshelf', volumes: [['config', '/config'], ['metadata', '/metadata'], ['@files', '/audiobooks:ro']] },
  { id: 'komga', name: 'Komga', category: 'Media', image: 'gotson/komga:latest', port: 25600, containerPort: 25600, memory: '1g', description: 'Comics, manga and ebook media server.', source: 'Komga', volumes: [['config', '/config'], ['@files', '/data:ro']] },
  { id: 'calibre-web', name: 'Calibre-Web', category: 'Media', image: 'lscr.io/linuxserver/calibre-web:latest', port: 8088, containerPort: 8083, memory: '1g', description: 'Browser interface for browsing and reading a Calibre ebook library.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/books']] },

  { id: 'freshrss', name: 'FreshRSS', category: 'Productivity', image: 'freshrss/freshrss:latest', port: 8084, containerPort: 80, memory: '768m', description: 'Fast self-hosted RSS and Atom feed reader.', source: 'FreshRSS', volumes: [['data', '/var/www/FreshRSS/data'], ['extensions', '/var/www/FreshRSS/extensions']] },
  { id: 'actual-budget', name: 'Actual Budget', category: 'Productivity', image: 'actualbudget/actual-server:latest', port: 5006, containerPort: 5006, memory: '768m', description: 'Privacy-focused personal budgeting application.', source: 'Actual Budget', volumes: [['data', '/data']] },
  { id: 'memos', name: 'Memos', category: 'Productivity', image: 'neosmemo/memos:stable', port: 5230, containerPort: 5230, memory: '512m', description: 'Lightweight self-hosted notes and knowledge capture.', source: 'Memos', volumes: [['data', '/var/opt/memos']] },
  { id: 'linkding', name: 'Linkding', category: 'Productivity', image: 'sissbruecker/linkding:latest', port: 9090, containerPort: 9090, memory: '512m', description: 'Minimal bookmark manager with tags and search.', source: 'Linkding', volumes: [['data', '/etc/linkding/data']] },
  { id: 'nextcloud', name: 'Nextcloud', category: 'Productivity', image: 'nextcloud:apache', port: 8090, containerPort: 80, memory: '2g', description: 'Self-hosted files, collaboration and sync. The first-run wizard can use SQLite for a simple deployment.', source: 'Nextcloud', volumes: [['html', '/var/www/html']] },
  { id: 'stirling-pdf', name: 'Stirling PDF', category: 'Productivity', image: 'frooodle/s-pdf:latest', port: 8086, containerPort: 8080, memory: '1g', description: 'Local web toolkit for PDF conversion, editing, OCR and document operations.', source: 'Stirling PDF', volumes: [['configs', '/configs'], ['custom-files', '/customFiles']] },
  { id: 'drawio', name: 'draw.io', category: 'Productivity', image: 'jgraph/drawio:latest', port: 8091, containerPort: 8080, memory: '768m', description: 'Self-hosted diagrams.net diagram editor.', source: 'diagrams.net', volumes: [] },

  { id: 'gitea', name: 'Gitea', category: 'Development', image: 'gitea/gitea:latest', port: 3002, containerPort: 3000, memory: '1g', description: 'Lightweight self-hosted Git service with issues, pull requests and packages.', source: 'Gitea', volumes: [['data', '/data']] },
  { id: 'code-server', name: 'code-server', category: 'Development', image: 'lscr.io/linuxserver/code-server:latest', port: 8443, containerPort: 8443, memory: '2g', description: 'VS Code in the browser for development and administration.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/data']] },
  { id: 'ansible-semaphore', name: 'Ansible Semaphore', category: 'Automation', image: 'semaphoreui/semaphore:latest', port: 3000, containerPort: 3000, memory: '1g', description: 'Browser-based Ansible automation, playbooks, inventories and schedules.', source: 'Semaphore UI', volumes: [['data', '/etc/semaphore']], namedVolumes: true, requiresAdminPassword: true, requiresAccessKeyEncryption: true, adminUsername: 'admin', environment: [['SEMAPHORE_DB_DIALECT', 'sqlite'], ['SEMAPHORE_DB', '/etc/semaphore/semaphore.sqlite'], ['SEMAPHORE_ADMIN', 'admin'], ['SEMAPHORE_ADMIN_NAME', 'LightNAS Administrator'], ['SEMAPHORE_ADMIN_EMAIL', 'admin@localhost']] },

  { id: 'vaultwarden', name: 'Vaultwarden', category: 'Security', image: 'vaultwarden/server:latest', port: 8085, containerPort: 80, memory: '768m', description: 'Lightweight Bitwarden-compatible password vault server.', source: 'Vaultwarden', volumes: [['data', '/data']] },
  { id: 'gotify', name: 'Gotify', category: 'Notifications', image: 'gotify/server:latest', port: 8087, containerPort: 80, memory: '512m', description: 'Simple self-hosted push notification server.', source: 'Gotify', volumes: [['data', '/app/data']] },

  { id: 'uptime-kuma', name: 'Uptime Kuma', category: 'Monitoring', image: 'louislam/uptime-kuma:2', port: 3001, containerPort: 3001, memory: '1g', description: 'Self-hosted uptime and status monitoring.', source: 'Uptime Kuma', volumes: [['data', '/app/data']] },
  { id: 'changedetection', name: 'changedetection.io', category: 'Monitoring', image: 'ghcr.io/dgtlmoon/changedetection.io:latest', port: 5000, containerPort: 5000, memory: '1g', description: 'Monitor websites for content changes and alerts.', source: 'changedetection.io', volumes: [['data', '/datastore']] },

  { id: 'heimdall', name: 'Heimdall', category: 'Dashboard', image: 'lscr.io/linuxserver/heimdall:latest', port: 8083, containerPort: 80, memory: '512m', description: 'Personal dashboard for hosted applications.', source: 'LinuxServer.io', volumes: [['config', '/config']] },
  { id: 'pairdrop', name: 'PairDrop', category: 'Files', image: 'lscr.io/linuxserver/pairdrop:latest', port: 3003, containerPort: 3000, memory: '512m', description: 'Local-network browser file transfer inspired by AirDrop.', source: 'LinuxServer.io', volumes: [['config', '/config']] },
  { id: 'filebrowser', name: 'File Browser', category: 'Files', image: 'filebrowser/filebrowser:s6', port: 8092, containerPort: 80, memory: '512m', description: 'Alternative browser-based file manager for your LightNAS files.', source: 'File Browser', volumes: [['@files', '/srv'], ['database', '/database'], ['config', '/config']] },

  { id: 'openspeedtest', name: 'OpenSpeedTest', category: 'Network', image: 'openspeedtest/latest', port: 8082, containerPort: 3000, memory: '512m', description: 'Test LAN speed from a browser against the LightNAS node.', source: 'OpenSpeedTest', volumes: [] },
  { id: 'searxng', name: 'SearXNG', category: 'Search', image: 'searxng/searxng:latest', port: 8089, containerPort: 8080, memory: '1g', description: 'Privacy-respecting self-hosted metasearch engine.', source: 'SearXNG', volumes: [['config', '/etc/searxng']] },
  { id: 'open-webui', name: 'Open WebUI', category: 'AI', image: 'ghcr.io/open-webui/open-webui:main', port: 8093, containerPort: 8080, memory: '2g', description: 'Self-hosted web interface for local and remote AI model providers.', source: 'Open WebUI', volumes: [['data', '/app/backend/data']] },

  // Broad one-click catalog: popular self-hosted applications that also
  // overlap heavily with TrueNAS/community NAS application catalogs.
  { id: 'emby', name: 'Emby', category: 'Media', image: 'emby/embyserver:latest', port: 8094, containerPort: 8096, memory: '2g', description: 'Personal media server for movies, TV, music and photos.', source: 'Emby', volumes: [['config', '/config'], ['@files', '/mnt/share1']] },
  { id: 'plex', name: 'Plex Media Server', category: 'Media', image: 'lscr.io/linuxserver/plex:latest', port: 32400, containerPort: 32400, memory: '2g', description: 'Popular personal media server with broad client support.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/media']], environment: [['VERSION', 'docker']] },
  { id: 'jellyseerr', name: 'Jellyseerr', category: 'Media', image: 'fallenbagel/jellyseerr:latest', port: 5055, containerPort: 5055, memory: '768m', description: 'Media request and discovery manager for Jellyfin and related services.', source: 'Jellyseerr', volumes: [['config', '/app/config']] },
  { id: 'tautulli', name: 'Tautulli', category: 'Media', image: 'lscr.io/linuxserver/tautulli:latest', port: 8181, containerPort: 8181, memory: '512m', description: 'Plex monitoring, statistics and notifications.', source: 'LinuxServer.io', volumes: [['config', '/config']] },
  { id: 'metube', name: 'MeTube', category: 'Media', image: 'ghcr.io/alexta69/metube:latest', port: 8101, containerPort: 8081, memory: '768m', description: 'Browser-based media downloader powered by yt-dlp.', source: 'MeTube', volumes: [['@files', '/downloads']] },

  { id: 'sonarr', name: 'Sonarr', category: 'Downloads', image: 'lscr.io/linuxserver/sonarr:latest', port: 8989, containerPort: 8989, memory: '1g', description: 'TV series collection and download automation.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/data']] },
  { id: 'radarr', name: 'Radarr', category: 'Downloads', image: 'lscr.io/linuxserver/radarr:latest', port: 7878, containerPort: 7878, memory: '1g', description: 'Movie collection and download automation.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/data']] },
  { id: 'lidarr', name: 'Lidarr', category: 'Downloads', image: 'lscr.io/linuxserver/lidarr:latest', port: 8686, containerPort: 8686, memory: '1g', description: 'Music collection and download automation.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/data']] },
  { id: 'prowlarr', name: 'Prowlarr', category: 'Downloads', image: 'lscr.io/linuxserver/prowlarr:latest', port: 9696, containerPort: 9696, memory: '768m', description: 'Indexer manager for the *arr application family.', source: 'LinuxServer.io', volumes: [['config', '/config']] },
  { id: 'bazarr', name: 'Bazarr', category: 'Downloads', image: 'lscr.io/linuxserver/bazarr:latest', port: 6767, containerPort: 6767, memory: '768m', description: 'Subtitle automation companion for Sonarr and Radarr.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/data']] },
  { id: 'sabnzbd', name: 'SABnzbd', category: 'Downloads', image: 'lscr.io/linuxserver/sabnzbd:latest', port: 8095, containerPort: 8080, memory: '1g', description: 'Usenet download client with a browser interface.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/downloads']] },
  { id: 'qbittorrent', name: 'qBittorrent', category: 'Downloads', image: 'lscr.io/linuxserver/qbittorrent:latest', port: 8097, containerPort: 8080, memory: '1g', description: 'BitTorrent client with a full web interface.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/downloads']], extraPorts: [[6881, 6881, 'tcp'], [6881, 6881, 'udp']] },
  { id: 'transmission', name: 'Transmission', category: 'Downloads', image: 'lscr.io/linuxserver/transmission:latest', port: 9091, containerPort: 9091, memory: '768m', description: 'Lightweight BitTorrent client with remote web management.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/downloads']], extraPorts: [[51413, 51413, 'tcp'], [51413, 51413, 'udp']] },

  { id: 'syncthing', name: 'Syncthing', category: 'Files', image: 'lscr.io/linuxserver/syncthing:latest', port: 8384, containerPort: 8384, memory: '1g', description: 'Continuous peer-to-peer file synchronization.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/data']], extraPorts: [[22000, 22000, 'tcp'], [22000, 22000, 'udp'], [21027, 21027, 'udp']] },
  { id: 'duplicati', name: 'Duplicati', category: 'Backup', image: 'lscr.io/linuxserver/duplicati:latest', port: 8200, containerPort: 8200, memory: '1g', description: 'Encrypted backup client supporting local and cloud destinations.', source: 'LinuxServer.io', volumes: [['config', '/config'], ['@files', '/source']] },
  { id: 'mealie', name: 'Mealie', category: 'Productivity', image: 'ghcr.io/mealie-recipes/mealie:latest', port: 9925, containerPort: 9000, memory: '1g', description: 'Self-hosted recipe manager and meal planner.', source: 'Mealie', volumes: [['data', '/app/data']] },
  { id: 'forgejo', name: 'Forgejo', category: 'Development', image: 'codeberg.org/forgejo/forgejo:latest', port: 3004, containerPort: 3000, memory: '1g', description: 'Community-driven Git forge for repositories, issues and collaboration.', source: 'Forgejo', volumes: [['data', '/data']] },
  { id: 'vikunja', name: 'Vikunja', category: 'Productivity', image: 'vikunja/vikunja:latest', port: 3456, containerPort: 3456, memory: '1g', description: 'Open-source task and project management.', source: 'Vikunja', volumes: [['files', '/app/vikunja/files'], ['db', '/db']] },
  { id: 'home-assistant', name: 'Home Assistant', category: 'Home', image: 'ghcr.io/home-assistant/home-assistant:stable', port: 8123, containerPort: 8123, memory: '2g', description: 'Open-source home automation platform.', source: 'Home Assistant', volumes: [['config', '/config']] },
  { id: 'homarr', name: 'Homarr', category: 'Dashboard', image: 'ghcr.io/homarr-labs/homarr:latest', port: 7575, containerPort: 7575, memory: '768m', description: 'Modern dashboard for self-hosted services.', source: 'Homarr', volumes: [['appdata', '/appdata']] },
  { id: 'dashy', name: 'Dashy', category: 'Dashboard', image: 'lissy93/dashy:latest', port: 8102, containerPort: 8080, memory: '768m', description: 'Customizable dashboard for homelab and NAS services.', source: 'Dashy', volumes: [] },
  { id: 'it-tools', name: 'IT-Tools', category: 'Utility', image: 'corentinth/it-tools:latest', port: 8100, containerPort: 80, memory: '512m', description: 'Collection of browser-based tools for developers and IT administrators.', source: 'IT-Tools', volumes: [] },
  { id: 'whoogle', name: 'Whoogle', category: 'Search', image: 'benbusby/whoogle-search:latest', port: 5001, containerPort: 5000, memory: '512m', description: 'Privacy-focused search frontend.', source: 'Whoogle', volumes: [] },
  { id: 'grafana', name: 'Grafana', category: 'Monitoring', image: 'grafana/grafana-oss:latest', port: 3005, containerPort: 3000, memory: '1g', description: 'Dashboards and visualization for metrics and observability data.', source: 'Grafana', volumes: [['data', '/var/lib/grafana']] },
  { id: 'influxdb', name: 'InfluxDB', category: 'Database', image: 'influxdb:2', port: 8086, containerPort: 8086, memory: '1g', description: 'Time-series database for monitoring, sensors and automation.', source: 'InfluxData', volumes: [['data', '/var/lib/influxdb2']] },
  { id: 'node-red', name: 'Node-RED', category: 'Automation', image: 'nodered/node-red:latest', port: 1880, containerPort: 1880, memory: '768m', description: 'Flow-based automation and integration environment.', source: 'Node-RED', volumes: [['data', '/data']] },
  { id: 'n8n', name: 'n8n', category: 'Automation', image: 'n8nio/n8n:latest', port: 5678, containerPort: 5678, memory: '1g', description: 'Workflow automation platform for APIs, apps and scheduled jobs.', source: 'n8n', volumes: [['data', '/home/node/.n8n']] },
  { id: 'minio', name: 'MinIO', category: 'Storage', image: 'quay.io/minio/minio:latest', port: 9001, containerPort: 9001, memory: '1g', description: 'S3-compatible object storage with browser management console.', source: 'MinIO', volumes: [['data', '/data']], extraPorts: [[9000, 9000, 'tcp']], command: ['server', '/data', '--console-address', ':9001'] },
  { id: 'redisinsight', name: 'Redis Insight', category: 'Database', image: 'redis/redisinsight:latest', port: 5540, containerPort: 5540, memory: '768m', description: 'Browser management and visualization for Redis databases.', source: 'Redis', volumes: [['data', '/data']] },
  { id: 'trilium-next', name: 'TriliumNext Notes', category: 'Productivity', image: 'triliumnext/notes:latest', port: 8088, containerPort: 8080, memory: '1g', description: 'Hierarchical personal knowledge base and note-taking system.', source: 'TriliumNext', volumes: [['data', '/home/node/trilium-data']] },
  { id: 'librespeed', name: 'LibreSpeed', category: 'Utility', image: 'lscr.io/linuxserver/librespeed:latest', port: 8124, containerPort: 80, memory: '512m', description: 'Self-hosted browser network speed test.', source: 'LinuxServer.io', volumes: [['config', '/config']] },
  { id: 'web-check', name: 'Web-Check', category: 'Utility', image: 'ghcr.io/lissy93/web-check:latest', port: 3010, containerPort: 3000, memory: '768m', description: 'Website and infrastructure analysis toolbox.', source: 'Web-Check', volumes: [] },
  { id: 'glances', name: 'Glances', category: 'Monitoring', image: 'nicolargo/glances:latest-full', port: 61208, containerPort: 61208, memory: '512m', description: 'System monitoring dashboard and metrics viewer.', source: 'Glances', volumes: [], environment: [['GLANCES_OPT', '-w']] }
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

function isWindowsInstaller(entry) {
  const text = `${entry?.name || ''} ${entry?.id || ''} ${entry?.path || ''}`.toLowerCase();
  return /(?:^|[^a-z])(windows|win(?:dows)?[-_. ]?(?:10|11)|win[-_. ]?(?:10|11)|server[-_. ]?20\d\d)(?:[^a-z]|$)/i.test(text)
    || /(?:win11|win10|windows11|windows10|windows[_ -]?server)/i.test(text);
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
  const displayModel = ['vga', 'qxl', 'virtio'].includes(settings.displayModel) ? settings.displayModel : 'vga';
  const networkModel = ['virtio', 'e1000', 'rtl8139'].includes(settings.networkModel) ? settings.networkModel : 'virtio';
  const scsiController = ['virtio-scsi', 'virtio-scsi-single', 'lsilogic'].includes(settings.scsiController) ? settings.scsiController : 'virtio-scsi';
  const diskBus = ['scsi', 'virtio', 'sata'].includes(settings.diskBus) ? settings.diskBus : null;
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

  // Switching the disk bus does not move or recreate the qcow2 file; it only
  // changes how QEMU presents that same disk to the guest. Windows installation
  // media has an inbox AHCI/SATA driver but not the VirtIO storage driver, so
  // this is also the safe in-place recovery path for an existing Windows VM
  // that reaches Setup with an empty disk list.
  if (diskBus) {
    const diskPattern = /<disk\b[^>]*device=(['"])disk\1[^>]*>[\s\S]*?<\/disk>/i;
    const disk = xml.match(diskPattern)?.[0] || '';
    if (disk) {
      const targetDevice = diskBus === 'virtio' ? 'vda' : 'sda';
      let updatedDisk = /<target\b[^>]*\/>/i.test(disk)
        ? disk.replace(/<target\b[^>]*\/>/i, `<target dev='${targetDevice}' bus='${diskBus}'/>`)
        : disk.replace('</disk>', `<target dev='${targetDevice}' bus='${diskBus}'/></disk>`);
      // Alias/address elements encode the old controller topology. Let libvirt
      // regenerate them after a bus change instead of carrying stale SCSI
      // controller coordinates onto a SATA/VirtIO disk.
      updatedDisk = updatedDisk
        .replace(/\s*<alias\b[^>]*\/>/gi, '')
        .replace(/\s*<address\b[^>]*type=(['"])drive\1[^>]*\/>/gi, '');
      xml = xml.replace(diskPattern, updatedDisk);
    }
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
    const [info, blockDevices, domainXml] = await Promise.all([
      command('virsh', ['-c', 'qemu:///system', 'dominfo', name], 10000),
      command('virsh', ['-c', 'qemu:///system', 'domblklist', name, '--details'], 10000),
      command('virsh', ['-c', 'qemu:///system', 'dumpxml', name, '--inactive'], 10000)
    ]);
    if (!info.ok) continue;
    const parsed = parseDomInfo(info.output);
    details.push({
      id: name,
      name,
      uuid: parsed.uuid || null,
      status: parsed.state || 'unknown',
      cpus: Number(parsed['cpu(s)']) || 0,
      memory: (Number(String(parsed['max memory'] || '').split(/\s+/)[0]) || 0) * 1024,
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
  for (const mapping of app.extraPorts || []) {
    const [hostPort, containerPort, protocol = 'tcp'] = mapping;
    args.push('-p', `0.0.0.0:${hostPort}:${containerPort}/${protocol}`);
  }
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
  for (const argument of app.command || []) args.push(String(argument));
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
  const windowsInstaller = isWindowsInstaller(isoEntry);
  const firmware = windowsInstaller
    ? 'uefi'
    : (['bios', 'uefi'].includes(input.firmware) ? input.firmware : 'bios');
  const requestedDiskBus = ['scsi', 'virtio', 'sata'].includes(input.diskBus) ? input.diskBus : 'scsi';
  const requestedNetworkModel = ['virtio', 'e1000', 'rtl8139'].includes(input.networkModel) ? input.networkModel : 'virtio';
  // Windows Setup must work without a separate VirtIO driver ISO. Present the
  // install disk through AHCI/SATA and a broadly supported Intel NIC. Linux
  // guests retain the faster VirtIO defaults.
  const diskBus = windowsInstaller ? 'sata' : requestedDiskBus;
  const networkModel = windowsInstaller ? 'e1000' : requestedNetworkModel;
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
  return { id: input.name, name: input.name, provider: virtualization.provider, acceleration: virtualization.acceleration, firmware, diskBus, networkModel, guestProfile: windowsInstaller ? 'windows' : 'generic', details: response.output || 'VM created and started.' };
}
