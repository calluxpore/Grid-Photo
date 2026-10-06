// Face recognition UI: model download prompt, background progress card,
// People panel (groups = folders) and "Save as folders".

import * as settings from './settings.js';
import * as ui from './ui.js';
import { basename, dirname, joinPath } from './util.js';

const THRESHOLDS = { strict: 0.45, balanced: 0.5, loose: 0.56 };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;

function sanitize(name) {
  // characters Windows does not allow in file names (control characters included)
  const cleaned = [...(name || 'Unnamed')].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch));
  return cleaned.join('').replace(/[. ]+$/, '').trim() || 'Unnamed';
}

export class People {
  constructor(app) {
    this.app = app;
    this.result = null;
    this.panel = null;
    this.card = null;
    this.busy = false;
    this.scanStart = 0;
    this.folders = null; // user-made folders: [{ id, name, paths, thumb, kind: 'folder' }]
    window.gp.on('faces:progress', (evt) => this.onProgress(evt));
    this.loadFolders();
  }

  // ------------------------------------------------------------ folders
  async loadFolders() {
    if (!this.folders) {
      const data = await window.gp.folders.load();
      this.folders = (data?.folders || []).map((f) => ({ ...f, kind: 'folder' }));
    }
    return this.folders;
  }

  saveFolders() {
    return window.gp.folders.save({ version: 1, folders: this.folders });
  }

  folderById(id) {
    return (this.folders || []).find((f) => f.id === id);
  }

