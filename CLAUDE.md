# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
# pythonocc-core MUST be installed via conda — pip wheel is broken
conda create -n step-label python=3.11
conda activate step-label
conda install -c conda-forge pythonocc-core
cd backend
pip install fastapi "uvicorn[standard]" pillow python-multipart

# Run dev server
uvicorn main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npm run build
```

### Docker (backend only)
```bash
docker build -t step-label-backend ./backend
docker run -p 8000:8000 step-label-backend
```

## Architecture

**Backend** (`backend/`) — FastAPI app with three endpoints:
- `POST /api/mesh` → binary STL for Three.js interactive preview
- `POST /api/edges` → JSON 3D polylines (all BRep edges including fillets) for wireframe overlay
- `POST /api/convert` → server-side HLR-projected JPG (currently unused by frontend; legacy/alternate export path)

All endpoints accept `multipart/form-data` with a `.step`/`.stp` file, write it to a temp file, process, then `unlink`. Processing is in `step_processor.py` using `pythonocc-core` (OpenCASCADE bindings) + Pillow. `HLRBRep_Algo` drives hidden-line removal for the `/api/convert` path; `GCPnts_TangentialDeflection` discretizes BRep curves for the `/api/edges` path.

**Frontend** (`frontend/`) — Single-page Next.js 14 app (`app/page.tsx`, ~495 lines). On file drop/select:
1. Parallel `fetch` to `/api/mesh` and `/api/edges`
2. Three.js renders STL mesh (depth-write pass + white fill pass) + `LineSegments2` edge overlay in an interactive `OrbitControls` viewport
3. On export: Three.js renders off-screen at target resolution → `canvas.toDataURL` → client-side JPG download (no backend call)

**API proxy**: Next.js rewrites `/api/*` → `http://localhost:8000/api/*` (or `NEXT_PUBLIC_API_URL` env var).

**No test suite** exists currently.

## Key constraints

- `pythonocc-core` is conda-only. Never attempt `pip install pythonocc-core`.
- Export is entirely client-side (Three.js canvas). The `/api/convert` HLR endpoint exists but is not wired to the UI.
- Line thickness in the viewport uses `LineMaterial.linewidth` (screen pixels, not world units). Export re-renders at target `px × px` and resets resolution on the material afterward.
- `loadIdRef` guards against race conditions when a new file is dropped before the previous load completes.
