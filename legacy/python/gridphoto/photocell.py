"""A single grid cell displaying one photo."""

import os
import random
import shutil
import subprocess
import sys
import time

from PyQt6.QtCore import (
    QByteArray, QMimeData, QPoint, QPointF, QRectF, QSize, QSizeF, Qt, QTimer,
    QUrl, pyqtSignal,
)
from PyQt6.QtGui import (
    QColor, QDesktopServices, QDrag, QFont, QFontMetrics, QGuiApplication, QImage,
    QMovie, QPainter, QPainterPath, QPen, QPixmap, QTransform,
)
from PyQt6.QtWidgets import (
    QApplication, QDialog, QDialogButtonBox, QFileDialog, QHeaderView,
    QInputDialog, QMessageBox, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from gridphoto import imageloader
from gridphoto.models import ASPECT_MODES, ASPECT_TITLES, CellState

CELL_MIME = "application/x-gridphoto-cell"

ALIGN_FACTORS = {
    "top_left": (0.0, 0.0), "top": (0.5, 0.0), "top_right": (1.0, 0.0),
    "left": (0.0, 0.5), "center": (0.5, 0.5), "right": (1.0, 0.5),
    "bottom_left": (0.0, 1.0), "bottom": (0.5, 1.0), "bottom_right": (1.0, 1.0),
}

ZOOM_MIN = 0.05
ZOOM_MAX = 64.0
INTERVAL_STEPS = (0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60, 120, 300)


class PhotoCell(QWidget):
    activated = pyqtSignal(object)
    view_changed = pyqtSignal(object)  # zoom/pan changed by the user
    loaded = pyqtSignal(object)
    changed = pyqtSignal()  # anything persisted changed

    def __init__(self, host, state: CellState, parent=None):
        super().__init__(parent)
        self.host = host
        self.state = state
        self.setMouseTracking(True)
        self.setAcceptDrops(True)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)

        self.image = QImage()
        self.full_size = QSize()
        self.is_full = True
        self.loading = False
        self.error = False
        self._full_requested = False
        self.movie = None

        self._base_key = None
        self._base_pm = None
        self._scaled_pm = None
        self._scaled_key = None
        self._scale_timer = QTimer(self, singleShot=True, interval=120)
        self._scale_timer.timeout.connect(self._rebuild_scaled)
        self._want_scaled = None

        self.loader = imageloader.ImageLoader(self)
        self.loader.loaded.connect(self._on_loaded)

        self.slideshow_timer = QTimer(self, singleShot=True)
        self.slideshow_timer.timeout.connect(self._slideshow_step)

        self.active = False
        self.hovered = False
        self._overlay_until = 0.0
        self._flash_until = 0.0
        self._flash_text = ""
        self._overlay_timer = QTimer(self, singleShot=True)
        self._overlay_timer.timeout.connect(self.update)

        self._press_pos = None
        self._press_button = None
        self._panning = False
        self._last_pan_pos = None

        if state.path:
            self.load_path(state.path, keep_view=True)

    # ------------------------------------------------------------------ loading
    def cfg(self, key):
        return self.host.settings.get(key)

    def load_path(self, path, keep_view=False):
        if path:
            path = os.path.normpath(os.path.abspath(path))
        self.state.path = path
        if not keep_view:
            self.state.reset_view()
            self.state.reset_crop()
            self.state.reset_transform()
            self.state.title = ""
        self._stop_movie()
        self._full_requested = False
        self.error = False
        self.loading = True
        if path and os.path.isfile(path) and imageloader.is_animated(path):
            self.loader.cancel()
            self._start_movie(path)
        elif path and os.path.isfile(path):
            self.loader.load(path, self.cfg("preview_max_size"))
        else:
            self.loader.cancel()
            self.loading = False
            self.error = True
            self.image = QImage()
        self.slideshow_timer.stop()
        self.update()
        self.changed.emit()

    def _start_movie(self, path):
        self.movie = QMovie(path, parent=self)
        self.movie.setCacheMode(QMovie.CacheMode.CacheAll)
        self.movie.frameChanged.connect(self._on_movie_frame)
        self.movie.start()
        if self.state.animation_paused:
            self.movie.setPaused(True)
        if not self.movie.isValid():
            self._stop_movie()
            self.loader.load(path, self.cfg("preview_max_size"))

    def _stop_movie(self):
        if self.movie is not None:
            self.movie.stop()
            self.movie.deleteLater()
            self.movie = None

    def _on_movie_frame(self, _frame):
        if self.movie is None:
            return
        first = self.image.isNull() or self.loading
        self.image = self.movie.currentImage()
        self.full_size = self.image.size()
        self.is_full = True
        self.loading = False
        self.update()
        if first:
            self._after_load()

    def _on_loaded(self, path, image, full_size, is_full):
        if path != self.state.path:
            return
        if image.isNull():
            self.error = True
            self.loading = False
            self.image = QImage()
            self.update()
            self.loaded.emit(self)
            return
        was_loading = self.loading
        self.image = image
        self.full_size = full_size if full_size.isValid() else image.size()
        self.is_full = is_full
        self.loading = False
        self.error = False
        self.update()
        if was_loading:
            self._after_load()

    def _after_load(self):
        self.loaded.emit(self)
        if self.state.slideshow:
            self._restart_slideshow()

    def reload(self):
        imageloader._folder_cache.clear()
        self.load_path(self.state.path, keep_view=True)
        self.flash("Reloaded")

    # ---------------------------------------------------------- geometry math
    def base_size(self) -> QSizeF:
        """Full-resolution size after rotation, in 'base units'."""
        if self.full_size.isValid():
            s = QSizeF(self.full_size)
        elif not self.image.isNull():
            s = QSizeF(self.image.size())
        else:
            return QSizeF()
        if self.state.rotation in (90, 270):
            s = s.transposed()
        return s

    def content_rect(self) -> QRectF:
        b = self.base_size()
        st = self.state
        return QRectF(
            b.width() * st.crop_l,
            b.height() * st.crop_t,
            b.width() * max(0.02, 1 - st.crop_l - st.crop_r),
            b.height() * max(0.02, 1 - st.crop_t - st.crop_b),
        )

    def aspect_ratio(self):
        c = self.content_rect()
        if c.isEmpty():
            return None
        return c.width() / c.height()

    def _base_scales(self, c: QRectF):
        r = QRectF(self.rect())
        if c.isEmpty() or r.isEmpty():
            return 1.0, 1.0
        fx, fy = r.width() / c.width(), r.height() / c.height()
        mode = self.state.aspect
        if mode == "fill":
            s = max(fx, fy)
            return s, s
        if mode == "stretch":
            return fx, fy
        if mode == "none":
            s = 1.0 / self.devicePixelRatioF()
            return s, s
        s = min(fx, fy)
        return s, s

    def dest_rect(self, zoom=None, pan_x=None, pan_y=None) -> QRectF:
        st = self.state
        zoom = st.zoom if zoom is None else zoom
        pan_x = st.pan_x if pan_x is None else pan_x
        pan_y = st.pan_y if pan_y is None else pan_y
        c = self.content_rect()
        sx, sy = self._base_scales(c)
        dw, dh = c.width() * sx * zoom, c.height() * sy * zoom
        ax, ay = ALIGN_FACTORS.get(st.align, (0.5, 0.5))
        rw, rh = self.width(), self.height()
        left = (rw - dw) * ax + pan_x * dw
        top = (rh - dh) * ay + pan_y * dh
        return QRectF(left, top, dw, dh)

    def clamp_view(self):
        st = self.state
        st.zoom = min(ZOOM_MAX, max(ZOOM_MIN, st.zoom))
        d = self.dest_rect()
        if d.isEmpty():
            return
        ax, ay = ALIGN_FACTORS.get(st.align, (0.5, 0.5))
        rw, rh = self.width(), self.height()

        def clamp_axis(pos, size, avail, factor):
            lo, hi = sorted((0.0, avail - size))
            new = min(hi, max(lo, pos))
            return (new - (avail - size) * factor) / size

        st.pan_x = clamp_axis(d.left(), d.width(), rw, ax)
        st.pan_y = clamp_axis(d.top(), d.height(), rh, ay)

    def overflows(self):
        d = self.dest_rect()
        return d.width() > self.width() + 1 or d.height() > self.height() + 1

    # --------------------------------------------------------------- painting
    def _base_pixmap(self):
        if self.image.isNull():
            return None
        st = self.state
        key = (self.image.cacheKey(), st.rotation, st.flip_h, st.flip_v)
        if key != self._base_key:
            img = self.image
            if st.rotation:
                img = img.transformed(QTransform().rotate(st.rotation))
            if st.flip_h or st.flip_v:
                img = _mirror(img, st.flip_h, st.flip_v)
            self._base_pm = QPixmap.fromImage(img)
            self._base_key = key
            self._scaled_pm = None
            self._scaled_key = None
        return self._base_pm

    def _rebuild_scaled(self):
        pm = self._base_pixmap()
        if pm is None or self._want_scaled is None:
            return
        key = (pm.cacheKey(), self._want_scaled.width(), self._want_scaled.height())
        if key == self._scaled_key:
            return
        self._scaled_pm = pm.scaled(
            self._want_scaled,
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._scaled_key = key
        self.update()

    def corner_radius(self):
        if self.host.single_cell is self:
            return 0
        return min(self.cfg("corner_radius"), self.width() / 4, self.height() / 4)

    def paintEvent(self, _event):
        p = QPainter(self)
        bg = QColor(self.cfg("background_color"))
        p.fillRect(self.rect(), bg)
        pm = self._base_pixmap()
        if pm is None:
            p.fillRect(self.rect(), QColor(128, 128, 128, 40))  # placeholder
        if pm is not None:
            self._paint_image(p, pm)
        elif self.loading:
            self._paint_center_text(p, "Loading…")
        elif self.error:
            name = os.path.basename(self.state.path) or "(no file)"
            self._paint_center_text(p, f"Cannot load\n{name}", QColor(220, 90, 90))
        self._paint_overlay(p)
        self._paint_corners(p, bg)
        p.end()

    def _paint_corners(self, p, bg):
        """Mask the corners with the background (anti-aliased rounded corners)."""
        radius = self.corner_radius()
        rect = QRectF(self.rect())
        pl = self.host.playlist
        show_border = (self.active and pl.overlay_border and not pl.disable_overlay
                       and self.host.visible_cell_count() > 1 and not self.host.exporting)
        if radius <= 0 and not show_border:
            return
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if radius > 0:
            rounded = QPainterPath()
            rounded.addRoundedRect(rect, radius, radius)
            outside = QPainterPath()
            outside.addRect(rect)
            p.fillPath(outside.subtracted(rounded), bg)
        if show_border:
            p.setPen(QPen(QColor(self.host.accent_color()), 2.5))
            p.setBrush(Qt.BrushStyle.NoBrush)
            r = max(0.0, radius - 1)
            p.drawRoundedRect(rect.adjusted(1.25, 1.25, -1.25, -1.25), r, r)

    def _paint_image(self, p, pm):
        smooth = self.cfg("smooth_scaling")
        dpr = self.devicePixelRatioF()
        c = self.content_rect()
        dest = self.dest_rect()
        if c.isEmpty() or dest.isEmpty():
            return
        b = self.base_size()
        res_x = pm.width() / b.width()
        res_y = pm.height() / b.height()
        src = QRectF(c.x() * res_x, c.y() * res_y, c.width() * res_x, c.height() * res_y)

        # need a higher resolution decode?
        need = dest.width() * dpr / c.width()
        if not self.is_full and not self._full_requested and need > res_x * 1.05:
            self._full_requested = True
            self.loader.load(self.state.path, 0)

        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, smooth)
        kx = dest.width() * dpr / src.width()
        ky = dest.height() * dpr / src.height()
        if smooth and self.movie is None and min(kx, ky) < 0.7:
            want = QSize(max(1, round(pm.width() * kx)), max(1, round(pm.height() * ky)))
            key = (pm.cacheKey(), want.width(), want.height())
            if key != self._scaled_key:
                self._want_scaled = want
                if self._scaled_pm is None:
                    self._rebuild_scaled()
                else:
                    self._scale_timer.start()
            spm = self._scaled_pm
            if spm is not None:
                fx = spm.width() / pm.width()
                fy = spm.height() / pm.height()
                ssrc = QRectF(src.x() * fx, src.y() * fy, src.width() * fx, src.height() * fy)
                p.drawPixmap(dest, spm, ssrc)
                return
        p.drawPixmap(dest, pm, src)

    def _font(self, scale=1.0):
        f = QFont(self.font())
        size = max(8, min(14, int(min(self.width(), self.height()) / 28)))
        f.setPointSizeF(size * scale)
        return f

    def _paint_center_text(self, p, text, color=None):
        p.setPen(color or QColor(170, 170, 170))
        p.setFont(self._font())
        p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, text)

    def overlay_visible(self):
        pl = self.host.playlist
        if pl.disable_overlay or self.host.exporting:
            return False
        now = time.monotonic()
        if not self.hovered:
            return False
        if not pl.overlay_hide:
            return True
        return now < self._overlay_until

    def _paint_overlay(self, p):
        pl = self.host.playlist
        now = time.monotonic()
        if self.host.exporting:
            return
        if self.overlay_visible():
            self._paint_info_bars(p)
        elif self.state.slideshow and not pl.disable_overlay:
            # small persistent slideshow indicator
            p.setFont(self._font(0.85))
            self._text_box(p, "▶", Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignTop)

        if now < self._flash_until and self._flash_text and not pl.disable_overlay:
            p.setFont(self._font(1.3))
            self._text_box(p, self._flash_text, Qt.AlignmentFlag.AlignCenter, pad=10)

    def _text_box(self, p, text, align, pad=6, margin=8):
        fm = QFontMetrics(p.font())
        br = fm.boundingRect(text)
        w, h = br.width() + pad * 2, fm.height() + pad
        r = QRectF(self.rect()).adjusted(margin, margin, -margin, -margin)
        if align & Qt.AlignmentFlag.AlignRight:
            x = r.right() - w
        elif align & Qt.AlignmentFlag.AlignLeft:
            x = r.left()
        else:
            x = r.center().x() - w / 2
        if align & Qt.AlignmentFlag.AlignTop:
            y = r.top()
        elif align & Qt.AlignmentFlag.AlignBottom:
            y = r.bottom() - h
        else:
            y = r.center().y() - h / 2
        box = QRectF(x, y, w, h)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(0, 0, 0, 160))
        p.drawRoundedRect(box, 4, 4)
        p.setPen(QColor(240, 240, 240))
        p.drawText(box, Qt.AlignmentFlag.AlignCenter, text)

    def _paint_info_bars(self, p):
        st = self.state
        font = self._font()
        p.setFont(font)
        fm = QFontMetrics(font)
        bar_h = fm.height() + 8

        top = QRectF(0, 0, self.width(), bar_h)
        bottom = QRectF(0, self.height() - bar_h, self.width(), bar_h)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(0, 0, 0, 150))
        p.drawRect(top)
        p.drawRect(bottom)
        p.setPen(QColor(240, 240, 240))

        siblings = self.siblings()
        idx = self.sibling_index(siblings)
        idx_text = f"{idx + 1} / {len(siblings)}" if idx is not None else ""
        name = st.title or os.path.basename(st.path)
        idx_w = fm.horizontalAdvance(idx_text) + 16
        name = fm.elidedText(name, Qt.TextElideMode.ElideMiddle, int(self.width() - idx_w - 16))
        p.drawText(top.adjusted(8, 0, -8, 0),
                   Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, name)
        p.drawText(top.adjusted(8, 0, -8, 0),
                   Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, idx_text)

        parts = []
        if self.full_size.isValid():
            parts.append(f"{self.full_size.width()}×{self.full_size.height()}")
        parts.append(f"{self.display_zoom_percent():.0f}%")
        if st.aspect != "fit":
            parts.append(ASPECT_TITLES[st.aspect].split(" (")[0])
        if st.rotation:
            parts.append(f"{st.rotation}°")
        if st.flip_h or st.flip_v:
            parts.append("flipped")
        if any((st.crop_l, st.crop_t, st.crop_r, st.crop_b)):
            parts.append("cropped")
        if self.movie is not None:
            parts.append("⏸ anim" if st.animation_paused else "anim")
        left = "  ·  ".join(parts)
        right = ""
        if st.slideshow:
            right = f"▶ {st.slideshow_interval:g}s {st.slideshow_order}"
        p.drawText(bottom.adjusted(8, 0, -8, 0),
                   Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
                   fm.elidedText(left, Qt.TextElideMode.ElideRight, int(self.width() - 16)))
        if right:
            p.drawText(bottom.adjusted(8, 0, -8, 0),
                       Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, right)

    def display_zoom_percent(self):
        """Zoom relative to the photo's real pixels."""
        c = self.content_rect()
        if c.isEmpty():
            return 100.0
        d = self.dest_rect()
        return d.width() / c.width() * self.devicePixelRatioF() * 100

    def flash(self, text, seconds=1.2):
        self._flash_text = text
        self._flash_until = time.monotonic() + seconds
        QTimer.singleShot(int(seconds * 1000) + 30, self.update)
        self.update()

    def poke_overlay(self):
        self._overlay_until = time.monotonic() + self.cfg("overlay_timeout")
        self._overlay_timer.start(int(self.cfg("overlay_timeout") * 1000) + 30)
        self.update()

    # ------------------------------------------------------------------ mouse
    def set_active(self, active):
        if self.active != active:
            self.active = active
            self.update()

    def enterEvent(self, event):
        self.hovered = True
        self.poke_overlay()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.hovered = False
        self.update()
        super().leaveEvent(event)

    def _pan_trigger_matches(self, event):
        trig = self.cfg("pan_trigger")
        btn = event.button()
        mods = event.modifiers()
        if btn == Qt.MouseButton.MiddleButton:
            return trig != "disabled"
        if btn != Qt.MouseButton.LeftButton:
            return False
        if trig == "ctrl":
            return bool(mods & Qt.KeyboardModifier.ControlModifier)
        if trig == "shift":
            return bool(mods & Qt.KeyboardModifier.ShiftModifier)
        if trig == "alt":
            return bool(mods & Qt.KeyboardModifier.AltModifier)
        if trig == "left":
            # left drag pans when photo overflows the cell; Alt+drag swaps cells
            return self.overflows() and not mods & Qt.KeyboardModifier.AltModifier
        return False

    def mousePressEvent(self, event):
        self.activated.emit(self)
        self.poke_overlay()
        if event.button() == Qt.MouseButton.RightButton:
            return
        if self._pan_trigger_matches(event):
            self._panning = True
            self._last_pan_pos = event.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if event.button() == Qt.MouseButton.LeftButton and not self.host.playlist.disable_click:
            self._press_pos = event.position()

    def mouseMoveEvent(self, event):
        self.host.on_mouse_activity()
        self.poke_overlay()
        if self.host.active_cell is not self and not event.buttons():
            self.activated.emit(self)
        if self._panning and self._last_pan_pos is not None:
            delta = event.position() - self._last_pan_pos
            self._last_pan_pos = event.position()
            self.pan_by_pixels(delta.x(), delta.y())
            return
        if self._press_pos is not None and event.buttons() & Qt.MouseButton.LeftButton:
            dist = (event.position() - self._press_pos).manhattanLength()
            if dist >= QApplication.startDragDistance() and self.cfg("drag_swap"):
                self._press_pos = None
                self._start_drag()

    def mouseReleaseEvent(self, event):
        if self._panning:
            self._panning = False
            self.unsetCursor()
            self.changed.emit()
        self._press_pos = None

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and not self.host.playlist.disable_click:
            self.host.toggle_single(self)

    def wheelEvent(self, event):
        if self.host.playlist.disable_wheel:
            return
        self.poke_overlay()
        delta = event.angleDelta().y() or event.angleDelta().x()
        if not delta:
            return
        mods = event.modifiers()
        ctrl = bool(mods & Qt.KeyboardModifier.ControlModifier)
        shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        browse = (self.cfg("wheel_action") == "browse") != ctrl
        targets = self.host.all_cells() if shift else [self]
        if browse:
            for cell in targets:
                cell.prev_file() if delta > 0 else cell.next_file()
            return
        step = self.cfg("zoom_step") ** (delta / 120.0)
        pos = event.position()
        for cell in targets:
            anchor = pos if cell is self else None
            cell.zoom_to(cell.state.zoom * step, anchor, notify=cell is self)

    def contextMenuEvent(self, event):
        self.activated.emit(self)
        self.host.show_context_menu(event.globalPos())

    # --------------------------------------------------------------- drag/drop
    def _start_drag(self):
        drag = QDrag(self)
        mime = QMimeData()
        mime.setData(CELL_MIME, QByteArray(str(self.host.cell_index(self)).encode()))
        if self.state.path:
            mime.setUrls([QUrl.fromLocalFile(self.state.path)])
        drag.setMimeData(mime)
        pm = self.grab().scaled(
            160, 160, Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        drag.setPixmap(pm)
        drag.setHotSpot(QPoint(pm.width() // 2, pm.height() // 2))
        drag.exec(Qt.DropAction.MoveAction | Qt.DropAction.CopyAction)

    def dragEnterEvent(self, event):
        md = event.mimeData()
        if md.hasFormat(CELL_MIME) or md.hasUrls():
            event.acceptProposedAction()

    def dragMoveEvent(self, event):
        event.acceptProposedAction()

    def dropEvent(self, event):
        md = event.mimeData()
        if md.hasFormat(CELL_MIME):
            src = int(bytes(md.data(CELL_MIME)).decode())
            self.host.swap_cells(src, self.host.cell_index(self))
            event.acceptProposedAction()
            return
        paths = [u.toLocalFile() for u in md.urls() if u.isLocalFile()]
        replace = bool(event.modifiers() & Qt.KeyboardModifier.ControlModifier)
        self.host.drop_files(paths, self if replace else None)
        event.acceptProposedAction()

    # ------------------------------------------------------- view commands
    def _view_changed(self, notify=True):
        self.clamp_view()
        self.update()
        self.changed.emit()
        if notify:
            self.view_changed.emit(self)

    def zoom_to(self, new_zoom, anchor=None, notify=True):
        st = self.state
        new_zoom = min(ZOOM_MAX, max(ZOOM_MIN, new_zoom))
        old = self.dest_rect()
        if old.isEmpty():
            st.zoom = new_zoom
            return
        if anchor is None:
            anchor = QPointF(self.width() / 2, self.height() / 2)
        ratio = new_zoom / st.zoom
        new_left = anchor.x() - (anchor.x() - old.left()) * ratio
        new_top = anchor.y() - (anchor.y() - old.top()) * ratio
        st.zoom = new_zoom
        d = self.dest_rect(pan_x=0, pan_y=0)
        st.pan_x = (new_left - d.left()) / d.width()
        st.pan_y = (new_top - d.top()) / d.height()
        self._view_changed(notify)

    def zoom_in(self):
        self.zoom_to(self.state.zoom * self.cfg("zoom_step"))

    def zoom_out(self):
        self.zoom_to(self.state.zoom / self.cfg("zoom_step"))

    def zoom_reset(self):
        self.state.reset_view()
        self._view_changed()

    def zoom_actual(self):
        c = self.content_rect()
        sx, sy = self._base_scales(c)
        target = 1.0 / self.devicePixelRatioF()
        self.zoom_to(target / min(sx, sy))

    def pan_by_pixels(self, dx, dy, notify=True):
        d = self.dest_rect()
        if d.isEmpty():
            return
        self.state.pan_x += dx / d.width()
        self.state.pan_y += dy / d.height()
        self._view_changed(notify)

    def move(self, dx, dy):
        step = self.cfg("move_step")
        self.pan_by_pixels(dx * step * self.width(), dy * step * self.height())

    def position_reset(self):
        self.state.pan_x = self.state.pan_y = 0.0
        self._view_changed()

    def set_align(self, align):
        self.state.align = align
        self.state.pan_x = self.state.pan_y = 0.0
        self._view_changed()

    def is_align(self, align):
        return self.state.align == align

    def set_aspect(self, mode):
        self.state.aspect = mode
        self.state.reset_view()
        self._view_changed()
        self.flash(ASPECT_TITLES[mode])
        self.loaded.emit(self)  # grid may re-fit

    def is_aspect(self, mode):
        return self.state.aspect == mode

    def cycle_aspect(self):
        i = ASPECT_MODES.index(self.state.aspect)
        self.set_aspect(ASPECT_MODES[(i + 1) % len(ASPECT_MODES)])

    def rotate(self, degrees):
        st = self.state
        if st.flip_h != st.flip_v and degrees != 180:
            degrees = -degrees
        st.rotation = (st.rotation + degrees) % 360
        st.reset_view()
        self._view_changed()
        self.flash(f"Rotation {st.rotation}°")
        self.loaded.emit(self)

    def flip(self, horizontal):
        if horizontal:
            self.state.flip_h = not self.state.flip_h
        else:
            self.state.flip_v = not self.state.flip_v
        self._view_changed()

    def transform_reset(self):
        self.state.reset_transform()
        self.state.reset_view()
        self._view_changed()
        self.loaded.emit(self)

    def crop(self, side, direction):
        attr = "crop_" + side
        step = self.cfg("crop_step") * direction
        value = min(0.45, max(0.0, getattr(self.state, attr) + step))
        setattr(self.state, attr, round(value, 4))
        self._view_changed()
        self.loaded.emit(self)

    def crop_reset(self):
        self.state.reset_crop()
        self._view_changed()
        self.loaded.emit(self)

    def reset_all(self):
        self.state.reset_view()
        self.state.reset_crop()
        self.state.reset_transform()
        self.state.align = "center"
        self._view_changed()
        self.loaded.emit(self)

    def copy_view_from(self, other):
        self.state.zoom = other.state.zoom
        self.state.pan_x = other.state.pan_x
        self.state.pan_y = other.state.pan_y
        self.clamp_view()
        self.update()
        self.changed.emit()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.clamp_view()

    # ------------------------------------------------------ file navigation
    def siblings(self):
        if not self.state.path:
            return []
        files = imageloader.folder_siblings(self.state.path, self.cfg("sort_mode"))
        return files

    def sibling_index(self, files=None):
        files = self.siblings() if files is None else files
        key = os.path.normcase(self.state.path)
        for i, f in enumerate(files):
            if os.path.normcase(f) == key:
                return i
        return None

    def _goto_index(self, files, idx):
        if not files:
            return
        self.load_path(files[idx % len(files)])

    def _step_file(self, step):
        files = self.siblings()
        if not files:
            return
        idx = self.sibling_index(files)
        if idx is None:
            idx = -1 if step > 0 else 0
        self._goto_index(files, idx + step)

    def prev_file(self):
        self._step_file(-1)

    def next_file(self):
        self._step_file(1)

    def first_file(self):
        self._goto_index(self.siblings(), 0)

    def last_file(self):
        self._goto_index(self.siblings(), -1)

    def random_file(self):
        files = self.siblings()
        cur = self.sibling_index(files)
        files = [f for i, f in enumerate(files) if i != cur]
        if files:
            self.load_path(random.choice(files))

    def seek_percent(self, percent):
        files = self.siblings()
        if files:
            self._goto_index(files, int(len(files) * percent / 100))

    # -------------------------------------------------------------- slideshow
    def toggle_slideshow(self):
        self.set_slideshow(not self.state.slideshow)

    def set_slideshow(self, on):
        self.state.slideshow = on
        if on:
            self._restart_slideshow()
            self.flash(f"Slideshow ▶ {self.state.slideshow_interval:g}s")
        else:
            self.slideshow_timer.stop()
            self.flash("Slideshow ⏸")
        self.changed.emit()

    def _restart_slideshow(self):
        self.slideshow_timer.start(int(self.state.slideshow_interval * 1000))

    def _slideshow_step(self):
        if not self.state.slideshow:
            return
        if self.loading:
            self._restart_slideshow()
            return
        order = self.state.slideshow_order
        if order == "previous":
            self.prev_file()
        elif order == "shuffle":
            self.random_file()
        else:
            self.next_file()
        if len(self.siblings()) <= 1:
            self._restart_slideshow()

    def set_slideshow_interval(self, seconds):
        self.state.slideshow_interval = max(0.2, float(seconds))
        if self.state.slideshow:
            self._restart_slideshow()
        self.flash(f"Interval {self.state.slideshow_interval:g}s")
        self.changed.emit()

    def slideshow_faster(self):
        cur = self.state.slideshow_interval
        smaller = [s for s in INTERVAL_STEPS if s < cur - 1e-6]
        self.set_slideshow_interval(smaller[-1] if smaller else INTERVAL_STEPS[0])

    def slideshow_slower(self):
        cur = self.state.slideshow_interval
        larger = [s for s in INTERVAL_STEPS if s > cur + 1e-6]
        self.set_slideshow_interval(larger[0] if larger else INTERVAL_STEPS[-1])

    def slideshow_normal(self):
        self.set_slideshow_interval(self.cfg("def_slideshow_interval"))

    def ask_slideshow_interval(self, apply=True):
        value, ok = QInputDialog.getDouble(
            self.window(), "Slideshow interval", "Seconds per photo:",
            self.state.slideshow_interval, 0.2, 3600, 1,
        )
        if ok and apply:
            self.set_slideshow_interval(value)
        return value if ok else None

    def set_slideshow_order(self, order):
        self.state.slideshow_order = order
        self.changed.emit()
        self.update()

    def is_slideshow_order(self, order):
        return self.state.slideshow_order == order

    def toggle_animation(self):
        self.state.animation_paused = not self.state.animation_paused
        if self.movie is not None:
            self.movie.setPaused(self.state.animation_paused)
            self.flash("Animation ⏸" if self.state.animation_paused else "Animation ▶")
        self.changed.emit()

    # ------------------------------------------------------------ file ops
    def render_full(self, visible_only=False):
        """Full-resolution QImage with transform & crop applied."""
        img = QImage()
        if self.movie is not None:
            img = self.movie.currentImage()
        elif self.is_full:
            img = self.image
        if img.isNull():
            QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
            try:
                img, _full, _ = imageloader.decode_image(self.state.path, 0)
            finally:
                QApplication.restoreOverrideCursor()
        if img.isNull():
            return QImage()
        if not self.full_size.isValid():
            self.full_size = img.size()  # not loaded yet
        st = self.state
        if st.rotation:
            img = img.transformed(QTransform().rotate(st.rotation))
        if st.flip_h or st.flip_v:
            img = _mirror(img, st.flip_h, st.flip_v)
        b = QSizeF(img.size())
        bs = self.base_size()
        k = b.width() / bs.width() if bs.width() else 1.0
        region = self.content_rect()
        if visible_only:
            d = self.dest_rect()
            vis = d.intersected(QRectF(self.rect()))
            if not vis.isEmpty():
                sx = region.width() / d.width()
                sy = region.height() / d.height()
                region = QRectF(
                    region.x() + (vis.x() - d.x()) * sx,
                    region.y() + (vis.y() - d.y()) * sy,
                    vis.width() * sx,
                    vis.height() * sy,
                )
        rect = QRectF(region.x() * k, region.y() * k,
                      region.width() * k, region.height() * k).toAlignedRect()
        return img.copy(rect)

    def has_edits(self):
        st = self.state
        return bool(st.rotation or st.flip_h or st.flip_v
                    or any((st.crop_l, st.crop_t, st.crop_r, st.crop_b)))

    def save_as(self):
        """Save a copy of the photo; the chosen folder is remembered."""
        src = self.state.path
        if not src or not os.path.isfile(src):
            return
        name = os.path.basename(src)
        start = os.path.join(self.host.save_dir(os.path.dirname(src)), name)
        ext = os.path.splitext(name)[1].lower()
        filters = (f"Same format (*{ext});;PNG (*.png);;JPEG (*.jpg *.jpeg);;"
                   "WebP (*.webp);;All files (*)")
        dest, _ = QFileDialog.getSaveFileName(self.window(), "Save photo as", start, filters)
        if not dest:
            return
        if not os.path.splitext(dest)[1]:
            dest += ext
        self.host.remember_save_dir(os.path.dirname(dest))
        if os.path.normcase(os.path.abspath(dest)) == os.path.normcase(src):
            return
        same_format = os.path.splitext(dest)[1].lower() == ext
        try:
            if same_format and not self.has_edits():
                shutil.copy2(src, dest)  # exact copy, no re-compression
            else:
                img = self.render_full()  # applies rotation / flip / crop
                quality = self.cfg("screenshot_jpg_quality") if dest.lower().endswith(
                    (".jpg", ".jpeg", ".webp")) else -1
                if img.isNull() or not img.save(dest, None, quality):
                    raise OSError(f"Could not write {dest}")
        except OSError as e:
            QMessageBox.warning(self.window(), "Save failed", str(e))
            return
        self.flash("Saved")

    def export_view(self):
        img = self.render_full(visible_only=True)
        if img.isNull():
            return
        fmt = self.cfg("screenshot_format")
        base = os.path.splitext(os.path.basename(self.state.path))[0] or "photo"
        default = os.path.join(self.host.settings.screenshot_dir(),
                               f"{base}_view_{time.strftime('%Y%m%d_%H%M%S')}.{fmt}")
        path, _ = QFileDialog.getSaveFileName(
            self.window(), "Save visible area", default,
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;WebP (*.webp);;All files (*)",
        )
        if path:
            quality = self.cfg("screenshot_jpg_quality") if path.lower().endswith(
                (".jpg", ".jpeg", ".webp")) else -1
            if img.save(path, None, quality):
                self.flash("Saved")
            else:
                QMessageBox.warning(self.window(), "Save failed", f"Could not save {path}")

    def copy_image(self):
        img = self.render_full()
        if not img.isNull():
            QGuiApplication.clipboard().setImage(img)
            self.flash("Image copied")

    def copy_path(self):
        if self.state.path:
            QGuiApplication.clipboard().setText(os.path.normpath(self.state.path))
            self.flash("Path copied")

    def open_folder(self):
        path = self.state.path
        if not path:
            return
        if sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.dirname(path)))

    def open_external(self):
        if self.state.path:
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.state.path))

    def rename_file(self):
        path = self.state.path
        if not path or not os.path.isfile(path):
            return
        folder, name = os.path.split(path)
        new, ok = QInputDialog.getText(self.window(), "Rename", "New file name:", text=name)
        if not ok or not new or new == name:
            return
        new_path = os.path.join(folder, new)
        if os.path.exists(new_path):
            QMessageBox.warning(self.window(), "Rename", "A file with that name already exists.")
            return
        try:
            os.rename(path, new_path)
        except OSError as e:
            QMessageBox.warning(self.window(), "Rename failed", str(e))
            return
        imageloader._folder_cache.clear()
        self.host.path_renamed(path, new_path)

    def trash_file(self):
        from PyQt6.QtCore import QFile

        path = self.state.path
        if not path or not os.path.isfile(path):
            return
        answer = QMessageBox.question(
            self.window(), "Move to Recycle Bin",
            f"Move this file to the Recycle Bin?\n\n{os.path.normpath(path)}",
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        files = self.siblings()
        idx = self.sibling_index(files)
        if not QFile.moveToTrash(path):
            QMessageBox.warning(self.window(), "Failed", "Could not move the file to the Recycle Bin.")
            return
        imageloader._folder_cache.clear()
        remaining = [f for i, f in enumerate(files) if i != idx]
        if remaining:
            self.load_path(remaining[min(idx or 0, len(remaining) - 1)])
        else:
            self.host.close_cell(self)

    def show_info(self):
        info = {"Path": os.path.normpath(self.state.path)}
        info.update(imageloader.image_info(self.state.path))
        st = self.state
        info["View zoom"] = f"{self.display_zoom_percent():.0f}%"
        info["Aspect mode"] = ASPECT_TITLES[st.aspect]
        info["Rotation"] = f"{st.rotation}°"
        dlg = QDialog(self.window())
        dlg.setWindowTitle("Image info - " + os.path.basename(st.path))
        dlg.resize(560, 520)
        lay = QVBoxLayout(dlg)
        table = QTableWidget(len(info), 2)
        table.setHorizontalHeaderLabels(["Property", "Value"])
        table.verticalHeader().hide()
        table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        for row, (k, v) in enumerate(info.items()):
            table.setItem(row, 0, QTableWidgetItem(str(k)))
            table.setItem(row, 1, QTableWidgetItem(str(v)))
        table.resizeColumnToContents(0)
        lay.addWidget(table)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dlg.reject)
        lay.addWidget(buttons)
        dlg.exec()

    def shutdown(self):
        self.loader.cancel()
        self.slideshow_timer.stop()
        self._stop_movie()


def _mirror(img, horizontal, vertical):
    if hasattr(img, "flipped"):
        orient = Qt.Orientation(0)
        if horizontal:
            orient |= Qt.Orientation.Horizontal
        if vertical:
            orient |= Qt.Orientation.Vertical
        return img.flipped(orient)
    return img.mirrored(horizontal, vertical)

