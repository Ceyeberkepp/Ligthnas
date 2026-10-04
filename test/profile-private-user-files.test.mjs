import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, app, styles] = await Promise.all([
  readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
]);

test('local files.own users stay scoped to their private library', () => {
  const start = server.indexOf('function privateFileScope');
  const end = server.indexOf('function scopedFilePath', start);
  const block = server.slice(start, end);
  assert.match(block, /context\.isAdmin\) return ''/);
  assert.match(block, /context\.permissions\.includes\('files\.own'\).*Users\/\$\{context\.username\}/s);
  assert.ok(block.indexOf("files.own") < block.indexOf('globalPermissions.some'));
});

test('administrator private-user browser requires the owner password and normal files hide Users', () => {
  assert.match(server, /\/api\/admin\/user-files\/list/);
  assert.match(server, /verifyPassword\(input\.currentPassword, store\.state\.config\.passwordHash\)/);
  assert.match(server, /entries\.filter\(entry => entry\.name !== 'Users'\)/);
  assert.match(server, /Private user libraries are protected/);
  assert.match(app, /User folders/);
  assert.match(app, /data-action="private-user-files"/);
  assert.doesNotMatch(app, /protectedUsersAction/);
  assert.match(app, /Administrator password/);
});

test('server name is hidden from ordinary users unless explicitly granted', () => {
  assert.match(server, /showDeviceName: false/);
  assert.match(server, /showDeviceName: Boolean\(user\.showDeviceName\)/);
  assert.match(server, /deviceName: isAdmin \|\| account\.showDeviceName \?/);
  assert.match(app, /appliance\.deviceNameVisible.*'Online'/);
  assert.match(app, /name="showDeviceName"/);
});

test('new local users require at least ten password characters in API and UI', () => {
  assert.match(server, /input\.password\.length < 4/);
  assert.match(app, /minlength="4"/);
  assert.match(app, /password\.length < 4/);
});

test('profile image editor fits the whole image at default zoom and uses modern contained preview', () => {
  assert.match(app, /Math\.min\(512 \/ image\.naturalWidth, 512 \/ image\.naturalHeight\)/);
  assert.match(styles, /\.profile-crop-stage img[\s\S]*?object-fit:contain/);
  assert.match(styles, /\.profile-dialog[\s\S]*?border-radius:20px/);
});


test('private users have an explicit view-own-files permission and missing libraries initialize automatically', () => {
  assert.match(server, /'files\.view\.own', 'files\.own'/);
  assert.match(server, /DEFAULT_USER_PERMISSIONS = Object\.freeze\(\['files\.view\.own', 'files\.own'\]\)/);
  assert.match(server, /permissions\.includes\('files\.view\.own'\) \|\| context\.permissions\.includes\('files\.own'\)/);
  assert.match(server, /createFolder\(`Users\/\$\{input\.username\}\/\$\{folder\}`\)/);
  assert.match(app, /'files\.view\.own': 'View my own files'/);
  assert.match(app, /files: \['files\.view\.own', 'files\.own', 'files\.read'\]/);
});

test('view-only private users do not get file modification controls', () => {
  assert.match(app, /canManageOwnFiles/);
  assert.match(app, /View only\.<\/b> You can browse and preview your private files/);
  assert.match(app, /canDeleteFiles/);
});

test('scoped all-files listing creates a missing user library root recursively', async () => {
  const files = await readFile(new URL('../src/files.mjs', import.meta.url), 'utf8');
  assert.match(files, /const base = prefixSegments\.length \? join\(root, \.\.\.prefixSegments\) : root/);
  assert.match(files, /await mkdir\(base, \{ recursive: true, mode: 0o700 \}\)/);
});


test('refresh controls are icon-only and Files settings can return to files', () => {
  assert.doesNotMatch(app, />Refresh(?: now| apps| readings| storage| activity| analytics| logs)?<\/button>/);
  assert.match(app, /refresh-icon-button[^>]*aria-label="Refresh"[^>]*>↻<\/button>/);
  assert.match(app, /data-files-settings-close>Back to files<\/button>/);
  assert.match(app, /state\.filesSettingsOpen = !state\.filesSettingsOpen/);
});

test('online footer does not add a second status dot', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /#mini-name\.online-only::before/);
});


test('mobile shell hides desktop top and task bars', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.topbar,[\s\S]*?\.task-dock[\s\S]*?display: none !important/);
  assert.match(styles, /\.console,[\s\S]*?\.console\.sidebar-collapsed[\s\S]*?grid-template: 1fr \/ 1fr/);
});

