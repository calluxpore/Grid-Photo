// GridPhoto renderer entry: owns the playlist state, cells, layout, menus and shortcuts.

import { COMMANDS, COMMANDS_BY_ID, defaultShortcuts } from './commands.js';
import { PhotoCell, newCellState } from './cell.js';
import { comboFromEvent, normalizeCombo } from './keys.js';
import { computeMasonry, gridRects } from './layout.js';
import * as settings from './settings.js';
import { DURATION_PRESETS, TRANSITIONS, TRANSITION_TITLES } from './transitions.js';
import * as ui from './ui.js';
import { People } from './people.js';
import {
  basename, dirname, extname, isAbsolute, joinPath, normcase, relativeTo, resolvePath, samePath,
  timestamp,
} from './util.js';

const FOLDER_PROMPT_THRESHOLD = 60; // ask before adding more photos than this from one folder
const PLAYLIST_EXT = '.gphl';
const isGridFile = (p) => ['.gphl', '.json'].includes(extname(p));
const SNAPSHOT_KEYS = 10;
// cell commands that apply to every selected photo at once
const MULTI_METHODS = new Set(['setRating', 'setFlag', 'rotate', 'flip', 'transformReset', 'cropReset',
  'resetAll', 'zoomReset', 'zoomActual', 'setAspect', 'cycleAspect', 'setAlign', 'reload', 'toggleSlideshow']);

const BG_PRESETS = {
  black: { label: 'Black', mode: 'solid', color: '#000000' },
  charcoal: { label: 'Charcoal', mode: 'solid', color: '#1b1b1d' },
  slate: { label: 'Slate', mode: 'solid', color: '#2b3038' },
  gray: { label: 'Gray', mode: 'solid', color: '#6b6b70' },
  paper: { label: 'Paper', mode: 'solid', color: '#ece9e4' },
  white: { label: 'White', mode: 'solid', color: '#ffffff' },
  acrylic: { label: 'Acrylic glass', mode: 'acrylic' },
  mica: { label: 'Mica', mode: 'mica' },
};

