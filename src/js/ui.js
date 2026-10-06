// HTML modal dialogs: prompt, alert, info table, settings, shortcuts.

import { COMMANDS, defaultShortcuts } from './commands.js';
import { comboFromEvent, displayCombo, normalizeCombo } from './keys.js';
import * as settings from './settings.js';
import { TRANSITIONS } from './transitions.js';

let openCount = 0;
export const isModalOpen = () => openCount > 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

/** Generic modal. build(body, close) fills the body; returns a promise of close(value). */
function modal(title, build, { width = 420, buttons = [] } = {}) {
  return new Promise((resolve) => {
    openCount++;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal', role: 'dialog' });
    box.style.width = `min(${width}px, calc(100vw - 32px))`;
    const body = el('div', { class: 'modal-body' });
    const footer = el('div', { class: 'modal-footer' });
    box.append(el('div', { class: 'modal-title', text: title }), body, footer);
    backdrop.append(box);
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      openCount--;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const ctx = { close, onEnter: null };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && ctx.onEnter && !(e.target instanceof HTMLTextAreaElement)
        && !e.target.closest('.keycapture')) {
        e.preventDefault();
        ctx.onEnter();
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(null);
    });
    build(body, ctx);
    for (const b of buttons) {
      const btn = el('button', { class: b.primary ? 'primary' : '', text: b.label, onclick: () => b.action(ctx) });
      footer.append(btn);
    }
    if (!buttons.length) footer.remove();
    document.body.append(backdrop);
    const focusable = box.querySelector('input, select, button.primary, button');
    if (focusable) focusable.focus();
  });
}

export function prompt({ title, label, value = '', type = 'text', min, max, step, selectStem = false }) {
  let input;
  return modal(title, (body, ctx) => {
    input = el('input', { type, value: String(value), min, max, step, spellcheck: 'false' });
    body.append(el('label', { class: 'field' }, el('span', { text: label }), input));
    ctx.onEnter = () => submit(ctx);
    setTimeout(() => {
      input.focus();
      if (selectStem && type === 'text') {
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      } else {
        input.select();
      }
    }, 0);
  }, {
    buttons: [
      { label: 'Cancel', action: (ctx) => ctx.close(null) },
      { label: 'OK', primary: true, action: (ctx) => submit(ctx) },
    ],
  });
  function submit(ctx) {
    if (type === 'number') {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      ctx.close(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
    } else {
      ctx.close(input.value.trim());
    }
  }
}

export function alert(title, message) {
  return modal(title, (body, ctx) => {
    body.append(el('p', { class: 'message', text: message }));
    ctx.onEnter = () => ctx.close(true);
  }, { buttons: [{ label: 'OK', primary: true, action: (ctx) => ctx.close(true) }] });
}

export function infoTable(title, info) {
  return modal(title, (body) => {
    const table = el('table', { class: 'info-table' });
    for (const [k, v] of Object.entries(info)) {
      table.append(el('tr', {}, el('th', { text: k }), el('td', { text: String(v) })));
    }
    body.append(el('div', { class: 'scroll' }, table));
  }, { width: 620, buttons: [{ label: 'Close', primary: true, action: (ctx) => ctx.close(true) }] });
}

export function about(info) {
  return modal('About GridPhoto', (body) => {
    body.append(
      el('h2', { text: `GridPhoto ${info.version}` }),
      el('p', { text: 'View many photos at the same time in one window.' }),
      el('p', { text: 'Inspired by GridPlayer (github.com/vzhd1701/gridplayer).' }),
      el('p', { class: 'muted', text: `Electron ${info.electron} · Chromium ${info.chrome}` }),
      el('p', { class: 'muted', text: `Formats: ${info.extensions.map((e) => e.slice(1)).join(', ')}` }),
    );
  }, { buttons: [{ label: 'OK', primary: true, action: (ctx) => ctx.close(true) }] });
}

// ------------------------------------------------------------ shortcuts
const EXTRA_MOUSE = [
  ['Zoom at cursor', 'Mouse wheel'],
  ['Browse files', 'Ctrl + mouse wheel'],
  ['Zoom / browse all photos', 'Shift + mouse wheel'],
  ['Pan zoomed photo', 'Left drag (or middle drag)'],
  ['Swap two cells', 'Drag a cell onto another (Alt+drag when zoomed)'],
  ['Single mode', 'Double click'],
  ['Replace a cell\'s photo', 'Ctrl + drop file onto the cell'],
];

export function shortcutsDialog(shortcutsFor) {
  return modal('Keyboard shortcuts', (body) => {
    const filter = el('input', { type: 'search', placeholder: 'Filter...' });
    const table = el('table', { class: 'info-table' });
    const rows = [];
    for (const cmd of COMMANDS) {
      const seqs = shortcutsFor(cmd.id);
      if (!seqs.length) continue;
      rows.push(el('tr', {}, el('th', { text: cmd.title }), el('td', { text: seqs.map(displayCombo).join(', ') })));
    }
    for (const [t, k] of EXTRA_MOUSE) rows.push(el('tr', {}, el('th', { text: t }), el('td', { text: k })));
    table.append(...rows);
    filter.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      for (const r of rows) r.hidden = q && !r.textContent.toLowerCase().includes(q);
    });
    body.append(filter, el('div', { class: 'scroll' }, table));
  }, { width: 640, buttons: [{ label: 'Close', primary: true, action: (ctx) => ctx.close(true) }] });
}

