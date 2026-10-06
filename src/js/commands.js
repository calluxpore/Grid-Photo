// Registry of every command: title, default shortcut(s) and dispatch target.
//   target "cell" - method of the active PhotoCell
//   target "all"  - same method applied to every visible PhotoCell
//   target "win"  - method of the App
// Shortcuts are separated by ";".

export const COMMANDS = [];

function add(id, title, target, method, opts = {}) {
  const cmd = {
    id, title, target, method,
    args: opts.args || [],
    shortcut: opts.shortcut || '',
    checked: opts.checked || null, // method name returning bool
    checkedArgs: opts.checkedArgs || opts.args || [],
  };
  COMMANDS.push(cmd);
  return cmd;
}

/** Register a cell command and its [ALL] twin. */
function cell(id, title, method, opts = {}) {
  add(id, title, 'cell', method, opts);
  add(`${id}_all`, `${title} [ALL]`, 'all', method, { ...opts, shortcut: opts.all || '' });
}

// --- Browsing ---------------------------------------------------------------
cell('slideshow', 'Slideshow Play / Pause (in the grid)', 'toggleSlideshow', { shortcut: 'Ctrl+Space', all: 'Shift+Space' });
cell('prev_file', 'Previous File', 'prevFile', { shortcut: 'PgUp;Left', all: 'Shift+PgUp;Shift+Left' });
cell('next_file', 'Next File', 'nextFile', { shortcut: 'PgDown;Right', all: 'Shift+PgDown;Shift+Right' });
cell('first_file', 'First File in Folder', 'firstFile', { shortcut: 'Home', all: 'Shift+Home' });
cell('last_file', 'Last File in Folder', 'lastFile', { shortcut: 'End', all: 'Shift+End' });
cell('random_file', 'Random File in Folder', 'randomFile', { shortcut: 'R', all: 'Shift+R' });
cell('slideshow_faster', 'Slideshow Faster', 'slideshowFaster', { shortcut: '.' });
cell('slideshow_slower', 'Slideshow Slower', 'slideshowSlower', { shortcut: ',' });
cell('slideshow_normal', 'Slideshow Default Speed', 'slideshowNormal');

// --- Rating & culling (Lightroom-style keys) --------------------------------
for (let i = 0; i <= 5; i++) {
  add(`rate_${i}`, i ? `${'\u2605'.repeat(i)}${'\u2606'.repeat(5 - i)}` : 'Clear Rating', 'cell', 'setRating', {
    args: [i], shortcut: String(i), checked: i ? 'isRating' : null,
  });
}
add('flag_pick', 'Pick', 'cell', 'setFlag', { args: ['pick'], shortcut: 'P', checked: 'isFlag' });
add('flag_reject', 'Reject', 'cell', 'setFlag', { args: ['reject'], shortcut: 'X', checked: 'isFlag' });
add('flag_clear', 'Remove Flag', 'cell', 'setFlag', { args: [null], shortcut: 'U' });
for (const [f, t] of [['all', 'All Photos'], ['picks', 'Picks Only'], ['no_rejects', 'Hide Rejected'],
  ['stars_1', '\u2605 and Up'], ['stars_2', '\u2605\u2605 and Up'], ['stars_3', '\u2605\u2605\u2605 and Up'],
  ['stars_4', '\u2605\u2605\u2605\u2605 and Up'], ['stars_5', '\u2605\u2605\u2605\u2605\u2605 Only']]) {
  add(`filter_${f}`, t, 'win', 'setFilter', { args: [f], checked: 'isFilter' });
}
add('faces', 'Find People (Face Recognition)', 'win', 'findPeople', { shortcut: 'Ctrl+Shift+F' });
add('people_rescan', 'Rescan Faces', 'win', 'rescanPeople');
add('new_folder', 'New Folder...', 'win', 'newFolder', { shortcut: 'Ctrl+Shift+N' });
add('import_folders', 'Import Sorted Folders...', 'win', 'importFolders');
add('people_panel', 'Show People Panel', 'win', 'togglePeoplePanel', { shortcut: 'Ctrl+Shift+E', checked: 'isPeoplePanel' });
add('save_picks', 'Save Picks To Folder...', 'win', 'savePicks', { shortcut: 'Ctrl+Shift+P' });
add('sort_rating', 'Sort Grid by Rating', 'win', 'sortByRating');
cell('slideshow_interval', 'Slideshow Interval...', 'askSlideshowInterval');
add('transition_cycle', 'Next Transition Type', 'win', 'cycleTransition', { shortcut: 'T' });
add('transition_prev', 'Previous Transition Type', 'win', 'cycleTransition', { args: [-1], shortcut: 'Shift+T' });
for (const [o, t] of [['next', 'Next File'], ['previous', 'Previous File'], ['shuffle', 'Random File']]) {
  cell(`slideshow_order_${o}`, `Slideshow Order: ${t}`, 'setSlideshowOrder', {
    args: [o], checked: 'isSlideshowOrder',
  });
}
cell('animation', 'Animation Play / Pause', 'toggleAnimation', { shortcut: 'Ctrl+G', all: 'Ctrl+Shift+G' });

