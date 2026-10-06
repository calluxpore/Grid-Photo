'use strict';
// Face recognition: model download, background worker window, cache and clustering.
//
// Models: @vladmandic/face-api (MIT) - SSD MobileNet v1 detector, 68-point landmarks
// and a 128-d face descriptor network (~12.5 MB). They are downloaded on first use
// into a "models" folder next to the installed app (or the app data folder when
// that location is not writable) and verified by SHA-256.

const { app, BrowserWindow, net } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MODEL_VERSION = '1.7.15';
const CDN = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${MODEL_VERSION}/model/`;
const MODEL_FILES = [
  ['ssd_mobilenetv1_model-weights_manifest.json', 28233, '888f744dffbc84f5f060d1f8427d9742341943a2dfaaf9205d10029b7e7a2955'],
  ['ssd_mobilenetv1_model.bin', 5616957, '2835640602d53718aa6ae9a42896327eaa21beefed056c218d32ca7d79e1e2f8'],
  ['face_landmark_68_model-weights_manifest.json', 8485, 'ca4886639f86e99b39fed0c155f81b63317225773bd9616716e887b0153389c9'],
  ['face_landmark_68_model.bin', 356840, '4611ef65c87d836d03d684b30eec4d195d8b219fa1dd58fc58945831c6b9299b'],
  ['face_recognition_model-weights_manifest.json', 19615, 'cbaffa501b0b9275a12b63357a6843e7e30c054e1c9151e1a5f879b26e32986b'],
  ['face_recognition_model.bin', 6444032, 'b413e420d6840b2775fba32008db6f3cddb07d485967fb42cfcf379c16a8c589'],
].map(([name, size, sha256]) => ({ name, size, sha256 }));
const TOTAL_BYTES = MODEL_FILES.reduce((n, f) => n + f.size, 0);

// ------------------------------------------------------------ model location
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let cachedDir = null;
/** "models" next to the installation; app data folder as a fallback. */
function modelDir() {
  if (cachedDir) return cachedDir;
  let base;
  if (process.env.PORTABLE_EXECUTABLE_DIR) base = process.env.PORTABLE_EXECUTABLE_DIR; // portable exe
  else if (app.isPackaged) base = path.dirname(process.execPath); // installed app folder
  else base = path.join(__dirname, '..'); // running from source
  const preferred = path.join(base, 'models');
  // a folder that already holds the models wins, even if read-only
  if (MODEL_FILES.every((f) => fileOk(path.join(preferred, f.name), f.size))) cachedDir = preferred;
  else cachedDir = isWritable(preferred) ? preferred : path.join(app.getPath('userData'), 'models');
  return cachedDir;
}

function fileOk(file, size) {
  try {
    return fs.statSync(file).size === size;
  } catch {
    return false;
  }
}

function modelsReady() {
  const dir = modelDir();
  return MODEL_FILES.every((f) => fileOk(path.join(dir, f.name), f.size));
}

// ------------------------------------------------------------- download
let downloading = null;

async function downloadModels(onProgress) {
  if (downloading) return downloading;
  downloading = (async () => {
    const dir = modelDir();
    await fsp.mkdir(dir, { recursive: true });
    let done = 0;
    for (const f of MODEL_FILES) {
      const target = path.join(dir, f.name);
      if (fileOk(target, f.size)) {
        done += f.size;
        onProgress({ received: done, total: TOTAL_BYTES, file: f.name });
        continue;
      }
      const res = await net.fetch(CDN + f.name, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${f.name}`);
      const hash = crypto.createHash('sha256');
      const part = `${target}.part`;
      const out = fs.createWriteStream(part);
      const reader = res.body.getReader();
      let got = 0;
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          hash.update(value);
          got += value.length;
          if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
          onProgress({ received: done + got, total: TOTAL_BYTES, file: f.name });
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      const digest = hash.digest('hex');
      if (got !== f.size || digest !== f.sha256) {
        await fsp.rm(part, { force: true });
        throw new Error(`Checksum mismatch for ${f.name} - the download was corrupted, please retry.`);
      }
      await fsp.rename(part, target);
      done += f.size;
    }
    onProgress({ received: TOTAL_BYTES, total: TOTAL_BYTES, file: null });
    return dir;
  })();
  try {
    return await downloading;
  } finally {
    downloading = null;
  }
}

