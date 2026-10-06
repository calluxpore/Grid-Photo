"""Entry point: python -m gridphoto [files / folders / grid.gphl ...]"""

import argparse
import json
import os
import sys

from PyQt6.QtCore import QByteArray, Qt
from PyQt6.QtGui import QIcon, QPainter, QPixmap, QColor
from PyQt6.QtNetwork import QLocalServer, QLocalSocket
from PyQt6.QtWidgets import QApplication

from gridphoto import __app_name__, __version__
from gridphoto.dialogs import apply_app_theme
from gridphoto.settings import init_settings

SERVER_NAME = "GridPhoto-" + (os.environ.get("USERNAME") or os.environ.get("USER") or "user")


def send_to_running_instance(paths):
    sock = QLocalSocket()
    sock.connectToServer(SERVER_NAME)
    if not sock.waitForConnected(300):
        return False
    sock.write(QByteArray(json.dumps(paths).encode("utf-8")))
    sock.flush()
    sock.waitForBytesWritten(1000)
    sock.disconnectFromServer()
    return True


def start_server(window):
    QLocalServer.removeServer(SERVER_NAME)
    server = QLocalServer(window)

    def on_connection():
        conn = server.nextPendingConnection()

        def read():
            conn.waitForReadyRead(200)
            data = bytes(conn.readAll()).decode("utf-8", errors="replace")
            try:
                paths = json.loads(data)
            except ValueError:
                paths = []
            window.receive_args(paths)

        conn.readyRead.connect(read)

    server.newConnection.connect(on_connection)
    server.listen(SERVER_NAME)
    return server


def make_icon():
    """Simple generated 2x2 grid icon."""
    icon = QIcon()
    for size in (16, 32, 64, 256):
        pm = QPixmap(size, size)
        pm.fill(Qt.GlobalColor.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        gap = max(1, size // 16)
        half = (size - gap) / 2
        colors = ("#4a90e2", "#50c878", "#f5a623", "#e94e77")
        for i, c in enumerate(colors):
            x = (i % 2) * (half + gap)
            y = (i // 2) * (half + gap)
            p.setBrush(QColor(c))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(int(x), int(y), int(half), int(half), size / 10, size / 10)
        p.end()
        icon.addPixmap(pm)
    return icon


def main():
    parser = argparse.ArgumentParser(prog="gridphoto", description="View many photos in a grid.")
    parser.add_argument("paths", nargs="*", help="photos, folders or .gphl grid files")
    parser.add_argument("--version", action="version", version=f"{__app_name__} {__version__}")
    args = parser.parse_args()
    paths = [os.path.abspath(p) for p in args.paths]

    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("GridPhoto.GridPhoto")
        except Exception:
            pass

    app = QApplication(sys.argv[:1])
    app.setApplicationName(__app_name__)
    app.setApplicationVersion(__version__)
    app.setWindowIcon(make_icon())
    settings = init_settings()

    if settings.get("one_instance") and send_to_running_instance(paths):
        return 0

    apply_app_theme(settings)

    from gridphoto.mainwindow import MainWindow

    window = MainWindow(settings)
    if settings.get("one_instance"):
        window.ipc_server = start_server(window)

    if settings.get("start_fullscreen"):
        window.showFullScreen()
    elif settings.get("start_maximized"):
        window.showMaximized()
    else:
        window.show()
    window.receive_args(paths)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