// --- View -------------------------------------------------------------------
cell('zoom_in', 'Zoom In', 'zoomIn', { shortcut: '=;NumAdd', all: 'Alt+=' });
cell('zoom_out', 'Zoom Out', 'zoomOut', { shortcut: '-;NumSub', all: 'Alt+-' });
cell('zoom_reset', 'Zoom Reset', 'zoomReset', { shortcut: 'Backspace;NumMul', all: 'Alt+Backspace' });
cell('zoom_100', 'Zoom 100% (actual pixels)', 'zoomActual', { shortcut: '/', all: 'Alt+/' });
cell('move_left', 'Move Left', 'move', { args: [-1, 0], shortcut: 'Alt+Left', all: 'Shift+Alt+Left' });
cell('move_right', 'Move Right', 'move', { args: [1, 0], shortcut: 'Alt+Right', all: 'Shift+Alt+Right' });
cell('move_up', 'Move Up', 'move', { args: [0, -1], shortcut: 'Alt+Up', all: 'Shift+Alt+Up' });
cell('move_down', 'Move Down', 'move', { args: [0, 1], shortcut: 'Alt+Down', all: 'Shift+Alt+Down' });
cell('position_reset', 'Position Reset', 'positionReset');
for (const a of ['center', 'top', 'bottom', 'left', 'right', 'top_left', 'top_right',
  'bottom_left', 'bottom_right']) {
  const title = a.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  cell(`align_${a}`, `Align ${title}`, 'setAlign', { args: [a], checked: 'isAlign' });
}
for (const [m, t] of [['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch'], ['none', 'Original Size']]) {
  cell(`aspect_${m}`, `Aspect ${t}`, 'setAspect', { args: [m], checked: 'isAspect' });
}
cell('aspect_cycle', 'Aspect Cycle', 'cycleAspect', { shortcut: 'A', all: 'Shift+A' });

cell('rotate_cw', 'Rotate 90° Clockwise', 'rotate', { args: [90], shortcut: ']', all: 'Alt+]' });
cell('rotate_ccw', 'Rotate 90° Counter-clockwise', 'rotate', { args: [-90], shortcut: '[', all: 'Alt+[' });
cell('rotate_180', 'Rotate 180°', 'rotate', { args: [180] });
cell('flip_h', 'Flip Horizontally', 'flip', { args: [true], shortcut: 'H', all: 'Shift+H' });
cell('flip_v', 'Flip Vertically', 'flip', { args: [false], shortcut: 'V', all: 'Shift+V' });
cell('transform_reset', 'No Transform', 'transformReset');

cell('crop_l_inc', 'Crop Left +', 'crop', { args: ['l', 1] });
cell('crop_l_dec', 'Crop Left -', 'crop', { args: ['l', -1] });
cell('crop_t_inc', 'Crop Top +', 'crop', { args: ['t', 1] });
cell('crop_t_dec', 'Crop Top -', 'crop', { args: ['t', -1] });
cell('crop_r_inc', 'Crop Right +', 'crop', { args: ['r', 1] });
cell('crop_r_dec', 'Crop Right -', 'crop', { args: ['r', -1] });
cell('crop_b_inc', 'Crop Bottom +', 'crop', { args: ['b', 1] });
cell('crop_b_dec', 'Crop Bottom -', 'crop', { args: ['b', -1] });
cell('crop_reset', 'Crop Reset', 'cropReset', { shortcut: 'Y', all: 'Shift+Y' });
cell('reset_all', 'Reset View (zoom, position, crop, rotation)', 'resetAll', {
  shortcut: 'Ctrl+Backspace', all: 'Ctrl+Shift+Backspace',
});

