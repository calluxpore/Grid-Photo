"""Grid container: positions PhotoCell widgets according to the grid settings."""

import math

from PyQt6.QtCore import QRect, Qt
from PyQt6.QtGui import QColor, QFont, QPainter
from PyQt6.QtWidgets import QWidget

from gridphoto.photocell import CELL_MIME

DEFAULT_ASPECT = 1.5

WELCOME = (
    "Drag & drop photos or folders here\n\n"
    "Ctrl+A  add files      Ctrl+Shift+A  add folder      Ctrl+O  open grid\n"
    "Right-click for the menu      F2  keyboard shortcuts      F6  settings"
)


def compute_grid(n, width, height, grid, aspects):
    """Return (rows, cols) for n cells."""
    if n <= 0:
        return 0, 0
    columns_first = grid.mode == "columns"
    if grid.fixed and grid.size > 0:
        k = grid.size
        other = max(k, math.ceil(n / k)) if grid.show_all_cells else math.ceil(n / k)
        return (other, k) if not columns_first else (k, other)

    if grid.fit_cells and width > 0 and height > 0:
        best = None
        for major in range(1, n + 1):
            minor = math.ceil(n / major)
            cols, rows = (major, minor) if not columns_first else (minor, major)
            sp = grid.spacing
            cw = (width - sp * (cols - 1)) / cols
            ch = (height - sp * (rows - 1)) / rows
            if cw <= 0 or ch <= 0:
                continue
            area = 0.0
            for aspect in aspects:
                ar = aspect or DEFAULT_ASPECT
                area += min(cw, ch * ar) * min(ch, cw / ar)
            empties = rows * cols - n
            score = (area, -empties)
            if best is None or score > best[0]:
                best = (score, rows, cols)
        if best:
            return best[1], best[2]

    major = math.ceil(math.sqrt(n))
    minor = math.ceil(n / major)
    return (minor, major) if not columns_first else (major, minor)


def _split(total, parts, spacing):
    """Integer partition of `total` pixels into `parts` segments with spacing."""
    avail = total - spacing * (parts - 1)
    edges = [round(avail * i / parts) for i in range(parts + 1)]
    return [(edges[i] + spacing * i, edges[i + 1] - edges[i]) for i in range(parts)]


def _masonry_greedy(aspects, cols, order):
    """Shortest-column placement of items in the given order."""
    heights = [0.0] * cols
    members = [[] for _ in range(cols)]
    for i in order:
        k = min(range(cols), key=lambda j: heights[j])
        heights[k] += 1.0 / aspects[i]
        members[k].append(i)
    return members


def _fit_width(members, aspects, height, gap):
    """Largest column width at which every column fits in `height`."""
    w = float("inf")
    for m in members:
        if m:
            inv = sum(1.0 / aspects[i] for i in m)
            w = min(w, (height - gap * (len(m) - 1)) / inv)
    return w


def _refine(members, aspects, height, gap, max_rounds=60):
    """Move / swap photos out of the limiting column while it helps."""
    def col_w(m):
        if not m:
            return float("inf")
        return (height - gap * (len(m) - 1)) / sum(1.0 / aspects[i] for i in m)

    for _ in range(max_rounds):
        widths = [col_w(m) for m in members]
        worst = min(range(len(members)), key=lambda k: widths[k])
        current = widths[worst]
        best = None
        for k in range(len(members)):
            if k == worst:
                continue
            others = sorted(widths[j] for j in range(len(members)) if j not in (worst, k))
            floor = others[0] if others else float("inf")
            for a in members[worst]:
                # move a -> k
                na = [x for x in members[worst] if x != a]
                nk = members[k] + [a]
                score = min(col_w(na), col_w(nk), floor)
                if score > current + 1e-6 and (best is None or score > best[0]):
                    best = (score, a, None, k)
                # swap a <-> b
                for b in members[k]:
                    if abs(aspects[a] - aspects[b]) < 1e-9:
                        continue
                    na = [x for x in members[worst] if x != a] + [b]
                    nk = [x for x in members[k] if x != b] + [a]
                    score = min(col_w(na), col_w(nk), floor)
                    if score > current + 1e-6 and (best is None or score > best[0]):
                        best = (score, a, b, k)
        if best is None:
            break
        _, a, b, k = best
        members[worst].remove(a)
        members[k].append(a)
        if b is not None:
            members[k].remove(b)
            members[worst].append(b)
    return members


