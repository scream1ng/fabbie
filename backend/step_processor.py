import io
import logging
import math
import os
import tempfile
from typing import Callable, List, Tuple

logger = logging.getLogger(__name__)

from PIL import Image, ImageDraw
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.StlAPI import StlAPI_Writer
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Edge
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

DEFAULT_DPI = 300
DEFAULT_LABEL_CM = 26.0
EXPORT_SUPERSAMPLE = 2
PADDING_FRAC = 0.08

_S2 = math.sqrt(2)
_S3 = math.sqrt(3)
Vec3 = Tuple[float, float, float]

VIEWS: dict[str, Tuple[Vec3, Vec3]] = {
    "isometric": ((1 / _S3, 1 / _S3, 1 / _S3), (1 / _S2, -1 / _S2, 0.0)),
    "front": ((0.0, 1.0, 0.0), (1.0, 0.0, 0.0)),
    "back": ((0.0, -1.0, 0.0), (-1.0, 0.0, 0.0)),
    "right": ((1.0, 0.0, 0.0), (0.0, -1.0, 0.0)),
    "left": ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "top": ((0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
    "bottom": ((0.0, 0.0, -1.0), (1.0, 0.0, 0.0)),
}


def _norm(v: Vec3) -> Vec3:
    x, y, z = v
    mag = math.sqrt(x * x + y * y + z * z) or 1.0
    return (x / mag, y / mag, z / mag)


def _label_px(label_cm: float, dpi: int) -> int:
    return max(1, round((label_cm / 2.54) * dpi))


def _finite(v: float) -> bool:
    return math.isfinite(v)


def load_step(path: str):
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise ValueError(f"Cannot read STEP file: {path}")
    reader.TransferRoots()
    return reader.OneShape()


def step_to_stl(path: str) -> bytes:
    """Convert a STEP file to STL bytes for the interactive preview."""
    shape = load_step(path)
    BRepMesh_IncrementalMesh(shape, 0.03, False, 0.12).Perform()
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False)
    tmp.close()
    StlAPI_Writer().Write(shape, tmp.name)
    data = open(tmp.name, "rb").read()
    os.unlink(tmp.name)
    return data


def _extract_edges(
    compound,
    project: Callable[[float, float, float], Tuple[float, float]],
    result: List,
) -> None:
    if compound.IsNull():
        return
    exp = TopExp_Explorer(compound, TopAbs_EDGE)
    while exp.More():
        edge = TopoDS_Edge(exp.Current())
        try:
            curve = BRepAdaptor_Curve(edge)
            disc = GCPnts_TangentialDeflection()
            disc.Initialize(curve, 0.15, 0.02)
            pts = [project(*disc.Value(i).Coord()) for i in range(1, disc.NbPoints() + 1)]
            if len(pts) >= 2:
                result.append(pts)
        except Exception:
            pass
        exp.Next()


def visible_polylines(
    shape,
    n: Vec3,
    vx: Vec3,
    origin: Vec3 = (0.0, 0.0, 0.0),
    focus: float | None = None,
) -> List:
    ax2 = gp_Ax2(gp_Pnt(*origin), gp_Dir(*n), gp_Dir(*vx))
    projector = HLRAlgo_Projector(ax2, focus) if focus is not None else HLRAlgo_Projector(ax2)

    def project(x: float, y: float, z: float) -> Tuple[float, float]:
        px, py, _ = projector.Project(gp_Pnt(x, y, z))
        return (px, py)

    hlr = HLRBRep_Algo()
    hlr.Add(shape)
    hlr.Projector(projector)
    hlr.Update()
    hlr.Hide()
    hs = HLRBRep_HLRToShape(hlr)
    result = []
    for getter_name in ("VCompound", "Rg1LineVCompound", "RgNLineVCompound", "OutLineVCompound"):
        getter = getattr(hs, getter_name, None)
        if getter is not None:
            _extract_edges(getter(), project, result)
    return result


def polylines_to_jpg(
    lines: List,
    line_px: int = 3,
    label_cm: float = DEFAULT_LABEL_CM,
    dpi: int = DEFAULT_DPI,
    focus: float | None = None,
    fov_deg: float | None = None,
) -> bytes:
    if not lines:
        raise ValueError("No visible edges found; check STEP file")

    label_px = _label_px(label_cm, dpi)
    work_px = label_px * EXPORT_SUPERSAMPLE

    if focus is not None and fov_deg is not None:
        half_view = focus * math.tan(math.radians(fov_deg) / 2.0)
        if half_view <= 0:
            raise ValueError("Invalid perspective framing")

        pixels_per_unit = (work_px / 2.0) / half_view

        def to_px(px: float, py: float) -> Tuple[int, int]:
            return (
                int(round(work_px / 2.0 + px * pixels_per_unit)),
                int(round(work_px / 2.0 - py * pixels_per_unit)),
            )

    else:
        all_pts = [p for polyline in lines for p in polyline]
        xs, ys = zip(*all_pts)
        xmin, xmax = min(xs), max(xs)
        ymin, ymax = min(ys), max(ys)
        span = max(xmax - xmin, ymax - ymin) or 1.0
        draw_px = work_px * (1.0 - 2.0 * PADDING_FRAC)
        scale = draw_px / span
        ox = (work_px - (xmax - xmin) * scale) / 2.0
        oy = (work_px - (ymax - ymin) * scale) / 2.0

        def to_px(px: float, py: float) -> Tuple[int, int]:
            return (
                int((px - xmin) * scale + ox),
                int((ymax - py) * scale + oy),
            )

    img = Image.new("RGB", (work_px, work_px), "white")
    draw = ImageDraw.Draw(img)
    line_width = max(1, round(line_px * EXPORT_SUPERSAMPLE))
    for polyline in lines:
        if len(polyline) < 2:
            continue
        coords = [to_px(*p) for p in polyline]
        for i in range(len(coords) - 1):
            draw.line([coords[i], coords[i + 1]], fill="black", width=line_width)

    if work_px != label_px:
        img = img.resize((label_px, label_px), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=100, subsampling=0, dpi=(dpi, dpi))
    return buf.getvalue()


def step_to_edges_json(path: str) -> list:
    """Return all BRep edges as 3D polylines, including smooth/fillet edges."""
    shape = load_step(path)
    result = []
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        curr = exp.Current()
        if curr.IsNull():
            exp.Next()
            continue
        try:
            edge = TopoDS_Edge(curr)
            curve = BRepAdaptor_Curve(edge)
            first = curve.FirstParameter()
            last = curve.LastParameter()
            if not (_finite(first) and _finite(last) and last > first):
                exp.Next()
                continue
            disc = GCPnts_TangentialDeflection()
            disc.Initialize(curve, 0.1, 0.01)
            count = disc.NbPoints()
            if count < 2:
                exp.Next()
                continue
            pts = []
            for i in range(1, count + 1):
                p = disc.Value(i)
                x, y, z = p.X(), p.Y(), p.Z()
                if _finite(x) and _finite(y) and _finite(z):
                    pts.append([round(x, 3), round(y, 3), round(z, 3)])
            if len(pts) >= 2:
                result.append(pts)
        except Exception as e:
            logger.warning("Edge skip: %s", e)
        exp.Next()
    logger.info("step_to_edges_json: %d polylines extracted", len(result))
    return result


def step_to_jpg(
    path: str,
    line_px: int = 3,
    view: str = "isometric",
    eye: Vec3 | None = None,
    right: Vec3 | None = None,
    target: Vec3 | None = None,
    focus: float | None = None,
    fov_deg: float | None = None,
    label_cm: float = DEFAULT_LABEL_CM,
    dpi: int = DEFAULT_DPI,
) -> bytes:
    shape = load_step(path)

    if eye is not None and right is not None:
        n = _norm(eye)
        vx = _norm(right)
        origin = target if target is not None else (0.0, 0.0, 0.0)
    else:
        if view not in VIEWS:
            raise ValueError(f"Unknown view '{view}'")
        n, vx = VIEWS[view]
        origin = (0.0, 0.0, 0.0)
        focus = None
        fov_deg = None

    lines = visible_polylines(shape, n, vx, origin=origin, focus=focus)
    return polylines_to_jpg(
        lines,
        line_px=line_px,
        label_cm=label_cm,
        dpi=dpi,
        focus=focus,
        fov_deg=fov_deg,
    )
