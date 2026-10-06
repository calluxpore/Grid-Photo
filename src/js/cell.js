// A single grid cell displaying one photo on a <canvas>.

import * as settings from './settings.js';
import { AnimationPlayer, animatedDecoder, decodeBitmap, extOf, fetchBlob } from './imageload.js';
import { runTransition } from './transitions.js';
import * as ui from './ui.js';
import {
  basename, clamp, dirname, extname, joinPath, samePath, stem, timestamp,
} from './util.js';

export const ASPECT_MODES = ['fit', 'fill', 'stretch', 'none'];
export const ASPECT_TITLES = {
  fit: 'Fit', fill: 'Fill (crop to cell)', stretch: 'Stretch', none: 'Original size (1:1)',
};
const ALIGN_FACTORS = {
  top_left: [0, 0], top: [0.5, 0], top_right: [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1],
};
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 64;
const INTERVAL_STEPS = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60, 120, 300];

export function newCellState(path, overrides = {}) {
  return {
    path,
    aspect: settings.get('def_aspect'),
    zoom: 1,
    pan_x: 0,
    pan_y: 0,
    align: 'center',
    rotation: 0,
    flip_h: false,
    flip_v: false,
    crop_l: 0,
    crop_t: 0,
    crop_r: 0,
    crop_b: 0,
    slideshow: false,
    slideshow_interval: settings.get('def_slideshow_interval'),
    slideshow_order: settings.get('def_slideshow_order'),
    animation_paused: false,
    title: '',
    ...overrides,
  };
}

