"""Settings dialog (incl. keyboard shortcut editor) and theme handling."""

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QKeySequence, QPalette
from PyQt6.QtWidgets import (
    QAbstractItemView, QApplication, QCheckBox, QColorDialog, QComboBox, QDialog,
    QDialogButtonBox, QDoubleSpinBox, QFileDialog, QFormLayout, QHBoxLayout,
    QHeaderView, QKeySequenceEdit, QLabel, QLineEdit, QListWidget, QMessageBox,
    QPushButton, QSpinBox, QStackedWidget, QStyleFactory, QTreeWidget,
    QTreeWidgetItem, QVBoxLayout, QWidget,
)

from gridphoto.actions import COMMANDS, default_shortcuts
from gridphoto.models import ASPECT_TITLES, SLIDESHOW_ORDER_TITLES
from gridphoto.settings import DEFAULTS


# ---------------------------------------------------------------- theming
def apply_theme(app, scheme):
    app.setStyle(QStyleFactory.create("Fusion"))
    if scheme == "system":
        app.setPalette(app.style().standardPalette())
        hints = app.styleHints()
        if hints.colorScheme() == Qt.ColorScheme.Dark:
            scheme = "dark"
        else:
            return
    if scheme == "light":
        app.setPalette(app.style().standardPalette())
        return
    pal = QPalette()
    base = QColor(30, 30, 32)
    window = QColor(40, 40, 43)
    text = QColor(225, 225, 225)
    accent = QColor(64, 140, 230)
    role = QPalette.ColorRole
    pal.setColor(role.Window, window)
    pal.setColor(role.WindowText, text)
    pal.setColor(role.Base, base)
    pal.setColor(role.AlternateBase, window)
    pal.setColor(role.ToolTipBase, window)
    pal.setColor(role.ToolTipText, text)
    pal.setColor(role.Text, text)
    pal.setColor(role.Button, window)
    pal.setColor(role.ButtonText, text)
    pal.setColor(role.BrightText, QColor(255, 80, 80))
    pal.setColor(role.Highlight, accent)
    pal.setColor(role.HighlightedText, QColor(255, 255, 255))
    pal.setColor(role.Link, accent)
    pal.setColor(role.PlaceholderText, QColor(130, 130, 130))
    dis = QPalette.ColorGroup.Disabled
    pal.setColor(dis, role.Text, QColor(120, 120, 120))
    pal.setColor(dis, role.ButtonText, QColor(120, 120, 120))
    pal.setColor(dis, role.WindowText, QColor(120, 120, 120))
    app.setPalette(pal)


# ------------------------------------------------------- shortcut editor
class KeymapEditor(QWidget):
    """Tree of commands with editable shortcuts."""

    def __init__(self, keymap, parent=None):
        super().__init__(parent)
        self.keymap = dict(keymap)  # id -> list of strings
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self.filter = QLineEdit(placeholderText="Filter by name or shortcut...")
        self.filter.textChanged.connect(self._apply_filter)
        lay.addWidget(self.filter)

        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Command", "Shortcut"])
        self.tree.setRootIsDecorated(False)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.tree.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.tree.header().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.tree.currentItemChanged.connect(self._on_select)
        lay.addWidget(self.tree, 1)

        row = QHBoxLayout()
        self.edit = QKeySequenceEdit()
        self.edit.setMaximumSequenceLength(1)
        row.addWidget(QLabel("Shortcut:"))
        row.addWidget(self.edit, 1)
        for title, slot in (("Assign", self._assign), ("Add", self._add),
                            ("Clear", self._clear), ("Default", self._default)):
            b = QPushButton(title)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)
        self.conflict = QLabel()
        self.conflict.setStyleSheet("color: #e07070")
        lay.addWidget(self.conflict)

        self.items = {}
        for cmd in COMMANDS:
            item = QTreeWidgetItem([cmd.title, ""])
            item.setData(0, Qt.ItemDataRole.UserRole, cmd.id)
            self.tree.addTopLevelItem(item)
            self.items[cmd.id] = item
            self._refresh(cmd.id)

    def shortcuts(self, cid):
        if cid in self.keymap:
            return self.keymap[cid]
        return default_shortcuts(cid)

    def _refresh(self, cid):
        seqs = [QKeySequence(s).toString(QKeySequence.SequenceFormat.NativeText)
                for s in self.shortcuts(cid)]
        self.items[cid].setText(1, ", ".join(seqs))

    def _current(self):
        item = self.tree.currentItem()
        return item.data(0, Qt.ItemDataRole.UserRole) if item else None

    def _on_select(self, *_):
        cid = self._current()
        self.edit.clear()
        self.conflict.clear()
        if cid and self.shortcuts(cid):
            self.edit.setKeySequence(QKeySequence(self.shortcuts(cid)[0]))

    def _new_seq(self):
        seq = self.edit.keySequence().toString(QKeySequence.SequenceFormat.PortableText)
        return seq

    def _check_conflict(self, cid, seq):
        target = QKeySequence(seq)
        for other in self.items:
            if other == cid:
                continue
            for s in self.shortcuts(other):
                if QKeySequence(s) == target:
                    self.keymap[other] = [x for x in self.shortcuts(other)
                                          if QKeySequence(x) != target]
                    self._refresh(other)
                    self.conflict.setText(
                        f"Removed {seq} from \"{self.items[other].text(0)}\"")

    def _assign(self):
        cid, seq = self._current(), self._new_seq()
        if cid and seq:
            self._check_conflict(cid, seq)
            self.keymap[cid] = [seq]
            self._refresh(cid)

    def _add(self):
        cid, seq = self._current(), self._new_seq()
        if cid and seq and seq not in self.shortcuts(cid):
            self._check_conflict(cid, seq)
            self.keymap[cid] = self.shortcuts(cid) + [seq]
            self._refresh(cid)

    def _clear(self):
        cid = self._current()
        if cid:
            self.keymap[cid] = []
            self._refresh(cid)
            self.edit.clear()

    def _default(self):
        cid = self._current()
        if cid:
            self.keymap.pop(cid, None)
            self._refresh(cid)
            self._on_select()

    def reset_all(self):
        self.keymap = {}
        for cid in self.items:
            self._refresh(cid)

    def _apply_filter(self, text):
        text = text.lower()
        for item in self.items.values():
            hay = (item.text(0) + " " + item.text(1)).lower()
            item.setHidden(bool(text) and text not in hay)

    def result_keymap(self):
        # store only differences from the defaults
        return {cid: v for cid, v in self.keymap.items() if v != default_shortcuts(cid)}


