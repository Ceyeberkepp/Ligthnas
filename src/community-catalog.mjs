import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { arch } from 'node:os';

const CACHE_DIR = process.env.LIGHTNAS_CATALOG_CACHE_DIR || '/var/lib/lightnas/catalogs';
const CACHE_FILE = join(CACHE_DIR, 'community-index.json');
const CACHE_MS = 6 * 60 * 60 * 1000;

const DEFAULT_SOURCES = Object.freeze([
  { id:'zimaos-official', name:'ZimaOS / CasaOS Official', index:'https://appstore.zimaspace.com/index.json' },
  { id:'big-bear', name:'Big Bear Community', index:'https://raw.githubusercontent.com/bigbeartechworld/big-bear-casaos/master/index.json' },
  { id:'linuxserver', name:'LinuxServer Community', index:'https://raw.githubusercontent.com/WisdomSky/LinuxServer-AppStore/main/index.json' }
]);

const machineArch = () => ({ x64:'amd64', arm64:'arm64', arm:'arm' }[arch()] || arch());
const text = value => typeof value === 'string' ? value : (value?.en_US || value?.en_GB || Object.values(value || {})[0] || '');
const safeId = value => String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function normalize(item, source) {
  const id = safeId(item.id || item.app_id || item.name || item.title);
  if (!id) return null;
  const architectures = Array.isArray(item.architectures) ? item.architectures : [];
  const compatible = !architectures.length || architectures.includes(machineArch());
  return {
    id: 'community-' + source.id + '-' + id,
    upstreamId: id,
    name: text(item.title) || text(item.name) || id,
    category: text(item.category) || 'Community',
    description: text(item.description) || text(item.tagline) || 'Community application.',
    tagline: text(item.tagline),
    source: source.name,
    sourceId: source.id,
    image: item.image || '',
    icon: item.icon || '',
    thumbnail: item.thumbnail || '',
    architectures,
    compatible,
    version: String(item.version || ''),
    composeUrl: item.compose_url || item.composeUrl || '',
    metaUrl: item.meta_url || item.metaUrl || '',
    community: true
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers:{ 'User-Agent':'LightNAS-AppStore/1.0' } });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function itemsFromIndex(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['apps','items','data','list']) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

async function readCache() {
  try {
    const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    return cached;
  } catch { return null; }
}

export async function communityCatalog({ refresh=false } = {}) {
  const cached = await readCache();
  if (!refresh && cached?.updatedAt && Date.now() - Date.parse(cached.updatedAt) < CACHE_MS && Array.isArray(cached.apps)) return cached;
  const apps = [], sources = [];
  for (const source of DEFAULT_SOURCES) {
    try {
      const data = await fetchJson(source.index);
      const normalized = itemsFromIndex(data).map(item => normalize(item, source)).filter(Boolean);
      apps.push(...normalized);
      sources.push({ id:source.id, name:source.name, ok:true, count:normalized.length });
    } catch (error) {
      sources.push({ id:source.id, name:source.name, ok:false, count:0, error:error.message });
    }
  }
  const deduped = [...new Map(apps.map(app => [app.upstreamId + '|' + app.name.toLowerCase(), app])).values()]
    .sort((a,b) => a.name.localeCompare(b.name));
  const result = { updatedAt:new Date().toISOString(), apps:deduped, sources, count:deduped.length };
  try { await mkdir(CACHE_DIR,{recursive:true}); await writeFile(CACHE_FILE, JSON.stringify(result,null,2)); } catch {}
  if (!deduped.length && cached?.apps?.length) return { ...cached, stale:true, sources };
  return result;
}

export async function communityApp(id, { refresh=false } = {}) {
  const catalog = await communityCatalog({refresh});
  return catalog.apps.find(app => app.id === id) || null;
}

async function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio:['ignore','pipe','pipe'] });
    let stdout='', stderr='';
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout || file + ' failed').trim())));
  });
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers:{ 'User-Agent':'LightNAS-AppStore/1.0' } });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.text();
}

export async function installCommunityApp(id) {
  if (process.env.LIGHTNAS_DOCKER_ENABLED !== '1') throw Object.assign(new Error('Docker applications are disabled on this host.'), { status:409 });
  const app = await communityApp(id);
  if (!app) throw Object.assign(new Error('Unknown community application.'), { status:404 });
  if (!app.compatible) throw Object.assign(new Error('This application does not support this CPU architecture.'), { status:409 });
  if (!app.composeUrl) throw Object.assign(new Error('This catalog entry does not publish a Compose package.'), { status:409 });
  const appRoot = join(process.env.LIGHTNAS_DATA_DIRECTORY || '/var/lib/lightnas', 'apps', app.id);
  await mkdir(appRoot, { recursive:true });
  const composePath = join(appRoot, 'compose.yaml');
  const compose = await fetchText(app.composeUrl);
  if (!/\bservices\s*:/m.test(compose)) throw Object.assign(new Error('The community package is not a valid Docker Compose application.'), { status:409 });
  await writeFile(composePath, compose, { mode:0o600 });
  const project = safeId('lightnas-' + app.id).slice(0,63);
  await command('docker', ['compose','-p',project,'-f',composePath,'pull']);
  await command('docker', ['compose','-p',project,'-f',composePath,'up','-d','--remove-orphans']);
  return { id:app.id, name:app.name, project, installed:true, composePath, message:'Community application installed with Docker Compose.' };
}

export async function manageCommunityApp(id, action) {
  if (!['start','stop','restart','remove'].includes(action)) throw Object.assign(new Error('Invalid application action.'), { status:400 });
  const app = await communityApp(id);
  if (!app) throw Object.assign(new Error('Unknown community application.'), { status:404 });
  const appRoot = join(process.env.LIGHTNAS_DATA_DIRECTORY || '/var/lib/lightnas', 'apps', app.id);
  const composePath = join(appRoot, 'compose.yaml');
  const project = safeId('lightnas-' + app.id).slice(0,63);
  if (action === 'remove') await command('docker',['compose','-p',project,'-f',composePath,'down']);
  else if (action === 'restart') await command('docker',['compose','-p',project,'-f',composePath,'restart']);
  else await command('docker',['compose','-p',project,'-f',composePath,action]);
  return { id, action, dataPreserved:true };
}