// --- File -------------------------------------------------------------------
add('save_as', 'Save Photo As...', 'cell', 'saveAs', { shortcut: 'Ctrl+Alt+S' });
add('save_all_as', 'Save All Photos To Folder...', 'win', 'saveAllAs');
add('export_view', 'Save Visible Area (full resolution)', 'cell', 'exportView', { shortcut: 'Alt+S' });
add('export_grid', 'Save Grid Screenshot', 'win', 'exportGrid', { shortcut: 'Shift+Alt+S' });
add('copy_image', 'Copy Image', 'cell', 'copyImage', { shortcut: 'Ctrl+C' });
add('copy_path', 'Copy File Path', 'cell', 'copyPath', { shortcut: 'Ctrl+Shift+C' });
add('show_info', 'Image Info / EXIF', 'cell', 'showInfo', { shortcut: 'Ctrl+I' });
add('open_folder', 'Show in Explorer', 'cell', 'openFolder', { shortcut: 'Ctrl+E' });
add('open_external', 'Open in Default App', 'cell', 'openExternal');
add('replace_file', 'Replace Image...', 'win', 'replaceActive', { shortcut: 'Ctrl+Shift+O' });
add('rename', 'Rename File', 'cell', 'renameFile', { shortcut: 'F2' });
add('trash', 'Delete from GridPhoto (copy only)', 'win', 'trashSelected', { shortcut: 'Delete' });
cell('reload', 'Reload', 'reload', { shortcut: 'F5', all: 'Shift+F5' });
add('close_cell', 'Close & Delete (undo with Ctrl+Z)', 'win', 'closeActive', { shortcut: 'Ctrl+F4;Ctrl+W' });
add('undo_close', 'Undo Delete', 'win', 'undoClose', { shortcut: 'Ctrl+Z' });
add('apply_view_others', 'Apply This View to All Others', 'win', 'applyViewToOthers');

// --- Cells navigation -------------------------------------------------------
add('single_mode', 'Single Mode ON / OFF', 'win', 'toggleSingle', { shortcut: 'Enter', checked: 'isSingle' });
add('present', 'Enlarge & Play Slideshow (with transitions)', 'win', 'presentSlideshow', { shortcut: 'Space', checked: 'isPresenting' });
add('prev_cell', 'Previous Cell', 'win', 'cycleActive', { args: [-1], shortcut: 'B;Shift+Tab' });
add('next_cell', 'Next Cell', 'win', 'cycleActive', { args: [1], shortcut: 'N;Tab' });