# --------------------------------------------------------- settings dialog
def _combo(options, current):
    box = QComboBox()
    for value, title in options:
        box.addItem(title, value)
    idx = box.findData(current)
    box.setCurrentIndex(max(0, idx))
    return box


class SettingsDialog(QDialog):
    def __init__(self, settings, parent=None):
        super().__init__(parent)
        self.settings = settings
        self.setWindowTitle("Settings")
        self.resize(760, 560)
        self.widgets = {}

        outer = QVBoxLayout(self)
        body = QHBoxLayout()
        outer.addLayout(body, 1)
        self.pages_list = QListWidget()
        self.pages_list.setFixedWidth(170)
        self.stack = QStackedWidget()
        body.addWidget(self.pages_list)
        body.addWidget(self.stack, 1)
        self.pages_list.currentRowChanged.connect(self.stack.setCurrentIndex)

        g = settings.get
        self._page("General", [
            ("color_scheme", "Color scheme", _combo(
                [("system", "System"), ("light", "Light"), ("dark", "Dark")],
                g("color_scheme"))),
            ("start_maximized", "Start maximized", self._check("start_maximized")),
            ("start_fullscreen", "Start fullscreen", self._check("start_fullscreen")),
            ("stay_on_top", "Stay on top", self._check("stay_on_top")),
            ("one_instance", "Open files in the running window (one instance)",
             self._check("one_instance")),
            ("recent_list_enabled", "Remember recent files and grids",
             self._check("recent_list_enabled")),
            ("recent_list_max_size", "Recent list size", self._spin(1, 100, g("recent_list_max_size"))),
            ("background_color", "Background color", self._color("background_color")),
            ("corner_radius", "Rounded corner radius (px)", self._spin(0, 60, g("corner_radius"))),
        ])
        self._page("Mouse && Display", [
            ("wheel_action", "Mouse wheel", _combo(
                [("zoom", "Zoom (Ctrl+wheel browses files)"),
                 ("browse", "Browse files (Ctrl+wheel zooms)")], g("wheel_action"))),
            ("pan_trigger", "Pan (move zoomed photo)", _combo(
                [("left", "Left drag when zoomed (Alt+drag swaps cells)"),
                 ("middle", "Middle button"), ("ctrl", "Ctrl + left drag"),
                 ("shift", "Shift + left drag"), ("alt", "Alt + left drag"),
                 ("disabled", "Disabled")], g("pan_trigger"))),
            ("drag_swap", "Drag cells to swap them", self._check("drag_swap")),
            ("mouse_hide", "Hide mouse cursor when idle", self._check("mouse_hide")),
            ("mouse_hide_timeout", "Hide cursor after (s)", self._spin(1, 60, g("mouse_hide_timeout"))),
            ("overlay_timeout", "Hide overlay after (s)", self._spin(1, 60, g("overlay_timeout"))),
            ("smooth_scaling", "Smooth (high quality) scaling", self._check("smooth_scaling")),
            ("zoom_step", "Zoom step (factor)", self._dspin(1.05, 3.0, g("zoom_step"), 2, 0.05)),
            ("move_step", "Move step (fraction of cell)", self._dspin(0.01, 0.5, g("move_step"), 2, 0.01)),
            ("crop_step", "Crop step (fraction of side)", self._dspin(0.005, 0.2, g("crop_step"), 3, 0.005)),
            ("preview_max_size", "Initial decode size (px, long edge)",
             self._spin(512, 16384, g("preview_max_size"), 256)),
        ])
        self._page("Files", [
            ("sort_mode", "Folder sort order", _combo(
                [("name", "Name (natural)"), ("date", "Date modified"), ("size", "File size")],
                g("sort_mode"))),
            ("include_subfolders", "Include subfolders when adding a folder",
             self._check("include_subfolders")),
            ("screenshot_dir", "Save folder", self._dir_picker("screenshot_dir")),
            ("screenshot_format", "Default save format", _combo(
                [("png", "PNG"), ("jpg", "JPG"), ("webp", "WebP")], g("screenshot_format"))),
            ("screenshot_jpg_quality", "JPG / WebP quality",
             self._spin(1, 100, g("screenshot_jpg_quality"))),
        ])
        self._page("Defaults: Grid", [
            ("def_grid_layout", "Layout", _combo(
                [("masonry", "Waterfall (masonry) - every photo uncropped, all fit"),
                 ("grid", "Grid - equal cells")], g("def_grid_layout"))),
            ("def_grid_mode", "Fill order (grid layout)", _combo(
                [("rows", "Rows first"), ("columns", "Columns first")], g("def_grid_mode"))),
            ("def_grid_fit_cells", "Fit cells (maximize photo area)",
             self._check("def_grid_fit_cells")),
            ("def_grid_spacing", "Gap between photos (px)", self._spin(0, 40, g("def_grid_spacing"))),
            ("def_overlay_border", "Show overlay border", self._check("def_overlay_border")),
            ("def_overlay_hide", "Hide overlay after timeout", self._check("def_overlay_hide")),
            ("def_disable_overlay", "Disable overlay", self._check("def_disable_overlay")),
        ])
        self._page("Defaults: Photo", [
            ("def_aspect", "Aspect", _combo(list(ASPECT_TITLES.items()), g("def_aspect"))),
            ("def_slideshow_interval", "Slideshow interval (s)",
             self._dspin(0.2, 3600, g("def_slideshow_interval"), 1, 0.5)),
            ("def_slideshow_order", "Slideshow order",
             _combo(list(SLIDESHOW_ORDER_TITLES.items()), g("def_slideshow_order"))),
        ])

        self.keymap_editor = KeymapEditor(settings.get_json("keymap"))
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.addWidget(self.keymap_editor)
        reset = QPushButton("Reset all shortcuts")
        reset.clicked.connect(self.keymap_editor.reset_all)
        lay.addWidget(reset, 0, Qt.AlignmentFlag.AlignLeft)
        self.stack.addWidget(page)
        self.pages_list.addItem("Shortcuts")

        self.pages_list.setCurrentRow(0)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok
            | QDialogButtonBox.StandardButton.Cancel
            | QDialogButtonBox.StandardButton.RestoreDefaults
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        buttons.button(QDialogButtonBox.StandardButton.RestoreDefaults).clicked.connect(
            self._restore_defaults)
        outer.addWidget(buttons)

    # widget helpers
    def _check(self, key):
        box = QCheckBox()
        box.setChecked(self.settings.get(key))
        return box

    @staticmethod
    def _spin(lo, hi, value, step=1):
        box = QSpinBox()
        box.setRange(lo, hi)
        box.setSingleStep(step)
        box.setValue(int(value))
        return box

    @staticmethod
    def _dspin(lo, hi, value, decimals, step):
        box = QDoubleSpinBox()
        box.setRange(lo, hi)
        box.setDecimals(decimals)
        box.setSingleStep(step)
        box.setValue(float(value))
        return box

    def _color(self, key):
        btn = QPushButton()
        btn.setProperty("color", self.settings.get(key))

        def refresh():
            c = btn.property("color")
            btn.setText(c)
            btn.setStyleSheet(f"background:{c}; color:{'#000' if QColor(c).lightness() > 128 else '#fff'}")

        def pick():
            c = QColorDialog.getColor(QColor(btn.property("color")), self)
            if c.isValid():
                btn.setProperty("color", c.name())
                refresh()

        btn.clicked.connect(pick)
        refresh()
        return btn

    def _dir_picker(self, key):
        w = QWidget()
        lay = QHBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        edit = QLineEdit(self.settings.get(key))
        edit.setPlaceholderText("Pictures folder")
        btn = QPushButton("Browse...")

        def pick():
            d = QFileDialog.getExistingDirectory(self, "Choose folder", edit.text())
            if d:
                edit.setText(d)

        btn.clicked.connect(pick)
        lay.addWidget(edit, 1)
        lay.addWidget(btn)
        w.edit = edit
        return w

    def _page(self, title, rows):
        page = QWidget()
        form = QFormLayout(page)
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        for key, label, widget in rows:
            form.addRow(label, widget)
            self.widgets[key] = widget
        self.stack.addWidget(page)
        self.pages_list.addItem(title.replace("&&", "&"))

    @staticmethod
    def _value(widget):
        if isinstance(widget, QCheckBox):
            return widget.isChecked()
        if isinstance(widget, QComboBox):
            return widget.currentData()
        if isinstance(widget, (QSpinBox, QDoubleSpinBox)):
            return widget.value()
        if isinstance(widget, QPushButton):
            return widget.property("color")
        if hasattr(widget, "edit"):
            return widget.edit.text()
        return None

    def _restore_defaults(self):
        if QMessageBox.question(self, "Restore defaults",
                                "Reset all settings (except shortcuts) to defaults?") \
                != QMessageBox.StandardButton.Yes:
            return
        for key in self.widgets:
            self.settings.set(key, DEFAULTS[key])
        self.done(2)

    def save(self):
        for key, widget in self.widgets.items():
            self.settings.set(key, self._value(widget))
        self.settings.set_json("keymap", self.keymap_editor.result_keymap())
        self.settings.sync()


