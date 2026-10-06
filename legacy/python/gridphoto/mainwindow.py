"""Main window: owns the playlist state, the cells, actions and menus."""

import json
import os
import random
import shutil
import tempfile
import time

from PyQt6.QtCore import QByteArray, QEvent, QSettings, Qt, QTimer, QUrl
from PyQt6.QtGui import QAction, QCursor, QGuiApplication, QKeySequence
from PyQt6.QtWidgets import (
    QApplication, QFileDialog, QInputDialog, QMainWindow, QMenu, QMessageBox,
)

from gridphoto import __app_name__, __version__, imageloader
from gridphoto.actions import COMMANDS, default_shortcuts
from gridphoto.dialogs import (
    SettingsDialog, ShortcutsDialog, apply_app_theme, ask_folder_import,
)
from gridphoto.grid import GridWidget
from gridphoto.models import CellState, GridState, PlaylistState
from gridphoto.photocell import PhotoCell

FOLDER_PROMPT_THRESHOLD = 16


class MainWindow(QMainWindow):
    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.playlist = self._new_playlist_state()
        self.cells = []
        self.active_cell = None
        self.single_cell = None
        self.playlist_path = None
        self.dirty = False
        self.exporting = False
        self._cursor_hidden = False

        self.setWindowTitle(__app_name__)
        self.setAcceptDrops(True)
        self.resize(1280, 800)
        self.setMinimumSize(320, 240)

        self.grid = GridWidget(self)
        self.setCentralWidget(self.grid)

        self._relayout_timer = QTimer(self, singleShot=True, interval=30)
        self._relayout_timer.timeout.connect(self.grid.relayout)

        self._mouse_timer = QTimer(self, singleShot=True)
        self._mouse_timer.timeout.connect(self._hide_cursor)

        self.actions_by_id = {}
        self._build_actions()
        QApplication.instance().installEventFilter(self)

        geo = QSettings("GridPhoto", "GridPhoto").value("geometry")
        if isinstance(geo, QByteArray):
            self.restoreGeometry(geo)
        if settings.get("stay_on_top"):
            self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)

    # ----------------------------------------------------------- state
    def _new_playlist_state(self):
        g = self.settings.get
        return PlaylistState(
            grid=GridState(
                layout=g("def_grid_layout"),
                mode=g("def_grid_mode"),
                fit_cells=g("def_grid_fit_cells"),
                spacing=g("def_grid_spacing"),
            ),
            overlay_border=g("def_overlay_border"),
            overlay_hide=g("def_overlay_hide"),
            disable_overlay=g("def_disable_overlay"),
        )

    def _new_cell_state(self, path):
        g = self.settings.get
        return CellState(
            path=path,
            aspect=g("def_aspect"),
            slideshow_interval=g("def_slideshow_interval"),
            slideshow_order=g("def_slideshow_order"),
        )

    def set_dirty(self, dirty=True):
        self.dirty = dirty
        self._update_title()

    def _update_title(self):
        title = __app_name__
        if self.playlist_path:
            name = os.path.splitext(os.path.basename(self.playlist_path))[0]
            title = f"{name}{'*' if self.dirty else ''} - {title}"
        if self.cells:
            title += f"  [{len(self.cells)}]"
        self.setWindowTitle(title)

    # ------------------------------------------------------------ actions
    def shortcuts_for(self, cid):
        keymap = self.settings.get_json("keymap")
        if cid in keymap:
            return keymap[cid]
        return default_shortcuts(cid)

    def _build_actions(self):
        for cmd in COMMANDS:
            act = QAction(cmd.title, self)
            act.setCheckable(cmd.checkable)
            act.setShortcutContext(Qt.ShortcutContext.WindowShortcut)
            act.triggered.connect(lambda _=False, c=cmd: self.dispatch(c))
            self.addAction(act)
            self.actions_by_id[cmd.id] = act
        self._apply_shortcuts()

    def _apply_shortcuts(self):
        for cmd in COMMANDS:
            seqs = [QKeySequence(s) for s in self.shortcuts_for(cmd.id)]
            self.actions_by_id[cmd.id].setShortcuts(seqs)

    def _target_cell(self):
        if self.active_cell in self.cells:
            return self.active_cell
        if self.single_cell is not None:
            return self.single_cell
        return self.cells[0] if self.cells else None

    def dispatch(self, cmd):
        if cmd.target == "win":
            getattr(self, cmd.method)(*cmd.args)
            return
        if cmd.target == "cell":
            cell = self._target_cell()
            if cell is not None:
                getattr(cell, cmd.method)(*cmd.args)
            return
        # [ALL]
        cells = self.visible_cells()
        if not cells:
            return
        if cmd.method.startswith("ask_"):
            ref = self._target_cell()
            value = getattr(ref, cmd.method)(apply=False)
            if value is None:
                return
            setter = "set_" + cmd.method[4:]
            for cell in cells:
                getattr(cell, setter)(value)
            return
        if cmd.method in ("toggle_slideshow", "toggle_animation"):
            # make all cells consistent, like "play/pause all"
            ref = self._target_cell()
            if cmd.method == "toggle_slideshow":
                on = not ref.state.slideshow
                for cell in cells:
                    cell.set_slideshow(on)
            else:
                paused = not ref.state.animation_paused
                for cell in cells:
                    if cell.state.animation_paused != paused:
                        cell.toggle_animation()
            return
        for cell in cells:
            getattr(cell, cmd.method)(*cmd.args)

    def _sync_checks(self, cell):
        for cmd in COMMANDS:
            if not cmd.checkable or not cmd.checked:
                continue
            obj = self if cmd.target == "win" else cell
            if obj is None:
                continue
            self.actions_by_id[cmd.id].setChecked(bool(getattr(obj, cmd.checked)(*cmd.checked_args)))

    # --------------------------------------------------------------- menu
    def show_context_menu(self, global_pos):
        cell = self.active_cell if self.active_cell in self.cells else None
        self._sync_checks(cell)
        a = self.actions_by_id
        menu = QMenu(self)

        def add(m, *ids):
            for cid in ids:
                if cid == "-":
                    m.addSeparator()
                else:
                    m.addAction(a[cid])

        if cell is not None:
            name = cell.state.title or os.path.basename(cell.state.path) or "(empty)"
            header = menu.addAction(name)
            header.setEnabled(False)
            menu.addSeparator()
            add(menu, "save_as", "-")

            m = menu.addMenu("Browse")
            add(m, "prev_file", "next_file", "first_file", "last_file", "random_file")
            seek = m.addMenu("Jump to")
            add(seek, *[f"seek_{i}" for i in range(10)])

            m = menu.addMenu("Slideshow")
            add(m, "slideshow", "-", "slideshow_faster", "slideshow_slower",
                "slideshow_normal", "slideshow_interval", "-",
                "slideshow_order_next", "slideshow_order_previous",
                "slideshow_order_shuffle")
            if cell.movie is not None:
                add(m, "-", "animation")

            m = menu.addMenu("Zoom && Position")
            add(m, "zoom_in", "zoom_out", "zoom_reset", "zoom_100", "-",
                "move_left", "move_right", "move_up", "move_down", "position_reset")
            al = m.addMenu("Align")
            add(al, "align_center", "align_top", "align_bottom", "align_left",
                "align_right", "align_top_left", "align_top_right",
                "align_bottom_left", "align_bottom_right")

            m = menu.addMenu("Aspect")
            add(m, "aspect_fit", "aspect_fill", "aspect_stretch", "aspect_none", "-",
                "aspect_cycle")

            m = menu.addMenu("Rotate && Flip")
            add(m, "rotate_cw", "rotate_ccw", "rotate_180", "-", "flip_h", "flip_v",
                "-", "transform_reset")

            m = menu.addMenu("Crop")
            add(m, "crop_l_inc", "crop_l_dec", "crop_t_inc", "crop_t_dec",
                "crop_r_inc", "crop_r_dec", "crop_b_inc", "crop_b_dec", "-",
                "crop_reset")

            add(menu, "reset_all")

            m = menu.addMenu("File")
            add(m, "save_as", "export_view", "copy_image", "copy_path", "-", "show_info",
                "open_folder", "open_external", "-", "replace_file", "rename",
                "trash", "reload")

            menu.addSeparator()
            add(menu, "single_mode", "apply_view_others", "close_cell")
            menu.addSeparator()

        if self.cells:
            m = menu.addMenu("All Photos")
            add(m, "slideshow_all", "slideshow_faster_all", "slideshow_slower_all",
                "slideshow_normal_all", "slideshow_interval_all")
            order = m.addMenu("Slideshow Order")
            add(order, "slideshow_order_next_all", "slideshow_order_previous_all",
                "slideshow_order_shuffle_all")
            add(m, "-", "prev_file_all", "next_file_all", "first_file_all",
                "last_file_all", "random_file_all")
            seek = m.addMenu("Jump to")
            add(seek, *[f"seek_{i}_all" for i in range(10)])
            add(m, "-", "zoom_in_all", "zoom_out_all", "zoom_reset_all", "zoom_100_all")
            asp = m.addMenu("Aspect")
            add(asp, "aspect_fit_all", "aspect_fill_all", "aspect_stretch_all",
                "aspect_none_all")
            al = m.addMenu("Align")
            add(al, "align_center_all", "align_top_all", "align_bottom_all",
                "align_left_all", "align_right_all")
            tr = m.addMenu("Rotate && Flip")
            add(tr, "rotate_cw_all", "rotate_ccw_all", "rotate_180_all", "flip_h_all",
                "flip_v_all", "transform_reset_all")
            add(m, "-", "crop_reset_all", "reset_all_all", "reload_all", "animation_all")
            add(m, "-", "save_all_as")

            m = menu.addMenu("Grid")
            add(m, "layout_masonry", "layout_grid", "keep_order", "-", "grid_rows", "grid_columns",
                "-", "grid_fit", "grid_fixed",
                "grid_size", "grid_show_all", "grid_more", "grid_less", "grid_spacing",
                "-", "shuffle_grid", "sort_grid", "shuffle_on_load", "-", "sync_view")

            m = menu.addMenu("Snapshots")
            save = m.addMenu("Save")
            add(save, *[f"snapshot_save_{i}" for i in range(10)])
            load = m.addMenu("Load")
            delete = m.addMenu("Delete")
            for i in range(10):
                exists = str(i) in self.playlist.snapshots
                if exists:
                    load.addAction(a[f"snapshot_load_{i}"])
                    delete.addAction(a[f"snapshot_delete_{i}"])
            load.setEnabled(bool(self.playlist.snapshots))
            delete.setEnabled(bool(self.playlist.snapshots))

            m = menu.addMenu("Options")
            add(m, "disable_click", "disable_wheel", "disable_overlay",
                "overlay_border", "overlay_hide")
            menu.addSeparator()

        add(menu, "add_files", "add_folder", "add_clipboard")
        self._recent_menu(menu, "Recent Files", "recent_files", self.add_paths)
        menu.addSeparator()
        add(menu, "open_playlist")
        self._recent_menu(menu, "Recent Grids", "recent_playlists", self.open_playlist)
        if self.cells:
            add(menu, "save_all_as", "save_playlist", "save_playlist_as", "export_grid", "close_playlist")
        menu.addSeparator()
        add(menu, "fullscreen", "stay_on_top", "-", "settings", "shortcuts", "about", "quit")
        self._show_cursor()
        menu.exec(global_pos)

    def _recent_menu(self, parent, title, key, handler):
        if not self.settings.get("recent_list_enabled"):
            return
        items = [p for p in self.settings.get_json(key) if os.path.exists(p)]
        m = parent.addMenu(title)
        m.setEnabled(bool(items))
        for p in items:
            act = m.addAction(os.path.normpath(p))
            act.triggered.connect(lambda _=False, p=p: handler([p] if handler == self.add_paths else p))
        if items:
            m.addSeparator()
            clear = m.addAction("Clear list")
            clear.triggered.connect(lambda: self.settings.set_json(key, []))

    # ------------------------------------------------------ cell plumbing
    def all_cells(self):
        return list(self.cells)

    def visible_cells(self):
        if self.single_cell is not None:
            return [self.single_cell]
        return list(self.cells)

    def visible_cell_count(self):
        return len(self.visible_cells())

    def cell_index(self, cell):
        return self.cells.index(cell)

    def accent_color(self):
        return self.palette().highlight().color().name()

    def set_active(self, cell):
        if self.active_cell is cell:
            return
        if self.active_cell is not None and self.active_cell in self.cells:
            self.active_cell.set_active(False)
        self.active_cell = cell
        if cell is not None:
            cell.set_active(True)

    def _make_cell(self, state):
        cell = PhotoCell(self, state, self.grid)
        cell.activated.connect(self.set_active)
        cell.loaded.connect(self._on_cell_loaded)
        cell.changed.connect(self.set_dirty)
        cell.view_changed.connect(self._on_view_changed)
        return cell

    def _on_cell_loaded(self, cell):
        g = self.playlist.grid
        if g.layout == "masonry" or (g.fit_cells and not g.fixed):
            self._relayout_timer.start()

    def _on_view_changed(self, cell):
        if self.playlist.sync_view:
            for other in self.cells:
                if other is not cell:
                    other.copy_view_from(cell)

    def add_states(self, states):
        for st in states:
            cell = self._make_cell(st)
            self.cells.append(cell)
            cell.show()
        if self.cells and self.active_cell is None:
            self.set_active(self.cells[0])
        self.grid.relayout()
        self.set_dirty()

    def add_paths(self, paths):
        """Add files and folders as new cells."""
        recursive = self.settings.get("include_subfolders")
        sort_mode = self.settings.get("sort_mode")
        files = []
        for p in paths:
            if os.path.isdir(p):
                found = imageloader.list_folder(p, recursive, sort_mode)
                if len(found) > FOLDER_PROMPT_THRESHOLD:
                    choice = ask_folder_import(self, len(found), os.path.basename(p) or p)
                    if choice is None:
                        continue
                    if choice == "some":
                        found = found[:FOLDER_PROMPT_THRESHOLD]
                    elif choice == "one":
                        found = found[:1]
                files.extend(found)
            elif os.path.isfile(p):
                if p.lower().endswith(imageloader.PLAYLIST_EXTENSION):
                    self.open_playlist(p)
                elif imageloader.is_image(p):
                    files.append(p)
        if files:
            self.add_states([self._new_cell_state(f) for f in files])
            for f in files[:self.settings.get("recent_list_max_size")]:
                self.settings.add_recent("recent_files", f)
        return len(files)

    def drop_files(self, paths, replace_cell):
        if not paths:
            return
        if replace_cell is not None:
            files = imageloader.expand_paths(paths, False, self.settings.get("sort_mode"))
            if files:
                replace_cell.load_path(files[0])
            return
        self.add_paths(paths)

    def swap_cells(self, src, dst):
        if src == dst or not (0 <= src < len(self.cells)) or not (0 <= dst < len(self.cells)):
            return
        self.cells[src], self.cells[dst] = self.cells[dst], self.cells[src]
        self.grid.relayout()
        self.set_dirty()

    def close_cell(self, cell):
        if cell not in self.cells:
            return
        if self.single_cell is cell:
            self.single_cell = None
        idx = self.cells.index(cell)
        self.cells.remove(cell)
        cell.shutdown()
        cell.deleteLater()
        if self.active_cell is cell:
            self.active_cell = None
            if self.cells:
                self.set_active(self.cells[min(idx, len(self.cells) - 1)])
        self.grid.relayout()
        self.set_dirty()

    def close_active(self):
        cell = self._target_cell()
        if cell is not None:
            self.close_cell(cell)

    def path_renamed(self, old, new):
        for cell in self.cells:
            if os.path.normcase(cell.state.path) == os.path.normcase(old):
                cell.state.path = new
                cell.update()
        self.set_dirty()

    def replace_active(self):
        cell = self._target_cell()
        if cell is None:
            return
        start = os.path.dirname(cell.state.path) if cell.state.path else ""
        path, _ = QFileDialog.getOpenFileName(self, "Replace image", start,
                                              imageloader.file_filter())
        if path:
            cell.load_path(path)

    def apply_view_to_others(self):
        src = self._target_cell()
        if src is None:
            return
        for cell in self.cells:
            if cell is src:
                continue
            cell.state.aspect = src.state.aspect
            cell.state.align = src.state.align
            cell.copy_view_from(src)
        self._relayout_timer.start()

    # ---------------------------------------------------------- navigation
    def toggle_single(self, cell=None):
        if self.single_cell is not None:
            self.single_cell = None
        else:
            cell = cell or self._target_cell()
            if cell is None or len(self.cells) < 2:
                return
            self.single_cell = cell
            self.set_active(cell)
        self.grid.relayout()

    def is_single(self):
        return self.single_cell is not None

    def cycle_active(self, step):
        if not self.cells:
            return
        cur = self._target_cell()
        idx = (self.cells.index(cur) + step) % len(self.cells)
        cell = self.cells[idx]
        self.set_active(cell)
        if self.single_cell is not None:
            self.single_cell = cell
            self.grid.relayout()
        cell.flash(os.path.basename(cell.state.path), 0.8)

    def escape(self):
        if self.single_cell is not None:
            self.toggle_single()
        elif self.isFullScreen():
            self.toggle_fullscreen()

    # ----------------------------------------------------------------- grid
    def set_layout(self, layout):
        self.playlist.grid.layout = layout
        self.grid.relayout()
        self.set_dirty()

    def is_layout(self, layout):
        return self.playlist.grid.layout == layout

    def toggle_layout(self):
        self.set_layout("grid" if self.is_layout("masonry") else "masonry")

    def set_grid_mode(self, mode):
        self.playlist.grid.mode = mode
        self.grid.relayout()
        self.set_dirty()

    def is_grid_mode(self, mode):
        return self.playlist.grid.mode == mode

    def toggle_grid_flag(self, flag):
        g = self.playlist.grid
        setattr(g, flag, not getattr(g, flag))
        if flag == "fixed" and g.fixed and g.size <= 0:
            g.size = max(1, self.grid.cols if g.mode == "rows" else self.grid.rows)
        self.grid.relayout()
        self.set_dirty()

    def grid_flag(self, flag):
        return getattr(self.playlist.grid, flag)

    def ask_grid_size(self):
        g = self.playlist.grid
        label = "Columns:" if g.mode == "rows" else "Rows:"
        current = g.size or (self.grid.cols if g.mode == "rows" else self.grid.rows) or 2
        value, ok = QInputDialog.getInt(self, "Grid size", label, current, 1, 64)
        if ok:
            g.size = value
            g.fixed = True
            self.grid.relayout()
            self.set_dirty()

    def change_grid_size(self, step):
        g = self.playlist.grid
        current = g.size if g.fixed and g.size else (
            self.grid.cols if g.mode == "rows" else self.grid.rows) or 1
        g.size = max(1, min(64, current + step))
        g.fixed = True
        self.grid.relayout()
        self.set_dirty()

    def ask_grid_spacing(self):
        value, ok = QInputDialog.getInt(self, "Cell spacing", "Spacing (px):",
                                        self.playlist.grid.spacing, 0, 40)
        if ok:
            self.playlist.grid.spacing = value
            self.grid.relayout()
            self.set_dirty()

    def shuffle_grid(self):
        random.shuffle(self.cells)
        self.grid.relayout()
        self.set_dirty()

    def sort_grid(self):
        from gridphoto.imageloader import _natural_key

        self.cells.sort(key=lambda c: _natural_key(os.path.basename(c.state.path)))
        self.grid.relayout()
        self.set_dirty()

    def toggle_pl_flag(self, flag):
        setattr(self.playlist, flag, not getattr(self.playlist, flag))
        for cell in self.cells:
            cell.update()
        if flag == "sync_view" and self.playlist.sync_view and self.active_cell:
            self._on_view_changed(self.active_cell)
        self.set_dirty()

    def pl_flag(self, flag):
        return getattr(self.playlist, flag)

    # ------------------------------------------------------------ snapshots
    def _cells_snapshot(self):
        from dataclasses import asdict

        return {
            "grid": asdict(self.playlist.grid),
            "cells": [c.state.to_dict() for c in self.cells],
        }

    def snapshot_save(self, i):
        if not self.cells:
            return
        self.playlist.snapshots[str(i)] = self._cells_snapshot()
        self.set_dirty()
        cell = self._target_cell()
        if cell:
            cell.flash(f"Snapshot {i} saved")

    def snapshot_load(self, i):
        snap = self.playlist.snapshots.get(str(i))
        if not snap:
            return
        data = dict(snap)
        tmp = PlaylistState.from_dict(data)
        self._clear_cells()
        self.playlist.grid = tmp.grid
        self.add_states(tmp.cells)
        if self.cells:
            self.cells[0].flash(f"Snapshot {i}")

    def snapshot_delete(self, i):
        self.playlist.snapshots.pop(str(i), None)
        self.set_dirty()

    # ----------------------------------------------------------- file I/O
    def add_files_dialog(self):
        start = self._last_dir()
        paths, _ = QFileDialog.getOpenFileNames(self, "Add photos", start,
                                                imageloader.file_filter())
        if paths:
            self.settings.set("last_dir", os.path.dirname(paths[0]))
            self.add_paths(paths)

    def add_folder_dialog(self):
        folder = QFileDialog.getExistingDirectory(self, "Add folder", self._last_dir())
        if folder:
            self.settings.set("last_dir", folder)
            if not self.add_paths([folder]):
                QMessageBox.information(self, "Add folder", "No supported photos found.")

    def _last_dir(self):
        d = self.settings.get("last_dir")
        return d if d and os.path.isdir(d) else ""

    def add_clipboard(self):
        md = QGuiApplication.clipboard().mimeData()
        paths = []
        if md.hasUrls():
            paths = [u.toLocalFile() for u in md.urls() if u.isLocalFile()]
        elif md.hasText():
            for raw in md.text().splitlines():
                path = raw.strip().strip('"')
                if path.startswith("file:"):
                    path = QUrl(path).toLocalFile()
                if path and os.path.exists(path):
                    paths.append(path)
        if paths:
            self.add_paths(paths)
            return
        if md.hasImage():
            img = QGuiApplication.clipboard().image()
            if not img.isNull():
                folder = os.path.join(tempfile.gettempdir(), "GridPhoto")
                os.makedirs(folder, exist_ok=True)
                path = os.path.join(folder, f"clipboard_{time.strftime('%Y%m%d_%H%M%S')}.png")
                img.save(path)
                self.add_paths([path])

    def open_playlist_dialog(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Open grid", self._last_dir(),
            f"GridPhoto grid (*{imageloader.PLAYLIST_EXTENSION});;All files (*)")
        if path:
            self.open_playlist(path)

    def open_playlist(self, path):
        if not self._maybe_save():
            return
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            state = PlaylistState.from_dict(data)
        except (OSError, ValueError) as e:
            QMessageBox.warning(self, "Open grid", f"Could not open grid:\n{e}")
            return
        base = os.path.dirname(os.path.abspath(path))
        for c in state.cells:
            if c.path and not os.path.isabs(c.path):
                c.path = os.path.normpath(os.path.join(base, c.path))
        self._clear_cells()
        self.playlist = state
        if state.shuffle_on_load:
            random.shuffle(state.cells)
        cells = state.cells
        state.cells = []
        self.add_states(cells)
        self.playlist_path = path
        self.settings.add_recent("recent_playlists", path)
        self.set_dirty(False)

    def _write_playlist(self, path):
        self.playlist.cells = [c.state for c in self.cells]
        data = self.playlist.to_dict()
        # store paths relative to the grid file when possible
        base = os.path.dirname(os.path.abspath(path))
        for c in data["cells"]:
            try:
                rel = os.path.relpath(c["path"], base)
                if not rel.startswith(".."):
                    c["path"] = rel
            except ValueError:
                pass  # different drive
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except OSError as e:
            QMessageBox.warning(self, "Save grid", f"Could not save grid:\n{e}")
            return False
        self.playlist_path = path
        self.settings.add_recent("recent_playlists", path)
        self.set_dirty(False)
        return True

    def save_playlist(self):
        if self.playlist_path:
            return self._write_playlist(self.playlist_path)
        return self.save_playlist_as()

    def save_playlist_as(self):
        start = self.playlist_path or os.path.join(self._last_dir(), "grid" + imageloader.PLAYLIST_EXTENSION)
        path, _ = QFileDialog.getSaveFileName(
            self, "Save grid", start,
            f"GridPhoto grid (*{imageloader.PLAYLIST_EXTENSION})")
        if not path:
            return False
        if not path.lower().endswith(imageloader.PLAYLIST_EXTENSION):
            path += imageloader.PLAYLIST_EXTENSION
        return self._write_playlist(path)

    def _maybe_save(self):
        """Ask to save changes of a saved grid. Returns False if cancelled."""
        if not (self.dirty and self.playlist_path and self.cells):
            return True
        answer = QMessageBox.question(
            self, "Unsaved changes",
            f"Save changes to \"{os.path.basename(self.playlist_path)}\"?",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if answer == QMessageBox.StandardButton.Cancel:
            return False
        if answer == QMessageBox.StandardButton.Save:
            return self.save_playlist()
        return True

    def _clear_cells(self):
        for cell in self.cells:
            cell.shutdown()
            cell.deleteLater()
        self.cells = []
        self.active_cell = None
        self.single_cell = None

    def close_playlist(self):
        if not self._maybe_save():
            return
        self._clear_cells()
        self.playlist = self._new_playlist_state()
        self.playlist_path = None
        self.grid.relayout()
        self.set_dirty(False)

    def save_dir(self, fallback=""):
        d = self.settings.get("save_as_dir")
        if d and os.path.isdir(d):
            return d
        return fallback or self.settings.screenshot_dir()

    def remember_save_dir(self, folder):
        if folder and os.path.isdir(folder):
            self.settings.set("save_as_dir", folder)
            self.settings.sync()

    def save_all_as(self):
        if not self.cells:
            return
        first = self.cells[0].state.path
        folder = QFileDialog.getExistingDirectory(
            self, "Save all photos to folder",
            self.save_dir(os.path.dirname(first) if first else ""))
        if not folder:
            return
        self.remember_save_dir(folder)


        saved, failed, overwrite = 0, [], None
        for cell in self.cells:
            src = cell.state.path
            if not src or not os.path.isfile(src):
                continue
            dest = os.path.join(folder, os.path.basename(src))
            if os.path.normcase(os.path.abspath(dest)) == os.path.normcase(src):
                continue
            if os.path.exists(dest):
                if overwrite is None:
                    answer = QMessageBox.question(
                        self, "Files exist",
                        "Some files already exist in that folder. Overwrite them?\n"
                        "(No keeps both by adding a number to the new file names)",
                        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
                        | QMessageBox.StandardButton.Cancel)
                    if answer == QMessageBox.StandardButton.Cancel:
                        break
                    overwrite = answer == QMessageBox.StandardButton.Yes
                if not overwrite:
                    base, ext = os.path.splitext(dest)
                    n = 1
                    while os.path.exists(f"{base} ({n}){ext}"):
                        n += 1
                    dest = f"{base} ({n}){ext}"
            try:
                if cell.has_edits():
                    img = cell.render_full()
                    if img.isNull() or not img.save(dest):
                        raise OSError(dest)
                else:
                    shutil.copy2(src, dest)
                saved += 1
            except OSError:
                failed.append(os.path.basename(src))
        msg = f"Saved {saved} photo(s) to\n{os.path.normpath(folder)}"
        if failed:
            msg += "\n\nFailed: " + ", ".join(failed[:10])
        QMessageBox.information(self, "Save all photos", msg)

    def export_grid(self):
        if not self.cells:
            return
        self.exporting = True
        for c in self.cells:
            c.update()
        pm = self.grid.grab()
        self.exporting = False
        for c in self.cells:
            c.update()
        fmt = self.settings.get("screenshot_format")
        default = os.path.join(self.settings.screenshot_dir(),
                               f"grid_{time.strftime('%Y%m%d_%H%M%S')}.{fmt}")
        path, _ = QFileDialog.getSaveFileName(
            self, "Save grid screenshot", default,
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;WebP (*.webp)")
        if path:
            q = self.settings.get("screenshot_jpg_quality") if path.lower().endswith(
                (".jpg", ".jpeg", ".webp")) else -1
            pm.save(path, None, q)

    # ------------------------------------------------------- window / misc
    def toggle_fullscreen(self):
        if self.isFullScreen():
            if getattr(self, "_was_maximized", False):
                self.showMaximized()
            else:
                self.showNormal()
        else:
            self._was_maximized = self.isMaximized()
            self.showFullScreen()

    def is_fullscreen(self):
        return self.isFullScreen()

    def toggle_on_top(self):
        on = not self.is_on_top()
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, on)
        self.show()

    def is_on_top(self):
        return bool(self.windowFlags() & Qt.WindowType.WindowStaysOnTopHint)

    def open_settings(self):
        old_spacing = self.settings.get("def_grid_spacing")
        dlg = SettingsDialog(self.settings, self)
        result = dlg.exec()
        if result == 1:
            dlg.save()
        if result in (1, 2):
            apply_app_theme(self.settings)
            self._apply_shortcuts()
            self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint,
                               self.settings.get("stay_on_top"))
            self.show()
            new_spacing = self.settings.get("def_grid_spacing")
            if new_spacing != old_spacing:  # only when the default was changed
                self.playlist.grid.spacing = new_spacing
            for cell in self.cells:
                cell._scaled_key = None
                cell.update()
            self.grid.relayout()

    def show_shortcuts(self):
        ShortcutsDialog(self.shortcuts_for, self).exec()

    def show_about(self):
        QMessageBox.about(
            self, f"About {__app_name__}",
            f"<h3>{__app_name__} {__version__}</h3>"
            "<p>View many photos at the same time in one window.</p>"
            "<p>Inspired by <a href='https://github.com/vzhd1701/gridplayer'>GridPlayer</a>.</p>"
            f"<p>Supported formats: {', '.join(sorted(e[1:] for e in imageloader.IMAGE_EXTENSIONS))}</p>",
        )

    # ------------------------------------------------------- mouse hiding
    def on_mouse_activity(self):
        self._show_cursor()
        if self.settings.get("mouse_hide") and self.cells:
            self._mouse_timer.start(self.settings.get("mouse_hide_timeout") * 1000)

    def _hide_cursor(self):
        if self._cursor_hidden or not self.isActiveWindow() or QApplication.activePopupWidget():
            return
        if QApplication.mouseButtons() != Qt.MouseButton.NoButton:
            return
        if not self.grid.rect().contains(self.grid.mapFromGlobal(QCursor.pos())):
            return
        QApplication.setOverrideCursor(Qt.CursorShape.BlankCursor)
        self._cursor_hidden = True

    def _show_cursor(self):
        if self._cursor_hidden:
            QApplication.restoreOverrideCursor()
            self._cursor_hidden = False

    def eventFilter(self, obj, event):
        if event.type() == QEvent.Type.MouseMove and self._cursor_hidden:
            self._show_cursor()
        return False

    # ---------------------------------------------------------------- events
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.drop_files([u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()], None)

    def changeEvent(self, event):
        if event.type() == QEvent.Type.WindowStateChange:
            self._relayout_timer.start()
        super().changeEvent(event)

    def closeEvent(self, event):
        if not self._maybe_save():
            event.ignore()
            return
        if not self.isFullScreen():
            QSettings("GridPhoto", "GridPhoto").setValue("geometry", self.saveGeometry())
        self._show_cursor()
        for cell in self.cells:
            cell.shutdown()
        event.accept()

    def receive_args(self, paths):
        """Paths from the command line or from another instance."""
        if not paths:
            return
        playlists = [p for p in paths if p.lower().endswith(imageloader.PLAYLIST_EXTENSION)]
        if playlists:
            self.open_playlist(playlists[0])
        others = [p for p in paths if p not in playlists]
        if others:
            self.add_paths(others)
        if self.isMinimized():
            self.showNormal()
        self.raise_()
        self.activateWindow()