def compute_masonry(aspects, width, height, gap, fixed_cols=0, keep_order=False):
    """Pinterest-style waterfall layout that fits entirely inside width x height.

    Tries every column count, shrinks the column width until the tallest column
    fits, and keeps the layout with the biggest photos. Unless keep_order is set,
    photos are distributed to balance the column heights (bigger photos, rough
    reading order kept). Returns (cols, rects).
    """
    n = len(aspects)
    if not n or width <= 0 or height <= 0:
        return 0, []
    aspects = [ar if ar and ar > 0 else DEFAULT_ASPECT for ar in aspects]
    in_order = list(range(n))
    tallest_first = sorted(in_order, key=lambda i: -1.0 / aspects[i])
    candidates = [fixed_cols] if fixed_cols else range(1, n + 1)
    best = None
    for cols in candidates:
        max_w = (width - gap * (cols - 1)) / cols
        if max_w <= 8:
            break
        options = [_masonry_greedy(aspects, cols, in_order)]
        if not keep_order:
            options.append(_masonry_greedy(aspects, cols, tallest_first))
        for members in options:
            w = min(max_w, _fit_width(members, aspects, height, gap))
            if w > 1 and (best is None or w > best[0] + 0.01):
                best = (w, cols, members)
    if best is None:
        return 0, []
    w, cols, members = best
    if not keep_order and cols > 1:
        max_w = (width - gap * (cols - 1)) / cols
        if w < max_w:  # height-limited: balancing can still help
            members = _refine([list(m) for m in members], aspects, height, gap)
            w = min(max_w, _fit_width(members, aspects, height, gap))
        # rough reading order: sort inside columns, columns by first photo
        members = sorted((sorted(m) for m in members if m), key=lambda m: m[0])
        cols = len(members)
    # anchored top-left: every column starts at the top, leftover space only
    # appears after the last photos
    rects = [None] * n
    for k, m in enumerate(members):
        x = k * (w + gap)
        y = 0.0
        for i in m:
            h = w / aspects[i]
            rects[i] = QRect(round(x), round(y), round(x + w) - round(x),
                             round(y + h) - round(y))
            y += h + gap
    return cols, rects


class GridWidget(QWidget):
    def __init__(self, host, parent=None):
        super().__init__(parent)
        self.host = host
        self.setAcceptDrops(True)
        self.setMouseTracking(True)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)
        self.rows = self.cols = 0

    def relayout(self):
        cells = self.host.cells
        single = self.host.single_cell
        for cell in cells:
            cell.setVisible(single is None or cell is single)
        if single is not None:
            single.setGeometry(self.rect())
            single.clamp_view()
            self.update()
            return
        grid = self.host.playlist.grid
        n = len(cells)
        if grid.layout == "masonry":
            fixed = grid.size if grid.fixed and grid.size > 0 else 0
            aspects = [c.aspect_ratio() for c in cells]
            self.cols, rects = compute_masonry(
                aspects, self.width(), self.height(), grid.spacing, fixed,
                grid.keep_order)
            self.rows = 0
            for cell, rect in zip(cells, rects):
                cell.setGeometry(rect)
            self.update()
            return
        aspects = [self._effective_aspect(c) for c in cells]
        rows, cols = compute_grid(n, self.width(), self.height(), grid, aspects)
        self.rows, self.cols = rows, cols
        if not n:
            self.update()
            return
        xs = _split(self.width(), cols, grid.spacing)
        ys = _split(self.height(), rows, grid.spacing)
        for i, cell in enumerate(cells):
            if grid.mode == "columns":
                r, c = i % rows, i // rows
            else:
                r, c = i // cols, i % cols
            if r >= rows or c >= cols:
                cell.hide()
                continue
            x, w = xs[c]
            y, h = ys[r]
            cell.setGeometry(QRect(x, y, w, h))
        self.update()

    @staticmethod
    def _effective_aspect(cell):
        if cell.state.aspect in ("fill", "stretch"):
            return None  # fills any cell
        return cell.aspect_ratio()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.relayout()

    def paintEvent(self, _event):
        p = QPainter(self)
        bg = QColor(self.host.settings.get("background_color"))
        p.fillRect(self.rect(), bg)
        if not self.host.cells:
            p.setPen(QColor(150, 150, 150))
            f = QFont(self.font())
            f.setPointSize(20)
            p.setFont(f)
            top = self.rect().adjusted(0, 0, 0, -self.height() // 6)
            p.drawText(top, Qt.AlignmentFlag.AlignCenter, "GridPhoto")
            f.setPointSize(10)
            p.setFont(f)
            p.drawText(self.rect().adjusted(0, self.height() // 6, 0, 0),
                       Qt.AlignmentFlag.AlignCenter, WELCOME)
        p.end()

    def mouseMoveEvent(self, event):
        self.host.on_mouse_activity()

    def mouseDoubleClickEvent(self, event):
        if not self.host.cells:
            self.host.add_files_dialog()

    def contextMenuEvent(self, event):
        self.host.set_active(None)
        self.host.show_context_menu(event.globalPos())

    def dragEnterEvent(self, event):
        md = event.mimeData()
        if md.hasUrls() and not md.hasFormat(CELL_MIME):
            event.acceptProposedAction()

    def dropEvent(self, event):
        paths = [u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()]
        self.host.drop_files(paths, None)
        event.acceptProposedAction()
