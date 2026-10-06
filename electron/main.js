'use strict';
// GridPhoto - Electron main process.
// Owns everything that touches the OS: files, dialogs, clipboard, settings,
// native menus, window state and single-instance handling.

const {
  app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, nativeTheme,
  net, protocol, shell,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/** Mark a folder hidden on Windows (best effort). */
function execHidden(dir) {
  if (process.platform === 'win32') execFileSync('attrib', ['+h', dir], { windowsHide: true });
}
const { pathToFileURL } = require('node:url');
const faces = require('./faces');

const SRC_DIR = path.join(__dirname, '..', 'src');
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jfif', '.pjpeg', '.pjp', '.png', '.apng', '.gif', '.webp',
  '.avif', '.bmp', '.ico', '.svg',
]);
const GRID_EXTENSIONS = ['.gphl', '.json']; // saved grids are JSON
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'gp',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

let mainWindow = null;
let pendingPaths = [];

// --------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    settings = {};
  }
}

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 300);
}

function saveSettingsNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

// ------------------------------------------------------------ file helpers
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const isImage = (p) => IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());

// ------------------------------------------------------------ photo library
// Every photo shown in GridPhoto is a copy inside "images" next to the
// installation (app data folder if that is not writable). The originals are
// never referenced after copying, and never renamed or deleted by the app.
let libraryDirCache = null;
function libraryDir() {
  if (libraryDirCache) return libraryDirCache;
  let base;
  if (process.env.PORTABLE_EXECUTABLE_DIR) base = process.env.PORTABLE_EXECUTABLE_DIR;
  else if (app.isPackaged) base = path.dirname(process.execPath);
  else base = path.join(__dirname, '..');
  const preferred = path.join(base, 'images');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    libraryDirCache = preferred;
  } catch {
    libraryDirCache = path.join(app.getPath('userData'), 'images');
    fs.mkdirSync(libraryDirCache, { recursive: true });
  }
  return libraryDirCache;
}

function inLibrary(p) {
  const rel = path.relative(libraryDir(), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeName(name) {
  const cleaned = [...(name || 'Photos')].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch));
  return cleaned.join('').replace(/[. ]+$/, '').trim() || 'Photos';
}

// Closed photos wait in a hidden holding folder so Undo works; it is emptied
// when the app quits (and on the next start as a safety net).
const closedDir = () => path.join(libraryDir(), '.closed');
const closedIndexFile = () => path.join(closedDir(), 'index.json');

function readClosedIndex() {
  try {
    return JSON.parse(fs.readFileSync(closedIndexFile(), 'utf8'));
  } catch {
    return [];
  }
}

function purgeClosed() {
  const index = readClosedIndex();
  fs.rmSync(closedDir(), { recursive: true, force: true });
  return index.map((e) => e.path);
}

/** Copy one photo into the library (grouped by its source folder name). */
async function importOne(src) {
  if (inLibrary(src)) return src;
  const st = await fsp.stat(src);
  const dir = path.join(libraryDir(), safeName(path.basename(path.dirname(src))));
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  let dest = path.join(dir, path.basename(src));
  for (let n = 1; ; n++) {
    try {
      const existing = await fsp.stat(dest);
      if (existing.size === st.size) return dest; // already imported: reuse the copy
      dest = path.join(dir, `${stem} (${n})${ext}`);
    } catch {
      break; // free name
    }
  }
  await fsp.copyFile(src, dest);
  await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
  return dest;
}

async function sortPaths(paths, mode) {
  if (mode === 'date' || mode === 'size') {
    const key = mode === 'date' ? 'mtimeMs' : 'size';
    const stats = await Promise.all(paths.map((p) => fsp.stat(p).then((s) => s[key], () => 0)));
    const idx = paths.map((_, i) => i);
    idx.sort((a, b) => stats[a] - stats[b] || collator.compare(paths[a], paths[b]));
    return idx.map((i) => paths[i]);
  }
  return [...paths].sort(collator.compare);
}

async function listFolder(folder, recursive = false, sortMode = 'name') {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && isImage(e.name)) found.push(full);
      else if (recursive && e.isDirectory()) await walk(full);
    }
  }
  await walk(folder);
  return sortPaths(found, sortMode);
}

