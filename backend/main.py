import os
import tempfile
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from fastapi.responses import JSONResponse
from cost_analysis import analyse_part
from step_processor import step_to_edges_json, step_to_jpg, step_to_stl

app = FastAPI(title="step-to-label API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Recommend changing "*" to your production frontend URL later
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _save_upload(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as tmp:
        tmp.write(data)
        return tmp.name


def _check_file(file: UploadFile) -> None:
    name = (file.filename or "").lower()
    if not name.endswith((".step", ".stp")):
        raise HTTPException(400, "Only .step / .stp files accepted")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/mesh")
async def mesh(file: UploadFile = File(...)):
    """Return binary STL for Three.js interactive preview."""
    _check_file(file)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    tmp_path = _save_upload(data)
    try:
        stl = step_to_stl(tmp_path)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(500, f"Mesh error: {e}")
    finally:
        os.unlink(tmp_path)
    return Response(content=stl, media_type="model/stl")


@app.post("/api/edges")
async def edges(file: UploadFile = File(...)):
    """Return BRep edges as JSON 3D polylines (includes fillet/smooth edges)."""
    _check_file(file)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    tmp_path = _save_upload(data)
    try:
        edge_data = step_to_edges_json(tmp_path)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(500, f"Edge error: {e}")
    finally:
        os.unlink(tmp_path)
    return JSONResponse(content=edge_data)


@app.post("/api/convert")
async def convert(
    file: UploadFile = File(...),
    line_px: int = Query(3, ge=1, le=20),
    view: str = Query("isometric"),
    label_cm: float = Query(26.0, ge=5.0, le=100.0),
    dpi: int = Query(300, ge=72, le=1200),
    eye_x: Optional[float] = Query(None),
    eye_y: Optional[float] = Query(None),
    eye_z: Optional[float] = Query(None),
    right_x: Optional[float] = Query(None),
    right_y: Optional[float] = Query(None),
    right_z: Optional[float] = Query(None),
    target_x: Optional[float] = Query(None),
    target_y: Optional[float] = Query(None),
    target_z: Optional[float] = Query(None),
    focus: Optional[float] = Query(None, gt=0),
    fov_deg: Optional[float] = Query(None, gt=0, lt=180),
):
    _check_file(file)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    tmp_path = _save_upload(data)

    # Use camera vectors from Three.js if all six supplied
    eye = (eye_x, eye_y, eye_z) if None not in (eye_x, eye_y, eye_z) else None
    right = (right_x, right_y, right_z) if None not in (right_x, right_y, right_z) else None
    target = (target_x, target_y, target_z) if None not in (target_x, target_y, target_z) else None

    try:
        jpg = step_to_jpg(
            tmp_path,
            line_px=line_px,
            view=view,
            eye=eye,
            right=right,
            target=target,
            focus=focus,
            fov_deg=fov_deg,
            label_cm=label_cm,
            dpi=dpi,
        )
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(500, f"Processing error: {e}")
    finally:
        os.unlink(tmp_path)

    stem = os.path.splitext(file.filename or "part")[0]
    return Response(
        content=jpg,
        media_type="image/jpeg",
        headers={"Content-Disposition": f'attachment; filename="{stem}_label.jpg"'},
    )


@app.post("/api/analyse")
async def analyse(file: UploadFile = File(...)):
    """Return fabrication feature analysis (bbox, bends, perimeter, etc.) for cost estimation."""
    _check_file(file)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    tmp_path = _save_upload(data)
    try:
        result = analyse_part(tmp_path)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(500, f"Analysis error: {e}")
    finally:
        os.unlink(tmp_path)
    return JSONResponse(content=result)