  /** Square thumbnail of a folder's first photo, used as its avatar. */
  async makeThumb(folder) {
    const p = folder.paths[0];
    if (!p) {
      folder.thumb = null;
      return;
    }
    try {
      const blob = await (await fetch(`gp://app/img?p=${encodeURIComponent(p)}`)).blob();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: 120, resizeQuality: 'medium' });
      const c = document.createElement('canvas');
      c.width = 88;
      c.height = 88;
      const s = Math.min(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 88, 88);
      bmp.close();
      folder.thumb = c.toDataURL('image/jpeg', 0.8);
    } catch {
      folder.thumb = null;
    }
  }

  async newFolder(paths = []) {
    await this.loadFolders();
    const name = await ui.prompt({ title: 'New folder', label: 'Folder name (for example a person\'s name):', value: '' });
    if (!name) return null;
    const folder = { id: `f-${crypto.randomUUID()}`, name, paths: [...new Set(paths.filter(Boolean))], thumb: null, kind: 'folder' };
    await this.makeThumb(folder);
    this.folders.unshift(folder);
    await this.saveFolders();
    this.togglePanel(true);
    ui.toast(folder.paths.length ? `Created "${name}" with ${folder.paths.length} photo(s)`
      : `Created "${name}" \u00b7 drag photos onto it or right-click a photo \u2192 Add to Folder`, null, null, 7);
    return folder;
  }

  async addToFolder(id, paths) {
    await this.loadFolders();
    const folder = id === 'new' ? await this.newFolder(paths) : this.folderById(id);
    if (!folder || id === 'new') return;
    const fresh = paths.filter((p) => p && !folder.paths.includes(p));
    if (!fresh.length) {
      ui.toast(`Already in "${folder.name}"`);
      return;
    }
    folder.paths.push(...fresh);
    if (!folder.thumb) await this.makeThumb(folder);
    await this.saveFolders();
    if (this.app.groupView?.id === folder.id) this.app.addStates(fresh.map((p) => ({ path: p })));
    this.render();
    ui.toast(`Added ${fresh.length} photo${fresh.length === 1 ? '' : 's'} to "${folder.name}"`);
  }

  async removeFromFolder(id, paths) {
    const folder = this.folderById(id);
    if (!folder) return;
    const first = folder.paths[0];
    folder.paths = folder.paths.filter((p) => !paths.includes(p));
    if (paths.includes(first)) await this.makeThumb(folder); // the avatar photo was removed
    await this.saveFolders();
    if (this.app.groupView?.id === folder.id) {
      for (const c of [...this.app.cells]) if (paths.includes(c.state.path)) this.app.closeCell(c, { animate: true });
    }
    this.render();
    ui.toast(`Removed from "${folder.name}"`);
  }

  async deleteFolder(folder) {
    const answer = await window.gp.dialog.message({
      type: 'question', title: 'Delete folder', message: `Delete the folder "${folder.name}"?`,
      detail: 'Only the folder in GridPhoto is removed. Your photos on disk are not touched.',
      buttons: ['Delete folder', 'Cancel'], defaultId: 0, cancelId: 1,
    });
    if (answer !== 0) return;
    this.folders = this.folders.filter((f) => f !== folder);
    await this.saveFolders();
    if (this.app.groupView?.id === folder.id) this.app.closeGroup();
    this.render();
  }

  /** Import a directory you have already sorted: one sub-folder per person. */
  async importFolders(chosenDir = null) {
    await this.loadFolders();
    const dir = chosenDir || await window.gp.dialog.openFolder('Choose a folder that has one sub-folder per person', this.app.saveDir());
    if (!dir) return;
    const found = await window.gp.fs.subfolders(dir, settings.get('sort_mode'));
    const sets = found.subfolders.filter((s) => s.images.length);
    if (!sets.length && found.images.length) sets.push({ name: basename(dir), images: found.images });
    if (!sets.length) {
      ui.alert('Import sorted folders', 'No photos were found in that folder or its sub-folders.');
      return;
    }
    let photos = 0;
    for (const s of sets) s.images = (await this.app.importToLibrary(s.images)).filter(Boolean);
    for (const s of sets) {
      let folder = this.folders.find((f) => f.name.toLowerCase() === s.name.toLowerCase());
      if (!folder) {
        folder = { id: `f-${crypto.randomUUID()}`, name: s.name, paths: [], thumb: null, kind: 'folder' };
        this.folders.push(folder);
      }
      const fresh = s.images.filter((p) => !folder.paths.includes(p));
      folder.paths.push(...fresh);
      photos += fresh.length;
      if (!folder.thumb) await this.makeThumb(folder);
    }
    await this.saveFolders();
    this.togglePanel(true);
    ui.toast(`Imported ${sets.length} folder${sets.length === 1 ? '' : 's'} (${photos} photos)`, null, null, 6);
  }

  /** Drop deleted photos from folders and recognised people. */
  async forgetPaths(paths) {
    if (!paths.length) return;
    const gone = new Set(paths);
    await this.loadFolders();
    let changed = false;
    for (const f of this.folders) {
      const keep = f.paths.filter((p) => !gone.has(p));
      if (keep.length !== f.paths.length) {
        const first = f.paths[0];
        f.paths = keep;
        if (gone.has(first)) await this.makeThumb(f);
        changed = true;
      }
    }
    if (changed) await this.saveFolders();
    if (this.result) {
      for (const g of this.result.groups) g.paths = g.paths.filter((p) => !gone.has(p));
      this.result.groups = this.result.groups.filter((g) => g.paths.length);
      await this.persist();
    }
    this.render();
  }

  /** Name recognised people after the user's folders when they clearly match. */
  applyFolderNames(result) {
    const folders = (this.folders || []).filter((f) => f.paths.length >= 2);
    const people = result.groups.filter((g) => !g.special && !g.named);
    let named = 0;
    for (const folder of folders) {
      const set = new Set(folder.paths);
      let best = null;
      let bestScore = 0;
      for (const g of people) {
        if (g.named) continue;
        const overlap = g.paths.filter((p) => set.has(p)).length;
        const score = overlap / folder.paths.length;
        if (overlap >= 2 && score >= 0.5 && score > bestScore) {
          best = g;
          bestScore = score;
        }
      }
      if (best) {
        best.name = folder.name;
        best.named = true;
        best.fromFolder = true;
        named++;
      }
    }
    return named;
  }

  // ------------------------------------------------------------- flow
  /** Toolbar / menu entry: open the panel if we have results, otherwise scan. */
  async start() {
    if (this.busy) {
      this.card?.classList.add('pulse');
      setTimeout(() => this.card?.classList.remove('pulse'), 600);
      return;
    }
    if (!this.result) this.result = await window.gp.faces.groups();
    await this.loadFolders();
    if (this.result?.groups?.length || this.folders.length) this.togglePanel(true);
    else this.run();
  }

  async run() {
    if (this.busy) return;
    if (!this.app.cells.length && !(this.folders || []).some((f) => f.paths.length)) {
      ui.alert('Find people', 'Add some photos first, then run face recognition.');
      return;
    }
    const status = await window.gp.faces.status();
    if (!status.ready && !(await this.download(status))) return;
    const paths = await this.choosePaths();
    if (!paths) return;
    await this.scan(paths);
  }

  async download(status) {
    const answer = await window.gp.dialog.message({
      type: 'info',
      title: 'Face recognition',
      message: 'Download the face recognition model?',
      detail: `GridPhoto needs a one-time download of a small AI model (${fmtMB(status.totalBytes)}) `
        + 'from cdn.jsdelivr.net. It will be saved to:\n\n'
        + `${status.dir}\n\nRecognition then runs entirely on this computer. No photos are uploaded.`,
      buttons: ['Download', 'Cancel'], defaultId: 0, cancelId: 1,
    });
    if (answer !== 0) return false;
    this.busy = true;
    this.showCard('Downloading face model', 'Connecting…', 0, false);
    try {
      await window.gp.faces.download();
      return true;
    } catch (err) {
      this.hideCard();
      const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      const retry = await window.gp.dialog.message({
        type: 'error', title: 'Download failed', message: 'The face model could not be downloaded.',
        detail: `${msg}\n\nCheck your internet connection and try again.`,
        buttons: ['Retry', 'Cancel'], defaultId: 0, cancelId: 1,
      });
      this.busy = false;
      return retry === 0 ? this.download(status) : false;
    } finally {
      this.busy = false;
    }
  }

  /** Photos in the grid, or every photo in their folders. */
  async choosePaths() {
    const gridPaths = [...new Set(this.app.cells.map((c) => c.state.path).filter(Boolean))];
    if (!gridPaths.length) return [...new Set((this.folders || []).flatMap((f) => f.paths))]; // only folders hold photos
    const folders = [...new Set(gridPaths.map(dirname))];
    const sort = settings.get('sort_mode');
    const folderPaths = [...new Set((await Promise.all(
      folders.map((f) => window.gp.fs.listFolder(f, false, sort)),
    )).flat())];
    if (folderPaths.length <= gridPaths.length) return gridPaths;
    const answer = await window.gp.dialog.message({
      type: 'question', title: 'Find people', message: 'Which photos should be scanned for faces?',
      detail: `The grid shows ${gridPaths.length} photo(s); their folder(s) contain ${folderPaths.length}.`,
      buttons: [`Photos in the grid (${gridPaths.length})`, `All photos in the folder(s) (${folderPaths.length})`, 'Cancel'],
      defaultId: 1, cancelId: 2,
    });
    if (answer === 2) return null;
    return answer === 0 ? gridPaths : folderPaths;
  }

  async scan(paths) {
    // photos in the user's folders are always scanned too: their faces are what
    // lets recognised people be named after the folders
    await this.loadFolders();
    paths = [...new Set([...paths, ...this.folders.flatMap((f) => f.paths)])];
    this.busy = true;
    this.scanStart = Date.now();
    this.showCard('Finding people', `Preparing ${paths.length} photos…`, 0, true);
    try {
      const result = await window.gp.faces.scan(paths, {
        threshold: THRESHOLDS[settings.get('face_strictness')] || 0.5,
        minFace: settings.get('face_min_size'),
      });
      this.hideCard();
      if (!result) {
        ui.toast('Face recognition cancelled');
        return;
      }
      this.result = result;
      await this.loadFolders();
      const learned = this.applyFolderNames(result);
      if (learned) await this.persist();
      const people = result.groups.filter((g) => !g.special).length;
      ui.toast(people ? `Found ${people} ${people === 1 ? 'person' : 'people'} in ${result.scanned} photos`
        + (learned ? ` \u00b7 ${learned} named from your folders` : '')
        : `No recurring faces found in ${result.scanned} photos`);
      this.togglePanel(true);
    } catch (err) {
      this.hideCard();
      ui.alert('Face recognition failed', String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      this.busy = false;
    }
  }

  onProgress(evt) {
    if (!this.card) return;
    if (evt.phase === 'download') {
      const f = evt.total ? evt.received / evt.total : 0;
      this.updateCard(`${fmtMB(evt.received)} of ${fmtMB(evt.total)}`, f);
    } else if (evt.phase === 'scan') {
      const f = evt.total ? evt.done / evt.total : 0;
      let eta = '';
      const elapsed = (Date.now() - this.scanStart) / 1000;
      if (evt.done > 2 && f < 1 && elapsed > 3) {
        const left = Math.round((elapsed / evt.done) * (evt.total - evt.done));
        eta = left > 90 ? ` · about ${Math.ceil(left / 60)} min left` : ` · about ${left}s left`;
      }
      if (!evt.done) this.updateCard(`Loading the face model… (${evt.total} photos to scan)`, 0.02);
      else this.updateCard(`${evt.done} of ${evt.total} photos · ${evt.faces} faces${eta}`, f);
    } else if (evt.phase === 'group') {
      this.updateCard(`Grouping ${evt.faces} faces into people…`, 1);
    } else if (evt.phase === 'save') {
      this.updateCard(evt.detail, evt.fraction);
    }
  }

  // ------------------------------------------------------- progress card
  showCard(title, detail, fraction, cancellable) {
    this.hideCard(true);
    const fill = el('div', { class: 'pc-fill' });
    this.card = el('div', { class: 'progress-card', role: 'status' },
      el('div', { class: 'pc-head' },
        el('span', { class: 'pc-spinner' }),
        el('span', { class: 'pc-title', text: title }),
        cancellable ? el('button', { class: 'icon-btn', text: 'Cancel', onclick: () => this.cancel() }) : null),
      el('div', { class: 'pc-detail', text: detail }),
      el('div', { class: 'pc-bar' }, fill));
    this.card.fill = fill;
    document.body.append(this.card);
    requestAnimationFrame(() => this.card?.classList.add('visible'));
    this.updateCard(detail, fraction);
  }

  updateCard(detail, fraction) {
    if (!this.card) return;
    this.card.querySelector('.pc-detail').textContent = detail;
    this.card.fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  hideCard(immediate = false) {
    const card = this.card;
    this.card = null;
    if (!card) return;
    if (immediate) card.remove();
    else {
      card.classList.remove('visible');
      setTimeout(() => card.remove(), 220);
    }
  }

  cancel() {
    window.gp.faces.cancel();
    this.updateCard('Cancelling…', 0);
  }

  // --------------------------------------------------------------- panel
  togglePanel(force) {
    const open = force ?? !this.panel;
    if (!open) {
      if (this.panel) {
        const p = this.panel;
        this.panel = null;
        p.classList.remove('visible');
        document.body.classList.remove('people-open');
        setTimeout(() => p.remove(), 220);
        this.app.relayout(true);
      }
      return;
    }
    if (!this.panel) {
      this.panel = el('aside', { class: 'people-panel', 'aria-label': 'People' });
      document.body.append(this.panel);
      requestAnimationFrame(() => this.panel?.classList.add('visible'));
      document.body.classList.add('people-open');
      this.app.relayout(true);
    }
    this.render();
  }

  isPanelOpen() { return !!this.panel; }

  render() {
    if (!this.panel) return;
    const groups = this.result?.groups || [];
    const people = groups.filter((g) => !g.special);
    const folders = this.folders || [];
    const p = this.panel;
    const scroll = p.querySelector('.pp-list')?.scrollTop || 0;
    p.innerHTML = '';
    p.append(el('div', { class: 'pp-head' },
      el('div', {},
        el('div', { class: 'pp-title', text: 'People & Folders' }),
        el('div', { class: 'pp-sub', text: `${folders.length} folder${folders.length === 1 ? '' : 's'} \u00b7 `
          + (this.result ? `${people.length} ${people.length === 1 ? 'person' : 'people'} found` : 'faces not scanned yet') })),
      el('button', { class: 'icon-btn', title: 'Close', text: '\u2715', onclick: () => this.togglePanel(false) })));
    p.append(el('div', { class: 'pp-actions' },
      el('button', { text: '+ New folder', title: 'Create your own folder (Ctrl+Shift+N)', onclick: () => this.newFolder() }),
      el('button', { text: 'Import\u2026', title: 'Import folders you have already sorted (one sub-folder per person)', onclick: () => this.importFolders() }),
      el('button', {
        class: 'primary', text: 'Export\u2026', title: 'Save every folder and person as real folders on disk',
        disabled: !groups.length && !folders.length,
        onclick: () => this.saveAsFolders([...folders.filter((f) => f.paths.length), ...groups]),
      })));

    const list = el('div', { class: 'pp-list' });
    const inGroup = this.app.groupView;
    list.append(this.row({ id: '__all', name: 'All photos', paths: [], special: true }, !inGroup, () => this.app.closeGroup()));

    list.append(el('div', { class: 'pp-section' }, el('span', { text: 'My folders' })));
    for (const f of folders) list.append(this.row(f, inGroup?.id === f.id, () => this.open(f)));
    if (!folders.length) {
      list.append(el('p', { class: 'pp-empty', text: 'Sorted people yourself? Create a folder, or import folders you already have.' }));
    }

    list.append(el('div', { class: 'pp-section' }, el('span', { text: 'Recognised people' }),
      el('button', { class: 'link-btn', text: this.result ? 'Rescan' : 'Find people', onclick: () => this.run() })));
    for (const g of groups) list.append(this.row(g, inGroup?.id === g.id, () => this.open(g)));
    if (!groups.length) {
      list.append(el('p', { class: 'pp-empty', text: 'Find people groups photos by face, entirely on this computer. Your folder names are used to name the people it recognises.' }));
    }
    p.append(list);
    list.scrollTop = scroll;
    p.append(el('div', { class: 'pp-hint', text: 'Drag photos from the grid onto a folder to add them \u00b7 double-click a name to rename' }));
  }

  row(g, active, onOpen) {
    const avatar = g.thumb ? el('img', { class: 'pp-avatar', src: g.thumb, alt: '' })
      : el('div', { class: `pp-avatar icon ${g.id}`, text: g.id === '__all' ? '▦' : g.id === 'nofaces' ? '◌' : '☺' });
    const name = el('div', { class: 'pp-name', text: g.name });
    const count = g.id === '__all' ? '' : `${g.paths.length} photo${g.paths.length === 1 ? '' : 's'}`;
    const isFolder = g.kind === 'folder';
    const row = el('div', {
      class: `pp-row${active ? ' active' : ''}${g.special ? ' special' : ''}${isFolder ? ' folder' : ''}`,
      tabindex: '0', 'data-folder-id': isFolder ? g.id : null,
    }, avatar, el('div', { class: 'pp-text' }, name, el('div', { class: 'pp-count', text: count })));
    row.addEventListener('click', onOpen);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onOpen();
    });
    if (g.id === '__all') return row;
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.rowMenu(g);
    });
    if (isFolder) {
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.rename(g);
      });
      return row;
    }
    if (!g.special) {
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.rename(g);
      });
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-gp-person', g.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('application/x-gp-person')) {
          e.preventDefault();
          row.classList.add('drop');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop');
        const src = this.result.groups.find((x) => x.id === e.dataTransfer.getData('application/x-gp-person'));
        if (src && src !== g) this.merge(src, g);
      });
    }
    return row;
  }

  async rowMenu(g) {
    if (g.kind === 'folder') {
      const id = await window.gp.menu.popup([
        { id: 'open', label: 'Open' },
        { id: 'rename', label: 'Rename\u2026' },
        { id: 'addgrid', label: `Add All Photos in the Grid (${this.app.visibleCells().length})`, enabled: this.app.visibleCells().length > 0 },
        { id: 'save', label: 'Save as Folder\u2026', enabled: g.paths.length > 0 },
        { type: 'separator' },
        { id: 'delete', label: 'Delete Folder\u2026' },
      ]);
      if (id === 'open') this.open(g);
      else if (id === 'rename') this.rename(g);
      else if (id === 'addgrid') this.addToFolder(g.id, this.app.visibleCells().map((c) => c.state.path));
      else if (id === 'save') this.saveAsFolders([g]);
      else if (id === 'delete') this.deleteFolder(g);
      return;
    }
    const people = this.result.groups.filter((x) => !x.special && x !== g);
    const menu = [
      { id: 'open', label: 'Open' },
      ...(g.special ? [] : [{ id: 'rename', label: 'Rename…' }]),
      { id: 'save', label: 'Save as Folder…' },
    ];
    if (!g.special && people.length) {
      menu.push({ type: 'separator' }, {
        label: 'Merge Into', submenu: people.map((x) => ({ id: `merge:${x.id}`, label: x.name })),
      });
    }
    const id = await window.gp.menu.popup(menu);
    if (id === 'open') this.open(g);
    else if (id === 'rename') this.rename(g);
    else if (id === 'save') this.saveAsFolders([g]);
    else if (id?.startsWith('merge:')) this.merge(g, this.result.groups.find((x) => x.id === id.slice(6)));
  }

  open(g) {
    if (!g.paths.length) {
      ui.toast(g.kind === 'folder' ? `"${g.name}" is empty \u00b7 drag photos onto it first` : 'No photos');
      return;
    }
    this.app.openGroup(g);
    this.render();
  }

  async rename(g) {
    const isFolder = g.kind === 'folder';
    const name = await ui.prompt({
      title: isFolder ? 'Rename folder' : 'Rename person', label: 'Name:', value: isFolder || g.named ? g.name : '',
    });
    if (!name) return;
    g.name = name;
    g.named = true;
    await (isFolder ? this.saveFolders() : this.persist());
    if (this.app.groupView?.id === g.id) {
      this.app.groupView.name = name;
      this.app.updateTitle();
    }
    this.render();
  }

  async merge(src, dst) {
    dst.paths = [...new Set([...dst.paths, ...src.paths])];
    dst.faceCount = (dst.faceCount || 0) + (src.faceCount || 0);
    if (src.centroid && dst.centroid) {
      const a = dst.faceCount - (src.faceCount || 0);
      const b = src.faceCount || 0;
      dst.centroid = dst.centroid.map((x, i) => (x * a + src.centroid[i] * b) / Math.max(1, a + b));
    }
    if (!dst.named && src.named) {
      dst.name = src.name;
      dst.named = true;
    }
    this.result.groups = this.result.groups.filter((x) => x !== src);
    await this.persist();
    ui.toast(`Merged "${src.name}" into "${dst.name}"`);
    if (this.app.groupView?.id === src.id) this.open(dst);
    this.render();
  }

  persist() {
    return window.gp.faces.saveGroups(this.result);
  }

  // -------------------------------------------------------- save folders
  async saveAsFolders(groups, parentFolder = null) {
    const parent = parentFolder || await window.gp.dialog.openFolder(
      groups.length === 1 ? `Save "${groups[0].name}" to folder` : 'Choose where to create the people folders',
      this.app.saveDir(),
    );
    if (!parent) return;
    this.app.rememberSaveDir(parent);
    const total = groups.reduce((n, g) => n + g.paths.length, 0);
    this.showCard('Saving folders', `0 of ${total} photos`, 0, false);
    let done = 0;
    let failed = 0;
    const usedNames = new Set();
    for (const g of groups) {
      let folderName = sanitize(g.name);
      for (let n = 2; usedNames.has(folderName.toLowerCase()); n++) folderName = `${sanitize(g.name)} (${n})`;
      usedNames.add(folderName.toLowerCase());
      const folder = joinPath(parent, folderName);
      try {
        await window.gp.fs.mkdir(folder);
      } catch {
        failed += g.paths.length;
        continue;
      }
      for (const src of g.paths) {
        try {
          const dest = await window.gp.fs.uniquePath(joinPath(folder, basename(src)));
          await window.gp.fs.copy(src, dest);
        } catch {
          failed++;
        }
        done++;
        this.updateCard(`${g.name}: ${done} of ${total} photos`, done / total);
      }
    }
    this.hideCard();
    if (failed) ui.alert('Saved with errors', `${done - failed} photo(s) copied, ${failed} failed.\n\n${parent}`);
    else ui.toast(`Created ${groups.length} folder${groups.length === 1 ? '' : 's'} (${done} photos)`, 'Show',
      () => window.gp.shell.openPath(groups.length === 1 ? joinPath(parent, sanitize(groups[0].name)) : parent));
  }
}