// ------------------------------------------------------------- settings
const PAGES = [
  ['General', [
    ['color_scheme', 'Color scheme', 'select', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]],
    ['start_maximized', 'Start maximized', 'check'],
    ['start_fullscreen', 'Start fullscreen', 'check'],
    ['stay_on_top', 'Stay on top', 'check'],
    ['restore_session', 'Reopen the last photos when starting', 'check'],
    ['show_toolbar', 'Show the auto-hiding toolbar', 'check'],
    ['one_instance', 'Open files in the running window (one instance, applies after restart)', 'check'],
    ['recent_list_enabled', 'Remember recent files and grids', 'check'],
    ['recent_list_max_size', 'Recent list size', 'number', { min: 1, max: 100 }],
    ['bg_mode', 'Background style', 'select', [['solid', 'Solid color'], ['acrylic', 'Acrylic glass (Windows 11)'], ['mica', 'Mica (Windows 11)']]],
    ['background_color', 'Background / tint color', 'color'],
    ['bg_tint', 'Glass tint strength (%)', 'number', { min: 0, max: 100 }],
    ['corner_radius', 'Rounded corner radius (px)', 'number', { min: 0, max: 60 }],
  ]],
  ['Mouse & Display', [
    ['wheel_action', 'Mouse wheel', 'select', [['zoom', 'Zoom (Ctrl+wheel browses files)'], ['browse', 'Browse files (Ctrl+wheel zooms)']]],
    ['pan_trigger', 'Pan (move zoomed photo)', 'select', [
      ['left', 'Left drag when zoomed (Alt+drag swaps cells)'], ['middle', 'Middle button'],
      ['ctrl', 'Ctrl + left drag'], ['shift', 'Shift + left drag'], ['alt', 'Alt + left drag'],
      ['disabled', 'Disabled']]],
    ['drag_swap', 'Drag cells to swap them', 'check'],
    ['mouse_hide', 'Hide mouse cursor when idle', 'check'],
    ['mouse_hide_timeout', 'Hide cursor after (s)', 'number', { min: 1, max: 60 }],
    ['overlay_timeout', 'Hide overlay after (s)', 'number', { min: 1, max: 60 }],
    ['smooth_scaling', 'Smooth (high quality) scaling', 'check'],
    ['dim_rejected', 'Dim photos flagged as Reject', 'check'],
    ['zoom_step', 'Zoom step (factor)', 'number', { min: 1.05, max: 3, step: 0.05 }],
    ['move_step', 'Move step (fraction of cell)', 'number', { min: 0.01, max: 0.5, step: 0.01 }],
    ['crop_step', 'Crop step (fraction of side)', 'number', { min: 0.005, max: 0.2, step: 0.005 }],
    ['preview_max_size', 'Initial decode size (px, long edge)', 'number', { min: 512, max: 16384, step: 256 }],
  ]],
  ['Slideshow', [
    ['def_slideshow_interval', 'Default interval (s)', 'number', { min: 0.2, max: 3600, step: 0.5 }],
    ['def_slideshow_order', 'Default order', 'select', [['next', 'Next file'], ['previous', 'Previous file'], ['shuffle', 'Random file']]],
    ['transition_type', 'Transition', 'select', TRANSITIONS],
    ['transition_duration', 'Transition duration (ms)', 'number', { min: 100, max: 4000, step: 50 }],
    ['transition_easing', 'Transition easing', 'select', [
      ['smooth', 'Smooth'], ['ease_out', 'Ease out (fast start)'], ['ease_in_out', 'Ease in-out'], ['linear', 'Linear']]],
    ['present_fullscreen', 'Space slideshow goes fullscreen', 'check'],
    ['ken_burns', 'Ken Burns effect (slow pan & zoom) during the Space slideshow', 'check'],
    ['transition_scope', 'In the enlarged view, use transitions for', 'select', [
      ['slideshow', 'Slideshow only'], ['all', 'Every photo change (also manual browsing)']]],
  ]],
  ['People', [
    ['face_strictness', 'Face matching', 'select', [
      ['strict', 'Strict (fewer mix-ups, may split a person)'], ['balanced', 'Balanced (recommended)'],
      ['loose', 'Loose (merges more, may mix similar faces)']]],
    ['face_min_size', 'Ignore faces smaller than (px)', 'number', { min: 20, max: 200, step: 4 }],
  ]],
  ['Files', [
    ['sort_mode', 'Folder sort order', 'select', [['name', 'Name (natural)'], ['date', 'Date modified'], ['size', 'File size']]],
    ['include_subfolders', 'Include subfolders when adding a folder', 'check'],
    ['__library', 'Photo library (copies of your photos)', 'library'],
    ['screenshot_dir', 'Screenshot / export folder', 'folder'],
    ['screenshot_format', 'Default export format', 'select', [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']]],
    ['screenshot_jpg_quality', 'JPG / WebP quality', 'number', { min: 1, max: 100 }],
  ]],
  ['Defaults: Grid', [
    ['def_grid_layout', 'Layout', 'select', [['masonry', 'Waterfall (masonry) - uncropped, all fit'], ['grid', 'Grid - equal cells']]],
    ['def_grid_mode', 'Fill order (grid layout)', 'select', [['rows', 'Rows first'], ['columns', 'Columns first']]],
    ['def_grid_fit_cells', 'Fit cells (maximize photo area)', 'check'],
    ['def_grid_spacing', 'Gap between photos (px)', 'number', { min: 0, max: 40 }],
    ['def_overlay_border', 'Show overlay border', 'check'],
    ['def_overlay_hide', 'Hide overlay after timeout', 'check'],
    ['def_disable_overlay', 'Disable overlay', 'check'],
  ]],
  ['Defaults: Photo', [
    ['def_aspect', 'Aspect', 'select', [['fit', 'Fit'], ['fill', 'Fill (crop to cell)'], ['stretch', 'Stretch'], ['none', 'Original size (1:1)']]],
  ]],
];

function fieldWidget(key, kind, extra, value) {
  if (kind === 'check') return el('input', { type: 'checkbox', checked: !!value });
  if (kind === 'select') {
    const s = el('select');
    for (const [v, t] of extra) s.append(el('option', { value: v, text: t, selected: v === value }));
    return s;
  }
  if (kind === 'number') return el('input', { type: 'number', value: String(value), ...extra });
  if (kind === 'color') return el('input', { type: 'color', value });
  if (kind === 'library') {
    const input = el('input', { type: 'text', readonly: true, value: '' });
    window.gp.library.dir().then((d) => { input.value = d; });
    const wrap = el('div', { class: 'row' }, input, el('button', { text: 'Open', onclick: () => window.gp.library.reveal() }));
    wrap.getValue = () => null;
    return wrap;
  }
  if (kind === 'folder') {
    const input = el('input', { type: 'text', value: value || '', placeholder: 'Pictures folder' });
    const btn = el('button', {
      text: 'Browse...',
      onclick: async () => {
        const d = await window.gp.dialog.openFolder('Choose folder', input.value || undefined);
        if (d) input.value = d;
      },
    });
    const wrap = el('div', { class: 'row' }, input, btn);
    wrap.getValue = () => input.value;
    return wrap;
  }
  return el('input', { type: 'text', value });
}

function widgetValue(w, kind, extra) {
  if (kind === 'check') return w.checked;
  if (kind === 'number') {
    const v = Number(w.value);
    return Math.min(extra.max ?? Infinity, Math.max(extra.min ?? -Infinity, Number.isFinite(v) ? v : extra.min));
  }
  if (kind === 'folder') return w.getValue();
  return w.value;
}

class KeymapEditor {
  constructor(keymap) {
    this.keymap = { ...keymap };
    this.rows = {};
    this.selected = null;
    this.node = el('div', { class: 'keymap' });
    this.filter = el('input', { type: 'search', placeholder: 'Filter by name or shortcut...' });
    this.list = el('div', { class: 'keymap-list' });
    this.capture = el('div', { class: 'keycapture', tabindex: '0', text: 'Select a command, click here and press keys' });
    this.status = el('div', { class: 'muted small' });
    const buttons = el('div', { class: 'row' },
      el('button', { text: 'Assign', onclick: () => this.assign(false) }),
      el('button', { text: 'Add', onclick: () => this.assign(true) }),
      el('button', { text: 'Clear', onclick: () => this.clear() }),
      el('button', { text: 'Default', onclick: () => this.restore() }),
      el('button', { text: 'Reset all', onclick: () => this.resetAll() }));
    this.node.append(this.filter, this.list, this.capture, buttons, this.status);
    this.pending = null;

    for (const cmd of COMMANDS) {
      const keys = el('span', { class: 'keys' });
      const row = el('div', { class: 'keymap-row', onclick: () => this.select(cmd.id) },
        el('span', { text: cmd.title }), keys);
      row.keysEl = keys;
      row.title = cmd.title;
      this.rows[cmd.id] = row;
      this.list.append(row);
      this.refresh(cmd.id);
    }
    this.filter.addEventListener('input', () => {
      const q = this.filter.value.toLowerCase();
      for (const row of Object.values(this.rows)) row.hidden = q && !row.textContent.toLowerCase().includes(q);
    });
    this.capture.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.capture.blur();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      this.pending = combo;
      this.capture.textContent = displayCombo(combo);
    });
  }

  shortcuts(id) {
    return id in this.keymap ? this.keymap[id] : defaultShortcuts(id);
  }

  refresh(id) {
    this.rows[id].keysEl.textContent = this.shortcuts(id).map(displayCombo).join(', ');
  }

  select(id) {
    if (this.selected) this.rows[this.selected].classList.remove('selected');
    this.selected = id;
    this.rows[id].classList.add('selected');
    this.pending = null;
    this.capture.textContent = 'Click here and press the new shortcut';
    this.status.textContent = '';
  }

  removeConflicts(id, combo) {
    for (const other of Object.keys(this.rows)) {
      if (other === id) continue;
      const list = this.shortcuts(other);
      if (list.some((s) => normalizeCombo(s) === combo)) {
        this.keymap[other] = list.filter((s) => normalizeCombo(s) !== combo);
        this.refresh(other);
        this.status.textContent = `Removed ${displayCombo(combo)} from "${this.rows[other].title}"`;
      }
    }
  }

  assign(append) {
    if (!this.selected || !this.pending) return;
    const combo = this.pending;
    this.removeConflicts(this.selected, combo);
    const current = this.shortcuts(this.selected).map(normalizeCombo);
    this.keymap[this.selected] = append ? [...new Set([...current, combo])] : [combo];
    this.refresh(this.selected);
  }

  clear() {
    if (!this.selected) return;
    this.keymap[this.selected] = [];
    this.refresh(this.selected);
  }

  restore() {
    if (!this.selected) return;
    delete this.keymap[this.selected];
    this.refresh(this.selected);
  }

  resetAll() {
    this.keymap = {};
    for (const id of Object.keys(this.rows)) this.refresh(id);
  }

  result() {
    const out = {};
    for (const [id, list] of Object.entries(this.keymap)) {
      if (JSON.stringify(list) !== JSON.stringify(defaultShortcuts(id))) out[id] = list;
    }
    return out;
  }
}

