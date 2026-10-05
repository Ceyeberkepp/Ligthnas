import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { arch } from 'node:os';

const CACHE_DIR = process.env.LIGHTNAS_CATALOG_CACHE_DIR || '/var/lib/lightnas/catalogs';
const CACHE_FILE = join(CACHE_DIR, 'community-index.json');
const CACHE_MS = 6 * 60 * 60 * 1000;
const CATALOG_SCHEMA_VERSION = 2;
const REMOTE_TIMEOUT_MS = 8000;
const execute = promisify(execFile);
const dataRoot = dirname(process.env.NAS_DATA_FILE || 'data/state.json');
const COMMUNITY_APP_ROOT = process.env.LIGHTNAS_COMMUNITY_APP_DIR || join(dataRoot, 'apps', 'community');
const MANIFEST_CONCURRENCY = 10;
let refreshInFlight = null;

const DEFAULT_SOURCES = Object.freeze([
  { id:'zimaos-official', name:'ZimaOS / CasaOS Official', github:'IceWhaleTech/CasaOS-AppStore', branch:'main', type:'casaos-repo' },
  { id:'big-bear', name:'Big Bear Community', github:'bigbeartechworld/big-bear-casaos', branch:'master', type:'casaos-repo' },
  { id:'linuxserver', name:'LinuxServer Community', github:'WisdomSky/LinuxServer-AppStore', branch:'main', type:'casaos-repo' },
  { id:'truenas', name:'TrueNAS Apps', index:'https://raw.githubusercontent.com/truenas/apps/master/catalog.json', type:'truenas' }
]);

const machineArch = () => ({ x64:'amd64', arm64:'arm64', arm:'arm' }[arch()] || arch());
const stripLocalePrefix = value => String(value || '')
  .replace(/^\s*(?:[a-z]{2}[_-][A-Z]{2}|[a-z]{2}):\s*/i, '')
  .trim();
const text = value => stripLocalePrefix(typeof value === 'string' ? value : (value?.en_US || value?.en_GB || Object.values(value || {})[0] || ''));
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
    installable: Boolean((item.compose_url || item.composeUrl) && compatible),
    installReason: compatible ? ((item.compose_url || item.composeUrl) ? '' : 'This catalog entry does not provide a Docker Compose manifest.') : 'This app does not support this CPU architecture.',
    community: true
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS), headers:{ 'User-Agent':'LightNAS-AppStore/1.0', 'Accept':'application/vnd.github+json' } });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

async function githubTree(repo, branch) {
  const data = await fetchJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  return Array.isArray(data?.tree) ? data.tree : [];
}

async function githubText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS), headers:{ 'User-Agent':'LightNAS-AppStore/1.0' } });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.text();
}

