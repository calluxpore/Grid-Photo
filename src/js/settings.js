// Application settings: defaults + persisted values (stored by the main process).

export const DEFAULTS = {
  // General
  start_maximized: false,
  start_fullscreen: false,
  stay_on_top: false,
  one_instance: true,
  color_scheme: 'dark', // system / light / dark
  recent_list_enabled: true,
  recent_list_max_size: 15,
  background_color: '#000000',
  bg_mode: 'solid', // solid / acrylic / mica (Windows 11 glass)
  bg_tint: 35, // glass tint strength in %
  corner_radius: 10,
  window_opacity: 100, // %
  show_toolbar: true,
  restore_session: true,
  // Mouse & display
  wheel_action: 'zoom', // zoom / browse (Ctrl inverts)
  pan_trigger: 'left', // left (when zoomed) / middle / ctrl / shift / alt / disabled
  drag_swap: true,
  mouse_hide: true,
  mouse_hide_timeout: 3,
  overlay_timeout: 3,
  smooth_scaling: true,
  zoom_step: 1.2,
  move_step: 0.05,
  crop_step: 0.02,
  preview_max_size: 2560,
  // Files
  sort_mode: 'name', // name / date / size
  include_subfolders: false,
  screenshot_dir: '',
  screenshot_format: 'png',
  screenshot_jpg_quality: 92,
  // Defaults: grid
  def_grid_layout: 'masonry',
  def_grid_mode: 'rows',
  def_grid_fit_cells: true,
  def_grid_spacing: 4,
  def_overlay_border: true,
  def_overlay_hide: true,
  def_disable_overlay: false,
  // Defaults: photo
  def_aspect: 'fit',
  def_slideshow_interval: 5,
  def_slideshow_order: 'next',
  // Slideshow transitions
  transition_type: 'fade', // see transitions.js
  transition_duration: 500, // ms
  transition_easing: 'smooth',
  transition_scope: 'slideshow', // slideshow / all (every photo change)
  present_fullscreen: true, // Space slideshow goes fullscreen
  ken_burns: false, // slow pan & zoom during the Space slideshow
  dim_rejected: true,
  face_strictness: 'balanced', // strict / balanced / loose
  face_min_size: 40, // px, smaller faces are ignored
  // State
  keymap: {},
  recent_files: [],
  recent_playlists: [],
  last_dir: '',
  save_as_dir: '',
  session: null,
  library_notice_shown: false,
};

let values = {};

export async function loadSettings() {
  values = (await window.gp.settings.getAll()) || {};
}

export function get(key) {
  if (key in values && values[key] !== null && values[key] !== undefined) return values[key];
  const d = DEFAULTS[key];
  return Array.isArray(d) ? [...d] : d && typeof d === 'object' ? { ...d } : d;
}

export function set(key, value) {
  values[key] = value;
  window.gp.settings.set(key, value);
}

export async function resetKeys(keys) {
  values = await window.gp.settings.reset(keys);
}

export function addRecent(key, item) {
  if (!get('recent_list_enabled')) return;
  const list = get(key).filter((p) => p !== item);
  list.unshift(item);
  set(key, list.slice(0, get('recent_list_max_size')));
}
