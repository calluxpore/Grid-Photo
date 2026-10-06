# GridPhoto: legacy Python / Qt version

This is the original prototype, built with PyQt6. The main app is now the Electron version in the
repository root. This version is kept because it opens **HEIC** and **TIFF** photos, which the
Chromium engine inside Electron cannot decode.

It has the core feature set: waterfall and grid layouts, zoom, pan, rotate and crop, per-cell
slideshows, snapshots, saved grids, and Save Photo As. Newer features (ratings, transitions, glass
backgrounds, the toolbar) exist only in the Electron app.

From this folder, set up a virtual environment:

```bash
py -3 -m venv .venv
```

Install the dependencies:

```bash
.venv\Scripts\python -m pip install -r requirements.txt
```

Then run it:

```bash
.venv\Scripts\python -m gridphoto [photos | folders | grid.gphl]
```