test('mobile upload uses the native browser picker directly', () => {
  assert.match(app, /id="mobile-native-upload" type="file" multiple hidden/);
  assert.match(app, /mobile \? \$\('#mobile-native-upload', content\) : \$\('#file-upload', content\)/);
  assert.doesNotMatch(app, /openMobileUploadSourcePicker/);
  assert.doesNotMatch(app, /data-mobile-upload-source=/);
});


test('mobile file and folder uploads use direct native file inputs', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /id="mobile-native-upload" class="mobile-native-file-input" type="file" multiple/);
  assert.match(app, /id="mobile-folder-upload" class="mobile-native-file-input" type="file" webkitdirectory directory multiple/);
  assert.match(app, /\$\('#mobile-folder-upload', content\)\?\.addEventListener\('change'/);
  assert.match(styles, /\.mobile-native-file-input[\s\S]*?position: absolute[\s\S]*?opacity: 0/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.desktop-upload-select[\s\S]*?display: none !important/);
});


test('mobile uploads retry duplicate names instead of failing the batch', async () => {
  const files = await readFile(new URL('../src/files.mjs', import.meta.url), 'utf8');
  assert.match(files, /FILE_EXISTS/);
  assert.match(app, /function uniqueUploadPath\(/);
  assert.match(app, /error\.status !== 409/);
  assert.match(app, /path = uniqueUploadPath\(targets\[index\]\.path, attempt\)/);
});

test('mobile Files uses a photo-library style Years Months All experience', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /data-mobile-period="years"/);
  assert.match(app, /data-mobile-period="months"/);
  assert.match(app, /data-mobile-period="all"/);
  assert.match(app, /id="mobile-gallery-upload" type="file" multiple/);
  assert.match(app, /mobile-photo-grid/);
  assert.match(styles, /\.mobile-photo-period/);
  assert.match(styles, /grid-template-columns: repeat\(3, 1fr\)/);
});


test('mobile Files binds period controls without aborting later upload handlers', () => {
  assert.match(app, /content\.querySelectorAll\('\[data-mobile-period\]'\)\.forEach/);
  assert.doesNotMatch(app, /\$\('\[data-mobile-period\]', content\)\.forEach/);
  assert.match(app, /\$\('#mobile-gallery-upload', content\)\?\.addEventListener\('change'/);
});


test('mobile file viewer uses swipe navigation instead of arrow buttons', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const enhancementStyles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(enhancements, /stage\.addEventListener\('pointerdown'/);
  assert.match(enhancements, /navigatePreview\(dx < 0 \? 1 : -1\)/);
  assert.match(enhancements, /viewer-chrome-hidden/);
  assert.match(enhancementStyles, /@media \(max-width: 760px\)[\s\S]*?\.lightnas-viewer \.viewer-arrow[\s\S]*?display: none !important/);
  assert.match(enhancementStyles, /height: 100dvh/);
  assert.match(enhancementStyles, /touch-action: pan-y pinch-zoom/);
});


test('mobile viewer preloads neighbors and exposes edit save delete actions', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const enhancementStyles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(enhancements, /function preloadPreviewNeighbors\(/);
  assert.match(enhancements, /\/api\/files\/download\?path=/);
  assert.match(enhancements, /data-viewer-edit/);
  assert.match(enhancements, /data-viewer-delete/);
  assert.match(enhancements, /method:'DELETE'/);
  assert.match(enhancements, /function editCurrentImage\(/);
  assert.match(enhancementStyles, /background-image: var\(--viewer-bg\)/);
  assert.match(enhancementStyles, /grid-template-columns: repeat\(3, minmax\(0,1fr\)\)/);
});

test('multi-select media upload continues after individual file failures', () => {
  assert.match(app, /const failures = \[\]/);
  assert.match(app, /failures\.push\(/);
  assert.match(app, /const concurrency = Math\.min\(mobile \? 2 : 3, targets\.length\)/);
  assert.match(app, /const succeeded = targets\.length - failed/);
});


test('mobile viewer loads cached previews first and upgrades to full resolution', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const enhancementStyles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(enhancements, /const viewerPreloadCache = new Map\(\)/);
  assert.match(enhancements, /viewer\.src = urls\.preview/);
  assert.match(enhancements, /warmViewerImage\(urls\.original\)\.then/);
  assert.match(enhancements, /stage\.addEventListener\('pointermove'/);
  assert.match(enhancements, /translate3d\(/);
  assert.match(enhancementStyles, /viewer-dragging/);
  assert.match(enhancementStyles, /background: transparent/);
});

test('mobile batches serialize and retry transient photo or video failures', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(app, /const concurrency = Math\.min\(mobile \? 1 : 3, targets\.length\)/);
  assert.match(app, /error\.retryable \|\| error\.status === 0/);
  assert.match(app, /setTimeout\(resolve, 500 \* attempt\)/);
  assert.match(server, /server\.requestTimeout = 30 \* 60 \* 1000/);
});


test('mobile viewer fills the viewport and locks swipe direction', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(enhancements, /axis:null/);
  assert.match(enhancements, /gesture\.axis = Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.15 \? 'x' : 'y'/);
  assert.match(enhancements, /Math\.abs\(velocityX\) > \.48/);
  assert.match(enhancements, /viewer-swipe-out/);
  assert.match(styles, /object-fit: cover !important/);
  assert.match(styles, /width: 100vw !important/);
  assert.match(styles, /height: 100dvh !important/);
  assert.match(styles, /touch-action: none/);
});


test('mobile media uses resumable chunk uploads for photos and videos', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const files = await readFile(new URL('../src/files.mjs', import.meta.url), 'utf8');
  assert.match(app, /function chunkUploadRequest\(/);
  assert.match(app, /const chunkSize = 2 \* 1024 \* 1024/);
  assert.match(app, /\/api\/files\/chunk\?path=/);
  assert.match(app, /const transfer = mobile \? chunkUploadRequest : uploadRequest/);
  assert.match(server, /url\.pathname === '\/api\/files\/chunk'/);
  assert.match(server, /bodyBuffer\(req, 3 \* 1024 \* 1024/);
  assert.match(files, /export async function uploadFileChunk/);
  assert.match(files, /UPLOAD_OFFSET/);
  assert.match(files, /Idempotent retry/);
});


test('mobile viewer has Photos-style share favorite info edit delete controls', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(enhancements, /data-viewer-share/);
  assert.match(enhancements, /data-viewer-favorite/);
  assert.match(enhancements, /data-viewer-info/);
  assert.match(enhancements, /data-viewer-more/);
  assert.match(enhancements, /data-viewer-filmstrip/);
  assert.match(enhancements, /navigator\.share/);
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0,1fr\)\)/);
  assert.match(styles, /\.viewer-filmstrip/);
});

