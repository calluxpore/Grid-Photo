"""Persistent application settings (QSettings backed)."""

import json
import os

from PyQt6.QtCore import QSettings, QStandardPaths

DEFAULTS = {
    # Player
    "start_maximized": False,
    "start_fullscreen": False,
    "stay_on_top": False,
    "one_instance": True,
    "color_scheme": "dark",  # system / light / dark
    "pan_trigger": "left",  # left (when zoomed) / middle / ctrl / shift / alt / disabled
    "drag_swap": True,
    "wheel_action": "zoom",  # zoom / browse (Ctrl inverts)
    "recent_list_enabled": True,
    "recent_list_max_size": 15,
    "smooth_scaling": True,
    "background_color": "#000000",
    "preview_max_size": 2560,  # long edge of the initially decoded image
    # Misc
    "mouse_hide": True,
    "mouse_hide_timeout": 3,
    "overlay_timeout": 3,
    "zoom_step": 1.2,
    "move_step": 0.05,
    "crop_step": 0.02,
    "include_subfolders": False,
    "sort_mode": "name",  # name / date / size
    # Screenshots (save view)
    "screenshot_dir": "",
    "screenshot_format": "png",
    "screenshot_jpg_quality": 92,
    # Defaults: playlist
    "def_grid_layout": "masonry",
    "def_grid_mode": "rows",
    "def_grid_fit_cells": True,
    "def_grid_spacing": 4,
    "corner_radius": 10,
    "def_overlay_border": True,
    "def_overlay_hide": True,
    "def_disable_overlay": False,
    # Defaults: photo
    "def_aspect": "fit",
    "def_slideshow_interval": 5.0,
    "def_slideshow_order": "next",
    # Shortcuts (json overrides of default keymap)
    "keymap": "{}",
    "recent_files": "[]",
    "recent_playlists": "[]",
    "last_dir": "",
    "save_as_dir": "",
}


class Settings:
    def __init__(self):
        self._qs = QSettings("GridPhoto", "GridPhoto")

    def get(self, key):
        default = DEFAULTS[key]
        value = self._qs.value(key, default)
        if isinstance(default, bool):
            if isinstance(value, str):
                return value.lower() in ("1", "true", "yes")
            return bool(value)
        if isinstance(default, int):
            try:
                return int(value)
            except (TypeError, ValueError):
                return default
        if isinstance(default, float):
            try:
                return float(value)
            except (TypeError, ValueError):
                return default
        return value

    def set(self, key, value):
        self._qs.setValue(key, value)

    def sync(self):
        self._qs.sync()

    # JSON helpers
    def get_json(self, key):
        try:
            return json.loads(self.get(key))
        except (TypeError, ValueError):
            return json.loads(DEFAULTS[key])

    def set_json(self, key, value):
        self.set(key, json.dumps(value))

    def add_recent(self, key, path):
        if not self.get("recent_list_enabled"):
            return
        items = [p for p in self.get_json(key) if p != path]
        items.insert(0, path)
        self.set_json(key, items[: self.get("recent_list_max_size")])

    def screenshot_dir(self):
        d = self.get("screenshot_dir")
        if d and os.path.isdir(d):
            return d
        return QStandardPaths.writableLocation(
            QStandardPaths.StandardLocation.PicturesLocation
        )


settings = None


def init_settings():
    global settings
    settings = Settings()
    return settings