function casaosMeta(compose, fallbackId) {
  const scalar = key => (compose.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n#]+)["']?`, 'm'))?.[1] || '').trim();
  const localized = key => {
    const direct = scalar(key);
    if (direct && !/^(?:[a-z]{2}[_-][A-Z]{2}|[a-z]{2}):\s*$/i.test(direct)) return stripLocalePrefix(direct);
    const block = compose.match(new RegExp(`^\\s*${key}:\\s*\\n((?:\\s{2,}[^\\n]+\\n?)+)`, 'm'))?.[1] || '';
    const preferred = block.match(/^\s*(?:en_US|en_GB|en):\s*["']?([^"'\n#]+)["']?/mi)?.[1];
    const any = block.match(/^\s*[a-z]{2}(?:[_-][A-Z]{2})?:\s*["']?([^"'\n#]+)["']?/mi)?.[1];
    return stripLocalePrefix(preferred || any || direct);
  };
  const id = stripLocalePrefix(scalar('id') || fallbackId);
  const title = localized('title') || fallbackId;
  const tagline = localized('tagline');
  const category = localized('category') || 'Community';
  const icon = stripLocalePrefix(scalar('icon'));
  return { id, title, tagline, description:tagline, category, icon };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await mapper(items[index], index); }
      catch { results[index] = null; }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function casaosRepoItems(source) {
  const tree = await githubTree(source.github, source.branch);
  const manifests = tree.filter(item => /^Apps\/[^/]+\/(?:docker-compose|compose)\.ya?ml$/i.test(item.path || ''));
  return mapWithConcurrency(manifests, MANIFEST_CONCURRENCY, async manifest => {
    const name = manifest.path.split('/')[1];
    const composeUrl = 'https://raw.githubusercontent.com/' + source.github + '/' + source.branch + '/' + manifest.path;
    const raw = await githubText(composeUrl);
    return { ...casaosMeta(raw, name), composeUrl };
  });
}

function itemsFromIndex(data, source = {}) {
  if (Array.isArray(data)) return data;
  for (const key of ['apps','items','data','list']) if (Array.isArray(data?.[key])) return data[key];
  if (source.type === 'truenas' && data && typeof data === 'object') {
    const items = [];
    const trains = data.trains || data;
    for (const [train, apps] of Object.entries(trains || {})) {
      if (!apps || typeof apps !== 'object' || Array.isArray(apps)) continue;
      for (const [id, raw] of Object.entries(apps)) {
        const app = raw && typeof raw === 'object' ? raw : {};
        items.push({
          id,
          title: app.title || app.name || id,
          description: app.description || app.home || '',
          category: Array.isArray(app.categories) ? app.categories[0] : (app.category || 'TrueNAS'),
          icon: app.icon_url || app.icon || '',
          version: app.latest_version || app.version || '',
          architectures: app.architectures || [],
          truenasTrain: train
        });
      }
    }
    return items;
  }
  return [];
}

async function readCache() {
  try { return JSON.parse(await readFile(CACHE_FILE, 'utf8')); }
  catch { return null; }
}

async function refreshCommunityCatalog(cached = null) {
  const cachedApps = Array.isArray(cached?.apps) ? cached.apps : [];
  const cachedBySource = new Map(DEFAULT_SOURCES.map(source => [
    source.id,
    cachedApps.filter(app => app.sourceId === source.id)
  ]));

  const sourceResults = await Promise.all(DEFAULT_SOURCES.map(async source => {
    try {
      const data = source.type === 'casaos-repo' ? await casaosRepoItems(source) : await fetchJson(source.index);
      const items = source.type === 'casaos-repo' ? data : itemsFromIndex(data, source);
      const apps = items.map(item => normalize(item, source)).filter(Boolean);

      if (!apps.length && (cachedBySource.get(source.id) || []).length) {
        return {
          apps: cachedBySource.get(source.id),
          status:{ id:source.id, name:source.name, ok:false, stale:true, count:cachedBySource.get(source.id).length, error:'Refresh returned no applications; keeping cached catalog.' }
        };
      }

      return { apps, status:{ id:source.id, name:source.name, ok:true, count:apps.length } };
    } catch (error) {
      const fallback = cachedBySource.get(source.id) || [];
      return {
        apps:fallback,
        status:{ id:source.id, name:source.name, ok:false, stale:Boolean(fallback.length), count:fallback.length, error:error.message }
      };
    }
  }));

  const refreshedSourceIds = new Set(DEFAULT_SOURCES.map(source => source.id));
  const unknownCachedApps = cachedApps.filter(app => !refreshedSourceIds.has(app.sourceId));
  const apps = [...unknownCachedApps, ...sourceResults.flatMap(item => item.apps)];
  const sources = sourceResults.map(item => item.status);
  const deduped = [...new Map(apps.map(app => [app.id || (app.upstreamId + '|' + String(app.name || '').toLowerCase()), app])).values()]
    .sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));

  const successfulSources = sources.filter(source => source.ok).length;
  const result = {
    schemaVersion:CATALOG_SCHEMA_VERSION,
    updatedAt:new Date().toISOString(),
    apps:deduped,
    sources,
    count:deduped.length,
    stale:successfulSources !== DEFAULT_SOURCES.length
  };

  const shouldWrite = deduped.length > 0 || !cachedApps.length;
  if (shouldWrite) {
    try {
      await mkdir(CACHE_DIR,{recursive:true});
      await writeFile(CACHE_FILE, JSON.stringify(result,null,2));
    } catch {}
  }

  if (!deduped.length && cachedApps.length) {
    return { ...cached, stale:true, refreshing:false, sources };
  }
  return result;
}

