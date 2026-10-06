"""Registry of every command: title, default shortcut(s) and dispatch target.

target:
  "cell" - method of the active PhotoCell
  "all"  - same method applied to every PhotoCell
  "win"  - method of the MainWindow
Shortcuts are strings separated by ";" when a command has several.
"""

from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class Command:
    id: str
    title: str
    target: str
    method: str
    args: Tuple = ()
    shortcut: str = ""
    checkable: bool = False
    # name of the method (on the same target) returning the checked state
    checked: Optional[str] = None
    checked_args: Tuple = ()
    group: str = ""


COMMANDS = []


def _add(*args, **kwargs):
    cmd = Command(*args, **kwargs)
    COMMANDS.append(cmd)
    return cmd


def _cell(cid, title, method, args=(), shortcut="", all_shortcut="", **kw):
    """Register a cell command and its [ALL] twin."""
    _add(cid, title, "cell", method, args, shortcut, **kw)
    _add(cid + "_all", title + " [ALL]", "all", method, args, all_shortcut, **kw)


# --- Browsing ---------------------------------------------------------------
_cell("slideshow", "Slideshow Play / Pause", "toggle_slideshow",
      shortcut="Ctrl+Space", all_shortcut="Space")
_cell("prev_file", "Previous File", "prev_file",
      shortcut="PgUp;Left", all_shortcut="Shift+PgUp;Shift+Left")
_cell("next_file", "Next File", "next_file",
      shortcut="PgDown;Right", all_shortcut="Shift+PgDown;Shift+Right")
_cell("first_file", "First File in Folder", "first_file",
      shortcut="Home", all_shortcut="Shift+Home")
_cell("last_file", "Last File in Folder", "last_file",
      shortcut="End", all_shortcut="Shift+End")
_cell("random_file", "Random File in Folder", "random_file",
      shortcut="R", all_shortcut="Shift+R")
for _i in range(10):
    _cell(f"seek_{_i}", f"Jump to {_i * 10}% of Folder", "seek_percent", (_i * 10,),
          shortcut=str(_i), all_shortcut=f"Alt+{_i}", group="seek")

_cell("slideshow_faster", "Slideshow Faster", "slideshow_faster",
      shortcut="C", all_shortcut="Shift+C")
_cell("slideshow_slower", "Slideshow Slower", "slideshow_slower",
      shortcut="X", all_shortcut="Shift+X")
_cell("slideshow_normal", "Slideshow Default Speed", "slideshow_normal",
      shortcut="Z", all_shortcut="Shift+Z")
_cell("slideshow_interval", "Slideshow Interval...", "ask_slideshow_interval")
for _o, _t in (("next", "Next File"), ("previous", "Previous File"),
               ("shuffle", "Random File")):
    _cell(f"slideshow_order_{_o}", f"Slideshow Order: {_t}", "set_slideshow_order",
          (_o,), checkable=True, checked="is_slideshow_order", checked_args=(_o,))
_cell("animation", "Animation Play / Pause", "toggle_animation",
      shortcut="Ctrl+G", all_shortcut="Ctrl+Shift+G")

# --- View -------------------------------------------------------------------
_cell("zoom_in", "Zoom In", "zoom_in", shortcut="+;=", all_shortcut="Alt+=")
_cell("zoom_out", "Zoom Out", "zoom_out", shortcut="-", all_shortcut="Alt+-")
_cell("zoom_reset", "Zoom Reset", "zoom_reset", shortcut="*;Backspace",
      all_shortcut="Alt+Backspace")
_cell("zoom_100", "Zoom 100% (actual pixels)", "zoom_actual",
      shortcut="/", all_shortcut="Alt+/")
_cell("move_left", "Move Left", "move", (-1, 0),
      shortcut="Alt+Left", all_shortcut="Shift+Alt+Left")
_cell("move_right", "Move Right", "move", (1, 0),
      shortcut="Alt+Right", all_shortcut="Shift+Alt+Right")
_cell("move_up", "Move Up", "move", (0, -1),
      shortcut="Alt+Up", all_shortcut="Shift+Alt+Up")
_cell("move_down", "Move Down", "move", (0, 1),
      shortcut="Alt+Down", all_shortcut="Shift+Alt+Down")
_cell("position_reset", "Position Reset", "position_reset")
for _a in ("center", "top", "bottom", "left", "right",
           "top_left", "top_right", "bottom_left", "bottom_right"):
    _cell(f"align_{_a}", "Align " + _a.replace("_", " ").title(), "set_align", (_a,),
          checkable=True, checked="is_align", checked_args=(_a,))

for _m, _t in (("fit", "Fit"), ("fill", "Fill"), ("stretch", "Stretch"),
               ("none", "Original Size")):
    _cell(f"aspect_{_m}", f"Aspect {_t}", "set_aspect", (_m,),
          checkable=True, checked="is_aspect", checked_args=(_m,))
_cell("aspect_cycle", "Aspect Cycle", "cycle_aspect", shortcut="A", all_shortcut="Shift+A")