/** Returns true if settings were saved. */
export function settingsDialog() {
  const widgets = {};
  let keymapEditor;
  return modal('Settings', (body, ctx) => {
    const nav = el('div', { class: 'settings-nav' });
    const pages = el('div', { class: 'settings-pages' });
    const show = (i) => {
      [...nav.children].forEach((b, j) => b.classList.toggle('selected', i === j));
      [...pages.children].forEach((p, j) => { p.hidden = i !== j; });
    };
    PAGES.forEach(([title, fields], i) => {
      nav.append(el('button', { text: title, onclick: () => show(i) }));
      const page = el('div', { class: 'settings-page' });
      for (const [key, label, kind, extra] of fields) {
        const w = fieldWidget(key, kind, extra, settings.get(key));
        widgets[key] = { w, kind, extra: extra || {} };
        page.append(kind === 'check'
          ? el('label', { class: 'check-field' }, w, el('span', { text: label }))
          : el('label', { class: 'field' }, el('span', { text: label }), w));
      }
      pages.append(page);
    });
    keymapEditor = new KeymapEditor(settings.get('keymap'));
    nav.append(el('button', { text: 'Shortcuts', onclick: () => show(PAGES.length) }));
    pages.append(el('div', { class: 'settings-page' }, keymapEditor.node));
    body.append(el('div', { class: 'settings' }, nav, pages));
    show(0);
    ctx.onEnter = () => save(ctx);
  }, {
    width: 820,
    buttons: [
      {
        label: 'Restore defaults',
        action: async (ctx) => {
          await settings.resetKeys(Object.keys(widgets));
          ctx.close(true);
        },
      },
      { label: 'Cancel', action: (ctx) => ctx.close(false) },
      { label: 'OK', primary: true, action: (ctx) => save(ctx) },
    ],
  });
  function save(ctx) {
    for (const [key, { w, kind, extra }] of Object.entries(widgets)) {
      if (kind === 'library') continue;
      settings.set(key, widgetValue(w, kind, extra));
    }
    settings.set('keymap', keymapEditor.result());
    ctx.close(true);
  }
}

