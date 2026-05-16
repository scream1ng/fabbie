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


from collections import Counter

def analyse_part(path: str) -> dict:
    shape = load_step(path)

    # ── Geometry Extraction ──────────────────────────────────
    planes = []
    cylinders = []
    seen_faces = set()
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        curr = exp.Current()
        fid = id(curr.TShape())
        if fid not in seen_faces:
            seen_faces.add(fid)
            try:
                face = _as_face(curr)
                adaptor = BRepAdaptor_Surface(face)
                props = GProp_GProps()
                _surface_props(face, props)
                area = abs(props.Mass())
                if not math.isfinite(area) or area < 1e-6:
                    exp.Next()
                    continue

                stype = adaptor.GetType()
                if stype == GeomAbs_Plane:
                    p = adaptor.Plane()
                    planes.append({
                        "area": area,
                        "normal": (p.Axis().Direction().X(), p.Axis().Direction().Y(), p.Axis().Direction().Z()),
                        "d": p.Location().Dot(p.Axis().Direction()),
                        "face": face
                    })
                elif stype == GeomAbs_Cylinder:
                    c = adaptor.Cylinder()
                    cylinders.append({
                        "area": area,
                        "radius": c.Radius(),
                        "axis": (c.Axis().Direction().X(), c.Axis().Direction().Y(), c.Axis().Direction().Z()),
                        "face": face
                    })
            except Exception as exc:
                logger.debug("Face extract: %s", exc)
        exp.Next()

    # ── Thickness Detection (Parallel Face Pairing) ───────────
    distances = []
    for i in range(len(planes)):
        for j in range(i + 1, len(planes)):
            n1 = planes[i]["normal"]
            n2 = planes[j]["normal"]
            # Check if normals are parallel or anti-parallel
            dot = n1[0]*n2[0] + n1[1]*n2[1] + n1[2]*n2[2]
            if abs(abs(dot) - 1.0) < 1e-3:
                dist = abs(planes[i]["d"] - (planes[j]["d"] if dot > 0 else -planes[j]["d"]))
                if 0.1 < dist < 30.0:  # Sensible sheet thickness range
                    distances.append(round(dist, 2))
    
    if distances:
        # Use most common distance as thickness
        thickness_mm = Counter(distances).most_common(1)[0][0]
    else:
        # Fallback to bbox smallest dim if no parallel faces found
        bbox = Bnd_Box()
        _bbox_add(shape, bbox)
        xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
        thickness_mm = min(xmax - xmin, ymax - ymin, zmax - zmin)

    # ── Flat Pattern Calculation ─────────────────────────────
    # Sum of areas of one side (Total Area / 2) is a good start,
    # but we can refine it by considering the neutral axis.
    total_surface_area = sum(p["area"] for p in planes) + sum(c["area"] for c in cylinders)
    
    # Identify unique bends and flanges
    bend_count = len(cylinders) // 2  # Assuming internal/external cylinder pairs
    
    # Calculate neutral area for cylinders
    # A_neutral = A_surface * (R_neutral / R_surface)
    # K-factor 0.44 is common for mild steel
    k_factor = 0.44
    neutral_area = 0.0
    for c in cylinders:
        # Try to guess if it's internal or external radius
        # Typically internal R < external R by 'thickness'
        # We simplify: assume all cylindrical faces are bends and take mid-radius
        r = c["radius"]
        # If we found thickness, we can estimate neutral radius
        # But without knowing if 'r' is inner or outer, we take the average 
        # of the total cylindrical surface area adjusted for K-factor
        neutral_area += c["area"] # Simplified: area of one side is ~ Half the total cylinder area
    
    flat_area_mm2 = (sum(p["area"] for p in planes) / 2.0) + (sum(c["area"] for c in cylinders) / 2.0)

    # ── Edge analysis: cut perimeter + hole count ─────────────
    # A 'cut' edge is usually one shared by only 1 face (boundary)
    # or edges forming internal holes.
    cut_perimeter_mm = 0.0
    circle_count = 0
    
    edge_to_faces = {}
    exp_e = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp_e.More():
        edge = _as_edge(exp_e.Current())
        eid = id(edge.TShape())
        if eid not in edge_to_faces:
            edge_to_faces[eid] = []
        
        # Find faces sharing this edge
        # This is expensive, but necessary for accurate perimeter
        exp_f = TopExp_Explorer(shape, TopAbs_FACE)
        face_count = 0
        while exp_f.More():
            face = _as_face(exp_f.Current())
            # Check if edge belongs to face
            exp_ef = TopExp_Explorer(face, TopAbs_EDGE)
            while exp_ef.More():
                if exp_ef.Current().IsSame(edge):
                    face_count += 1
                    break
                exp_ef.Next()
            exp_f.Next()
        
        try:
            curve = BRepAdaptor_Curve(edge)
            first = curve.FirstParameter()
            last = curve.LastParameter()
            if math.isfinite(first) and math.isfinite(last) and last > first:
                length = _edge_length(curve)
                # If shared by only 1 face, it's a boundary cut
                # If shared by 2 faces and it's a 'sharp' or 'bend' edge, it's NOT a cut
                if face_count == 1:
                    cut_perimeter_mm += length
                
                if curve.GetType() == GeomAbs_Circle:
                    # Circular edges are often holes (count both sides)
                    circle_count += 1
        except Exception:
            pass
        exp_e.Next()

    # In sheet metal, hole count is usually number of interior loops.
    # Simplified: circle pairs (top/bottom)
    hole_count = max(0, circle_count // 2)
    
    # ── Flat Blank Estimation ────────────────────────────────
    # We have flat_area_mm2. We want to guess L and W.
    # We use the aspect ratio of the largest face as a heuristic.
    if planes:
        largest_p = max(planes, key=lambda x: x["area"])
        # Get aspect ratio of this face using its bbox
        f_bbox = Bnd_Box()
        _bbox_add(largest_p["face"], f_bbox)
        fx1, fy1, fz1, fx2, fy2, fz2 = f_bbox.Get()
        # The face is flat, so one dimension is small (thickness)
        f_dims = sorted([fx2 - fx1, fy2 - fy1, fz2 - fz1], reverse=True)
        f_l, f_w = f_dims[0], f_dims[1]
        aspect_ratio = f_l / max(f_w, 1.0)
        
        # Area = L * W, L/W = aspect_ratio => Area = W * aspect_ratio * W
        blank_w = math.sqrt(flat_area_mm2 / aspect_ratio)
        blank_l = blank_w * aspect_ratio
    else:
        side = math.sqrt(flat_area_mm2)
        blank_l, blank_w = side, side

    return {
        "bbox_mm": [round(blank_l, 1), round(blank_w, 1), round(thickness_mm, 1)],
        "thickness_mm": round(thickness_mm, 1),
        "cut_perimeter_mm": round(cut_perimeter_mm, 1),
        "hole_count": hole_count,
        "bend_count": bend_count,
        "flat_area_mm2": round(flat_area_mm2, 1),
        "flat_pattern_area_mm2": round(flat_area_mm2, 1),
    }