function beginRefresh(cached) {
  if (!refreshInFlight) {
    refreshInFlight = refreshCommunityCatalog(cached).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function communityCatalog({ refresh=false } = {}) {
  const cached = await readCache();
  const fresh = cached?.schemaVersion === CATALOG_SCHEMA_VERSION && cached?.updatedAt && Date.now() - Date.parse(cached.updatedAt) < CACHE_MS && Array.isArray(cached.apps);
  if (!refresh && fresh) return cached;
  if (!refresh && cached?.apps?.length) {
    beginRefresh(cached).catch(() => null);
    return { ...cached, stale:true, refreshing:true };
  }
  return beginRefresh(cached);
}

export async function communityApp(id, { refresh=false } = {}) {
  const catalog = await communityCatalog({refresh});
  return catalog.apps.find(app => app.id === id) || null;
}

function validateCommunityComposeUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch { throw Object.assign(new Error('Community application has no valid Compose manifest URL.'), { status: 409 }); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'raw.githubusercontent.com') {
    throw Object.assign(new Error('Community Compose manifests must come from the approved GitHub catalog source.'), { status: 409 });
  }
  return parsed.toString();
}

export async function installCommunityApp(id) {
  const app = await communityApp(id, { refresh:false });
  if (!app) throw Object.assign(new Error('Community application was not found.'), { status: 404 });
  if (!app.compatible) throw Object.assign(new Error('This community application does not support this CPU architecture.'), { status: 409 });
  if (!app.installable || !app.composeUrl) throw Object.assign(new Error(app.installReason || 'This community application has no deployable Compose manifest.'), { status: 409 });

  const composeUrl = validateCommunityComposeUrl(app.composeUrl);
  const response = await fetch(composeUrl, {
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    headers:{ 'User-Agent':'LightNAS-AppStore/1.0' }
  });
  if (!response.ok) throw Object.assign(new Error('Unable to download community Compose manifest: HTTP ' + response.status), { status: 409 });
  const compose = await response.text();
  if (!/\bservices\s*:/m.test(compose)) {
    throw Object.assign(new Error('The community package does not contain a valid Compose services section.'), { status: 409 });
  }

  const appDir = join(COMMUNITY_APP_ROOT, safeId(app.id));
  await mkdir(appDir, { recursive:true, mode:0o700 });
  const composePath = join(appDir, 'compose.yml');
  await writeFile(composePath, compose, { mode:0o600 });

  const project = safeId(('lightnas-' + app.id).slice(0, 55));
  const environment = {
    ...process.env,
    APP_DATA_DIR: appDir,
    PUID: process.env.PUID || '0',
    PGID: process.env.PGID || '0',
    TZ: process.env.TZ || 'Etc/UTC'
  };

  try {
    await execute('docker', ['compose', 'version'], { timeout:15000, maxBuffer:2 * 1024 * 1024 });
  } catch (error) {
    throw Object.assign(new Error('Docker Compose is required to install community applications.'), { status:409, cause:error });
  }

  try {
    const { stdout, stderr } = await execute(
      'docker',
      ['compose', '--project-name', project, '-f', composePath, 'up', '-d', '--pull', 'always'],
      { cwd:appDir, env:environment, timeout:10 * 60 * 1000, maxBuffer:16 * 1024 * 1024 }
    );
    return {
      id:app.id,
      upstreamId:app.upstreamId,
      name:app.name,
      source:app.source,
      project,
      composePath,
      installed:true,
      output:String(stdout || stderr || '').trim()
    };
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'Docker Compose failed.').trim();
    throw Object.assign(new Error('Unable to install community application: ' + detail), { status:409 });
  }
}