const MIME_FOR_SAVE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export class PhotoCell {
  constructor(app, state) {
    this.app = app;
    this.state = newCellState(state.path, state);
    // photos always open showing the whole picture, whatever zoom they were saved with
    Object.assign(this.state, { zoom: 1, pan_x: 0, pan_y: 0 });
    this.source = null; // ImageBitmap or VideoFrame currently shown
    this.blob = null; // compressed file data (for full-res decode)
    this.fullSize = null; // {w, h} oriented full resolution
    this.isFull = true;
    this.loading = false;
    this.error = false;
    this.anim = null;
    this.siblings = [];
    this.token = 0;
    this.fullRequested = false;
    this.active = false;
    this.hovered = false;
    this.w = 0;
    this.h = 0;

    this.el = document.createElement('div');
    this.el.className = 'cell';
    this.el.innerHTML = `
      <canvas></canvas>
      <div class="msg"></div>
      <div class="ov ov-bottom"><span class="info"></span><span class="right"><span class="ss"></span><span class="idx"></span></span></div>
      <div class="badge">▶</div>
      <div class="check" aria-hidden="true">✓</div>
      <div class="rating-badge"></div>
      <div class="flash"></div>
      <button class="close-btn" title="Delete this photo (Ctrl+W) · Undo with Ctrl+Z" aria-label="Delete photo">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>`;
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.$ = (sel) => this.el.querySelector(sel);

    this.slideshowTimer = null;
    this.overlayTimer = null;
    this.flashTimer = null;
    this.navHint = null; // direction / origin of the next photo change (for transitions)
    this.pendingTransition = null;
    this.transition = null;
    this.slideshowStepping = false;
    this.paintQueued = false;
    this.pan = null; // active pan drag
    this.press = null; // possible drag-swap start

    this._bindEvents();
    if (this.state.path) this.loadPath(this.state.path, true);
  }

  cfg(key) {
    return settings.get(key);
  }

  // ------------------------------------------------------------- loading
  async loadPath(path, keepView = false) {
    const st = this.state;
    st.path = path;
    if (!keepView) {
      Object.assign(st, {
        zoom: 1, pan_x: 0, pan_y: 0, rotation: 0, flip_h: false, flip_v: false,
        crop_l: 0, crop_t: 0, crop_r: 0, crop_b: 0, title: '',
      });
    }
    const hint = this.navHint;
    this.navHint = null;
    const token = ++this.token;
    this.loading = true;
    this.error = false;
    this.fullRequested = false;
    clearTimeout(this.slideshowTimer);
    this.updateOverlay();
    this.paint();
    this.app.markDirty();
    this._refreshSiblings();

    let blob;
    try {
      blob = await fetchBlob(path);
    } catch {
      if (token === this.token) this._fail();
      return;
    }
    if (token !== this.token) return;

    const decoder = await animatedDecoder(blob, path);
    if (token !== this.token) {
      if (decoder) decoder.close();
      return;
    }
    if (decoder) {
      this._prepareTransition(hint);
      this._dispose();
      this.blob = blob;
      const player = new AnimationPlayer(decoder, (frame) => {
        // keep the source in sync with the player even while another file loads,
        // otherwise we would keep a reference to an already closed VideoFrame
        if (this.anim !== player) return;
        const first = this.loading && token === this.token;
        this.source = frame;
        this.fullSize = { w: frame.displayWidth, h: frame.displayHeight };
        this.isFull = true;
        this.loading = false;
        this.paint();
        if (first) this._afterLoad();
      });
      this.anim = player;
      player.paused = st.animation_paused;
      player.start();
      return;
    }

    let result;
    try {
      result = await decodeBitmap(blob, this.cfg('preview_max_size'));
    } catch {
      if (token === this.token) this._fail();
      return;
    }
    if (token !== this.token) {
      result.bitmap.close();
      return;
    }
    this._prepareTransition(hint);
    this._dispose();
    this.blob = blob;
    this.source = result.bitmap;
    this.fullSize = result.fullSize;
    this.isFull = result.isFull;
    this.loading = false;
    this.paint();
    this._afterLoad();
  }

  // ------------------------------------------------------------ rating
  rating() {
    return this.app.ratingOf(this.state.path);
  }

  setRating(stars) {
    if (!this.state.path) return;
    const r = this.rating();
    const next = r.stars === stars && stars > 0 ? 0 : stars;
    this.app.setRatingOf(this.state.path, { stars: next });
    this.flash(next ? '\u2605'.repeat(next) : 'Rating cleared', 0.9);
  }

  isRating(stars) { return this.rating().stars === stars; }

  setFlag(flag) {
    if (!this.state.path) return;
    const r = this.rating();
    const next = flag && r.flag === flag ? null : flag;
    this.app.setRatingOf(this.state.path, { flag: next });
    this.flash(next === 'pick' ? '\u2713 Pick' : next === 'reject' ? '\u2715 Reject' : 'Flag removed', 0.9);
  }

  isFlag(flag) { return this.rating().flag === flag; }

  updateRatingBadge() {
    const r = this.rating();
    const badge = this.$('.rating-badge');
    const stars = r.stars ? '\u2605'.repeat(r.stars) : '';
    const flag = r.flag === 'pick' ? '\u2713' : r.flag === 'reject' ? '\u2715' : '';
    badge.innerHTML = '';
    if (flag) {
      const f = document.createElement('span');
      f.className = `flag ${r.flag}`;
      f.textContent = flag;
      badge.append(f);
    }
    if (stars) {
      const sEl = document.createElement('span');
      sEl.className = 'stars';
      sEl.textContent = stars;
      badge.append(sEl);
    }
    badge.hidden = !flag && !stars;
    this.el.classList.toggle('rejected', r.flag === 'reject');
    this.el.classList.toggle('picked', r.flag === 'pick');
  }

  // --------------------------------------------------------- ken burns
  startKenBurns() {
    this.stopKenBurns();
    if (!this.cfg('ken_burns') || this.app.presenting?.cell !== this || !this.state.slideshow) return;
    const dx = (Math.random() * 6 - 3).toFixed(2);
    const dy = (Math.random() * 6 - 3).toFixed(2);
    const zoomIn = Math.random() < 0.6;
    const [from, to] = zoomIn ? ['1', '1.12'] : ['1.12', '1'];
    this.kenBurns = this.canvas.animate([
      { scale: from, translate: zoomIn ? '0% 0%' : `${dx}% ${dy}%` },
      { scale: to, translate: zoomIn ? `${dx}% ${dy}%` : '0% 0%' },
    ], {
      duration: this.state.slideshow_interval * 1000 + this.cfg('transition_duration') + 800,
      easing: 'linear',
      fill: 'forwards',
    });
  }

  stopKenBurns() {
    if (this.kenBurns) {
      this.kenBurns.cancel();
      this.kenBurns = null;
    }
  }

  // ----------------------------------------------------------- transitions
  _prepareTransition(hint) {
    if (!hint || !this.source || this.destroyed || !this.w || !this.h) return;
    // transitions only play in the enlarged single-photo view, never in the grid
    if (this.app.singleCell !== this) return;
    const type = this.cfg('transition_type');
    if (type === 'none') return;
    if (this.cfg('transition_scope') === 'slideshow' && !hint.slideshow) return;
    this._cancelTransition();
    const snap = document.createElement('canvas');
    snap.className = 'snap';
    snap.width = this.canvas.width;
    snap.height = this.canvas.height;
    snap.getContext('2d').drawImage(this.canvas, 0, 0);
    // keep the old frame at its own size, centred: if the cell changes shape for
    // the new photo, the old one is clipped instead of stretched
    Object.assign(snap.style, {
      inset: 'auto',
      width: `${this.w}px`,
      height: `${this.h}px`,
      left: `calc(50% - ${this.w / 2}px)`,
      top: `calc(50% - ${this.h / 2}px)`,
    });
    if (this.kenBurns) {
      const cs = getComputedStyle(this.canvas);
      snap.style.scale = cs.scale;
      snap.style.translate = cs.translate;
      this.stopKenBurns();
    }
    this.canvas.after(snap);
    this.pendingTransition = { snap, dir: hint.dir };
  }

  _startTransition() {
    const t = this.pendingTransition;
    this.pendingTransition = null;
    const handle = runTransition({
      snap: t.snap,
      canvas: this.canvas,
      type: this.cfg('transition_type'),
      direction: t.dir,
      duration: this.cfg('transition_duration'),
      easing: this.cfg('transition_easing'),
    });
    this.transition = handle;
    handle.finished.then(() => {
      if (this.transition === handle) this.transition = null;
    });
  }

  _cancelTransition() {
    if (this.pendingTransition) {
      this.pendingTransition.snap.remove();
      this.pendingTransition = null;
    }
    if (this.transition) {
      this.transition.cancel();
      this.transition = null;
    }
  }

  async _loadFull() {
    const token = this.token;
    const blob = this.blob;
    if (!blob) return;
    try {
      const result = await decodeBitmap(blob, 0);
      if (token !== this.token || this.anim) {
        result.bitmap.close();
        return;
      }
      if (this.source && this.source.close) this.source.close();
      this.source = result.bitmap;
      this.isFull = true;
      this.paint();
    } catch { /* keep preview */ }
  }

  _fail() {
    this._cancelTransition();
    this._dispose();
    this.loading = false;
    this.error = true;
    this.updateOverlay();
    this.paint();
    this.app.cellLoaded(this);
  }

  _afterLoad() {
    this.updateOverlay();
    this.app.cellLoaded(this);
    if (this.state.slideshow) this._restartSlideshow();
    if (this.app.presenting?.cell === this) this.startKenBurns();
  }

  _dispose() {
    if (this.anim) {
      this.anim.dispose();
      this.anim = null;
    } else if (this.source && this.source.close) {
      this.source.close();
    }
    this.source = null;
    this.blob = null;
  }

  async _refreshSiblings() {
    const path = this.state.path;
    if (!path) return;
    const files = await window.gp.fs.siblings(path, this.cfg('sort_mode'));
    if (path === this.state.path) {
      this.siblings = files;
      this.updateOverlay();
    }
  }

  reload() {
    window.gp.fs.clearCache();
    this.loadPath(this.state.path, true);
    this.flash('Reloaded');
  }

  destroy() {
    this.destroyed = true;
    this.stopKenBurns();
    this._cancelTransition();
    this.token++;
    clearTimeout(this.slideshowTimer);
    clearTimeout(this.overlayTimer);
    clearTimeout(this.flashTimer);
    this._dispose();
    this.el.remove();
  }

  // ------------------------------------------------------- geometry math
  baseSize() {
    const s = this.fullSize;
    if (!s) return null;
    return this.state.rotation % 180 ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
  }

  contentRect() {
    const b = this.baseSize();
    if (!b) return null;
    const st = this.state;
    return {
      x: b.w * st.crop_l,
      y: b.h * st.crop_t,
      w: b.w * Math.max(0.02, 1 - st.crop_l - st.crop_r),
      h: b.h * Math.max(0.02, 1 - st.crop_t - st.crop_b),
    };
  }

  aspectRatio() {
    const c = this.contentRect();
    return c ? c.w / c.h : null;
  }

  baseScales(c) {
    if (!c || !this.w || !this.h) return [1, 1];
    const fx = this.w / c.w;
    const fy = this.h / c.h;
    switch (this.state.aspect) {
      case 'fill': {
        const s = Math.max(fx, fy);
        return [s, s];
      }
      case 'stretch':
        return [fx, fy];
      case 'none': {
        const s = 1 / devicePixelRatio;
        return [s, s];
      }
      default: {
        const s = Math.min(fx, fy);
        return [s, s];
      }
    }
  }

  destRect(zoom = this.state.zoom, panX = this.state.pan_x, panY = this.state.pan_y) {
    const c = this.contentRect();
    if (!c) return null;
    const [sx, sy] = this.baseScales(c);
    const dw = c.w * sx * zoom;
    const dh = c.h * sy * zoom;
    const [ax, ay] = ALIGN_FACTORS[this.state.align] || [0.5, 0.5];
    return {
      x: (this.w - dw) * ax + panX * dw,
      y: (this.h - dh) * ay + panY * dh,
      w: dw,
      h: dh,
    };
  }

  clampView() {
    const st = this.state;
    st.zoom = clamp(st.zoom, ZOOM_MIN, ZOOM_MAX);
    const d = this.destRect();
    if (!d || !d.w || !d.h) return;
    const [ax, ay] = ALIGN_FACTORS[st.align] || [0.5, 0.5];
    const axis = (pos, size, avail, factor) => {
      const lo = Math.min(0, avail - size);
      const hi = Math.max(0, avail - size);
      return (clamp(pos, lo, hi) - (avail - size) * factor) / size;
    };
    st.pan_x = axis(d.x, d.w, this.w, ax);
    st.pan_y = axis(d.y, d.h, this.h, ay);
  }

  overflows() {
    const d = this.destRect();
    return !!d && (d.w > this.w + 1 || d.h > this.h + 1);
  }

  setGeometry(r, animate = false) {
    const old = this.rect;
    this.rect = r;
    const el = this.el;
    const final = `translate(${r.x}px, ${r.y}px)`;
    const moved = old && (old.x !== r.x || old.y !== r.y || old.w !== r.w || old.h !== r.h);
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    if (animate && moved && !el.hidden) {
      // FLIP: start from the old rect, then glide to the new one
      el.style.transition = 'none';
      el.style.transform = `translate(${old.x}px, ${old.y}px) scale(${old.w / r.w}, ${old.h / r.h})`;
      void el.offsetWidth;
      el.style.transition = '';
      el.classList.add('gliding');
      el.style.transform = final;
      clearTimeout(this.glideTimer);
      this.glideTimer = setTimeout(() => el.classList.remove('gliding'), 320);
    } else {
      el.style.transform = final;
    }
    if (r.w !== this.w || r.h !== this.h) {
      this.w = r.w;
      this.h = r.h;
      this.clampView();
      this.paint();
    }
  }

  // -------------------------------------------------------------- painting
  paint() {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this._draw();
    });
  }

  _applySourceTransform(ctx) {
    // base space -> original image space (flip in display space, after rotation)
    const st = this.state;
    const b = this.baseSize();
    if (st.flip_h) {
      ctx.translate(b.w, 0);
      ctx.scale(-1, 1);
    }
    if (st.flip_v) {
      ctx.translate(0, b.h);
      ctx.scale(1, -1);
    }
    if (st.rotation === 90) {
      ctx.translate(b.w, 0);
      ctx.rotate(Math.PI / 2);
    } else if (st.rotation === 180) {
      ctx.translate(b.w, b.h);
      ctx.rotate(Math.PI);
    } else if (st.rotation === 270) {
      ctx.translate(0, b.h);
      ctx.rotate(-Math.PI / 2);
    }
  }

  _draw() {
    if (this.destroyed) return;
    const dpr = devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.w * dpr));
    const ch = Math.max(1, Math.round(this.h * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch); // cell background comes from CSS (solid or glass)

    const msg = this.$('.msg');
    if (!this.source) {
      ctx.fillStyle = 'rgba(128,128,128,0.16)';
      ctx.fillRect(0, 0, cw, ch);
      msg.textContent = this.loading ? 'Loading…'
        : this.error ? `Can't show this photo\n${basename(this.state.path) || '(no file)'}\nIt may have been moved, deleted, or use an unsupported format.` : '';
      msg.classList.toggle('error', this.error);
      return;
    }
    msg.textContent = '';
    const c = this.contentRect();
    const d = this.destRect();
    if (!c || !d || d.w <= 0 || d.h <= 0) return;

    const srcW = this.source.displayWidth || this.source.width;
    const res = srcW / this.fullSize.w;
    const need = (d.w * dpr) / c.w;
    if (!this.isFull && !this.fullRequested && need > res * 1.05) {
      this.fullRequested = true;
      this._loadFull();
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    ctx.rect(Math.max(0, d.x), Math.max(0, d.y),
      Math.min(this.w, d.x + d.w) - Math.max(0, d.x), Math.min(this.h, d.y + d.h) - Math.max(0, d.y));
    ctx.clip();
    ctx.translate(d.x, d.y);
    ctx.scale(d.w / c.w, d.h / c.h);
    ctx.translate(-c.x, -c.y);
    this._applySourceTransform(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.cfg('smooth_scaling') ? 'high' : 'low';
    try {
      ctx.drawImage(this.source, 0, 0, this.fullSize.w, this.fullSize.h);
    } catch {
      // source was released (e.g. animation frame) - the next frame repaints
    }
    ctx.restore();
    this.updateInfoLine();
    if (this.pendingTransition) this._startTransition();
  }

  // --------------------------------------------------------------- overlay
  updateOverlay() {
    this.updateRatingBadge();
    const st = this.state;
    const idx = this.siblingIndex();
    this.$('.idx').textContent = idx >= 0 ? `${idx + 1} / ${this.siblings.length}` : '';
    this.$('.ss').textContent = st.slideshow ? `▶ ${st.slideshow_interval}s ${st.slideshow_order}` : '';
    this.el.classList.toggle('slideshow', st.slideshow);
    this.updateInfoLine();
  }

  updateInfoLine() {
    const st = this.state;
    const parts = [];
    if (this.fullSize) parts.push(`${this.fullSize.w}×${this.fullSize.h}`);
    if (this.source) parts.push(`${Math.round(this.displayZoomPercent())}%`);
    if (st.aspect !== 'fit') parts.push(ASPECT_TITLES[st.aspect].split(' (')[0]);
    if (st.rotation) parts.push(`${st.rotation}°`);
    if (st.flip_h || st.flip_v) parts.push('flipped');
    if (st.crop_l || st.crop_t || st.crop_r || st.crop_b) parts.push('cropped');
    if (this.anim) parts.push(st.animation_paused ? '⏸ anim' : 'anim');
    const r = this.rating();
    if (r.stars) parts.unshift('★'.repeat(r.stars));
    if (r.flag) parts.unshift(r.flag === 'pick' ? '✓ Pick' : '✕ Reject');
    const text = parts.join('  ·  ');
    const info = this.$('.info');
    if (info.textContent !== text) info.textContent = text;
  }

  displayZoomPercent() {
    const c = this.contentRect();
    const d = this.destRect();
    if (!c || !d) return 100;
    return (d.w / c.w) * devicePixelRatio * 100;
  }

  setActive(active) {
    this.active = active;
    this.el.classList.toggle('active', active);
  }

  pokeOverlay() {
    this.el.classList.add('show-ov');
    clearTimeout(this.overlayTimer);
    if (this.app.playlist.overlay_hide) {
      this.overlayTimer = setTimeout(() => this.el.classList.remove('show-ov'),
        this.cfg('overlay_timeout') * 1000);
    }
  }

  flash(text, seconds = 1.2) {
    const el = this.$('.flash');
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => el.classList.remove('visible'), seconds * 1000);
  }

  // ----------------------------------------------------------------- mouse
  _panTriggerMatches(e) {
    const trig = this.cfg('pan_trigger');
    if (e.button === 1) return trig !== 'disabled';
    if (e.button !== 0) return false;
    switch (trig) {
      case 'ctrl': return e.ctrlKey;
      case 'shift': return e.shiftKey;
      case 'alt': return e.altKey;
      case 'left': return this.overflows() && !e.altKey && !e.ctrlKey && !e.shiftKey;
      default: return false;
    }
  }

  _bindEvents() {
    const el = this.el;
    const closeBtn = this.$('.close-btn');
    const stop = (e) => e.stopPropagation();
    closeBtn.addEventListener('pointerdown', stop);
    closeBtn.addEventListener('dblclick', stop);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.closeCell(this, { animate: true, undoable: true, discard: true });
    });
    el.addEventListener('pointerenter', () => {
      this.hovered = true;
      this.pokeOverlay();
    });
    el.addEventListener('pointerleave', () => {
      this.hovered = false;
      el.classList.remove('show-ov');
    });
    el.addEventListener('pointerdown', (e) => {
      this.app.setActive(this);
      this.pokeOverlay();
      if (e.button === 2) return;
      if (e.button === 1) e.preventDefault(); // no autoscroll
      // Ctrl+click toggles, Shift+click selects a range (unless those keys are set to pan)
      const selectKey = e.ctrlKey || e.shiftKey;
      if (e.button === 0 && selectKey && !this.app.playlist.disable_click
        && !['ctrl', 'shift'].includes(this.cfg('pan_trigger'))) {
        e.preventDefault();
        this.app.toggleSelect(this, e.shiftKey);
        return;
      }
      if (e.button === 0 && !selectKey && this.app.selection.size) this.app.clearSelection();
      if (this._panTriggerMatches(e)) {
        this.pan = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
        el.classList.add('panning');
        return;
      }
      if (e.button === 0 && !this.app.playlist.disable_click) {
        this.press = { x: e.clientX, y: e.clientY };
      }
    });
    el.addEventListener('pointermove', (e) => {
      this.app.onMouseActivity();
      this.pokeOverlay();
      if (!e.buttons && this.app.activeCell !== this) this.app.setActive(this);
      if (this.pan) {
        this.panByPixels(e.clientX - this.pan.x, e.clientY - this.pan.y);
        this.pan = { x: e.clientX, y: e.clientY };
        return;
      }
      if (this.press && e.buttons & 1) {
        const dist = Math.abs(e.clientX - this.press.x) + Math.abs(e.clientY - this.press.y);
        if (dist >= 6 && this.cfg('drag_swap')) {
          this.press = null;
          this.app.startCellDrag(this, e);
        }
      }
    });
    const endPan = () => {
      if (this.pan) {
        this.pan = null;
        el.classList.remove('panning');
        this.app.markDirty();
      }
      this.press = null;
    };
    el.addEventListener('pointerup', endPan);
    el.addEventListener('pointercancel', endPan);
    el.addEventListener('dblclick', (e) => {
      if (e.button === 0 && !this.app.playlist.disable_click) this.app.toggleSingle(this);
    });
    el.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.app.setActive(this);
      this.app.showContextMenu();
    });
  }

  _onWheel(e) {
    e.preventDefault();
    if (this.app.playlist.disable_wheel) return;
    this.pokeOverlay();
    const delta = -(e.deltaY || e.deltaX);
    if (!delta) return;
    const browse = (this.cfg('wheel_action') === 'browse') !== e.ctrlKey;
    const targets = e.shiftKey ? this.app.visibleCells() : [this];
    if (browse) {
      for (const cell of targets) (delta > 0 ? cell.prevFile() : cell.nextFile());
      return;
    }
    const notches = clamp(delta / 100, -3, 3);
    const step = this.cfg('zoom_step') ** notches;
    const rect = this.el.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    for (const cell of targets) {
      cell.zoomTo(cell.state.zoom * step, cell === this ? anchor : null, cell === this);
    }
  }

  // ------------------------------------------------------- view commands
  _viewChanged(notify = true) {
    this.clampView();
    this.paint();
    this.app.markDirty();
    if (notify) this.app.cellViewChanged(this);
  }

  zoomTo(newZoom, anchor = null, notify = true) {
    const st = this.state;
    newZoom = clamp(newZoom, ZOOM_MIN, ZOOM_MAX);
    const old = this.destRect();
    if (!old) {
      st.zoom = newZoom;
      return;
    }
    const a = anchor || { x: this.w / 2, y: this.h / 2 };
    const ratio = newZoom / st.zoom;
    const left = a.x - (a.x - old.x) * ratio;
    const top = a.y - (a.y - old.y) * ratio;
    st.zoom = newZoom;
    const d = this.destRect(newZoom, 0, 0);
    st.pan_x = (left - d.x) / d.w;
    st.pan_y = (top - d.y) / d.h;
    this._viewChanged(notify);
  }

  zoomIn() { this.zoomTo(this.state.zoom * this.cfg('zoom_step')); }

  zoomOut() { this.zoomTo(this.state.zoom / this.cfg('zoom_step')); }

  zoomReset() {
    Object.assign(this.state, { zoom: 1, pan_x: 0, pan_y: 0 });
    this._viewChanged();
  }

  zoomActual() {
    const [sx, sy] = this.baseScales(this.contentRect());
    this.zoomTo((1 / devicePixelRatio) / Math.min(sx, sy));
  }

  panByPixels(dx, dy, notify = true) {
    const d = this.destRect();
    if (!d) return;
    this.state.pan_x += dx / d.w;
    this.state.pan_y += dy / d.h;
    this._viewChanged(notify);
  }

  move(dx, dy) {
    const step = this.cfg('move_step');
    this.panByPixels(dx * step * this.w, dy * step * this.h);
  }

  positionReset() {
    this.state.pan_x = 0;
    this.state.pan_y = 0;
    this._viewChanged();
  }

  setAlign(align) {
    Object.assign(this.state, { align, pan_x: 0, pan_y: 0 });
    this._viewChanged();
  }

  isAlign(align) { return this.state.align === align; }

  _shapeChanged() {
    this._viewChanged();
    this.updateInfoLine();
    this.app.cellLoaded(this); // layout depends on the photo's shape
  }

  setAspect(mode) {
    Object.assign(this.state, { aspect: mode, zoom: 1, pan_x: 0, pan_y: 0 });
    this.flash(ASPECT_TITLES[mode]);
    this._shapeChanged();
  }

  isAspect(mode) { return this.state.aspect === mode; }

  cycleAspect() {
    const i = ASPECT_MODES.indexOf(this.state.aspect);
    this.setAspect(ASPECT_MODES[(i + 1) % ASPECT_MODES.length]);
  }

  rotate(degrees) {
    const st = this.state;
    if (st.flip_h !== st.flip_v && degrees !== 180) degrees = -degrees;
    st.rotation = (((st.rotation + degrees) % 360) + 360) % 360;
    Object.assign(st, { zoom: 1, pan_x: 0, pan_y: 0 });
    this.flash(`Rotation ${st.rotation}°`);
    this._shapeChanged();
  }

  flip(horizontal) {
    if (horizontal) this.state.flip_h = !this.state.flip_h;
    else this.state.flip_v = !this.state.flip_v;
    this._viewChanged();
    this.updateInfoLine();
  }

  transformReset() {
    Object.assign(this.state, { rotation: 0, flip_h: false, flip_v: false, zoom: 1, pan_x: 0, pan_y: 0 });
    this._shapeChanged();
  }

  crop(side, direction) {
    const key = `crop_${side}`;
    const v = clamp(this.state[key] + this.cfg('crop_step') * direction, 0, 0.45);
    this.state[key] = Math.round(v * 10000) / 10000;
    this._shapeChanged();
  }

  cropReset() {
    Object.assign(this.state, { crop_l: 0, crop_t: 0, crop_r: 0, crop_b: 0 });
    this._shapeChanged();
  }

  resetAll() {
    Object.assign(this.state, {
      zoom: 1, pan_x: 0, pan_y: 0, rotation: 0, flip_h: false, flip_v: false,
      crop_l: 0, crop_t: 0, crop_r: 0, crop_b: 0, align: 'center',
    });
    this._shapeChanged();
  }

  /** Show the whole photo again (zoom 1, no pan) without touching edits. */
  fitView() {
    Object.assign(this.state, { zoom: 1, pan_x: 0, pan_y: 0 });
    this.clampView();
    this.paint();
  }

  copyViewFrom(other) {
    Object.assign(this.state, { zoom: other.state.zoom, pan_x: other.state.pan_x, pan_y: other.state.pan_y });
    this.clampView();
    this.paint();
  }

  hasEdits() {
    const st = this.state;
    return !!(st.rotation || st.flip_h || st.flip_v || st.crop_l || st.crop_t || st.crop_r || st.crop_b);
  }

  // ------------------------------------------------------ file navigation
  siblingIndex(files = this.siblings) {
    return files.findIndex((f) => samePath(f, this.state.path));
  }

  async _files() {
    if (!this.state.path) return [];
    this.siblings = await window.gp.fs.siblings(this.state.path, this.cfg('sort_mode'));
    return this.siblings;
  }

  _hint(dir) {
    this.navHint = { dir, slideshow: this.slideshowStepping };
  }

  async _goto(index) {
    const files = await this._files();
    this._hint(index < 0 ? 1 : -1);
    if (files.length) this.loadPath(files[((index % files.length) + files.length) % files.length]);
  }

  async _step(step) {
    const files = await this._files();
    if (!files.length) return;
    let idx = this.siblingIndex(files);
    if (idx < 0) idx = step > 0 ? -1 : 0;
    this._hint(step > 0 ? 1 : -1);
    this.loadPath(files[(((idx + step) % files.length) + files.length) % files.length]);
  }

  prevFile() { return this._step(-1); }

  nextFile() { return this._step(1); }

  firstFile() { return this._goto(0); }

  lastFile() { return this._goto(-1); }

  async randomFile() {
    const files = await this._files();
    const cur = this.siblingIndex(files);
    const others = files.filter((_, i) => i !== cur);
    this._hint(1);
    if (others.length) this.loadPath(others[Math.floor(Math.random() * others.length)]);
  }

  async seekPercent(percent) {
    const files = await this._files();
    if (!files.length) return;
    const target = Math.floor((files.length * percent) / 100);
    this._hint(target >= this.siblingIndex(files) ? 1 : -1);
    this.loadPath(files[target]);
  }

  // ------------------------------------------------------------- slideshow
  toggleSlideshow() { this.setSlideshow(!this.state.slideshow); }

  setSlideshow(on) {
    this.state.slideshow = on;
    if (on) {
      this._restartSlideshow();
      this.flash(`Slideshow ▶ ${this.state.slideshow_interval}s`);
    } else {
      clearTimeout(this.slideshowTimer);
      this.flash('Slideshow ⏸');
    }
    if (this.kenBurns) {
      if (on) this.kenBurns.play();
      else this.kenBurns.pause();
    }
    this.updateOverlay();
    this.app.markDirty();
  }

  _restartSlideshow() {
    clearTimeout(this.slideshowTimer);
    this.slideshowTimer = setTimeout(() => this._slideshowStep(), this.state.slideshow_interval * 1000);
  }

  async _slideshowStep() {
    if (!this.state.slideshow) return;
    if (this.loading) {
      this._restartSlideshow();
      return;
    }
    const order = this.state.slideshow_order;
    this.slideshowStepping = true;
    try {
      if (order === 'previous') await this.prevFile();
      else if (order === 'shuffle') await this.randomFile();
      else await this.nextFile();
    } finally {
      this.slideshowStepping = false;
    }
    if (this.siblings.length <= 1) this._restartSlideshow();
  }

  setSlideshowInterval(seconds) {
    this.state.slideshow_interval = Math.max(0.2, Number(seconds));
    if (this.state.slideshow) this._restartSlideshow();
    this.flash(`Interval ${this.state.slideshow_interval}s`);
    this.updateOverlay();
    this.app.markDirty();
  }

  slideshowFaster() {
    const cur = this.state.slideshow_interval;
    const smaller = INTERVAL_STEPS.filter((s) => s < cur - 1e-6);
    this.setSlideshowInterval(smaller.length ? smaller[smaller.length - 1] : INTERVAL_STEPS[0]);
  }

  slideshowSlower() {
    const cur = this.state.slideshow_interval;
    const larger = INTERVAL_STEPS.filter((s) => s > cur + 1e-6);
    this.setSlideshowInterval(larger.length ? larger[0] : INTERVAL_STEPS[INTERVAL_STEPS.length - 1]);
  }

  slideshowNormal() { this.setSlideshowInterval(this.cfg('def_slideshow_interval')); }

  async askSlideshowInterval(apply = true) {
    const v = await ui.prompt({
      title: 'Slideshow interval', label: 'Seconds per photo:', type: 'number',
      value: this.state.slideshow_interval, min: 0.2, max: 3600, step: 0.5,
    });
    if (v !== null && apply) this.setSlideshowInterval(v);
    return v;
  }

  setSlideshowOrder(order) {
    this.state.slideshow_order = order;
    this.updateOverlay();
    this.app.markDirty();
  }

  isSlideshowOrder(order) { return this.state.slideshow_order === order; }

  toggleAnimation() {
    this.state.animation_paused = !this.state.animation_paused;
    if (this.anim) {
      this.anim.setPaused(this.state.animation_paused);
      this.flash(this.state.animation_paused ? 'Animation ⏸' : 'Animation ▶');
    }
    this.updateInfoLine();
    this.app.markDirty();
  }

  // -------------------------------------------------------------- file ops
  /** Full-resolution canvas with rotation / flip / crop applied. */
  async renderFull(visibleOnly = false) {
    let source = this.source;
    let temp = null;
    if (!this.anim && (!this.isFull || !source)) {
      const blob = this.blob || (await fetchBlob(this.state.path));
      const result = await decodeBitmap(blob, 0);
      temp = result.bitmap;
      source = temp;
      if (!this.fullSize) this.fullSize = result.fullSize;
    }
    if (!source || !this.fullSize) return null;
    let region = this.contentRect();
    if (visibleOnly) {
      const d = this.destRect();
      const vx0 = Math.max(0, d.x);
      const vy0 = Math.max(0, d.y);
      const vx1 = Math.min(this.w, d.x + d.w);
      const vy1 = Math.min(this.h, d.y + d.h);
      if (vx1 > vx0 && vy1 > vy0) {
        const sx = region.w / d.w;
        const sy = region.h / d.h;
        region = {
          x: region.x + (vx0 - d.x) * sx, y: region.y + (vy0 - d.y) * sy,
          w: (vx1 - vx0) * sx, h: (vy1 - vy0) * sy,
        };
      }
    }
    const w = Math.max(1, Math.round(region.w));
    const h = Math.max(1, Math.round(region.h));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.translate(-Math.round(region.x), -Math.round(region.y));
    this._applySourceTransform(ctx);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, this.fullSize.w, this.fullSize.h);
    if (temp) temp.close();
    return canvas;
  }

  async _encode(canvas, ext) {
    const type = MIME_FOR_SAVE[ext] || 'image/png';
    const quality = this.cfg('screenshot_jpg_quality') / 100;
    const blob = await canvas.convertToBlob({ type, quality });
    return blob.arrayBuffer();
  }

  async saveAs() {
    const src = this.state.path;
    if (!src) return;
    const name = basename(src);
    const ext = extname(src) || '.png';
    const defaultPath = joinPath(this.app.saveDir(dirname(src)), name);
    const dest = await window.gp.dialog.save({
      title: 'Save photo as',
      defaultPath,
      filters: [
        { name: 'Same format', extensions: [ext.slice(1)] },
        { name: 'PNG', extensions: ['png'] },
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP', extensions: ['webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!dest) return;
    this.app.rememberSaveDir(dirname(dest));
    if (samePath(dest, src)) return;
    const destExt = extname(dest) || ext;
    try {
      if (destExt === ext && !this.hasEdits()) {
        await window.gp.fs.copy(src, dest); // exact copy, no re-compression
      } else {
        const canvas = await this.renderFull();
        if (!canvas) throw new Error('Image is not loaded');
        await window.gp.fs.writeBuffer(dest, await this._encode(canvas, destExt));
      }
      this.flash('Saved');
    } catch (err) {
      ui.alert('Save failed', String(err.message || err));
    }
  }

  async exportView() {
    const canvas = await this.renderFull(true);
    if (!canvas) return;
    const fmt = this.cfg('screenshot_format');
    const dest = await window.gp.dialog.save({
      title: 'Save visible area',
      defaultPath: joinPath(this.app.screenshotDir(), `${stem(this.state.path) || 'photo'}_view_${timestamp()}.${fmt}`),
      filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP', extensions: ['webp'] }],
    });
    if (!dest) return;
    try {
      await window.gp.fs.writeBuffer(dest, await this._encode(canvas, extname(dest)));
      this.flash('Saved');
    } catch (err) {
      ui.alert('Save failed', String(err.message || err));
    }
  }

  async copyImage() {
    const canvas = await this.renderFull();
    if (!canvas) return;
    await window.gp.clipboard.writeImage(await this._encode(canvas, '.png'));
    this.flash('Image copied');
  }

  copyPath() {
    if (!this.state.path) return;
    window.gp.clipboard.writeText(this.state.path);
    this.flash('Path copied');
  }

  openFolder() {
    if (this.state.path) window.gp.shell.showInFolder(this.state.path);
  }

  openExternal() {
    if (this.state.path) window.gp.shell.openPath(this.state.path);
  }

  async renameFile() {
    const path = this.state.path;
    if (!path) return;
    const name = basename(path);
    const newName = await ui.prompt({ title: 'Rename', label: 'New file name:', value: name, selectStem: true });
    if (!newName || newName === name) return;
    if (/[\\/]/.test(newName)) {
      ui.alert('Rename', 'The name cannot contain slashes.');
      return;
    }
    try {
      const newPath = await window.gp.fs.rename(path, newName);
      this.app.pathRenamed(path, newPath);
    } catch (err) {
      ui.alert('Rename failed', String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }

  trashFile() {
    // deletes GridPhoto's copy only (see App.deletePhotos)
    return this.app.deletePhotos([this]);
  }

  async showInfo() {
    const st = this.state;
    const info = { Path: st.path };
    if (this.fullSize) info.Dimensions = `${this.fullSize.w} × ${this.fullSize.h}`;
    info.Format = extOf(st.path).toUpperCase();
    Object.assign(info, await window.gp.image.info(st.path));
    info['View zoom'] = `${Math.round(this.displayZoomPercent())}%`;
    info['Aspect mode'] = ASPECT_TITLES[st.aspect];
    info.Rotation = `${st.rotation}°`;
    ui.infoTable(`Image info - ${basename(st.path)}`, info);
  }
}