const siblingCache = new Map();
async function folderSiblings(file, sortMode) {
  const folder = path.dirname(path.resolve(file));
  let mtime;
  try {
    mtime = (await fsp.stat(folder)).mtimeMs;
  } catch {
    return [file];
  }
  const key = `${folder}|${sortMode}`;
  const cached = siblingCache.get(key);
  if (cached && cached.mtime === mtime) return cached.files;
  const files = await listFolder(folder, false, sortMode);
  siblingCache.set(key, { mtime, files });
  return files;
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p) {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

function argPaths(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args
    .filter((a) => a && !a.startsWith('-') && a !== '.')
    .map((a) => path.resolve(cwd || process.cwd(), a))
    .filter((a) => fs.existsSync(a));
}

// ------------------------------------------------------------- protocol
function registerProtocol() {
  protocol.handle('gp', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/models/')) {
      const name = path.basename(decodeURIComponent(url.pathname));
      if (!faces.MODEL_FILES.some((f) => f.name === name)) return new Response('Not found', { status: 404 });
      try {
        const data = await fsp.readFile(path.join(faces.modelDir(), name));
        return new Response(data, { headers: { 'content-type': MIME[path.extname(name)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    if (url.pathname === '/vendor/face-api.esm.js') {
      const data = await fsp.readFile(require.resolve('@vladmandic/face-api/dist/face-api.esm.js'));
      return new Response(data, { headers: { 'content-type': 'text/javascript' } });
    }
    if (url.pathname === '/img') {
      const file = url.searchParams.get('p') || '';
      if (!isImage(file)) return new Response('Forbidden', { status: 403 });
      try {
        return await net.fetch(pathToFileURL(file).toString());
      } catch {
        return new Response('Not found', { status: 404 }); // moved or deleted photo
      }
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.normalize(path.join(SRC_DIR, rel));
    if (!full.startsWith(SRC_DIR)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(full);
      return new Response(data, {
        headers: { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ----------------------------------------------------------- background
// Acrylic / Mica need Windows 11 22H2 (build 22621) or newer.
const GLASS_SUPPORTED = process.platform === 'win32'
  && Number(os.release().split('.')[2] || 0) >= 22621;

const isGlass = () => GLASS_SUPPORTED && ['acrylic', 'mica'].includes(settings.bg_mode);

function applyBackground(mode, color) {
  if (!mainWindow) return;
  const glass = GLASS_SUPPORTED && (mode === 'acrylic' || mode === 'mica');
  if (glass) {
    mainWindow.setBackgroundColor('#00000000');
    mainWindow.setBackgroundMaterial(mode);
  } else {
    if (GLASS_SUPPORTED) mainWindow.setBackgroundMaterial('none');
    mainWindow.setBackgroundColor(/^#[\da-f]{6}$/i.test(color || '') ? color : '#000000');
  }
}

// --------------------------------------------------------------- window
function createWindow() {
  const bounds = settings.windowBounds || { width: 1280, height: 800 };
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 240,
    backgroundColor: isGlass() ? '#00000000' : settings.background_color || '#000000',
    title: 'GridPhoto',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    alwaysOnTop: !!settings.stay_on_top,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.setMenu(null);
  applyBackground(settings.bg_mode, settings.background_color);
  if (settings.window_opacity && settings.window_opacity < 100) mainWindow.setOpacity(settings.window_opacity / 100);
  if (settings.windowMaximized || settings.start_maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (settings.start_fullscreen) mainWindow.setFullScreen(true);
  });

  // never navigate away / open new windows from the renderer
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);

  const rememberBounds = () => {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen() && !mainWindow.isMinimized()) {
      settings.windowBounds = mainWindow.getBounds();
    }
    settings.windowMaximized = mainWindow.isMaximized();
  };
  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);
  mainWindow.on('close', (e) => {
    rememberBounds();
    saveSettingsNow();
    if (!mainWindow.forceClose) {
      e.preventDefault();
      mainWindow.webContents.send('app:close-requested');
    }
  });
  mainWindow.on('closed', () => faces.shutdown());
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('win:fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('win:fullscreen', false));

  mainWindow.loadURL('gp://app/index.html');
}

function sendPaths(paths) {
  if (!paths.length) return;
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('app:open-paths', paths);
  } else {
    pendingPaths.push(...paths);
  }
}

// ------------------------------------------------------------ menus
const ACCEL_KEYS = {
  PgUp: 'PageUp', PgDown: 'PageDown', Esc: 'Escape', NumAdd: 'numadd', NumSub: 'numsub',
  NumMul: 'nummult', NumDiv: 'numdiv', NumDec: 'numdec', Meta: 'Super',
};

function toAccelerator(combo) {
  if (!combo) return undefined;
  const parts = combo.split('+').filter(Boolean);
  if (combo.endsWith('++')) parts.push('Plus');
  const mapped = parts.map((p) => ACCEL_KEYS[p] || (/^Num\d$/.test(p) ? `num${p.slice(3)}` : p));
  const accel = mapped.join('+');
  return /^[\w+=\-[\];',./\\`]+$/.test(accel) ? accel : undefined;
}

function buildMenu(template, resolve) {
  return template.map((item) => {
    if (item.type === 'separator') return { type: 'separator' };
    const out = {
      label: item.label,
      enabled: item.enabled !== false,
    };
    if (item.submenu) {
      out.submenu = buildMenu(item.submenu, resolve);
      if (!out.submenu.length) out.enabled = false;
      return out;
    }
    if (item.checkbox) {
      out.type = 'checkbox';
      out.checked = !!item.checked;
    }
    const accel = toAccelerator(item.accelerator);
    if (accel) {
      out.accelerator = accel;
      out.registerAccelerator = false;
    }
    out.click = () => resolve(item.id);
    return out;
  });
}

// --------------------------------------------------------------- IPC
function registerIpc() {
  const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));

  handle('settings:getAll', () => settings);
  handle('settings:set', (key, value) => {
    settings[key] = value;
    if (key === 'color_scheme') nativeTheme.themeSource = value === 'system' ? 'system' : value;
    saveSettingsSoon();
  });
  handle('settings:reset', (keys) => {
    for (const k of keys) delete settings[k];
    saveSettingsSoon();
    return settings;
  });

  handle('app:initialPaths', () => {
    const p = pendingPaths;
    pendingPaths = [];
    return p;
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    extensions: [...IMAGE_EXTENSIONS],
    glassSupported: GLASS_SUPPORTED,
  }));
  handle('app:quit', () => {
    mainWindow.forceClose = true;
    mainWindow.close();
  });

  // dialogs
  const imageFilters = [
    { name: 'Images', extensions: [...IMAGE_EXTENSIONS].map((e) => e.slice(1)) },
    { name: 'All files', extensions: ['*'] },
  ];
  handle('dialog:openFiles', async (defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Add photos', defaultPath, properties: ['openFile', 'multiSelections'],
      filters: imageFilters,
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:openFile', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title, defaultPath, properties: ['openFile'], filters: imageFilters,
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:openFolder', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title, defaultPath, properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:openPlaylist', async (defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Open grid', defaultPath, properties: ['openFile'],
      filters: [{ name: 'GridPhoto grid', extensions: ['gphl', 'json'] }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:save', async (options) => {
    const r = await dialog.showSaveDialog(mainWindow, options);
    return r.canceled ? null : r.filePath;
  });
  handle('dialog:message', async (options) => {
    const r = await dialog.showMessageBox(mainWindow, options);
    return r.response;
  });

  // files
  handle('fs:listFolder', listFolder);
  handle('fs:siblings', folderSiblings);
  handle('fs:expand', async (paths, recursive, sortMode, withFolders) => {
    // returns [{folder, files}] for folders, and [{file}] for files, in order
    const out = [];
    for (const p of paths) {
      if (await isDir(p)) out.push({ folder: p, files: await listFolder(p, recursive, sortMode) });
      else if (await isFile(p)) {
        if (GRID_EXTENSIONS.includes(path.extname(p).toLowerCase())) out.push({ playlist: p });
        else if (isImage(p)) out.push({ file: p });
      }
    }
    return withFolders ? out : out.flatMap((x) => x.files || (x.file ? [x.file] : []));
  });
  handle('fs:exists', (p) => fs.existsSync(p));
  handle('fs:isFile', isFile);
  handle('fs:rename', async (oldPath, newName) => {
    if (!inLibrary(oldPath)) throw new Error('Only photos in the GridPhoto library can be renamed.');
    const target = path.join(path.dirname(oldPath), newName);
    if (fs.existsSync(target)) throw new Error('A file with that name already exists.');
    await fsp.rename(oldPath, target);
    siblingCache.clear();
    return target;
  });
  handle('fs:trash', async (p) => {
    if (!inLibrary(p)) throw new Error('Only photos in the GridPhoto library can be deleted.');
    await shell.trashItem(p);
    siblingCache.clear();
  });
  handle('fs:copy', (src, dest) => fsp.copyFile(src, dest));
  handle('fs:writeBuffer', (dest, data) => fsp.writeFile(dest, Buffer.from(data)));
  handle('fs:readText', (p) => fsp.readFile(p, 'utf8'));
  handle('fs:writeText', (p, text) => fsp.writeFile(p, text, 'utf8'));
  handle('fs:clearCache', () => siblingCache.clear());
  handle('fs:uniquePath', (p) => {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p);
    const base = p.slice(0, p.length - ext.length);
    let n = 1;
    while (fs.existsSync(`${base} (${n})${ext}`)) n += 1;
    return `${base} (${n})${ext}`;
  });
  handle('path:info', () => ({
    sep: path.sep,
    pictures: app.getPath('pictures'),
    temp: app.getPath('temp'),
  }));

  // image metadata
  handle('image:info', async (p) => {
    const info = {};
    try {
      const st = await fsp.stat(p);
      info['File size'] = humanSize(st.size);
      info.Modified = st.mtime.toLocaleString();
    } catch { /* missing file */ }
    try {
      const exifr = require('exifr');
      const tags = await exifr.parse(p, { tiff: true, exif: true, gps: true, xmp: false, icc: false });
      for (const [k, v] of Object.entries(tags || {})) {
        if (v === null || v === undefined) continue;
        let text = v instanceof Date ? v.toLocaleString() : v;
        if (typeof text === 'object') {
          if (ArrayBuffer.isView(text) || Array.isArray(text)) {
            if (text.length > 8) continue;
            text = Array.from(text).join(', ');
          } else continue;
        }
        text = String(text);
        if (text.length < 200) info[k] = text;
      }
    } catch { /* not every format has EXIF */ }
    return info;
  });

  // shell / clipboard
  handle('shell:showInFolder', (p) => shell.showItemInFolder(p));
  handle('shell:openPath', (p) => shell.openPath(p));
  handle('clipboard:writeImage', (png) => clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png))));
  handle('clipboard:writeText', (t) => clipboard.writeText(t));
  handle('clipboard:read', async () => {
    const out = { paths: [], text: clipboard.readText() };
    if (process.platform === 'win32') {
      // Explorer "Copy" puts file paths in CF_HDROP / FileNameW
      const raw = clipboard.readBuffer('FileNameW');
      if (raw && raw.length) {
        const p = raw.toString('ucs2').replace(/\0/g, '');
        if (p) out.paths.push(p);
      }
    }
    const img = clipboard.readImage();
    if (!img.isEmpty() && !out.paths.length) {
      const file = path.join(app.getPath('temp'), 'GridPhoto',
        `clipboard_${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, img.toPNG());
      out.imageFile = file;
    }
    return out;
  });

  // window
  handle('win:toggleFullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });
  handle('win:setFullscreen', (on) => mainWindow.setFullScreen(!!on));
  handle('win:isFullscreen', () => mainWindow.isFullScreen());
  handle('win:setOnTop', (on) => mainWindow.setAlwaysOnTop(!!on));
  handle('win:isOnTop', () => mainWindow.isAlwaysOnTop());
  handle('win:capture', async (rect) => {
    const img = await mainWindow.webContents.capturePage(rect);
    return img.toPNG();
  });
  handle('win:setBackground', ({ mode, color }) => applyBackground(mode, color));
  handle('win:setOpacity', (v) => mainWindow.setOpacity(Math.min(1, Math.max(0.3, Number(v) || 1))));
  handle('win:devtools', () => mainWindow.webContents.toggleDevTools());
  handle('win:focus', () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // face recognition
  const sendProgress = (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('faces:progress', evt);
  };
  handle('faces:status', () => ({
    ready: faces.modelsReady(), dir: faces.modelDir(), totalBytes: faces.TOTAL_BYTES, scanning: faces.isScanning(),
  }));
  handle('faces:download', async () => {
    let last = 0;
    await faces.downloadModels((p) => {
      const now = Date.now();
      if (now - last > 80 || p.received === p.total) {
        last = now;
        sendProgress({ phase: 'download', ...p });
      }
    });
    return faces.modelDir();
  });
  handle('faces:scan', (paths, options) => faces.scan(paths, options || {}, sendProgress));
  handle('faces:cancel', () => faces.cancelScan());
  handle('faces:groups', () => faces.loadGroups());
  handle('faces:saveGroups', (data) => faces.saveGroups(data));
  ipcMain.on('face:worker-msg', (_e, msg) => faces.onWorkerMessage(msg));
  handle('fs:mkdir', (p) => fsp.mkdir(p, { recursive: true }));
  handle('library:dir', () => libraryDir());
  handle('library:reveal', () => shell.openPath(libraryDir()));
  handle('library:import', async (paths) => {
    const out = [];
    let last = 0;
    for (let i = 0; i < paths.length; i++) {
      try {
        out.push(await importOne(paths[i]));
      } catch {
        out.push(null); // unreadable source
      }
      const now = Date.now();
      if (now - last > 80 || i === paths.length - 1) {
        last = now;
        mainWindow?.webContents.send('library:progress', { done: i + 1, total: paths.length });
      }
    }
    siblingCache.clear();
    return out;
  });
  // closing a photo: move its copy out of the library (restorable until quit)
  handle('library:discard', async (p) => {
    if (!inLibrary(p) || path.resolve(p).startsWith(closedDir())) return null;
    await fsp.mkdir(closedDir(), { recursive: true });
    try {
      execHidden(closedDir());
    } catch { /* cosmetic */ }
    const tmp = path.join(closedDir(), `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${path.basename(p)}`);
    await fsp.rename(p, tmp);
    const index = readClosedIndex();
    index.push({ path: p, tmp });
    await fsp.writeFile(closedIndexFile(), JSON.stringify(index));
    siblingCache.clear();
    return { path: p, tmp };
  });
  handle('library:restore', async (entry) => {
    if (!entry?.tmp || !inLibrary(entry.path) || !path.resolve(entry.tmp).startsWith(closedDir())) return false;
    await fsp.mkdir(path.dirname(entry.path), { recursive: true });
    await fsp.rename(entry.tmp, entry.path);
    const index = readClosedIndex().filter((e) => e.tmp !== entry.tmp);
    await fsp.writeFile(closedIndexFile(), JSON.stringify(index)).catch(() => {});
    siblingCache.clear();
    return true;
  });
  handle('library:purge', () => purgeClosed());
  // deletes library copies only - anything outside the library is refused
  handle('library:delete', async (paths) => {
    const deleted = [];
    const refused = [];
    for (const p of paths) {
      if (!inLibrary(p)) {
        refused.push(p);
        continue;
      }
      try {
        await fsp.rm(p, { force: true });
        deleted.push(p);
      } catch {
        refused.push(p);
      }
    }
    siblingCache.clear();
    return { deleted, refused };
  });
  handle('fs:subfolders', async (dir, sortMode) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const subfolders = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const full = path.join(dir, e.name);
        subfolders.push({ name: e.name, path: full, images: await listFolder(full, true, sortMode) });
      }
    }
    subfolders.sort((a, b) => collator.compare(a.name, b.name));
    return { subfolders, images: await listFolder(dir, false, sortMode) };
  });
  // user-made folders (People & Folders panel)
  const foldersFile = () => path.join(app.getPath('userData'), 'folders.json');
  handle('folders:load', async () => {
    try {
      return JSON.parse(await fsp.readFile(foldersFile(), 'utf8'));
    } catch {
      return null;
    }
  });
  handle('folders:save', (data) => fsp.writeFile(foldersFile(), JSON.stringify(data)));

  handle('menu:popup', (template) => new Promise((resolve) => {
    let done = false;
    const finish = (id) => {
      if (!done) {
        done = true;
        resolve(id);
      }
    };
    const menu = Menu.buildFromTemplate(buildMenu(template, finish));
    menu.popup({ window: mainWindow, callback: () => setTimeout(() => finish(null), 50) });
  }));
}

function humanSize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

// ------------------------------------------------------------ lifecycle
loadSettings();
const singleInstance = settings.one_instance !== false;

if (singleInstance && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingPaths = argPaths(process.argv);
  app.on('second-instance', (_e, argv, cwd) => {
    sendPaths(argPaths(argv, cwd));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = settings.color_scheme === 'light' ? 'light'
      : settings.color_scheme === 'system' ? 'system' : 'dark';
    registerProtocol();
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    try {
      purgeClosed(); // closed photos are deleted for good
    } catch { /* nothing to purge */ }
  });
}
