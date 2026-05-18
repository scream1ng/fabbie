# step-to-label

Upload a STEP file and get three things in one local workflow:

- a 3D hidden-line viewer
- a costing window
- an editable MLB and PFC

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14, Tailwind CSS |
| Backend | FastAPI |
| CAD engine | pythonocc-core / OpenCASCADE |
| 3D viewer | three.js |

## Current Workflow

After upload, the page is arranged as a vertical flow:

1. 3D viewer
2. export controls
3. costing
4. MLB
5. PFC

### Costing

- material, sheet, thickness, MOQ
- process toggles for laser, bend, weld, finish, packing
- editable rates / setup / pcs per hour
- total unit cost and MOQ total

### MLB

- separate section from costing
- columns: `Type`, `Level`, `Part Number`, `Description`
- `Part Number` and `Description` are editable
- `Level` is editable and cascades through child rows
- process rows are generated from the process checkboxes in costing
- FG changes flow down into process row part numbers and descriptions

### PFC

- separate section from MLB
- generated from the current MLB rows
- centered flow cards with width sized closer to content

## Local Setup

### Backend

`pythonocc-core` should be installed with conda:

```bash
conda create -n step-label python=3.11
conda activate step-label
conda install -c conda-forge pythonocc-core

cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Health check:

```bash
http://127.0.0.1:8000/health
```

### Frontend

```bash
cd frontend
npm install
npm run dev -- --port 3000
```

Open:

```bash
http://127.0.0.1:3000
```

## Notes

- Upload endpoint used by the frontend: `POST /api/full-process`
- The frontend dev server can occasionally get into a stale Next.js cache state on restart. If that happens, clear `frontend/.next` and restart `npm run dev -- --port 3000`.