// ----------------------------------------------------------- face cache
const cacheFile = () => path.join(app.getPath('userData'), 'faces-cache.json');
const groupsFile = () => path.join(app.getPath('userData'), 'faces-groups.json');
let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (cache.version !== 1) cache = null;
  } catch {
    cache = null;
  }
  cache = cache || { version: 1, files: {} };
  return cache;
}

async function saveCache() {
  await fsp.writeFile(cacheFile(), JSON.stringify(cache));
}

async function loadGroups() {
  try {
    return JSON.parse(await fsp.readFile(groupsFile(), 'utf8'));
  } catch {
    return null;
  }
}

async function saveGroups(data) {
  await fsp.writeFile(groupsFile(), JSON.stringify(data));
}

// ------------------------------------------------------------ clustering
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function mean(vectors) {
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return out.map((x) => x / vectors.length);
}

/**
 * Groups face descriptors into people. Greedy assignment to centroids (best
 * quality faces first), a merge pass for clusters that are clearly the same
 * person, then a re-assignment pass to undo order effects.
 */
function cluster(faces, threshold) {
  const order = [...faces.keys()].sort((a, b) => faces[b].quality - faces[a].quality);
  let clusters = [];
  for (const i of order) {
    let best = -1;
    let bestD = Infinity;
    clusters.forEach((c, k) => {
      const d = dist(faces[i].descriptor, c.centroid);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best >= 0 && bestD < threshold) {
      const c = clusters[best];
      c.members.push(i);
      c.centroid = c.centroid.map((x, j) => x + (faces[i].descriptor[j] - x) / c.members.length);
    } else {
      clusters.push({ members: [i], centroid: [...faces[i].descriptor] });
    }
  }
  // merge clusters whose centres are very close
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        if (dist(clusters[a].centroid, clusters[b].centroid) < threshold * 0.85) {
          const members = [...clusters[a].members, ...clusters[b].members];
          clusters[a] = { members, centroid: mean(members.map((m) => faces[m].descriptor)) };
          clusters.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  // re-assign every face to its nearest centre
  const centres = clusters.map((c) => c.centroid);
  clusters = centres.map((centroid) => ({ centroid, members: [] }));
  faces.forEach((f, i) => {
    let best = 0;
    let bestD = Infinity;
    centres.forEach((c, k) => {
      const d = dist(f.descriptor, c);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    clusters[best].members.push(i);
  });
  return clusters.filter((c) => c.members.length)
    .map((c) => ({ ...c, centroid: mean(c.members.map((m) => faces[m].descriptor)) }));
}

/** Turn clusters into groups (= folders); keeps names of previously named people. */
function buildGroups(faces, scannedPaths, threshold, previous) {
  const clusters = cluster(faces, threshold);
  const named = (previous?.groups || []).filter((g) => g.named && g.centroid);
  const people = [];
  const singles = new Set();
  const others = [];
  for (const c of clusters) {
    const paths = [...new Set(c.members.map((m) => faces[m].path))];
    const best = c.members.reduce((a, b) => (faces[b].quality > faces[a].quality ? b : a));
    const group = {
      id: crypto.randomUUID(),
      name: '',
      named: false,
      paths,
      faceCount: c.members.length,
      thumb: faces[best].thumb,
      centroid: c.centroid.map((x) => Math.round(x * 1e5) / 1e5),
    };
    if (paths.length >= 2) people.push(group);
    else {
      others.push(group);
      paths.forEach((p) => singles.add(p));
    }
  }
  people.sort((a, b) => b.paths.length - a.paths.length);
  // carry over names from the previous run when the person is clearly the same
  const used = new Set();
  for (const g of people) {
    let match = null;
    let bestD = threshold * 0.9;
    for (const n of named) {
      if (used.has(n.id)) continue;
      const d = dist(g.centroid, n.centroid);
      if (d < bestD) {
        bestD = d;
        match = n;
      }
    }
    if (match) {
      used.add(match.id);
      g.name = match.name;
      g.named = true;
    }
  }
  let n = 1;
  for (const g of people) if (!g.named) g.name = `Person ${n++}`;
  const groups = [...people];
  if (singles.size) {
    groups.push({
      id: 'others', name: 'Other faces', special: true, paths: [...singles],
      faceCount: others.length, thumb: others[0]?.thumb || null,
    });
  }
  const withFaces = new Set(faces.map((f) => f.path));
  const noFaces = scannedPaths.filter((p) => !withFaces.has(p));
  if (noFaces.length) {
    groups.push({ id: 'nofaces', name: 'No people', special: true, paths: noFaces, faceCount: 0, thumb: null });
  }
  return groups;
}

// --------------------------------------------------------- worker window
let worker = null;
let workerReady = null;
let workerIdleTimer = null;
const jobs = new Map();

function ensureWorker() {
  clearTimeout(workerIdleTimer);
  if (worker && !worker.isDestroyed()) return workerReady;
  worker = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'face-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  worker.setMenu(null);
  workerReady = new Promise((resolve, reject) => {
    worker.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`Worker failed: ${desc}`)));
    worker.webContents.once('did-finish-load', () => resolve());
  });
  worker.on('closed', () => {
    worker = null;
    for (const job of jobs.values()) job.reject(new Error('Face worker stopped'));
    jobs.clear();
  });
  worker.loadURL('gp://app/face/worker.html');
  return workerReady;
}

function scheduleWorkerShutdown() {
  clearTimeout(workerIdleTimer);
  // free GPU memory after a minute without work
  workerIdleTimer = setTimeout(() => {
    if (worker && !worker.isDestroyed() && !jobs.size) worker.destroy();
  }, 60000);
}

function onWorkerMessage(msg) {
  const job = jobs.get(msg.jobId);
  if (!job) return;
  if (msg.type === 'image') job.onImage(msg);
  else if (msg.type === 'done') {
    jobs.delete(msg.jobId);
    job.resolve();
  } else if (msg.type === 'error') {
    jobs.delete(msg.jobId);
    job.reject(new Error(msg.message));
  }
}

let currentScan = null;

/** Scan photos for faces; progress(evt) is called often. Returns the groups. */
async function scan(paths, options, progress) {
  if (currentScan) throw new Error('A scan is already running');
  const threshold = Number(options.threshold) || 0.5;
  const minFace = Number(options.minFace) || 36;
  const jobId = crypto.randomUUID();
  currentScan = { jobId, cancelled: false };
  try {
    const c = loadCache();
    const todo = [];
    const stats = new Map();
    for (const p of paths) {
      try {
        const st = await fsp.stat(p);
        stats.set(p, `${st.size}:${Math.round(st.mtimeMs)}`);
        const hit = c.files[p];
        if (!hit || hit.key !== stats.get(p) || hit.minFace !== minFace) todo.push(p);
      } catch { /* missing file */ }
    }
    let done = paths.length - todo.length;
    let faceTotal = paths.reduce((n, p) => n + (c.files[p] && !todo.includes(p) ? c.files[p].faces.length : 0), 0);
    progress({ phase: 'scan', done, total: paths.length, faces: faceTotal });
    if (todo.length) {
      await ensureWorker();
      await new Promise((resolve, reject) => {
        jobs.set(jobId, {
          resolve,
          reject,
          onImage: (msg) => {
            // failed images are not cached so they are retried next time
            if (!msg.error) c.files[msg.path] = { key: stats.get(msg.path), minFace, faces: msg.faces || [] };
            done++;
            faceTotal += (msg.faces || []).length;
            progress({ phase: 'scan', done, total: paths.length, faces: faceTotal, error: msg.error });
          },
        });
        // relative to the worker page (gp://app/face/) - face-api mangles custom-scheme URLs
        worker.webContents.send('face:job', { jobId, paths: todo, minFace, modelUrl: '/models' });
      });
      await saveCache();
    }
    if (currentScan.cancelled) return null;
    progress({ phase: 'group', done: paths.length, total: paths.length, faces: faceTotal });
    const faces = [];
    for (const p of paths) {
      for (const f of c.files[p]?.faces || []) {
        faces.push({ path: p, descriptor: f.descriptor, thumb: f.thumb, quality: f.score * Math.sqrt(f.area || 1) });
      }
    }
    const previous = await loadGroups();
    const groups = faces.length || paths.length ? buildGroups(faces, paths, threshold, previous) : [];
    const result = { createdAt: Date.now(), scanned: paths.length, faces: faces.length, groups };
    await saveGroups(result);
    return result;
  } finally {
    currentScan = null;
    scheduleWorkerShutdown();
  }
}

function cancelScan() {
  if (!currentScan) return;
  currentScan.cancelled = true;
  if (worker && !worker.isDestroyed()) worker.webContents.send('face:cancel', currentScan.jobId);
}

function shutdown() {
  if (worker && !worker.isDestroyed()) worker.destroy();
}

module.exports = {
  MODEL_FILES, TOTAL_BYTES, modelDir, modelsReady, downloadModels, scan, cancelScan,
  onWorkerMessage, loadGroups, saveGroups, shutdown, isScanning: () => !!currentScan,
};