_cell("rotate_cw", "Rotate 90° Clockwise", "rotate", (90,),
      shortcut="]", all_shortcut="Alt+]")
_cell("rotate_ccw", "Rotate 90° Counter-clockwise", "rotate", (-90,),
      shortcut="[", all_shortcut="Alt+[")
_cell("rotate_180", "Rotate 180°", "rotate", (180,))
_cell("flip_h", "Flip Horizontally", "flip", (True,), shortcut="H", all_shortcut="Shift+H")
_cell("flip_v", "Flip Vertically", "flip", (False,), shortcut="V", all_shortcut="Shift+V")
_cell("transform_reset", "No Transform", "transform_reset")

_cell("crop_l_inc", "Crop Left +", "crop", ("l", 1), shortcut="U", all_shortcut="Shift+U")
_cell("crop_l_dec", "Crop Left -", "crop", ("l", -1), shortcut="I", all_shortcut="Shift+I")
_cell("crop_t_inc", "Crop Top +", "crop", ("t", 1), shortcut="O", all_shortcut="Shift+O")
_cell("crop_t_dec", "Crop Top -", "crop", ("t", -1), shortcut="P", all_shortcut="Shift+P")
_cell("crop_r_inc", "Crop Right +", "crop", ("r", 1),
      shortcut="Alt+U", all_shortcut="Shift+Alt+U")
_cell("crop_r_dec", "Crop Right -", "crop", ("r", -1),
      shortcut="Alt+I", all_shortcut="Shift+Alt+I")
_cell("crop_b_inc", "Crop Bottom +", "crop", ("b", 1),
      shortcut="Alt+O", all_shortcut="Shift+Alt+O")
_cell("crop_b_dec", "Crop Bottom -", "crop", ("b", -1),
      shortcut="Alt+P", all_shortcut="Shift+Alt+P")
_cell("crop_reset", "Crop Reset", "crop_reset", shortcut="Y", all_shortcut="Shift+Y")
_cell("reset_all", "Reset View (zoom, position, crop, rotation)", "reset_all",
      shortcut="Ctrl+Backspace", all_shortcut="Ctrl+Shift+Backspace")

# --- File -------------------------------------------------------------------
_add("save_as", "Save Photo As...", "cell", "save_as", shortcut="Ctrl+Alt+S")
_add("save_all_as", "Save All Photos To Folder...", "win", "save_all_as")
_add("export_view", "Save Visible Area (full resolution)", "cell", "export_view",
     shortcut="Alt+S")
_add("export_grid", "Save Grid Screenshot", "win", "export_grid", shortcut="Shift+Alt+S")
_add("copy_image", "Copy Image", "cell", "copy_image", shortcut="Ctrl+C")
_add("copy_path", "Copy File Path", "cell", "copy_path", shortcut="Ctrl+Shift+C")
_add("show_info", "Image Info / EXIF", "cell", "show_info", shortcut="Ctrl+I")
_add("open_folder", "Show in Explorer", "cell", "open_folder", shortcut="Ctrl+E")
_add("open_external", "Open in Default App", "cell", "open_external")
_add("replace_file", "Replace Image...", "win", "replace_active", shortcut="Ctrl+Shift+O")
_add("rename", "Rename File", "cell", "rename_file", shortcut="F4")
_add("trash", "Move File to Recycle Bin", "cell", "trash_file", shortcut="Delete")
_cell("reload", "Reload", "reload", shortcut="F5", all_shortcut="Shift+F5")
_add("close_cell", "Close", "win", "close_active", shortcut="Ctrl+F4;Ctrl+W")
_add("apply_view_others", "Apply This View to All Others", "win", "apply_view_to_others")

# --- Cells navigation -------------------------------------------------------
_add("single_mode", "Single Mode ON / OFF", "win", "toggle_single",
     shortcut="Return;Enter", checkable=True, checked="is_single")
_add("prev_cell", "Previous Cell", "win", "cycle_active", (-1,), shortcut="B;Shift+Tab")
_add("next_cell", "Next Cell", "win", "cycle_active", (1,), shortcut="N;Tab")

# --- Grid / playlist --------------------------------------------------------
_add("shuffle_grid", "Shuffle Grid", "win", "shuffle_grid", shortcut="Alt+R")
_add("sort_grid", "Sort Grid by File Name", "win", "sort_grid")
_add("layout_masonry", "Waterfall Layout (masonry)", "win", "set_layout", ("masonry",),
     checkable=True, checked="is_layout", checked_args=("masonry",))
_add("layout_grid", "Grid Layout (equal cells)", "win", "set_layout", ("grid",),
     checkable=True, checked="is_layout", checked_args=("grid",))
_add("keep_order", "Waterfall: Keep Exact Photo Order", "win", "toggle_grid_flag",
     ("keep_order",), checkable=True, checked="grid_flag", checked_args=("keep_order",))
_add("layout_toggle", "Toggle Waterfall / Grid Layout", "win", "toggle_layout",
     shortcut="Ctrl+L")
