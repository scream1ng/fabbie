# step-to-label

Drop a STEP file → get an isometric wireframe JPG (26×26 cm, 300 dpi) for label printing.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14, Tailwind CSS |
| Backend | Python FastAPI |
| CAD engine | pythonocc-core (OpenCASCADE) |
| Image | Pillow |

## Setup

### Backend

pythonocc-core must be installed via **conda** (pip wheel is unreliable):

```bash
conda create -n step-label python=3.11
conda activate step-label
conda install -c conda-forge pythonocc-core

cd backend
pip install fastapi "uvicorn[standard]" pillow python-multipart
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

## Usage

1. Drop a `.step` / `.stp` file onto the drop zone
2. Adjust line thickness if needed
3. Click **Generate label**
4. Preview renders — click **Download** to save JPG

Output: `<filename>_label.jpg` — 3071×3071 px, 300 dpi, white background, black wireframe.

## API

```
POST /api/convert?line_px=3
  body: multipart/form-data  field: file (.step/.stp)
  returns: image/jpeg
```

## Roadmap

- [ ] Sheet metal costing (laser cut — material + cut length)
- [ ] Press brake — bend count × length pricing
- [ ] Welding estimate
- [ ] PDF export with part number / BOM