// --- Grid / playlist --------------------------------------------------------
add('layout_masonry', 'Waterfall Layout (masonry)', 'win', 'setLayout', { args: ['masonry'], checked: 'isLayout' });
add('layout_grid', 'Grid Layout (equal cells)', 'win', 'setLayout', { args: ['grid'], checked: 'isLayout' });
add('keep_order', 'Waterfall: Keep Exact Photo Order', 'win', 'toggleGridFlag', {
  args: ['keep_order'], checked: 'gridFlag',
});
add('layout_toggle', 'Toggle Waterfall / Grid Layout', 'win', 'toggleLayout', { shortcut: 'Ctrl+L' });
add('shuffle_grid', 'Shuffle Grid', 'win', 'shuffleGrid', { shortcut: 'Alt+R' });
add('sort_grid', 'Sort Grid by File Name', 'win', 'sortGrid');
add('grid_rows', 'Rows First', 'win', 'setGridMode', { args: ['rows'], checked: 'isGridMode' });
add('grid_columns', 'Columns First', 'win', 'setGridMode', { args: ['columns'], checked: 'isGridMode' });
add('grid_fit', 'Fit Cells (maximize photo area)', 'win', 'toggleGridFlag', { args: ['fit_cells'], checked: 'gridFlag' });
add('grid_fixed', 'Fixed Number of Columns', 'win', 'toggleGridFlag', { args: ['fixed'], checked: 'gridFlag' });
add('grid_size', 'Number of Columns...', 'win', 'askGridSize');
add('grid_show_all', 'Show All Cells', 'win', 'toggleGridFlag', { args: ['show_all_cells'], checked: 'gridFlag' });
add('grid_spacing', 'Gap Between Photos...', 'win', 'askGridSpacing');
add('grid_more', 'More Columns', 'win', 'changeGridSize', { args: [1], shortcut: 'Ctrl+=' });
add('grid_less', 'Fewer Columns', 'win', 'changeGridSize', { args: [-1], shortcut: 'Ctrl+-' });
add('sync_view', 'Sync View (zoom & pan all together)', 'win', 'togglePlFlag', {
  args: ['sync_view'], shortcut: 'Ctrl+Y', checked: 'plFlag',
});
add('shuffle_on_load', 'Shuffle Grid On Load', 'win', 'togglePlFlag', { args: ['shuffle_on_load'], checked: 'plFlag' });
add('disable_click', 'Disable Mouse Click Events', 'win', 'togglePlFlag', { args: ['disable_click'], checked: 'plFlag' });
add('disable_wheel', 'Disable Mouse Wheel Events', 'win', 'togglePlFlag', { args: ['disable_wheel'], checked: 'plFlag' });
add('disable_overlay', 'Disable Overlay', 'win', 'togglePlFlag', {
  args: ['disable_overlay'], shortcut: 'Ctrl+D', checked: 'plFlag',
});
add('overlay_border', 'Show Overlay Border', 'win', 'togglePlFlag', { args: ['overlay_border'], checked: 'plFlag' });
add('overlay_hide', 'Hide Overlay After Timeout', 'win', 'togglePlFlag', { args: ['overlay_hide'], checked: 'plFlag' });
for (let i = 0; i < 10; i++) {
  add(`snapshot_save_${i}`, `Save Snapshot ${i}`, 'win', 'snapshotSave', { args: [i], shortcut: `Ctrl+Alt+${i}` });
  add(`snapshot_load_${i}`, `Load Snapshot ${i}`, 'win', 'snapshotLoad', { args: [i], shortcut: `Ctrl+${i}` });
  add(`snapshot_delete_${i}`, `Delete Snapshot ${i}`, 'win', 'snapshotDelete', { args: [i] });
}

// --- Program ----------------------------------------------------------------
add('add_files', 'Add Files...', 'win', 'addFilesDialog', { shortcut: 'Ctrl+N' });
add('select_all', 'Select All', 'win', 'selectAll', { shortcut: 'Ctrl+A' });
add('clear_selection', 'Clear Selection', 'win', 'clearSelection');
add('add_folder', 'Add Folder...', 'win', 'addFolderDialog', { shortcut: 'Ctrl+Shift+A' });
add('add_clipboard', 'Add from Clipboard', 'win', 'addClipboard', { shortcut: 'Ctrl+V' });
add('open_playlist', 'Open Grid...', 'win', 'openPlaylistDialog', { shortcut: 'Ctrl+O' });
add('save_playlist', 'Save Grid', 'win', 'savePlaylist', { shortcut: 'Ctrl+S' });
add('save_playlist_as', 'Save Grid As...', 'win', 'savePlaylistAs', { shortcut: 'Ctrl+Shift+S' });
add('close_playlist', 'Close All', 'win', 'closePlaylist', { shortcut: 'Ctrl+Shift+Q' });
add('fullscreen', 'Fullscreen', 'win', 'toggleFullscreen', { shortcut: 'F;F11', checked: 'isFullscreen' });
add('stay_on_top', 'Stay on Top', 'win', 'toggleOnTop', { shortcut: 'Ctrl+T', checked: 'isOnTop' });
add('toolbar', 'Show Toolbar', 'win', 'toggleToolbar', { shortcut: 'Ctrl+Shift+T', checked: 'isToolbar' });
add('escape', 'Exit Single Mode / Fullscreen', 'win', 'escape', { shortcut: 'Esc' });
add('background', 'Customize Background...', 'win', 'openBackgroundPanel', { shortcut: 'Ctrl+B' });
add('settings', 'Settings...', 'win', 'openSettings', { shortcut: 'F6' });
add('shortcuts', 'Keyboard Shortcuts', 'win', 'showShortcuts', { shortcut: 'F1;Shift+/' });
add('about', 'About', 'win', 'showAbout');
add('devtools', 'Developer Tools', 'win', 'devtools', { shortcut: 'Ctrl+Shift+I' });
add('quit', 'Quit', 'win', 'quit', { shortcut: 'Ctrl+Q' });

export const COMMANDS_BY_ID = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

export function defaultShortcuts(id) {
  return COMMANDS_BY_ID[id].shortcut.split(';').filter(Boolean);
}