_add("grid_rows", "Rows First", "win", "set_grid_mode", ("rows",),
     checkable=True, checked="is_grid_mode", checked_args=("rows",))
_add("grid_columns", "Columns First", "win", "set_grid_mode", ("columns",),
     checkable=True, checked="is_grid_mode", checked_args=("columns",))
_add("grid_fit", "Fit Cells (maximize photo area)", "win", "toggle_grid_flag",
     ("fit_cells",), checkable=True, checked="grid_flag", checked_args=("fit_cells",))
_add("grid_fixed", "Fixed Grid", "win", "toggle_grid_flag", ("fixed",),
     checkable=True, checked="grid_flag", checked_args=("fixed",))
_add("grid_size", "Grid Size...", "win", "ask_grid_size")
_add("grid_show_all", "Show All Cells", "win", "toggle_grid_flag", ("show_all_cells",),
     checkable=True, checked="grid_flag", checked_args=("show_all_cells",))
_add("grid_spacing", "Cell Spacing...", "win", "ask_grid_spacing")
_add("grid_more", "More Columns", "win", "change_grid_size", (1,), shortcut="Ctrl+=")
_add("grid_less", "Fewer Columns", "win", "change_grid_size", (-1,), shortcut="Ctrl+-")
_add("sync_view", "Sync View (zoom & pan all together)", "win", "toggle_pl_flag",
     ("sync_view",), shortcut="Ctrl+Y", checkable=True, checked="pl_flag",
     checked_args=("sync_view",))
_add("shuffle_on_load", "Shuffle Grid On Load", "win", "toggle_pl_flag",
     ("shuffle_on_load",), checkable=True, checked="pl_flag",
     checked_args=("shuffle_on_load",))
_add("disable_click", "Disable Mouse Click Events", "win", "toggle_pl_flag",
     ("disable_click",), checkable=True, checked="pl_flag", checked_args=("disable_click",))
_add("disable_wheel", "Disable Mouse Wheel Events", "win", "toggle_pl_flag",
     ("disable_wheel",), checkable=True, checked="pl_flag", checked_args=("disable_wheel",))
_add("disable_overlay", "Disable Overlay", "win", "toggle_pl_flag",
     ("disable_overlay",), shortcut="Ctrl+D", checkable=True, checked="pl_flag",
     checked_args=("disable_overlay",))
_add("overlay_border", "Show Overlay Border", "win", "toggle_pl_flag",
     ("overlay_border",), checkable=True, checked="pl_flag", checked_args=("overlay_border",))
_add("overlay_hide", "Hide Overlay After Timeout", "win", "toggle_pl_flag",
     ("overlay_hide",), checkable=True, checked="pl_flag", checked_args=("overlay_hide",))
for _i in range(10):
    _add(f"snapshot_save_{_i}", f"Save Snapshot {_i}", "win", "snapshot_save", (_i,),
         shortcut=f"Ctrl+Alt+{_i}", group="snapshot")
    _add(f"snapshot_load_{_i}", f"Load Snapshot {_i}", "win", "snapshot_load", (_i,),
         shortcut=f"Ctrl+{_i}", group="snapshot")
    _add(f"snapshot_delete_{_i}", f"Delete Snapshot {_i}", "win", "snapshot_delete", (_i,),
         group="snapshot")

# --- Program ----------------------------------------------------------------
_add("add_files", "Add Files...", "win", "add_files_dialog", shortcut="Ctrl+A")
_add("add_folder", "Add Folder...", "win", "add_folder_dialog", shortcut="Ctrl+Shift+A")
_add("add_clipboard", "Add from Clipboard", "win", "add_clipboard", shortcut="Ctrl+V")
_add("open_playlist", "Open Grid...", "win", "open_playlist_dialog", shortcut="Ctrl+O")
_add("save_playlist", "Save Grid", "win", "save_playlist", shortcut="Ctrl+S")
_add("save_playlist_as", "Save Grid As...", "win", "save_playlist_as",
     shortcut="Ctrl+Shift+S")
_add("close_playlist", "Close All", "win", "close_playlist", shortcut="Ctrl+Shift+Q")
_add("fullscreen", "Fullscreen", "win", "toggle_fullscreen", shortcut="F;F11",
     checkable=True, checked="is_fullscreen")
_add("stay_on_top", "Stay on Top", "win", "toggle_on_top", shortcut="Ctrl+T",
     checkable=True, checked="is_on_top")
_add("escape", "Exit Single Mode / Fullscreen", "win", "escape", shortcut="Esc")
_add("settings", "Settings...", "win", "open_settings", shortcut="F6")
_add("shortcuts", "Keyboard Shortcuts", "win", "show_shortcuts", shortcut="F2")
_add("about", "About", "win", "show_about", shortcut="F1")
_add("quit", "Quit", "win", "close", shortcut="Q;Ctrl+Q")

COMMANDS_BY_ID = {c.id: c for c in COMMANDS}


def default_shortcuts(cid):
    return [s for s in COMMANDS_BY_ID[cid].shortcut.split(";") if s]
