import logging
import math

from OCP.Bnd import Bnd_Box
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.GCPnts import GCPnts_AbscissaPoint
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Plane
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Edge, TopoDS_Face

from step_processor import load_step

logger = logging.getLogger(__name__)


def _as_face(shape) -> TopoDS_Face:
    if hasattr(TopoDS, "Face_s"):
        return TopoDS.Face_s(shape)
    if hasattr(TopoDS, "Face"):
        try:
            return TopoDS.Face(shape)
        except Exception:
            pass
    f = TopoDS_Face()
    f.TShape(shape.TShape())
    f.Location(shape.Location())
    f.Orientation(shape.Orientation())
    return f


def _as_edge(shape) -> TopoDS_Edge:
    if hasattr(TopoDS, "Edge_s"):
        return TopoDS.Edge_s(shape)
    if hasattr(TopoDS, "Edge"):
        try:
            return TopoDS.Edge(shape)
        except Exception:
            pass
    e = TopoDS_Edge()
    e.TShape(shape.TShape())
    e.Location(shape.Location())
    e.Orientation(shape.Orientation())
    return e


def _edge_length(curve: BRepAdaptor_Curve) -> float:
    try:
        return GCPnts_AbscissaPoint.Length_s(curve)
    except AttributeError:
        return GCPnts_AbscissaPoint.Length(curve)


def _surface_props(face, props: GProp_GProps) -> None:
    try:
        BRepGProp.SurfaceProperties_s(face, props)
    except AttributeError:
        BRepGProp.SurfaceProperties(face, props)


def _bbox_add(shape, bbox: Bnd_Box) -> None:
    try:
        BRepBndLib.Add_s(shape, bbox)
    except AttributeError:
        BRepBndLib.Add(shape, bbox)


def _ortho_axes(nx: float, ny: float, nz: float):
    """Return two unit vectors orthogonal to (nx, ny, nz)."""
    if abs(nx) < 0.9:
        ax, ay, az = 1.0, 0.0, 0.0
    else:
        ax, ay, az = 0.0, 1.0, 0.0
    dot = ax * nx + ay * ny + az * nz
    ux_r = ax - dot * nx
    uy_r = ay - dot * ny
    uz_r = az - dot * nz
    mag = math.sqrt(ux_r**2 + uy_r**2 + uz_r**2) or 1.0
    ux, uy, uz = ux_r / mag, uy_r / mag, uz_r / mag
    vx = ny * uz - nz * uy
    vy = nz * ux - nx * uz
    vz = nx * uy - ny * ux
    return (ux, uy, uz), (vx, vy, vz)


def _bbox_project(corners, dx, dy, dz):
    projs = [x * dx + y * dy + z * dz for x, y, z in corners]
    return max(projs) - min(projs)


def analyse_part(path: str) -> dict:
    shape = load_step(path)

    # ── Bounding box ─────────────────────────────────────────
    bbox = Bnd_Box()
    _bbox_add(shape, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    corners = [
        (xmin, ymin, zmin), (xmax, ymin, zmin),
        (xmin, ymax, zmin), (xmax, ymax, zmin),
        (xmin, ymin, zmax), (xmax, ymin, zmax),
        (xmin, ymax, zmax), (xmax, ymax, zmax),
    ]

    # ── Pass 1: flat faces → thickness direction + area ──────
    largest_flat_area = 0.0
    flat_area_mm2 = 0.0
    thickness_normal: tuple[float, float, float] | None = None
    seen_p1: set[int] = set()

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        curr = exp.Current()
        fid = id(curr.TShape())
        if fid not in seen_p1:
            seen_p1.add(fid)
            try:
                face = _as_face(curr)
                adaptor = BRepAdaptor_Surface(face)
                if adaptor.GetType() == GeomAbs_Plane:
                    props = GProp_GProps()
                    _surface_props(face, props)
                    area = abs(props.Mass())
                    if math.isfinite(area):
                        flat_area_mm2 += area
                        if area > largest_flat_area:
                            largest_flat_area = area
                            d = adaptor.Plane().Axis().Direction()
                            thickness_normal = (abs(d.X()), abs(d.Y()), abs(d.Z()))
            except Exception as exc:
                logger.debug("Face pass1: %s", exc)
        exp.Next()

    # Thickness = extent along face normal; blank dims = perpendicular extent
    if thickness_normal is not None:
        nx, ny, nz = thickness_normal
        thickness_mm = _bbox_project(corners, nx, ny, nz)
        (ux, uy, uz), (vx, vy, vz) = _ortho_axes(nx, ny, nz)
        fp_a = _bbox_project(corners, ux, uy, uz)
        fp_b = _bbox_project(corners, vx, vy, vz)
        blank_w = max(fp_a, fp_b)
        blank_h = min(fp_a, fp_b)
    else:
        dims = sorted([xmax - xmin, ymax - ymin, zmax - zmin])
        thickness_mm, blank_h, blank_w = dims[0], dims[1], dims[2]

    # ── Pass 2: count bends (cylindrical faces with axis ⊥ thickness) ──
    bend_count = 0
    seen_p2: set[int] = set()

    exp2 = TopExp_Explorer(shape, TopAbs_FACE)
    while exp2.More():
        curr = exp2.Current()
        fid = id(curr.TShape())
        if fid not in seen_p2:
            seen_p2.add(fid)
            try:
                face = _as_face(curr)
                adaptor = BRepAdaptor_Surface(face)
                if adaptor.GetType() == GeomAbs_Cylinder:
                    if thickness_normal is not None:
                        ax = adaptor.Cylinder().Axis().Direction()
                        dot = abs(
                            ax.X() * thickness_normal[0]
                            + ax.Y() * thickness_normal[1]
                            + ax.Z() * thickness_normal[2]
                        )
                        # axis ⊥ to sheet normal → bend; axis ∥ → hole wall
                        if dot < 0.5:
                            bend_count += 1
                    else:
                        bend_count += 1
            except Exception as exc:
                logger.debug("Face pass2: %s", exc)
        exp2.Next()

    # ── Edge analysis: cut perimeter + hole count ─────────────
    cut_perimeter_mm = 0.0
    circle_count = 0
    seen_edges: set[int] = set()

    exp3 = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp3.More():
        curr = exp3.Current()
        eid = id(curr.TShape())
        if eid not in seen_edges:
            seen_edges.add(eid)
            try:
                edge = _as_edge(curr)
                curve = BRepAdaptor_Curve(edge)
                first = curve.FirstParameter()
                last = curve.LastParameter()
                if math.isfinite(first) and math.isfinite(last) and last > first:
                    length = _edge_length(curve)
                    if math.isfinite(length) and length > 0:
                        cut_perimeter_mm += length
                    if curve.GetType() == GeomAbs_Circle:
                        circle_count += 1
            except Exception as exc:
                logger.debug("Edge skip: %s", exc)
        exp3.Next()

    hole_count = max(0, circle_count // 2)

    return {
        "bbox_mm": [round(blank_w, 1), round(blank_h, 1), round(thickness_mm, 1)],
        "thickness_mm": round(thickness_mm, 1),
        "cut_perimeter_mm": round(cut_perimeter_mm, 1),
        "hole_count": hole_count,
        "bend_count": bend_count,
        "flat_area_mm2": round(flat_area_mm2, 1),
        "flat_pattern_area_mm2": round(flat_area_mm2 / 2.0, 1),
    }
