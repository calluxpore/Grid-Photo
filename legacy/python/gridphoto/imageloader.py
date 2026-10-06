"""Image decoding (background threads) and folder browsing helpers."""

import os
import re

from PyQt6.QtCore import QObject, QRunnable, QSize, QThreadPool, pyqtSignal
from PyQt6.QtGui import QImage, QImageIOHandler, QImageReader

try:
    from PIL import Image, ImageOps

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        HEIF = True
    except Exception:
        HEIF = False
    PIL_OK = True
except Exception:
    PIL_OK = False
    HEIF = False

QT_EXTENSIONS = {
    "." + bytes(f).decode().lower() for f in QImageReader.supportedImageFormats()
} - {".pdf"}
PIL_EXTENSIONS = {".heic", ".heif", ".avif", ".jp2", ".dds", ".psd", ".pcx", ".sgi"}
if not HEIF:
    PIL_EXTENSIONS -= {".heic", ".heif", ".avif"}
if not PIL_OK:
    PIL_EXTENSIONS = set()

IMAGE_EXTENSIONS = QT_EXTENSIONS | PIL_EXTENSIONS
PLAYLIST_EXTENSION = ".gphl"


def is_image(path):
    return os.path.splitext(path)[1].lower() in IMAGE_EXTENSIONS


def file_filter():
    exts = " ".join("*" + e for e in sorted(IMAGE_EXTENSIONS))
    return f"Images ({exts});;All files (*)"


def _natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def sort_paths(paths, mode="name"):
    if mode == "date":
        return sorted(paths, key=lambda p: (_safe_stat(p, "st_mtime"), _natural_key(p)))
    if mode == "size":
        return sorted(paths, key=lambda p: (_safe_stat(p, "st_size"), _natural_key(p)))
    return sorted(paths, key=_natural_key)


def _safe_stat(path, attr):
    try:
        return getattr(os.stat(path), attr)
    except OSError:
        return 0


def list_folder(folder, recursive=False, sort_mode="name"):
    found = []
    if recursive:
        for root, _dirs, files in os.walk(folder):
            found.extend(os.path.join(root, f) for f in files)
    else:
        try:
            found = [os.path.join(folder, f) for f in os.listdir(folder)]
        except OSError:
            return []
    return sort_paths([p for p in found if os.path.isfile(p) and is_image(p)], sort_mode)


_folder_cache = {}


def folder_siblings(path, sort_mode="name"):
    """All images in the folder of `path` (cached by folder mtime)."""
    folder = os.path.dirname(os.path.abspath(path))
    try:
        mtime = os.stat(folder).st_mtime
    except OSError:
        return [path]
    key = (folder, sort_mode)
    cached = _folder_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    files = list_folder(folder, False, sort_mode)
    _folder_cache[key] = (mtime, files)
    return files


def expand_paths(paths, recursive=False, sort_mode="name"):
    """Expand a list of files/folders into a list of image files."""
    result = []
    for p in paths:
        if os.path.isdir(p):
            result.extend(list_folder(p, recursive, sort_mode))
        elif os.path.isfile(p) and is_image(p):
            result.append(p)
    return result


def image_info(path):
    """Basic metadata for the info dialog."""
    info = {}
    try:
        st = os.stat(path)
        info["File size"] = _human_size(st.st_size)
    except OSError:
        pass
    reader = QImageReader(path)
    size = reader.size()
    if size.isValid():
        info["Dimensions"] = f"{size.width()} x {size.height()}"
    fmt = bytes(reader.format()).decode().upper()
    if fmt:
        info["Format"] = fmt
    if PIL_OK:
        try:
            from PIL.ExifTags import TAGS

            with Image.open(path) as im:
                info.setdefault("Dimensions", f"{im.width} x {im.height}")
                info.setdefault("Format", im.format or "")
                info["Mode"] = im.mode
                exif = im.getexif()
                merged = dict(exif)
                try:
                    merged.update(exif.get_ifd(0x8769))  # Exif sub-IFD
                except Exception:
                    pass
                for tag_id, value in merged.items():
                    name = TAGS.get(tag_id, str(tag_id))
                    if name in ("MakerNote", "UserComment", "PrintImageMatching"):
                        continue
                    if isinstance(value, bytes):
                        if len(value) > 64:
                            continue
                        value = value.decode(errors="replace")
                    text = str(value).strip("\x00 ")
                    if text and len(text) < 200:
                        info[name] = text
        except Exception:
            pass
    return info


