# -*- coding: utf-8 -*-
"""
Renders a head MRI volume as a game card.

Shared by build_cards.py (original faces, rendered locally from IXI) and
export_anon_assets.py (anonymised faces, rendered once by the maintainer).
Both sides must use exactly these parameters, otherwise the two halves of a
pair stop matching visually.
"""

import math
import os
import platform

import nibabel as nib
import numpy as np
import pyvista as pv
from matplotlib.colors import LinearSegmentedColormap
from skimage.filters import gaussian

CARD_SIZE = 800          # pixels per side
SAMPLE_DIST = 0.1070

# Clay-coloured bust on a light background. The plain grey-on-black rendering
# used for clinical reading looked too grim for children.
LOOK = dict(
    cmap=LinearSegmentedColormap.from_list(
        "barro", ["#5c2f22", "#c2684a", "#efa980", "#ffe0c8"]),
    bg=("#e6ddd0", "#f6efe4"),
    sigma=0.9,
    ambient=0.55, diffuse=1.0, specular=0.08, spec_power=8,
)

# A and B are used by the "hard" difficulty (the two cards of a pair differ in
# angle); F is the frontal view of the "easy" difficulty.
POSES = {
    "A": {"azimuth": -20.0, "elevation":  6.0},
    "B": {"azimuth":  25.0, "elevation": -8.0},
    "F": {"azimuth":   0.0, "elevation":  0.0},
}

# "cabeca" shows the whole head; "cara" closes in on the face so the skull
# outline stops being a cue. focus_dz lowers the camera target, as a fraction
# of the largest volume dimension.
FRAMINGS = {
    "cabeca": {"distance": 2.5, "focus_dz":  0.00},
    "cara":   {"distance": 1.4, "focus_dz": -0.06},
}

KINDS = ("original", "anon")
EXT = ".webp"
WEBP_QUALITY = 95


def card_name(framing, kind, pose):
    return "{}_{}_pose{}{}".format(framing, kind, pose, EXT)


def ensure_display():
    """Headless Linux has no display for VTK; fall back to a virtual one."""
    if platform.system() == "Linux" and not os.environ.get("DISPLAY"):
        try:
            pv.start_xvfb()
        except Exception as exc:                                  # noqa: BLE001
            raise SystemExit(
                "No display available for off-screen rendering. Install Xvfb "
                "(e.g. apt install xvfb) or run under xvfb-run.\n  ({})".format(exc))


def opacity_params(data, voxel_spacing, percentil_ar=20, percentil_pele=35):
    """Opacity thresholds derived from the volume itself."""
    limiar_ar = np.percentile(data, percentil_ar)
    tecido = data[data > limiar_ar]
    min_op = float(np.percentile(tecido, percentil_pele))
    max_op = float(np.percentile(tecido, 99))
    op_unit = float(np.linalg.norm(voxel_spacing) * 0.5)
    return min_op, max_op, op_unit


def load_grid(nifti_path):
    """
    Loads a volume in canonical RAS orientation and returns the PyVista grid
    and the opacity parameters.

    The official IXI files are stored in PSR orientation; reorienting to RAS
    is the only transformation between the downloaded file and the volume the
    anonymised cards were rendered from.
    """
    nifti = nib.as_closest_canonical(nib.load(nifti_path))
    data = nifti.get_fdata().astype(np.float32)
    spacing = nifti.header.get_zooms()[:3]

    vol_min, vol_max = float(np.min(data)), float(np.max(data))
    min_op, max_op, op_unit = opacity_params(data, spacing)

    if LOOK["sigma"] > 0.01:
        data = gaussian(data, sigma=LOOK["sigma"])

    grid = pv.ImageData()
    grid.dimensions = np.array(data.shape)
    grid.spacing = spacing
    grid.point_data["intensities"] = data.flatten(order="F")
    return grid, (vol_min, vol_max, min_op, max_op, op_unit)


def camera_for(grid, pose, framing):
    """
    Camera position for a pose and a framing.

    Axes (NIfTI RAS): +Y points to the face, +Z to the top of the head.
    Azimuth 0 and elevation 0 is the frontal view.
    """
    angles, frame = POSES[pose], FRAMINGS[framing]
    b = grid.bounds
    cx, cy, cz = (b[0] + b[1]) / 2.0, (b[2] + b[3]) / 2.0, (b[4] + b[5]) / 2.0
    largest = max(b[1] - b[0], b[3] - b[2], b[5] - b[4])
    dist = largest * frame["distance"]
    cz += frame["focus_dz"] * largest

    a, e = math.radians(angles["azimuth"]), math.radians(angles["elevation"])
    eye = (cx + dist * math.sin(a) * math.cos(e),
           cy + dist * math.cos(a) * math.cos(e),
           cz + dist * math.sin(e))
    return [eye, (cx, cy, cz), (0.0, 0.0, 1.0)]


def render(grid, params, camera_pos, size=CARD_SIZE):
    """Renders one view and returns an (H, W, 3) uint8 array."""
    vol_min, vol_max, min_op, max_op, op_unit = params

    plotter = pv.Plotter(off_screen=True, window_size=[size, size])
    plotter.set_background(LOOK["bg"][0], top=LOOK["bg"][1])
    volume = plotter.add_volume(
        grid, scalars="intensities", cmap=LOOK["cmap"], shade=True,
        ambient=LOOK["ambient"], diffuse=LOOK["diffuse"],
        specular=LOOK["specular"], specular_power=LOOK["spec_power"],
        show_scalar_bar=False,
    )
    if hasattr(volume.mapper, "SetAutoAdjustSampleDistances"):
        volume.mapper.SetAutoAdjustSampleDistances(0)
    volume.prop.interpolation_type = "linear"
    if hasattr(volume.prop, "SetScalarOpacityUnitDistance"):
        volume.prop.SetScalarOpacityUnitDistance(op_unit)
    if hasattr(volume.mapper, "SetSampleDistance"):
        volume.mapper.SetSampleDistance(SAMPLE_DIST)

    pwf = volume.prop.GetScalarOpacity()
    pwf.RemoveAllPoints()
    pwf.AddPoint(vol_min, 0.0)
    pwf.AddPoint(min_op, 0.0)
    pwf.AddPoint(max_op, 1.0)
    pwf.AddPoint(vol_max, 1.0)

    plotter.camera_position = camera_pos
    img = plotter.screenshot(return_img=True)
    plotter.close()
    return img[:, :, :3] if img.ndim == 3 and img.shape[2] == 4 else img


def render_all(nifti_path):
    """Yields (framing, pose, image) for every card of one volume."""
    grid, params = load_grid(nifti_path)
    for framing in FRAMINGS:
        for pose in POSES:
            yield framing, pose, render(grid, params, camera_for(grid, pose, framing))