function parseHex(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  return m ? [m[1], m[2], m[3]].map((x) => parseInt(x, 16)) : [0, 0, 0];
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((x) => x / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function newPlaylist() {
  return {
    grid: {
      layout: settings.get('def_grid_layout'),
      keep_order: false,
      mode: settings.get('def_grid_mode'),
      fit_cells: settings.get('def_grid_fit_cells'),
      fixed: false,
      size: 0,
      show_all_cells: false,
      spacing: settings.get('def_grid_spacing'),
    },
    snapshots: {},
    ratings: {}, // path -> { stars, flag }
    filter: 'all',
    sync_view: false,
    shuffle_on_load: false,
    disable_click: false,
    disable_wheel: false,
    disable_overlay: settings.get('def_disable_overlay'),
    overlay_border: settings.get('def_overlay_border'),
    overlay_hide: settings.get('def_overlay_hide'),
  };
}

const PLAYLIST_FLAGS = ['sync_view', 'shuffle_on_load', 'disable_click', 'disable_wheel',
  'disable_overlay', 'overlay_border', 'overlay_hide'];

class App {
  constructor() {
    this.gridEl = document.getElementById('grid');
    this.welcomeEl = document.getElementById('welcome');
    this.playlist = newPlaylist();
    this.cells = [];
    this.activeCell = null;
    this.singleCell = null;
    this.playlistPath = null;
    this.dirty = false;
    this.fullscreen = false;
    this.onTop = settings.get('stay_on_top');
    this.layoutInfo = { rows: 0, cols: 0 };
    this.keyIndex = new Map();
    this.relayoutQueued = false;
    this.mouseTimer = null;
    this.drag = null;
    this.closedStack = [];
    this.selection = new Set();
    this.selectionAnchor = null;
    this.presenting = null;
    this.animateNext = false;

    this.buildKeyIndex();
    this.applyAppearance();
    this.bindEvents();
    this.bindToolbar();
    this.bindSelectionBar();
    this.groupView = null; // { id, name } while showing a person's photos
    this.groupReturn = null;
    this.people = new People(this);
    this.groupChip = document.getElementById('group-chip');
    this.groupChip.querySelector('button').addEventListener('click', () => this.closeGroup());
    this.relayout();
    this.updateTitle();
  }

  // ------------------------------------------------------------ settings
  applyAppearance() {
    const scheme = settings.get('color_scheme');
    document.documentElement.dataset.theme = scheme;
    const root = document.documentElement.style;
    const color = settings.get('background_color');
    const mode = this.glassSupported === false ? 'solid' : settings.get('bg_mode');
    const glass = mode === 'acrylic' || mode === 'mica';
    root.setProperty('--page-bg', glass ? hexToRgba(color, settings.get('bg_tint') / 100) : color);
    root.setProperty('--cell-bg', glass ? 'transparent' : color);
    root.setProperty('--radius', `${settings.get('corner_radius')}px`);
    // readable welcome text on light backgrounds
    const light = !glass && luminance(color) > 0.55;
    root.setProperty('--on-bg', light ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.55)');
    document.body.classList.toggle('glass', glass);
    document.body.classList.toggle('dim-rejected', settings.get('dim_rejected'));
    window.gp.win.setBackground({ mode, color });
    window.gp.win.setOpacity(settings.get('window_opacity') / 100);
  }

  // ----------------------------------------------------------- background
  setBackground(changes) {
    for (const [k, v] of Object.entries(changes)) settings.set(k, v);
    this.applyAppearance();
  }

  backgroundPreset(preset) {
    const p = BG_PRESETS[preset];
    if (p.mode === 'solid') this.setBackground({ bg_mode: 'solid', background_color: p.color });
    else this.setBackground({ bg_mode: p.mode });
  }

  isBackgroundPreset(preset) {
    const p = BG_PRESETS[preset];
    const mode = settings.get('bg_mode');
    if (p.mode !== 'solid') return mode === p.mode;
    return mode === 'solid' && settings.get('background_color').toLowerCase() === p.color;
  }

  // ---------------------------------------------------------- transitions
  setTransition(type) {
    settings.set('transition_type', type);
    this.targetCell()?.flash(`Transition: ${TRANSITION_TITLES[type]}`);
  }

  cycleTransition(step = 1) {
    const ids = TRANSITIONS.map(([id]) => id);
    const i = ids.indexOf(settings.get('transition_type'));
    this.setTransition(ids[(i + step + ids.length) % ids.length]);
  }

  // -------------------------------------------------------------- toolbar
  bindToolbar() {
    this.toolbarEl = document.getElementById('toolbar');
    for (const b of this.toolbarEl.querySelectorAll('button[title]')) b.setAttribute('aria-label', b.title.replace(/\s*\(.*\)$/, ''));
    for (const btn of document.querySelectorAll('[data-cmd]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = btn.dataset.cmd;
        if (cmd === 'filter_menu') this.showFilterMenu();
        else this.dispatch(COMMANDS_BY_ID[cmd]);
      });
    }
    this.toolbarEl.addEventListener('pointerenter', () => clearTimeout(this.toolbarTimer));
    this.toolbarEl.addEventListener('pointerleave', () => this.scheduleToolbarHide());
    document.addEventListener('pointermove', (e) => {
      if (!this.isToolbar() || ui.isModalOpen()) return;
      // only the very top edge reveals it, so it never covers the photos' close buttons by accident
      if (e.clientY < 16 || !this.cells.length) this.showToolbar();
    });
    this.updateToolbar();
  }

  showToolbar() {
    this.toolbarEl.classList.add('visible');
    this.scheduleToolbarHide();
  }

  scheduleToolbarHide() {
    clearTimeout(this.toolbarTimer);
    this.toolbarTimer = setTimeout(() => {
      if (!this.toolbarEl.matches(':hover') && this.cells.length) this.toolbarEl.classList.remove('visible');
    }, 2200);
  }

  updateToolbar() {
    if (!this.toolbarEl) return;
    const f = this.playlist.filter;
    const saveBtn = this.toolbarEl.querySelector('[data-cmd="save_playlist"]');
    saveBtn.classList.toggle('dirty', this.dirty && this.cells.length > 0 && !this.groupView);
    saveBtn.title = this.playlistPath ? `Save grid · ${basename(this.playlistPath)} (Ctrl+S)` : 'Save grid (Ctrl+S)';
    const filterBtn = this.toolbarEl.querySelector('[data-cmd="filter_menu"]');
    filterBtn.classList.toggle('active', f !== 'all');
    filterBtn.title = `Filter: ${COMMANDS_BY_ID[`filter_${f}`].title}`;
    const layoutBtn = this.toolbarEl.querySelector('[data-cmd="layout_toggle"]');
    layoutBtn.title = this.isLayout('masonry') ? 'Layout: Waterfall (Ctrl+L for grid)' : 'Layout: Grid (Ctrl+L for waterfall)';
    this.toolbarEl.querySelector('.count').textContent = this.cells.length
      ? (f === 'all' ? `${this.cells.length}` : `${this.visibleCells().length} / ${this.cells.length}`) : '';
    this.toolbarEl.hidden = !this.isToolbar();
  }

  async showFilterMenu() {
    const ids = ['filter_all', 'filter_picks', 'filter_no_rejects', '-', 'filter_stars_1', 'filter_stars_2',
      'filter_stars_3', 'filter_stars_4', 'filter_stars_5', '-', 'sort_rating', 'save_picks'];
    const menu = ids.map((id) => (id === '-' ? { type: 'separator' } : {
      id, label: COMMANDS_BY_ID[id].title, accelerator: this.shortcutsFor(id)[0],
      ...(COMMANDS_BY_ID[id].checked ? { checkbox: true, checked: this.isChecked(COMMANDS_BY_ID[id], null) } : {}),
    }));
    const id = await window.gp.menu.popup(menu);
    if (id) this.dispatch(COMMANDS_BY_ID[id]);
  }

  toggleToolbar() {
    settings.set('show_toolbar', !settings.get('show_toolbar'));
    this.updateToolbar();
    if (this.isToolbar()) this.showToolbar();
  }

  isToolbar() { return !!settings.get('show_toolbar'); }

  openBackgroundPanel() {
    ui.backgroundPanel(this, BG_PRESETS);
  }

  shortcutsFor(id) {
    const keymap = settings.get('keymap');
    return id in keymap ? keymap[id] : defaultShortcuts(id);
  }

  buildKeyIndex() {
    this.keyIndex.clear();
    for (const cmd of COMMANDS) {
      for (const s of this.shortcutsFor(cmd.id)) {
        const combo = normalizeCombo(s);
        if (combo && !this.keyIndex.has(combo)) this.keyIndex.set(combo, cmd);
      }
    }
  }

  // -------------------------------------------------------------- events
  bindEvents() {
    document.addEventListener('keydown', (e) => {
      if (ui.isModalOpen() || this.drag) return;
      if (e.target.closest?.('input, select, textarea, .bg-panel')) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const cmd = this.keyIndex.get(combo);
      if (cmd) {
        e.preventDefault();
        this.dispatch(cmd);
      }
    });
    // Ctrl+wheel must never zoom the page
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) e.preventDefault();
    }, { passive: false });
    window.addEventListener('resize', () => this.relayout());
    document.addEventListener('pointermove', () => this.onMouseActivity());

    this.gridEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.setActive(null);
      this.showContextMenu();
    });
    this.gridEl.addEventListener('dblclick', (e) => {
      if (!this.cells.length && e.target.closest('#welcome, #grid')) this.addFilesDialog();
    });

    // external file drops
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        document.body.classList.add('drop-target');
      }
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) document.body.classList.remove('drop-target');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('drop-target');
      const paths = [...(e.dataTransfer?.files || [])].map((f) => window.gp.pathForFile(f)).filter(Boolean);
      const cellEl = e.target.closest?.('.cell');
      const target = e.ctrlKey && cellEl ? this.cells.find((c) => c.el === cellEl) : null;
      this.dropFiles(paths, target);
    });

    window.gp.on('app:open-paths', (paths) => this.receivePaths(paths));
    window.gp.on('library:progress', ({ done, total }) => {
      if (this.copyingCard) this.people.updateCard(`${done} of ${total} photos`, done / total);
    });
    window.gp.on('win:fullscreen', (on) => {
      this.fullscreen = on;
      document.body.classList.toggle('fullscreen', on);
    });
    window.gp.on('app:close-requested', async () => {
      if (await this.maybeSave()) {
        this.saveSession();
        window.gp.app.quit();
      }
    });
  }

  dispatch(cmd) {
    try {
      if (cmd.target === 'win') return this[cmd.method](...cmd.args);
      if (cmd.target === 'cell') {
        const cell = this.targetCell();
        if (!cell) return undefined;
        const cells = MULTI_METHODS.has(cmd.method) ? this.commandCells(cell) : [cell];
        if (cells.length > 1) return this.applyToCells(cells, cmd, cell);
        return cell[cmd.method](...cmd.args);
      }
      return this.dispatchAll(cmd);
    } catch (err) {
      console.error(`command ${cmd.id} failed`, err);
      return undefined;
    }
  }

  async dispatchAll(cmd) {
    const cells = this.visibleCells();
    if (!cells.length) return;
    const ref = this.targetCell();
    if (cmd.method.startsWith('ask')) {
      const value = await ref[cmd.method](false);
      if (value === null) return;
      const setter = `set${cmd.method.slice(3)}`;
      for (const c of cells) c[setter](value);
      return;
    }
    if (cmd.method === 'toggleSlideshow') {
      const on = !ref.state.slideshow;
      for (const c of cells) c.setSlideshow(on);
      return;
    }
    if (cmd.method === 'toggleAnimation') {
      const paused = !ref.state.animation_paused;
      for (const c of cells) if (c.state.animation_paused !== paused) c.toggleAnimation();
      return;
    }
    for (const c of cells) c[cmd.method](...cmd.args);
  }

  isChecked(cmd, cell) {
    if (!cmd.checked) return undefined;
    const obj = cmd.target === 'win' ? this : cell;
    return obj ? !!obj[cmd.checked](...cmd.checkedArgs) : false;
  }

  // ---------------------------------------------------------------- menu
  async showContextMenu() {
    const cell = this.cells.includes(this.activeCell) ? this.activeCell : null;
    const item = (id) => {
      const cmd = COMMANDS_BY_ID[id];
      const out = { id, label: cmd.title, accelerator: this.shortcutsFor(id)[0] };
      const checked = this.isChecked(cmd, cell);
      if (checked !== undefined) {
        out.checkbox = true;
        out.checked = checked;
      }
      return out;
    };
    const sep = { type: 'separator' };
    const items = (...ids) => ids.map((id) => (id === '-' ? sep : item(id)));
    const sub = (label, children) => ({ label, submenu: children });
    const menu = [];
    const transitionMenu = () => {
      const type = settings.get('transition_type');
      const duration = settings.get('transition_duration');
      return sub(`Enlarged View Transition: ${TRANSITION_TITLES[type] || type}`, [
        ...TRANSITIONS.map(([id, label]) => ({
          id: `tr:${id}`, label, checkbox: true, checked: id === type,
        })),
        sep,
        ...DURATION_PRESETS.map(([ms, label]) => ({
          id: `trd:${ms}`, label, checkbox: true, checked: ms === duration,
        })),
        sep,
        {
          id: 'tr-scope', label: 'Also When Browsing Manually (not only slideshow)', checkbox: true,
          checked: settings.get('transition_scope') === 'all',
        },
        item('transition_cycle'),
      ]);
    };

    const ratingMenu = () => sub('Rating', items('rate_1', 'rate_2', 'rate_3', 'rate_4', 'rate_5', 'rate_0', '-',
      'flag_pick', 'flag_reject', 'flag_clear'));

    if (cell) {
      const multi = this.commandCells(cell);
      menu.push({
        label: multi.length > 1 ? `${multi.length} photos selected` : cell.state.title || basename(cell.state.path) || '(empty)',
        enabled: false,
      }, sep);
      menu.push(item('present'), ratingMenu());
      const folders = this.people.folders || [];
      menu.push(sub(multi.length > 1 ? `Add ${multi.length} Photos to Folder` : 'Add to Folder', [
        ...folders.map((f) => ({ id: `addf:${f.id}`, label: f.name, enabled: multi.length > 1 || !f.paths.includes(cell.state.path) })),
        ...(folders.length ? [sep] : []),
        { id: 'addf:new', label: 'New Folder\u2026' },
      ]));
      if (this.groupView && this.people.folderById(this.groupView.id)) {
        menu.push({ id: 'rmf', label: `Remove from "${this.groupView.name}"` });
      }
      menu.push(sep);
      menu.push(...items('save_as', 'copy_image', 'open_folder'), sep);
      menu.push(sub('View', [
        ...items('zoom_in', 'zoom_out', 'zoom_reset', 'zoom_100', '-'),
        sub('Aspect', items('aspect_fit', 'aspect_fill', 'aspect_stretch', 'aspect_none')),
        sub('Align', items('align_center', 'align_top', 'align_bottom', 'align_left', 'align_right',
          'align_top_left', 'align_top_right', 'align_bottom_left', 'align_bottom_right')),
        ...items('position_reset', '-', 'single_mode', 'apply_view_others', '-', 'reset_all'),
      ]));
      menu.push(sub('Rotate && Flip', items('rotate_cw', 'rotate_ccw', 'rotate_180', '-', 'flip_h', 'flip_v', '-',
        'transform_reset')));
      menu.push(sub('Crop', items('crop_l_inc', 'crop_l_dec', 'crop_t_inc', 'crop_t_dec', 'crop_r_inc',
        'crop_r_dec', 'crop_b_inc', 'crop_b_dec', '-', 'crop_reset')));
      menu.push(sub('Browse Folder', items('prev_file', 'next_file', 'first_file', 'last_file', 'random_file')));
      const slideshow = items('slideshow', '-', 'slideshow_faster', 'slideshow_slower', 'slideshow_normal',
        'slideshow_interval', '-', 'slideshow_order_next', 'slideshow_order_previous', 'slideshow_order_shuffle');
      if (cell.anim) slideshow.push(sep, item('animation'));
      slideshow.push(sep, transitionMenu());
      menu.push(sub('Slideshow', slideshow));
      menu.push(sub('File', items('export_view', 'copy_path', 'show_info', 'open_external', '-', 'replace_file',
        'rename', 'reload')));
      menu.push(sep, ...items('select_all', ...(this.selection.size ? ['clear_selection'] : []), '-', 'close_cell', 'trash'), sep);
    }

    if (this.cells.length) {
      menu.push(sub('All Photos', [
        ...items('slideshow_all', 'prev_file_all', 'next_file_all', 'random_file_all', '-',
          'zoom_reset_all', 'reset_all_all', 'reload_all'),
        sub('Aspect', items('aspect_fit_all', 'aspect_fill_all', 'aspect_stretch_all', 'aspect_none_all')),
        sub('Rotate && Flip', items('rotate_cw_all', 'rotate_ccw_all', 'flip_h_all', 'flip_v_all',
          'transform_reset_all')),
        sub('Slideshow Order', items('slideshow_order_next_all', 'slideshow_order_previous_all',
          'slideshow_order_shuffle_all')),
        item('slideshow_interval_all'),
      ]));
      menu.push(sub(`Filter: ${COMMANDS_BY_ID[`filter_${this.playlist.filter}`].title}`, [
        ...items('filter_all', 'filter_picks', 'filter_no_rejects', '-', 'filter_stars_1', 'filter_stars_2',
          'filter_stars_3', 'filter_stars_4', 'filter_stars_5'),
      ]));
      menu.push(sub('Layout', [
        ...items('layout_masonry', 'layout_grid', '-', 'grid_more', 'grid_less', 'grid_size', 'grid_spacing', '-',
          'shuffle_grid', 'sort_grid', 'sort_rating', '-', 'sync_view'),
        sub('Advanced', items('keep_order', 'grid_fixed', '-', 'grid_rows', 'grid_columns', 'grid_fit',
          'grid_show_all', '-', 'shuffle_on_load')),
      ]));
      menu.push(sub('People && Folders', items('faces', 'people_rescan', 'people_panel', '-', 'new_folder', 'import_folders')));
      const saved = Object.keys(this.playlist.snapshots).sort();
      menu.push(sub('Snapshots', [
        sub('Save', items(...Array.from({ length: SNAPSHOT_KEYS }, (_, i) => `snapshot_save_${i}`))),
        { ...sub('Load', items(...saved.map((i) => `snapshot_load_${i}`))), enabled: saved.length > 0 },
        { ...sub('Delete', items(...saved.map((i) => `snapshot_delete_${i}`))), enabled: saved.length > 0 },
      ]));
      menu.push(sep);
    }

    menu.push(...items('add_files', 'add_folder', 'add_clipboard'));
    const recentFiles = settings.get('recent_list_enabled') ? settings.get('recent_files') : [];
    const recentGrids = settings.get('recent_list_enabled') ? settings.get('recent_playlists') : [];
    menu.push({
      ...sub('Recent', [
        ...recentGrids.map((p, i) => ({ id: `recent_grid:${i}`, label: `Grid: ${p}` })),
        ...(recentGrids.length && recentFiles.length ? [sep] : []),
        ...recentFiles.map((p, i) => ({ id: `recent_file:${i}`, label: p })),
        ...(recentFiles.length || recentGrids.length ? [sep, { id: 'recent:clear', label: 'Clear Recent' }] : []),
      ]),
      enabled: recentFiles.length + recentGrids.length > 0,
    });
    menu.push(sep, item('open_playlist'));
    if (this.cells.length) {
      menu.push(...items('save_playlist', 'save_playlist_as', '-', 'save_picks', 'save_all_as', 'export_grid',
        '-', 'close_playlist'));
    }
    menu.push(sep, sub('Background', [
      ...Object.entries(BG_PRESETS).map(([key, p]) => ({
        id: `bg:${key}`, label: p.label, checkbox: true, checked: this.isBackgroundPreset(key),
        enabled: p.mode === 'solid' || this.glassSupported !== false,
      })),
      sep,
      item('background'),
    ]));
    const opacity = settings.get('window_opacity');
    menu.push(sub('Window', [
      ...items('fullscreen', 'stay_on_top', 'toolbar', '-'),
      sub('Opacity', [100, 90, 75, 60, 45].map((v) => ({
        id: `op:${v}`, label: `${v}%`, checkbox: true, checked: opacity === v,
      }))),
      sep,
      sub('Overlay', items('disable_overlay', 'overlay_border', 'overlay_hide', '-', 'disable_click',
        'disable_wheel')),
    ]));
    menu.push(...items('settings', 'shortcuts', 'about', '-', 'quit'));

    this.showCursor();
    const id = await window.gp.menu.popup(menu);
    if (!id) return;
    if (id === 'recent:clear') {
      settings.set('recent_files', []);
      settings.set('recent_playlists', []);
    } else if (id.startsWith('recent_file:')) {
      this.addPaths([recentFiles[Number(id.split(':')[1])]]);
    } else if (id.startsWith('recent_grid:')) {
      this.openPlaylist(recentGrids[Number(id.split(':')[1])]);
    } else if (id.startsWith('op:')) {
      this.setBackground({ window_opacity: Number(id.slice(3)) });
    } else if (id.startsWith('tr:')) {
      this.setTransition(id.slice(3));
    } else if (id.startsWith('trd:')) {
      settings.set('transition_duration', Number(id.slice(4)));
    } else if (id === 'tr-scope') {
      settings.set('transition_scope', settings.get('transition_scope') === 'all' ? 'slideshow' : 'all');
    } else if (id.startsWith('addf:')) {
      this.people.addToFolder(id.slice(5), this.commandCells(cell).map((c) => c.state.path));
    } else if (id === 'rmf') {
      this.people.removeFromFolder(this.groupView.id, [cell.state.path]);
    } else if (id.startsWith('bg:')) {
      this.backgroundPreset(id.slice(3));
    } else if (COMMANDS_BY_ID[id]) {
      this.dispatch(COMMANDS_BY_ID[id]);
    }
  }

  // ------------------------------------------------------ cell plumbing
  targetCell() {
    if (this.cells.includes(this.activeCell)) return this.activeCell;
    return this.singleCell || this.cells[0] || null;
  }

  visibleCells() {
    return this.singleCell ? [this.singleCell] : this.cells.filter((c) => this.passesFilter(c));
  }

  // ------------------------------------------------------- rating / filter
  ratingOf(path) {
    const r = this.playlist.ratings[path];
    return { stars: r?.stars || 0, flag: r?.flag || null };
  }

  setRatingOf(path, changes) {
    const next = { ...this.ratingOf(path), ...changes };
    if (!next.stars && !next.flag) delete this.playlist.ratings[path];
    else this.playlist.ratings[path] = next;
    for (const c of this.cells) if (c.state.path === path) c.updateRatingBadge();
    if (this.playlist.filter !== 'all') this.relayout(true);
    this.markDirty();
  }

  passesFilter(cell) {
    const f = this.playlist.filter;
    if (f === 'all') return true;
    const r = this.ratingOf(cell.state.path);
    if (f === 'picks') return r.flag === 'pick';
    if (f === 'no_rejects') return r.flag !== 'reject';
    if (f.startsWith('stars_')) return r.stars >= Number(f.slice(6));
    return true;
  }

  setFilter(filter) {
    this.playlist.filter = filter;
    const shown = this.cells.filter((c) => this.passesFilter(c)).length;
    this.updateToolbar();
    this.relayout(true);
    this.markDirty();
    if (filter === 'all') ui.toast(`Showing all ${this.cells.length} photos`);
    else if (!shown) ui.toast('No photos match this filter', 'Show all', () => this.setFilter('all'));
    else ui.toast(`${COMMANDS_BY_ID[`filter_${filter}`].title}: ${shown} of ${this.cells.length}`, 'Show all',
      () => this.setFilter('all'));
  }

  isFilter(filter) { return this.playlist.filter === filter; }

  sortByRating() {
    const score = (c) => {
      const r = this.ratingOf(c.state.path);
      return (r.flag === 'pick' ? 10 : r.flag === 'reject' ? -10 : 0) + r.stars;
    };
    this.cells.sort((a, b) => score(b) - score(a));
    this.relayout(true);
    this.markDirty();
  }

  async savePicks() {
    const picks = Object.entries(this.playlist.ratings).filter(([, r]) => r.flag === 'pick').map(([p]) => p);
    if (!picks.length) {
      ui.alert('Save picks', 'No picks yet.\n\nHover a photo and press P to pick it (X rejects, 1-5 rates).');
      return;
    }
    await this.copyFilesTo(picks.map((src) => ({ src, cell: null })), `Save ${picks.length} pick(s) to folder`);
  }

  setActive(cell) {
    if (this.activeCell === cell) return;
    if (this.activeCell) this.activeCell.setActive(false);
    this.activeCell = cell;
    if (cell) cell.setActive(true);
  }

  markDirty(dirty = true) {
    if (this.dirty !== dirty) {
      this.dirty = dirty;
      this.updateTitle();
    }
    this.updateToolbar();
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.saveSession(), 1500);
  }

  updateTitle() {
    let title = 'GridPhoto';
    if (this.playlistPath) {
      title = `${basename(this.playlistPath).replace(/\.gphl$/i, '')}${this.dirty ? '*' : ''} - ${title}`;
    }
    if (this.groupView) title = `${this.groupView.name} - GridPhoto`;
    if (this.cells.length) title += `  [${this.cells.length}]`;
    document.title = title;
    if (this.groupChip) {
      this.groupChip.hidden = !this.groupView;
      if (this.groupView) this.groupChip.querySelector('.name').textContent = this.groupView.name;
    }
    this.updateToolbar();
  }

  cellLoaded(cell) {
    const g = this.playlist.grid;
    // during a transition the other photos glide to their new places
    const transitioning = !!(cell && (cell.transition || cell.pendingTransition));
    if (g.layout === 'masonry' || (g.fit_cells && !g.fixed)) this.relayout(transitioning);
  }

  /** Cells running a photo transition keep their own animation; others may glide. */
  glide(cell, animate) {
    return animate && !cell.transition && !cell.pendingTransition;
  }

  cellViewChanged(cell) {
    if (!this.playlist.sync_view) return;
    for (const other of this.cells) if (other !== cell) other.copyViewFrom(cell);
  }

  addStates(states) {
    // briefly show the toolbar when the first photos arrive, so people know it exists
    if (!this.cells.length && states.length && this.isToolbar() && this.toolbarEl) this.showToolbar();
    for (const st of states) {
      const cell = new PhotoCell(this, st);
      this.cells.push(cell);
      this.gridEl.append(cell.el);
    }
    if (this.cells.length && !this.activeCell) this.setActive(this.cells[0]);
    this.relayout(true);
    this.markDirty();
    this.updateTitle();
  }

  async addPaths(paths) {
    const entries = await window.gp.fs.expand(paths, settings.get('include_subfolders'),
      settings.get('sort_mode'), true);
    const files = [];
    for (const entry of entries) {
      if (entry.playlist) {
        await this.openPlaylist(entry.playlist);
      } else if (entry.file) {
        files.push(entry.file);
      } else if (entry.folder) {
        let found = entry.files;
        if (found.length > FOLDER_PROMPT_THRESHOLD) {
          const answer = await window.gp.dialog.message({
            type: 'question', title: 'Add folder',
            message: `"${basename(entry.folder) || entry.folder}" contains ${found.length} photos.`,
            detail: 'Showing all of them makes each photo small. You can also show only the first '
              + `${FOLDER_PROMPT_THRESHOLD}, or one photo you browse through with \u2190 \u2192 and Space.`,
            buttons: [`Show all ${found.length}`, `First ${FOLDER_PROMPT_THRESHOLD}`, 'One photo', 'Cancel'],
            defaultId: 0, cancelId: 3,
          });
          if (answer === 3) continue;
          if (answer === 1) found = found.slice(0, FOLDER_PROMPT_THRESHOLD);
          if (answer === 2) {
            // copy the whole folder so it can still be browsed, but show one photo
            const copies = await this.importToLibrary(found);
            files.push(copies.find(Boolean));
            continue;
          }
        }
        files.push(...found);
      }
    }
    if (files.length) {
      const copies = (await this.importToLibrary(files.filter(Boolean))).filter(Boolean);
      this.addStates(copies.map((f) => newCellState(f)));
      for (const f of copies.slice(0, settings.get('recent_list_max_size'))) settings.addRecent('recent_files', f);
      if (!settings.get('library_notice_shown') && copies.length) {
        settings.set('library_notice_shown', true);
        ui.toast('Photos are copied into GridPhoto\u2019s library. Deleting here never touches your originals.',
          'Show library', () => window.gp.library.reveal(), 9);
      }
      return copies.length;
    } else if (paths.length && !entries.some((e) => e.playlist || e.folder)) {
      ui.toast('Nothing to add: these files are not supported photos. GridPhoto opens JPG, PNG, WebP, AVIF, GIF, BMP and SVG.',
        null, null, 7);
    } else if (entries.some((e) => e.folder && !e.files.length)) {
      ui.toast('No supported photos in that folder');
    }
    return files.length;
  }

  async dropFiles(paths, replaceCell) {
    if (!paths.length) return;
    if (replaceCell) {
      const files = await window.gp.fs.expand(paths, false, settings.get('sort_mode'), false);
      const [copy] = files.length ? await this.importToLibrary([files[0]]) : [];
      if (copy) replaceCell.loadPath(copy);
      return;
    }
    this.addPaths(paths);
  }

  swapCells(a, b) {
    const i = this.cells.indexOf(a);
    const j = this.cells.indexOf(b);
    if (i < 0 || j < 0 || i === j) return;
    [this.cells[i], this.cells[j]] = [this.cells[j], this.cells[i]];
    this.relayout(true);
    this.markDirty();
  }

  /**
   * Remove a photo from the grid. With discard (user closed it: x, Ctrl+W, Close)
   * GridPhoto's copy is deleted from disk too; Undo restores it until the app quits.
   */
  closeCell(cell, { animate = false, undoable = false, discard = false, toast = true } = {}) {
    const idx = this.cells.indexOf(cell);
    if (idx < 0) return;
    const path = cell.state.path;
    let discarding = null;
    if (discard && path && this.isInLibrary(path) && !this.cells.some((c) => c !== cell && c.state.path === path)) {
      discarding = window.gp.library.discard(path).catch(() => null);
      this.people.forgetPaths([path]);
      delete this.playlist.ratings[path];
    }
    if (this.singleCell === cell) this.singleCell = null;
    if (this.presenting?.cell === cell) this.presenting = null;
    if (this.selection.delete(cell)) this.updateSelectionBar();
    this.cells.splice(idx, 1);
    if (undoable && cell.state.path) {
      this.closedStack.push({ state: { ...cell.state }, index: idx, discarding });
      if (this.closedStack.length > 30) this.closedStack.shift();
      if (toast) {
        ui.toast(discarding ? 'Photo deleted' : 'Photo closed', 'Undo', () => this.undoClose(), 6, 'Ctrl+Z');
      }
    }
    if (this.activeCell === cell) {
      this.activeCell = null;
      if (this.cells.length) this.setActive(this.cells[Math.min(idx, this.cells.length - 1)]);
    }
    if (animate) {
      cell.el.classList.add('closing');
      cell.el.style.pointerEvents = 'none';
      setTimeout(() => cell.destroy(), 180);
    } else {
      cell.destroy();
    }
    this.relayout(animate);
    this.markDirty();
    this.updateTitle();
  }

  closeActive() {
    if (this.selection.size) {
      const cells = this.selectedCells();
      this.clearSelection();
      for (const c of cells) this.closeCell(c, { animate: true, undoable: true, discard: true, toast: false });
      ui.toast(`Deleted ${cells.length} photo${cells.length === 1 ? '' : 's'}`, 'Undo', async () => {
        for (let i = 0; i < cells.length; i++) await this.undoClose();
      }, 6, 'Ctrl+Z');
      return;
    }
    const cell = this.targetCell();
    if (cell) this.closeCell(cell, { animate: true, undoable: true, discard: true });
  }

  // ------------------------------------------------------------ selection
  selectedCells() {
    return this.cells.filter((c) => this.selection.has(c));
  }

  /** The photos a command applies to: the selection when it includes the target. */
  commandCells(target) {
    if (this.selection.size > 1 && (!target || this.selection.has(target))) return this.selectedCells();
    return target ? [target] : [];
  }

  setSelection(cells) {
    const next = new Set(cells.filter((c) => this.cells.includes(c)));
    for (const c of this.selection) if (!next.has(c)) c.el.classList.remove('selected');
    for (const c of next) c.el.classList.add('selected');
    this.selection = next;
    this.updateSelectionBar();
  }

  toggleSelect(cell, range = false) {
    const visible = this.visibleCells();
    if (range && this.selectionAnchor && visible.includes(this.selectionAnchor)) {
      const a = visible.indexOf(this.selectionAnchor);
      const b = visible.indexOf(cell);
      const span = visible.slice(Math.min(a, b), Math.max(a, b) + 1);
      this.setSelection([...this.selection, ...span]);
      return;
    }
    const next = new Set(this.selection);
    if (next.has(cell)) next.delete(cell);
    else next.add(cell);
    this.selectionAnchor = cell;
    this.setSelection([...next]);
  }

  selectAll() {
    const visible = this.visibleCells();
    if (!visible.length) return;
    this.selectionAnchor = visible[0];
    this.setSelection(visible);
  }

  clearSelection() {
    if (this.selection.size) this.setSelection([]);
  }

  hasSelection() { return this.selection.size > 0; }

  updateSelectionBar() {
    const n = this.selection.size;
    const bar = document.getElementById('selection-bar');
    if (!bar) return;
    bar.hidden = n === 0;
    bar.querySelector('.count').textContent = `${n} selected`;
    document.body.classList.toggle('has-selection', n > 0);
  }

  bindSelectionBar() {
    const bar = document.getElementById('selection-bar');
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.querySelector('[data-sel="all"]').addEventListener('click', () => this.selectAll());
    bar.querySelector('[data-sel="clear"]').addEventListener('click', () => this.clearSelection());
    bar.querySelector('[data-sel="close"]').addEventListener('click', () => this.closeActive());
    bar.querySelector('[data-sel="delete"]').addEventListener('click', () => this.trashSelected());
    bar.querySelector('[data-sel="folder"]').addEventListener('click', async () => {
      await this.people.loadFolders();
      const id = await window.gp.menu.popup([
        ...this.people.folders.map((f) => ({ id: f.id, label: f.name })),
        ...(this.people.folders.length ? [{ type: 'separator' }] : []),
        { id: 'new', label: 'New Folder\u2026' },
      ]);
      if (id) this.people.addToFolder(id, this.selectedCells().map((c) => c.state.path));
    });
  }

  /** Run a cell command on several photos; ratings and flags are set, not toggled. */
  applyToCells(cells, cmd, target) {
    if (cmd.method === 'setRating' || cmd.method === 'setFlag') {
      const [value] = cmd.args;
      const isRating = cmd.method === 'setRating';
      const all = cells.every((c) => (isRating ? c.isRating(value) : c.isFlag(value)));
      const next = value && all ? (isRating ? 0 : null) : value;
      for (const c of cells) if (c.state.path) this.setRatingOf(c.state.path, isRating ? { stars: next } : { flag: next });
      const what = isRating ? (next ? '\u2605'.repeat(next) : 'Rating cleared')
        : (next === 'pick' ? '\u2713 Pick' : next === 'reject' ? '\u2715 Reject' : 'Flag removed');
      target.flash(`${what} \u00b7 ${cells.length} photos`, 1);
      return undefined;
    }
    for (const c of cells) c[cmd.method](...cmd.args);
    return undefined;
  }

  /** Delete key: move the selected photos (or the photo under the mouse) to the Recycle Bin. */
  // -------------------------------------------------------------- library
  isInLibrary(p) {
    const lib = normcase(this.libraryDir || '');
    return !!lib && normcase(p).startsWith(lib.endsWith('\\') || lib.endsWith('/') ? lib : lib + (lib.includes('/') ? '/' : '\\'));
  }

  /** Copy photos into the library; returns the copies (null for unreadable files), same order. */
  async importToLibrary(paths) {
    if (!paths.length) return [];
    const outside = paths.filter((p) => !this.isInLibrary(p)).length;
    if (!outside) return paths;
    const showCard = outside > 6;
    if (showCard) {
      this.copyingCard = true;
      this.people.showCard('Copying photos into GridPhoto', `0 of ${paths.length} photos`, 0, false);
    }
    try {
      return await window.gp.library.import(paths);
    } finally {
      if (showCard) {
        this.copyingCard = false;
        this.people.hideCard();
      }
    }
  }

  /** Replace a grid's photo paths (and rating keys) with library copies. */
  async bringIntoLibrary(data, skip) {
    const todo = data.cells.map((c) => c.path).filter((p) => p && !skip.includes(p) && !this.isInLibrary(p));
    if (!todo.length) return;
    const copies = await this.importToLibrary(todo);
    const map = new Map(todo.map((p, i) => [p, copies[i]]));
    data.cells = data.cells.map((c) => (map.get(c.path) ? { ...c, path: map.get(c.path) } : c));
    data.ratings = Object.fromEntries(Object.entries(data.ratings || {}).map(([p, r]) => [map.get(p) || p, r]));
    this.dirty = true;
  }

  async trashSelected() {
    const cells = this.selection.size ? this.selectedCells() : [this.targetCell()].filter(Boolean);
    if (cells.length) await this.deletePhotos(cells);
  }

  /** Delete = remove GridPhoto's copies. Original files are never touched. */
  async deletePhotos(cells) {
    const paths = [...new Set(cells.map((c) => c.state.path).filter(Boolean))];
    if (!paths.length) return;
    const n = paths.length;
    const names = paths.slice(0, 6).map((p) => `\u2022 ${basename(p)}`).join('\n')
      + (n > 6 ? `\n\u2026and ${n - 6} more` : '');
    const answer = await window.gp.dialog.message({
      type: 'warning', title: 'Delete from GridPhoto',
      message: `Delete ${n} photo${n === 1 ? '' : 's'} from GridPhoto?`,
      detail: `${names}\n\nOnly GridPhoto\u2019s copies are deleted. Your original files are not touched.`,
      buttons: [`Delete ${n}`, 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (answer !== 0) return;
    const { deleted } = await window.gp.library.delete(paths);
    const gone = new Set(deleted);
    this.clearSelection();
    // photos outside the library (very old sessions) are just removed from the grid
    for (const c of [...this.cells]) if (paths.includes(c.state.path)) this.closeCell(c, { animate: true });
    for (const p of gone) delete this.playlist.ratings[p];
    await this.people.forgetPaths([...gone]);
    ui.toast(`Deleted ${n} photo${n === 1 ? '' : 's'} \u00b7 originals untouched`);
  }

  async undoClose() {
    const item = this.closedStack.pop();
    if (!item) return;
    if (item.discarding) {
      const entry = await item.discarding;
      if (entry) await window.gp.library.restore(entry).catch(() => {});
    }
    const cell = new PhotoCell(this, item.state);
    const index = Math.min(item.index, this.cells.length);
    this.cells.splice(index, 0, cell);
    this.gridEl.append(cell.el);
    cell.el.classList.add('appearing');
    setTimeout(() => cell.el.classList.remove('appearing'), 260);
    this.setActive(cell);
    ui.dismissToast();
    this.relayout(true);
    this.markDirty();
    this.updateTitle();
  }

  pathRenamed(oldPath, newPath) {
    for (const cell of this.cells) {
      if (samePath(cell.state.path, oldPath)) {
        cell.state.path = newPath;
        cell.siblings = [];
        cell._refreshSiblings();
      }
    }
    this.markDirty();
  }

  async replaceActive() {
    const cell = this.targetCell();
    if (!cell) return;
    const p = await window.gp.dialog.openFile('Replace image', this.lastDir());
    const [copy] = p ? await this.importToLibrary([p]) : [];
    if (copy) cell.loadPath(copy);
  }

  applyViewToOthers() {
    const src = this.targetCell();
    if (!src) return;
    for (const cell of this.cells) {
      if (cell === src) continue;
      cell.state.aspect = src.state.aspect;
      cell.state.align = src.state.align;
      cell.copyViewFrom(src);
    }
    this.relayout();
  }

  // --------------------------------------------------------------- layout
  relayout(animate = false) {
    this.animateNext = this.animateNext || animate;
    if (this.relayoutQueued) return;
    this.relayoutQueued = true;
    requestAnimationFrame(() => {
      this.relayoutQueued = false;
      const anim = this.animateNext;
      this.animateNext = false;
      this.doLayout(anim);
    });
  }

  doLayout(animate = false) {
    const width = this.gridEl.clientWidth;
    const height = this.gridEl.clientHeight;
    this.welcomeEl.hidden = this.cells.length > 0;
    document.body.classList.toggle('single', !!this.singleCell);
    for (const cell of this.cells) cell.el.hidden = !!this.singleCell && cell !== this.singleCell;
    if (this.singleCell) {
      this.singleCell.setGeometry({ x: 0, y: 0, w: width, h: height });
      return;
    }
    const g = this.playlist.grid;
    const shown = this.cells.filter((c) => this.passesFilter(c));
    for (const c of this.cells) if (!shown.includes(c)) c.el.hidden = true;
    if (g.layout === 'masonry') {
      const fixed = g.fixed && g.size > 0 ? g.size : 0;
      const { cols, rects } = computeMasonry(shown.map((c) => c.aspectRatio()), width, height,
        g.spacing, fixed, g.keep_order);
      this.layoutInfo = { rows: 0, cols };
      shown.forEach((c, i) => {
        c.el.hidden = !rects[i];
        if (rects[i]) c.setGeometry(rects[i], this.glide(c, animate));
      });
      return;
    }
    const aspects = shown.map((c) => (['fill', 'stretch'].includes(c.state.aspect) ? null : c.aspectRatio()));
    const { rows, cols, rects } = gridRects(shown.length, width, height, g, aspects);
    this.layoutInfo = { rows, cols };
    shown.forEach((c, i) => {
      c.el.hidden = !rects[i];
      if (rects[i]) c.setGeometry(rects[i], this.glide(c, animate));
    });
  }

  // ---------------------------------------------------------- navigation
  /**
   * Space: enlarge the last hovered photo and start its slideshow (with the
   * transition from Settings). While presenting, Space pauses / resumes.
   */
  presentSlideshow() {
    if (this.presenting && this.singleCell === this.presenting.cell) {
      this.presenting.cell.toggleSlideshow();
      return;
    }
    const cell = this.targetCell();
    if (!cell) return;
    if (this.singleCell && this.singleCell !== cell) {
      this.singleCell._cancelTransition();
      this.singleCell.fitView();
    }
    this.singleCell = cell;
    cell.fitView();
    this.setActive(cell);
    this.presenting = { cell, hadSlideshow: cell.state.slideshow, enteredFullscreen: false };
    if (settings.get('present_fullscreen') && !this.fullscreen) {
      this.presenting.enteredFullscreen = true;
      window.gp.win.setFullscreen(true);
    }
    this.relayout();
    cell.setSlideshow(true);
    cell.startKenBurns();
  }

  isPresenting() { return !!this.presenting; }

  stopPresenting() {
    const p = this.presenting;
    if (!p) return;
    this.presenting = null;
    p.cell.stopKenBurns();
    // a slideshow started by Space ends with the presentation
    if (!p.hadSlideshow && this.cells.includes(p.cell)) p.cell.setSlideshow(false);
    if (p.enteredFullscreen && this.fullscreen) window.gp.win.setFullscreen(false);
  }

  toggleSingle(cell = null) {
    if (this.singleCell) {
      const leaving = this.singleCell;
      leaving._cancelTransition();
      this.singleCell = null;
      this.stopPresenting();
      leaving.fitView(); // back in the grid as a whole photo
    } else {
      const target = cell || this.targetCell();
      if (!target || this.cells.length < 2) return;
      this.singleCell = target;
      this.setActive(target);
      target.fitView(); // enlarged view always starts with the full photo
    }
    this.relayout();
  }

  isSingle() { return !!this.singleCell; }

  cycleActive(step) {
    if (!this.cells.length) return;
    const cur = this.targetCell();
    const idx = (this.cells.indexOf(cur) + step + this.cells.length) % this.cells.length;
    const cell = this.cells[idx];
    this.setActive(cell);
    if (this.singleCell) {
      this.singleCell._cancelTransition();
      this.singleCell.fitView();
      const presenting = !!this.presenting;
      this.stopPresenting();
      this.singleCell = cell;
      cell.fitView();
      if (presenting) {
        // keep presenting: the slideshow moves to the newly selected photo
        this.presenting = { cell, hadSlideshow: cell.state.slideshow, enteredFullscreen: false };
        cell.setSlideshow(true);
        cell.startKenBurns();
      }
      this.relayout();
    }
    cell.flash(`${idx + 1} / ${this.cells.length}`, 0.8);
  }

  escape() {
    if (this.selection.size) this.clearSelection();
    else if (this.singleCell) this.toggleSingle();
    else if (this.fullscreen) window.gp.win.setFullscreen(false);
    else if (this.groupView) this.closeGroup();
  }

  // ----------------------------------------------------------------- grid
  setLayout(layout) {
    this.playlist.grid.layout = layout;
    this.relayout();
    this.markDirty();
  }

  isLayout(layout) { return this.playlist.grid.layout === layout; }

  toggleLayout() { this.setLayout(this.isLayout('masonry') ? 'grid' : 'masonry'); }

  setGridMode(mode) {
    this.playlist.grid.mode = mode;
    this.relayout();
    this.markDirty();
  }

  isGridMode(mode) { return this.playlist.grid.mode === mode; }

  toggleGridFlag(flag) {
    const g = this.playlist.grid;
    g[flag] = !g[flag];
    if (flag === 'fixed' && g.fixed && g.size <= 0) {
      g.size = Math.max(1, g.mode === 'rows' || g.layout === 'masonry' ? this.layoutInfo.cols : this.layoutInfo.rows);
    }
    this.relayout();
    this.markDirty();
  }

  gridFlag(flag) { return !!this.playlist.grid[flag]; }

  currentSize() {
    const g = this.playlist.grid;
    if (g.fixed && g.size) return g.size;
    return (g.mode === 'rows' || g.layout === 'masonry' ? this.layoutInfo.cols : this.layoutInfo.rows) || 1;
  }

  async askGridSize() {
    const g = this.playlist.grid;
    const label = g.mode === 'columns' && g.layout === 'grid' ? 'Rows:' : 'Columns:';
    const v = await ui.prompt({ title: 'Grid size', label, type: 'number', value: this.currentSize(), min: 1, max: 64, step: 1 });
    if (v === null) return;
    g.size = Math.round(v);
    g.fixed = true;
    this.relayout();
    this.markDirty();
  }

  changeGridSize(step) {
    const g = this.playlist.grid;
    g.size = Math.max(1, Math.min(64, this.currentSize() + step));
    g.fixed = true;
    this.relayout();
    this.markDirty();
  }

  async askGridSpacing() {
    const v = await ui.prompt({
      title: 'Gap between photos', label: 'Gap (px):', type: 'number',
      value: this.playlist.grid.spacing, min: 0, max: 40, step: 1,
    });
    if (v === null) return;
    this.playlist.grid.spacing = Math.round(v);
    this.relayout();
    this.markDirty();
  }

  shuffleGrid() {
    for (let i = this.cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cells[i], this.cells[j]] = [this.cells[j], this.cells[i]];
    }
    this.relayout(true);
    this.markDirty();
  }

  sortGrid() {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    this.cells.sort((a, b) => collator.compare(basename(a.state.path), basename(b.state.path)));
    this.relayout(true);
    this.markDirty();
  }

  togglePlFlag(flag) {
    this.playlist[flag] = !this.playlist[flag];
    document.body.classList.toggle('no-overlay', this.playlist.disable_overlay);
    document.body.classList.toggle('no-border', !this.playlist.overlay_border);
    if (flag === 'sync_view' && this.playlist.sync_view && this.activeCell) this.cellViewChanged(this.activeCell);
    this.markDirty();
  }

  plFlag(flag) { return !!this.playlist[flag]; }

  // ------------------------------------------------------------ snapshots
  snapshotSave(i) {
    if (!this.cells.length) return;
    this.playlist.snapshots[String(i)] = {
      grid: { ...this.playlist.grid },
      cells: this.cells.map((c) => ({ ...c.state })),
    };
    this.markDirty();
    this.targetCell()?.flash(`Snapshot ${i} saved`);
  }

  snapshotLoad(i) {
    const snap = this.playlist.snapshots[String(i)];
    if (!snap) return;
    this.clearCells();
    this.playlist.grid = { ...newPlaylist().grid, ...snap.grid };
    this.addStates(snap.cells.map((c) => ({ ...c })));
    this.cells[0]?.flash(`Snapshot ${i}`);
  }

  snapshotDelete(i) {
    delete this.playlist.snapshots[String(i)];
    this.markDirty();
  }

  // ------------------------------------------------------------- file I/O
  lastDir() {
    return settings.get('last_dir') || undefined;
  }

  async addFilesDialog() {
    const paths = await window.gp.dialog.openFiles(this.lastDir());
    if (paths.length) {
      settings.set('last_dir', dirname(paths[0]));
      this.addPaths(paths);
    }
  }

  async addFolderDialog() {
    const folder = await window.gp.dialog.openFolder('Add folder', this.lastDir());
    if (!folder) return;
    settings.set('last_dir', folder);
    if (!(await this.addPaths([folder]))) ui.alert('Add folder', 'No supported photos found in that folder.');
  }

  async addClipboard() {
    const clip = await window.gp.clipboard.read();
    const paths = [...clip.paths];
    if (!paths.length && clip.text) {
      for (const raw of clip.text.split(/\r?\n/)) {
        let p = raw.trim().replace(/^"|"$/g, '');
        if (p.startsWith('file:')) p = decodeURIComponent(new URL(p).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
        if (p && (await window.gp.fs.exists(p))) paths.push(p);
      }
    }
    if (paths.length) this.addPaths(paths);
    else if (clip.imageFile) this.addPaths([clip.imageFile]);
  }

  async openPlaylistDialog() {
    const p = await window.gp.dialog.openPlaylist(this.lastDir());
    if (p) this.openPlaylist(p);
  }

  /** Grid state as plain data; paths relative to baseDir when possible. */
  serialize(baseDir = '') {
    const rel = (p) => {
      const r = baseDir ? relativeTo(p, baseDir) : null;
      return r !== null ? r : p;
    };
    const data = {
      app: 'GridPhoto',
      version: 2,
      saved: new Date().toISOString(),
      grid: { ...this.playlist.grid },
      // "path" is relative to the grid file when possible; "abs" is the fallback
      cells: this.cells.map((c) => {
        const p = rel(c.state.path);
        return p !== c.state.path ? { ...c.state, path: p, abs: c.state.path } : { ...c.state };
      }),
      snapshots: this.playlist.snapshots,
      ratings: Object.fromEntries(Object.entries(this.playlist.ratings).map(([p, r]) => [rel(p), r])),
      filter: this.playlist.filter,
    };
    for (const key of PLAYLIST_FLAGS) data[key] = this.playlist[key];
    return data;
  }

  /** Replace the current grid with serialized data. */
  load(data, baseDir = '') {
    const abs = (p) => (p && baseDir && !isAbsolute(p) ? resolvePath(baseDir, p) : p);
    const pl = newPlaylist();
    Object.assign(pl.grid, data.grid || {});
    pl.snapshots = data.snapshots || {};
    pl.ratings = Object.fromEntries(Object.entries(data.ratings || {}).map(([p, r]) => [abs(p), r]));
    pl.filter = COMMANDS_BY_ID[`filter_${data.filter}`] ? data.filter : 'all';
    for (const key of PLAYLIST_FLAGS) if (key in data) pl[key] = !!data[key];
    const cells = (data.cells || []).map(({ abs: _abs, ...c }) => ({ ...c, path: abs(c.path) }));
    if (pl.shuffle_on_load) cells.sort(() => Math.random() - 0.5);
    this.clearCells();
    this.playlist = pl;
    document.body.classList.toggle('no-overlay', pl.disable_overlay);
    document.body.classList.toggle('no-border', !pl.overlay_border);
    this.addStates(cells);
    this.updateToolbar();
  }

  async openPlaylist(path) {
    if (!(await this.maybeSave())) return;
    this.groupView = null;
    this.groupReturn = null;
    let data;
    try {
      data = JSON.parse(await window.gp.fs.readText(path));
    } catch (err) {
      ui.alert('Open grid', `Could not open "${basename(path)}":\n${err.message || err}`);
      return;
    }
    if (!data || !Array.isArray(data.cells)) {
      ui.alert('Open grid', `"${basename(path)}" is not a GridPhoto grid file.`);
      return;
    }
    // resolve every photo: path relative to the grid file first, then the absolute fallback
    const base = dirname(path);
    const moved = {};
    const missing = [];
    data.cells = await Promise.all(data.cells.map(async (c) => {
      const candidates = [c.path && !isAbsolute(c.path) ? resolvePath(base, c.path) : c.path, c.abs].filter(Boolean);
      for (const cand of candidates) {
        if (await window.gp.fs.exists(cand)) {
          if (c.path) moved[c.path] = cand;
          return { ...c, path: cand, abs: undefined };
        }
      }
      missing.push(candidates[0]);
      return { ...c, path: candidates[0], abs: undefined };
    }));
    data.ratings = Object.fromEntries(Object.entries(data.ratings || {}).map(([p, r]) => [
      moved[p] || (isAbsolute(p) ? p : resolvePath(base, p)), r]));
    await this.bringIntoLibrary(data, missing);
    if (data.cells.length && missing.length === data.cells.length) {
      ui.alert('Open grid', `None of the ${missing.length} photos in "${basename(path)}" could be found.\n\n`
        + 'They may have been moved, renamed or deleted.');
      return;
    }
    this.load(data, '');
    this.playlistPath = path;
    settings.addRecent('recent_playlists', path);
    this.markDirty(false);
    this.updateTitle();
    const shown = data.cells.length - missing.length;
    if (missing.length) {
      ui.toast(`${missing.length} of ${data.cells.length} photos could not be found`, 'Remove them', () => {
        for (const cell of [...this.cells]) if (missing.includes(cell.state.path)) this.closeCell(cell, { animate: true });
      }, 10);
    } else {
      ui.toast(`Opened "${basename(path)}" \u00b7 ${shown} photo${shown === 1 ? '' : 's'}`);
    }
  }

  saveSession() {
    if (!settings.get('restore_session')) return;
    if (this.groupView && this.groupReturn) {
      const r = this.groupReturn;
      settings.set('session', { ...r.data, ratings: this.mergedRatings(), playlistPath: r.playlistPath, dirty: r.dirty });
      return;
    }
    settings.set('session', this.cells.length
      ? { ...this.serialize(''), playlistPath: this.playlistPath, dirty: this.dirty } : null);
  }

  // ------------------------------------------------------------ people
  findPeople() { this.people.start(); }

  newFolder() { this.people.newFolder(); }

  importFolders() { this.people.importFolders(); }

  rescanPeople() { this.people.run(); }

  togglePeoplePanel() { this.people.togglePanel(); }

  isPeoplePanel() { return this.people.isPanelOpen(); }

  /** Ratings of the saved grid updated with changes made in the person view. */
  mergedRatings() {
    const ratings = { ...(this.groupReturn?.data.ratings || {}) };
    for (const c of this.cells) {
      const r = this.playlist.ratings[c.state.path];
      if (r) ratings[c.state.path] = r;
      else delete ratings[c.state.path];
    }
    return ratings;
  }

  /** Show only the photos of one person (group); the grid is restored by closeGroup. */
  openGroup(group) {
    if (!group.paths.length) return;
    if (!this.groupReturn) {
      this.groupReturn = { data: this.serialize(''), playlistPath: this.playlistPath, dirty: this.dirty };
    } else {
      this.groupReturn.data.ratings = this.mergedRatings();
    }
    const base = this.serialize('');
    this.load({
      ...base,
      cells: group.paths.map((p) => newCellState(p)),
      snapshots: {},
      filter: 'all',
      ratings: this.groupReturn.data.ratings,
    });
    this.groupView = { id: group.id, name: group.name };
    this.playlistPath = null;
    this.dirty = false;
    this.updateTitle();
  }

  closeGroup() {
    const r = this.groupReturn;
    if (!r) return;
    const data = { ...r.data, ratings: this.mergedRatings() };
    this.groupReturn = null;
    this.groupView = null;
    this.load(data);
    this.playlistPath = r.playlistPath;
    this.dirty = false;
    this.markDirty(r.dirty);
    this.updateTitle();
    this.people.render();
  }

  async restoreSession() {
    const s = settings.get('session');
    if (!settings.get('restore_session') || !s?.cells?.length) return false;
    const existing = [];
    for (const c of s.cells) if (c.path && (await window.gp.fs.exists(c.path))) existing.push(c);
    if (!existing.length) return false;
    const data = { ...s, cells: existing };
    await this.bringIntoLibrary(data, []);
    this.load(data);
    this.playlistPath = s.playlistPath || null;
    this.markDirty(!!s.dirty);
    this.updateTitle();
    ui.toast(`Reopened your last ${existing.length} photo${existing.length === 1 ? '' : 's'}`, 'Start fresh', async () => {
      await this.closePlaylist();
    }, 6);
    return true;
  }

  async writePlaylist(path) {
    const data = this.serialize(dirname(path));
    try {
      await window.gp.fs.writeText(path, JSON.stringify(data, null, 2));
    } catch (err) {
      ui.alert('Save grid', `Could not save grid:\n${err.message || err}`);
      return false;
    }
    this.playlistPath = path;
    settings.addRecent('recent_playlists', path);
    this.markDirty(false);
    this.updateTitle();
    ui.toast(`Grid saved \u00b7 ${basename(path)}`, 'Show', () => window.gp.shell.showInFolder(path));
    return true;
  }

  savePlaylist() {
    if (!this.cells.length) {
      ui.toast('Add some photos first, then save the grid');
      return false;
    }
    return this.playlistPath ? this.writePlaylist(this.playlistPath) : this.savePlaylistAs();
  }

  async savePlaylistAs() {
    let p = await window.gp.dialog.save({
      title: 'Save grid',
      defaultPath: this.playlistPath || joinPath(this.lastDir() || '', `grid${PLAYLIST_EXT}`),
      filters: [{ name: 'GridPhoto grid (JSON)', extensions: ['gphl'] }, { name: 'JSON file', extensions: ['json'] }],
    });
    if (!p) return false;
    if (!isGridFile(p)) p += PLAYLIST_EXT;
    return this.writePlaylist(p);
  }

  async maybeSave() {
    if (!(this.dirty && this.playlistPath && this.cells.length)) return true;
    const answer = await window.gp.dialog.message({
      type: 'question', title: 'Unsaved changes',
      message: `Save changes to "${basename(this.playlistPath)}"?`,
      buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
    });
    if (answer === 2) return false;
    if (answer === 0) return this.savePlaylist();
    return true;
  }

  clearCells() {
    this.selection = new Set();
    this.updateSelectionBar();
    for (const cell of this.cells) cell.destroy();
    this.cells = [];
    this.activeCell = null;
    this.singleCell = null;
    this.presenting = null;
  }

  async closePlaylist() {
    if (!(await this.maybeSave())) return;
    this.groupView = null;
    this.groupReturn = null;
    this.clearCells();
    this.playlist = newPlaylist();
    this.playlistPath = null;
    this.relayout();
    this.markDirty(false);
    this.updateTitle();
  }

  // -------------------------------------------------------------- saving
  saveDir(fallback = '') {
    return settings.get('save_as_dir') || fallback || this.screenshotDir();
  }

  rememberSaveDir(folder) {
    if (folder) settings.set('save_as_dir', folder);
  }

  screenshotDir() {
    return settings.get('screenshot_dir') || this.picturesDir || '';
  }

  saveAllAs() {
    const cells = this.visibleCells().filter((c) => c.state.path);
    if (!cells.length) return undefined;
    return this.copyFilesTo(cells.map((cell) => ({ src: cell.state.path, cell })),
      `Save ${cells.length} photo(s) to folder`);
  }

  /** Copy files (or edited renders for cells with edits) into a chosen folder. */
  async copyFilesTo(items, title) {
    const first = items[0]?.src;
    const folder = await window.gp.dialog.openFolder(title, this.saveDir(first ? dirname(first) : ''));
    if (!folder) return;
    this.rememberSaveDir(folder);
    let saved = 0;
    let overwrite = null;
    const failed = [];
    for (const { src, cell } of items) {
      if (!src) continue;
      let dest = joinPath(folder, basename(src));
      if (samePath(dest, src)) continue;
      if (await window.gp.fs.exists(dest)) {
        if (overwrite === null) {
          const answer = await window.gp.dialog.message({
            type: 'question', title: 'Files exist',
            message: 'Some files already exist in that folder. Overwrite them?',
            detail: '"Keep both" adds a number to the new file names.',
            buttons: ['Overwrite', 'Keep both', 'Cancel'], defaultId: 1, cancelId: 2,
          });
          if (answer === 2) break;
          overwrite = answer === 0;
        }
        if (!overwrite) dest = await window.gp.fs.uniquePath(dest);
      }
      try {
        if (cell && cell.hasEdits()) {
          const canvas = await cell.renderFull();
          if (!canvas) throw new Error('not loaded');
          await window.gp.fs.writeBuffer(dest, await cell._encode(canvas, extname(dest)));
        } else {
          await window.gp.fs.copy(src, dest);
        }
        saved++;
      } catch {
        failed.push(basename(src));
      }
    }
    if (failed.length) {
      ui.alert('Saved with errors', `Saved ${saved} photo(s) to\n${folder}\n\nFailed: ${failed.slice(0, 10).join(', ')}`);
    } else {
      ui.toast(`Saved ${saved} photo(s)`, 'Show folder', () => window.gp.shell.openPath(folder));
    }
  }

  async exportGrid() {
    if (!this.cells.length) return;
    document.body.classList.add('exporting');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = this.gridEl.getBoundingClientRect();
    const png = await window.gp.win.capture({
      x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    });
    document.body.classList.remove('exporting');
    const dest = await window.gp.dialog.save({
      title: 'Save grid screenshot',
      defaultPath: joinPath(this.screenshotDir(), `grid_${timestamp()}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (dest) await window.gp.fs.writeBuffer(dest, png);
  }

  // ------------------------------------------------------- window / misc
  async toggleFullscreen() {
    this.fullscreen = await window.gp.win.toggleFullscreen();
  }

  isFullscreen() { return this.fullscreen; }

  toggleOnTop() {
    this.onTop = !this.onTop;
    window.gp.win.setOnTop(this.onTop);
  }

  isOnTop() { return this.onTop; }

  async openSettings() {
    const oldSpacing = settings.get('def_grid_spacing');
    const saved = await ui.settingsDialog();
    if (!saved) return;
    this.applyAppearance();
    this.buildKeyIndex();
    window.gp.win.setOnTop(settings.get('stay_on_top'));
    this.onTop = settings.get('stay_on_top');
    if (settings.get('def_grid_spacing') !== oldSpacing) this.playlist.grid.spacing = settings.get('def_grid_spacing');
    for (const cell of this.cells) {
      cell.paint();
      cell._refreshSiblings();
    }
    this.relayout();
  }

  showShortcuts() { ui.shortcutsDialog((id) => this.shortcutsFor(id)); }

  async showAbout() { ui.about(await window.gp.app.info()); }

  devtools() { window.gp.win.devtools(); }

  quit() { window.close(); }

  // ---------------------------------------------------------- cell drag
  startCellDrag(cell, e) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    const thumb = document.createElement('canvas');
    const k = Math.min(1, 180 / Math.max(cell.w, cell.h));
    thumb.width = Math.max(1, cell.w * k);
    thumb.height = Math.max(1, cell.h * k);
    thumb.getContext('2d').drawImage(cell.canvas, 0, 0, thumb.width, thumb.height);
    ghost.append(thumb);
    document.body.append(ghost);
    cell.el.classList.add('dragging');
    const moveGhost = (ev) => {
      ghost.style.transform = `translate(${ev.clientX - thumb.width / 2}px, ${ev.clientY - thumb.height / 2}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      for (const r of document.querySelectorAll('.pp-row.drop')) r.classList.remove('drop');
      hit?.closest('.pp-row[data-folder-id]')?.classList.add('drop');
      const over = hit?.closest('.cell');
      for (const c of this.cells) c.el.classList.toggle('drop-over', c.el === over && c !== cell);
    };
    moveGhost(e);
    const finish = (ev) => {
      window.removeEventListener('pointermove', moveGhost);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      ghost.remove();
      cell.el.classList.remove('dragging');
      for (const c of this.cells) c.el.classList.remove('drop-over');
      this.drag = null;
      for (const r of document.querySelectorAll('.pp-row.drop')) r.classList.remove('drop');
      if (ev.type !== 'pointerup') return;
      const folderRow = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pp-row[data-folder-id]');
      if (folderRow) {
        this.people.addToFolder(folderRow.dataset.folderId, [cell.state.path]);
        return;
      }
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cell');
      const target = this.cells.find((c) => c.el === overEl);
      if (target && target !== cell) this.swapCells(cell, target);
    };
    this.drag = { cell };
    window.addEventListener('pointermove', moveGhost);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  // --------------------------------------------------------- mouse hide
  onMouseActivity() {
    this.showCursor();
    clearTimeout(this.mouseTimer);
    if (settings.get('mouse_hide') && this.cells.length) {
      this.mouseTimer = setTimeout(() => {
        // never while browsing the grid: only in the enlarged view or fullscreen
        if (!this.singleCell && !this.fullscreen) return;
        if (!ui.isModalOpen() && !this.drag) document.body.classList.add('hide-cursor');
      }, settings.get('mouse_hide_timeout') * 1000);
    }
  }

  showCursor() {
    document.body.classList.remove('hide-cursor');
  }

  receivePaths(paths) {
    if (!paths?.length) return;
    const playlists = paths.filter(isGridFile);
    const others = paths.filter((p) => !isGridFile(p));
    (async () => {
      if (playlists.length) await this.openPlaylist(playlists[0]);
      if (others.length) await this.addPaths(others);
      window.gp.win.focus();
    })();
  }
}

async function main() {
  await settings.loadSettings();
  const app = new App();
  window.gridphoto = app; // handy for debugging / tests
  app.picturesDir = (await window.gp.path.info()).pictures;
  app.libraryDir = await window.gp.library.dir();
  app.glassSupported = (await window.gp.app.info()).glassSupported;
  app.applyAppearance();
  document.body.classList.toggle('no-overlay', app.playlist.disable_overlay);
  document.body.classList.toggle('no-border', !app.playlist.overlay_border);
  // photos closed in an earlier run that were not purged (e.g. after a crash)
  const purged = await window.gp.library.purge();
  if (purged.length) await app.people.forgetPaths(purged);
  const initial = await window.gp.app.initialPaths();
  if (initial.length) app.receivePaths(initial);
  else await app.restoreSession();
}

main();