class ShortcutsDialog(QDialog):
    """Read-only cheat sheet of current shortcuts."""

    def __init__(self, shortcuts_for, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Keyboard shortcuts")
        self.resize(620, 640)
        lay = QVBoxLayout(self)
        filt = QLineEdit(placeholderText="Filter...")
        lay.addWidget(filt)
        tree = QTreeWidget()
        tree.setHeaderLabels(["Command", "Shortcut"])
        tree.setRootIsDecorated(False)
        tree.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        tree.header().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        items = []
        for cmd in COMMANDS:
            seqs = shortcuts_for(cmd.id)
            if not seqs:
                continue
            text = ", ".join(QKeySequence(s).toString(QKeySequence.SequenceFormat.NativeText)
                             for s in seqs)
            item = QTreeWidgetItem([cmd.title, text])
            tree.addTopLevelItem(item)
            items.append(item)
        extra = [
            ("Zoom at cursor", "Mouse wheel"),
            ("Browse files", "Ctrl + mouse wheel"),
            ("Zoom / browse all photos", "Shift + mouse wheel"),
            ("Pan zoomed photo", "Left drag (or middle drag)"),
            ("Swap two cells", "Drag a cell onto another (Alt+drag when zoomed)"),
            ("Single mode", "Double click"),
            ("Replace a cell's photo", "Ctrl + drop file onto the cell"),
        ]
        for title, key in extra:
            item = QTreeWidgetItem([title, key])
            tree.addTopLevelItem(item)
            items.append(item)

        def apply(text):
            t = text.lower()
            for it in items:
                it.setHidden(bool(t) and t not in (it.text(0) + it.text(1)).lower())

        filt.textChanged.connect(apply)
        lay.addWidget(tree)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)


def ask_folder_import(parent, count, folder_name):
    """Ask how to add a folder with many photos. Returns 'all', 'some', 'one' or None."""
    box = QMessageBox(parent)
    box.setWindowTitle("Add folder")
    box.setText(f"\"{folder_name}\" contains {count} photos.")
    box.setInformativeText(
        "Add all of them as separate cells, only the first 16, or a single cell "
        "you can browse through (PgUp / PgDown, slideshow)?")
    b_all = box.addButton(f"All {count}", QMessageBox.ButtonRole.AcceptRole)
    b_some = box.addButton("First 16", QMessageBox.ButtonRole.AcceptRole)
    b_one = box.addButton("One cell", QMessageBox.ButtonRole.AcceptRole)
    box.addButton(QMessageBox.StandardButton.Cancel)
    box.setDefaultButton(b_some)
    box.exec()
    clicked = box.clickedButton()
    return {b_all: "all", b_some: "some", b_one: "one"}.get(clicked)


def apply_app_theme(settings):
    apply_theme(QApplication.instance(), settings.get("color_scheme"))