test('mobile photo editor has adjust filters crop undo redo revert and red-eye', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  assert.match(enhancements, /data-editor-tab="adjust"/);
  assert.match(enhancements, /data-editor-tab="filters"/);
  assert.match(enhancements, /data-editor-tab="crop"/);
  assert.match(enhancements, /data-editor-undo/);
  assert.match(enhancements, /data-editor-redo/);
  assert.match(enhancements, /data-editor-revert/);
  assert.match(enhancements, /data-filter="redeye"/);
  assert.match(enhancements, /Save as duplicate/);
  assert.match(enhancements, /Copy edits/);
  assert.match(enhancements, /Paste edits/);
});

test('desktop viewer remains available while mobile controls are media-query scoped', async () => {
  const styles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(styles, /@media \(min-width: 761px\)[\s\S]*?\.viewer-mobile-back/);
  assert.match(styles, /\.viewer-desktop-close/);
});


test('mobile viewer dialog overrides Safari dialog max width and fills right edge', async () => {
  const styles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');
  assert.match(styles, /dialog\.lightnas-viewer[\s\S]*?width: 100dvw !important/);
  assert.match(styles, /dialog\.lightnas-viewer[\s\S]*?max-width: none !important/);
  assert.match(styles, /dialog\.lightnas-viewer[\s\S]*?inset: 0 !important/);
});


test('video playback supports byte ranges and mobile native playback fallback', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  assert.match(server, /'Accept-Ranges': 'bytes'/);
  assert.match(server, /res\.writeHead\(206/);
  assert.match(server, /'Content-Range': `bytes \$\{start\}-\$\{end\}\/\$\{data\.size\}`/);
  assert.match(server, /createReadStream\(data\.path, \{ start, end \}\)/);
  assert.match(enhancements, /const nativeMobile = \['mp4','m4v','mov'\]\.includes\(extension\)/);
  assert.match(enhancements, /viewer\.addEventListener\('error', fallback\)/);
  assert.match(enhancements, /\/api\/files\/video-preview\?path=/);
});


