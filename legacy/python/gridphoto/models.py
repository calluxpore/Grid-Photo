"""Serializable state of a single photo cell and of a whole grid (playlist)."""

from dataclasses import asdict, dataclass, field, fields
from typing import Dict, List, Optional

ASPECT_MODES = ("fit", "fill", "stretch", "none")
ASPECT_TITLES = {
    "fit": "Fit",
    "fill": "Fill (crop to cell)",
    "stretch": "Stretch",
    "none": "Original size (1:1)",
}

ALIGNMENTS = (
    "top_left", "top", "top_right",
    "left", "center", "right",
    "bottom_left", "bottom", "bottom_right",
)

SLIDESHOW_ORDERS = ("next", "previous", "shuffle")
SLIDESHOW_ORDER_TITLES = {
    "next": "Next file",
    "previous": "Previous file",
    "shuffle": "Random file",
}

GRID_MODES = ("rows", "columns")


@dataclass
class CellState:
    path: str = ""
    aspect: str = "fit"
    zoom: float = 1.0
    # pan offset, as a fraction of the displayed image size
    pan_x: float = 0.0
    pan_y: float = 0.0
    align: str = "center"
    rotation: int = 0  # 0, 90, 180, 270 (clockwise)
    flip_h: bool = False
    flip_v: bool = False
    # crop, as a fraction of each side (0..0.45)
    crop_l: float = 0.0
    crop_t: float = 0.0
    crop_r: float = 0.0
    crop_b: float = 0.0
    slideshow: bool = False
    slideshow_interval: float = 5.0
    slideshow_order: str = "next"
    animation_paused: bool = False
    title: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "CellState":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in names})

    def reset_view(self):
        self.zoom = 1.0
        self.pan_x = 0.0
        self.pan_y = 0.0

    def reset_crop(self):
        self.crop_l = self.crop_t = self.crop_r = self.crop_b = 0.0

    def reset_transform(self):
        self.rotation = 0
        self.flip_h = False
        self.flip_v = False


@dataclass
class GridState:
    layout: str = "masonry"  # masonry (waterfall) / grid
    keep_order: bool = False  # masonry: strict Pinterest order instead of balanced
    mode: str = "rows"  # rows first / columns first
    fit_cells: bool = True  # pick grid size that maximizes photo area
    fixed: bool = False  # use a fixed number of rows/columns
    size: int = 0  # number of columns (rows mode) or rows (columns mode); 0 = auto
    show_all_cells: bool = False  # in fixed mode, keep empty cells visible
    spacing: int = 4


@dataclass
class PlaylistState:
    grid: GridState = field(default_factory=GridState)
    cells: List[CellState] = field(default_factory=list)
    snapshots: Dict[str, dict] = field(default_factory=dict)
    sync_view: bool = False
    shuffle_on_load: bool = False
    disable_click: bool = False
    disable_wheel: bool = False
    disable_overlay: bool = False
    overlay_border: bool = True
    overlay_hide: bool = True
    single_index: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "grid": asdict(self.grid),
            "cells": [c.to_dict() for c in self.cells],
            "snapshots": self.snapshots,
            "sync_view": self.sync_view,
            "shuffle_on_load": self.shuffle_on_load,
            "disable_click": self.disable_click,
            "disable_wheel": self.disable_wheel,
            "disable_overlay": self.disable_overlay,
            "overlay_border": self.overlay_border,
            "overlay_hide": self.overlay_hide,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PlaylistState":
        grid_names = {f.name for f in fields(GridState)}
        grid = GridState(
            **{k: v for k, v in data.get("grid", {}).items() if k in grid_names}
        )
        state = cls(grid=grid)
        state.cells = [CellState.from_dict(c) for c in data.get("cells", [])]
        state.snapshots = data.get("snapshots", {}) or {}
        for key in (
            "sync_view", "shuffle_on_load", "disable_click", "disable_wheel",
            "disable_overlay", "overlay_border", "overlay_hide",
        ):
            if key in data:
                setattr(state, key, bool(data[key]))
        return state