// ---------------------------------------------------------------- toast
let toastEl = null;
let toastTimer = null;

export function dismissToast() {
  clearTimeout(toastTimer);
  if (toastEl) {
    const node = toastEl;
    toastEl = null;
    node.classList.remove('visible');
    setTimeout(() => node.remove(), 200);
  }
}

/** Small notification at the bottom with an optional action button. */
export function toast(message, actionLabel = null, action = null, seconds = 6, hint = null) {
  dismissToast();
  const node = el('div', { class: 'toast', role: 'status' }, el('span', { text: message }));
  if (actionLabel) {
    node.append(el('button', {
      text: actionLabel,
      onclick: () => {
        dismissToast();
        action();
      },
    }));
    if (hint) node.append(el('span', { class: 'toast-hint', text: hint }));
  }
  document.body.append(node);
  toastEl = node;
  requestAnimationFrame(() => node.classList.add('visible'));
  toastTimer = setTimeout(dismissToast, seconds * 1000);
}

// ------------------------------------------------------ background panel
let bgPanel = null;

/** Non-modal panel to customise the background live. */
export function backgroundPanel(app, presets) {
  if (bgPanel) {
    bgPanel.close();
    return;
  }
  const glassOk = app.glassSupported !== false;
  const panel = el('div', { class: 'bg-panel', role: 'dialog', 'aria-label': 'Background' });
  const header = el('div', { class: 'bg-header' },
    el('span', { text: 'Background' }),
    el('button', { class: 'icon-btn', title: 'Close (Esc)', text: '✕', onclick: () => close() }));

  // style: segmented control
  const styles = [['solid', 'Solid'], ['acrylic', 'Acrylic glass'], ['mica', 'Mica']];
  const seg = el('div', { class: 'segmented' });
  const segButtons = {};
  for (const [mode, label] of styles) {
    const hint = mode === 'solid' ? 'A plain color behind the photos'
      : mode === 'acrylic' ? 'Blurred desktop shows through' : 'Subtle wallpaper-tinted glass';
    const b = el('button', {
      text: label,
      disabled: mode !== 'solid' && !glassOk,
      title: mode === 'solid' || glassOk ? hint : 'Requires Windows 11',
      onclick: () => {
        app.setBackground({ bg_mode: mode });
        refresh();
      },
    });
    segButtons[mode] = b;
    seg.append(b);
  }

  // color: preset swatches + custom picker + hex
  const swatches = el('div', { class: 'swatches' });
  const swatchButtons = [];
  for (const p of Object.values(presets)) {
    if (p.mode !== 'solid') continue;
    const b = el('button', {
      class: 'swatch', title: p.label, 'aria-label': p.label,
      onclick: () => {
        app.setBackground({ background_color: p.color });
        refresh();
      },
    });
    b.style.background = p.color;
    b.dataset.color = p.color;
    swatchButtons.push(b);
    swatches.append(b);
  }
  const picker = el('input', { type: 'color', title: 'Custom color' });
  picker.addEventListener('input', () => {
    app.setBackground({ background_color: picker.value });
    refresh(false);
  });
  const customWrap = el('label', { class: 'swatch custom', title: 'Custom color...' }, picker);
  swatches.append(customWrap);
  const hex = el('input', { type: 'text', class: 'hex', maxlength: '7', spellcheck: 'false' });
  hex.addEventListener('change', () => {
    let v = hex.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (/^#[\da-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    if (/^#[\da-f]{6}$/i.test(v)) app.setBackground({ background_color: v.toLowerCase() });
    refresh();
  });

  const slider = (min, max, value, onInput, unit) => {
    const input = el('input', { type: 'range', min, max, value: String(value) });
    const out = el('span', { class: 'slider-value', text: `${value}${unit}` });
    input.addEventListener('input', () => {
      out.textContent = `${input.value}${unit}`;
      onInput(Number(input.value));
    });
    const wrap = el('div', { class: 'slider' }, input, out);
    wrap.set = (v) => {
      input.value = String(v);
      out.textContent = `${v}${unit}`;
    };
    return wrap;
  };
  const tint = slider(0, 100, settings.get('bg_tint'), (v) => app.setBackground({ bg_tint: v }), '%');
  const setGap = (v) => {
    app.playlist.grid.spacing = v;
    settings.set('def_grid_spacing', v);
    app.relayout();
    app.markDirty();
  };
  const gap = slider(0, 24, app.playlist.grid.spacing, setGap, ' px');
  const radius = slider(0, 30, settings.get('corner_radius'),
    (v) => app.setBackground({ corner_radius: v }), ' px');
  const opacity = slider(30, 100, settings.get('window_opacity'),
    (v) => app.setBackground({ window_opacity: v }), '%');

  const colorLabel = el('div', { class: 'bg-label' });
  const tintRow = el('div', {}, el('div', { class: 'bg-label', text: 'Tint strength' }), tint);
  const reset = () => {
    app.setBackground({
      bg_mode: 'solid', background_color: '#000000', bg_tint: 35, corner_radius: 10, window_opacity: 100,
    });
    opacity.set(100);
    setGap(4);
    gap.set(4);
    radius.set(10);
    tint.set(35);
    refresh();
  };
  panel.append(
    header,
    el('div', { class: 'bg-label', text: 'Style' }), seg,
    colorLabel, swatches,
    el('div', { class: 'hex-row' }, el('span', { class: 'muted', text: 'Hex' }), hex),
    tintRow,
    el('div', { class: 'bg-label', text: 'Gap between photos' }), gap,
    el('div', { class: 'bg-label', text: 'Rounded corners' }), radius,
    el('div', { class: 'bg-label', text: 'Window opacity' }), opacity,
    el('div', { class: 'bg-footer' },
      el('button', { class: 'link-btn', text: 'Reset to default', onclick: reset }),
      el('button', { class: 'primary', text: 'Done', onclick: () => close() })),
  );

  function refresh(updatePicker = true) {
    const mode = glassOk ? settings.get('bg_mode') : 'solid';
    const color = settings.get('background_color').toLowerCase();
    for (const [m, b] of Object.entries(segButtons)) b.classList.toggle('selected', m === mode);
    for (const b of swatchButtons) b.classList.toggle('selected', b.dataset.color === color);
    customWrap.classList.toggle('selected', !swatchButtons.some((b) => b.dataset.color === color));
    customWrap.style.setProperty('--custom', color);
    if (updatePicker) picker.value = color;
    hex.value = color;
    const glass = mode !== 'solid';
    colorLabel.textContent = glass ? 'Tint color' : 'Color';
    tintRow.hidden = !glass;
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const onOutside = (e) => {
    if (!panel.contains(e.target)) close();
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    panel.classList.remove('visible');
    setTimeout(() => panel.remove(), 160);
    bgPanel = null;
  }
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  refresh();
  document.body.append(panel);
  requestAnimationFrame(() => panel.classList.add('visible'));
  bgPanel = { close };
}