test('mobile video playback normalizes source codecs for iPhone and Android', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const thumbnails = await readFile(new URL('../src/thumbnails.mjs', import.meta.url), 'utf8');

  assert.match(server, /'-c:v', 'libx264'/);
  assert.match(server, /'-profile:v', 'main'/);
  assert.match(server, /'-c:a', 'aac'/);
  assert.match(server, /'-profile:a', 'aac_low'/);
  assert.match(server, /'format=yuv420p'/);
  assert.match(server, /'-movflags', '\+faststart'/);

  assert.match(enhancements, /Android\|iPhone\|iPad\|iPod/);
  assert.match(enhancements, /viewer\.src = usingCompatibility \? compatibilityUrl : nativeUrl/);
  assert.match(enhancements, /'mxf'/);
  assert.match(enhancements, /'rmvb'/);

  assert.match(app, /'mxf'/);
  assert.match(app, /'rmvb'/);
  assert.match(thumbnails, /'\.mxf'/);
  assert.match(thumbnails, /'\.rmvb'/);
});


test('mobile photo editor fills viewport and uses native-style single-control workflow', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/enhancements.css', import.meta.url), 'utf8');

  assert.match(enhancements, /data-editor-slider/);
  assert.match(enhancements, /data-adjust-tool="brightness"/);
  assert.match(enhancements, /data-adjust-tool="vignette"/);
  assert.match(enhancements, /filter-preview/);
  assert.match(enhancements, /mobile-crop-actions/);

  assert.match(styles, /dialog\.mobile-photo-editor[\s\S]*?width: 100dvw !important/);
  assert.match(styles, /dialog\.mobile-photo-editor[\s\S]*?max-width: none !important/);
  assert.match(styles, /dialog\.mobile-photo-editor[\s\S]*?height: 100dvh !important/);
  assert.match(styles, /\.mobile-adjust-tools[\s\S]*?overflow-x: auto !important/);
  assert.match(styles, /\.filter-preview[\s\S]*?width: 72px !important/);
});


test('mobile video preview is cached as a seekable MP4', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const videoPreviewCacheRoot/);
  assert.match(server, /async function cachedVideoPreview/);
  assert.match(server, /videoPreviewJobs = new Map\(\)/);
  assert.match(server, /'-f', 'mp4'/);
  assert.match(server, /'-movflags', '\+faststart'/);
  assert.match(server, /return streamRangedMedia\(req, res, preview, 'video\/mp4'\)/);
});

test('mobile Files prewarms metadata and uses small lazy thumbnails', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const thumbnails = await readFile(new URL('../src/thumbnails.mjs', import.meta.url), 'utf8');
  assert.match(app, /restoreMobileFilesCache\(appliance\.username\)/);
  assert.match(app, /setTimeout\(\(\) => \{ if \(state\.files === null\) loadFiles\(false\); \}, 120\)/);
  assert.match(app, /loading="lazy" fetchpriority="low"/);
  assert.match(thumbnails, /const maxWidth = preview \? 1280 : 320/);
  assert.match(thumbnails, /source\.mtimeMs/);
});

test('photo viewer opens from the already visible tile and limits filmstrip work', async () => {
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  assert.match(enhancements, /const immediate = tile\?\.currentSrc \|\| tile\?\.src \|\| urls\.preview/);
  assert.match(enhancements, /const radius = 18/);
  assert.match(enhancements, /loading="lazy" decoding="async"/);
});


test('mobile media is prepared before the user opens it', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const enhancements = await readFile(new URL('../public/enhancements.js', import.meta.url), 'utf8');
  const thumbnails = await readFile(new URL('../src/thumbnails.mjs', import.meta.url), 'utf8');

  assert.match(server, /function enqueueMediaWarm\(relative\)/);
  assert.match(server, /thumbnailWarmActive < 2/);
  assert.match(server, /videoWarmActive < 1/);
  assert.match(server, /url\.pathname === '\/api\/files\/prewarm'/);
  assert.match(server, /enqueueMediaWarm\(path\)/);
  assert.match(server, /scale=1280:720/);
  assert.match(server, /'-preset', 'ultrafast'/);

  assert.match(app, /function queueMobileMediaPrewarm/);
  assert.match(app, /\/api\/files\/prewarm/);
  assert.match(app, /slice\(0, 18\)/);

  assert.match(enhancements, /const mobileImageViewer/);
  assert.match(enhancements, /if \(urls\.original && !mobileImageViewer\)/);
  assert.match(enhancements, /body:JSON\.stringify\(\{ paths:nearby\.map/);

  assert.match(thumbnails, /const thumbnailJobs = new Map\(\)/);
  assert.match(thumbnails, /const maxWidth = preview \? 1280 : 320/);
});
