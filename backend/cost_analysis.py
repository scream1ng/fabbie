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


def analyse_part(path: str) -> dict:
    shape = load_step(path)

    # ── Bounding box ─────────────────────────────────────────
    bbox = Bnd_Box()
    _bbox_add(shape, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    dims = sorted([xmax - xmin, ymax - ymin, zmax - zmin])
    thickness_mm = dims[0]
    h_mm = dims[1]
    w_mm = dims[2]

    # ── Face analysis — bends + flat area (deduplicated) ─────
    bend_count = 0
    flat_area_mm2 = 0.0
    seen_faces: set[int] = set()

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        curr = exp.Current()
        fid = id(curr.TShape())
        if fid not in seen_faces:
            seen_faces.add(fid)
            try:
                face = _as_face(curr)
                adaptor = BRepAdaptor_Surface(face)
                surf_type = adaptor.GetType()
                if surf_type == GeomAbs_Cylinder:
                    bend_count += 1
                elif surf_type == GeomAbs_Plane:
                    props = GProp_GProps()
                    _surface_props(face, props)
                    area = abs(props.Mass())
                    if math.isfinite(area):
                        flat_area_mm2 += area
            except Exception as exc:
                logger.debug("Face skip: %s", exc)
        exp.Next()

    # ── Edge analysis — cut perimeter + holes (deduplicated) ─
    cut_perimeter_mm = 0.0
    circle_count = 0
    seen_edges: set[int] = set()

    exp2 = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp2.More():
        curr = exp2.Current()
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
        exp2.Next()

    # Each full circular edge loop = 1 hole; shared inner/outer edges → halve
    hole_count = max(0, circle_count // 2)

    return {
        "bbox_mm": [round(w_mm, 1), round(h_mm, 1), round(thickness_mm, 1)],
        "thickness_mm": round(thickness_mm, 1),
        "cut_perimeter_mm": round(cut_perimeter_mm, 1),
        "hole_count": hole_count,
        "bend_count": bend_count,
        "flat_area_mm2": round(flat_area_mm2, 1),
    }