def _human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def is_animated(path):
    reader = QImageReader(path)
    return reader.supportsAnimation() and reader.imageCount() != 1


def decode_image(path, max_size=0):
    """Decode an image file into a QImage, applying EXIF orientation.

    Returns (image, full_size, is_full_resolution). max_size limits the long
    edge (0 = no limit).
    """
    ext = os.path.splitext(path)[1].lower()
    if ext not in PIL_EXTENSIONS:
        reader = QImageReader(path)
        reader.setAutoTransform(True)
        size = reader.size()
        if size.isValid():
            rot90 = QImageIOHandler.Transformation.TransformationRotate90
            if reader.transformation() & rot90:
                size = size.transposed()
        full_size = size
        scaled = False
        if max_size and size.isValid() and max(size.width(), size.height()) > max_size:
            target = size.scaled(QSize(max_size, max_size), _keep_aspect())
            # scaled size is applied before auto transform, so use raw orientation
            raw = reader.size()
            if raw.width() != size.width():
                target = target.transposed()
            reader.setScaledSize(target)
            scaled = True
        image = reader.read()
        if not image.isNull():
            return image, full_size if full_size.isValid() else image.size(), not scaled
        if not PIL_OK:
            return QImage(), QSize(), True

    if PIL_OK:
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)
                full_size = QSize(im.width, im.height)
                scaled = False
                if max_size and max(im.width, im.height) > max_size:
                    im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                    scaled = True
                im = im.convert("RGBA")
                data = im.tobytes("raw", "RGBA")
                qimg = QImage(
                    data, im.width, im.height, im.width * 4,
                    QImage.Format.Format_RGBA8888,
                ).copy()
                return qimg, full_size, not scaled
        except Exception:
            pass
    return QImage(), QSize(), True


def _keep_aspect():
    from PyQt6.QtCore import Qt

    return Qt.AspectRatioMode.KeepAspectRatio


class _LoaderSignals(QObject):
    loaded = pyqtSignal(int, str, QImage, QSize, bool)


class _LoadTask(QRunnable):
    def __init__(self, token, path, max_size, signals):
        super().__init__()
        self.token = token
        self.path = path
        self.max_size = max_size
        self.signals = signals
        self.setAutoDelete(True)

    def run(self):
        try:
            image, full, is_full = decode_image(self.path, self.max_size)
        except Exception:
            image, full, is_full = QImage(), QSize(), True
        try:
            self.signals.loaded.emit(self.token, self.path, image, full, is_full)
        except RuntimeError:
            pass  # receiver deleted


class ImageLoader(QObject):
    """Per-cell async loader. Only the latest request is delivered."""

    loaded = pyqtSignal(str, QImage, QSize, bool)

    pool = None

    def __init__(self, parent=None):
        super().__init__(parent)
        if ImageLoader.pool is None:
            ImageLoader.pool = QThreadPool.globalInstance()
            ImageLoader.pool.setMaxThreadCount(max(2, os.cpu_count() or 2))
        self._token = 0
        self._signals = _LoaderSignals()
        self._signals.loaded.connect(self._on_loaded)

    def load(self, path, max_size=0):
        self._token += 1
        ImageLoader.pool.start(_LoadTask(self._token, path, max_size, self._signals))

    def cancel(self):
        self._token += 1

    def _on_loaded(self, token, path, image, full, is_full):
        if token == self._token:
            self.loaded.emit(path, image, full, is_full)
