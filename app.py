"""
app.py — Orgo AI web application.

Serves the frontend at / and exposes POST /analyze which accepts an image
upload (JPEG, PNG, HEIC/HEIF from iPhone), runs the preprocessing pipeline,
and returns SMILES + stage images as base64 JSON.

Start:  uvicorn app:app --host 0.0.0.0 --port 8000 --reload
Or use: start.bat
"""

import asyncio
import base64
import io
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

# Register HEIC/HEIF support for iPhone photos (no-op if not installed)
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

from preprocessing import denoise, deskew, normalize_binarize, perspective_correct

app = FastAPI(title="Orgo AI")

# DECIMER is a heavy model — lazy-load once and reuse
_decimer_fn = None

# Single worker: DECIMER is not thread-safe under concurrent calls
_executor = ThreadPoolExecutor(max_workers=1)

# Resize large iPhone photos before the slow denoise step
MAX_DIM = 1800


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_decimer():
    global _decimer_fn
    if _decimer_fn is None:
        from DECIMER import predict_SMILES
        _decimer_fn = predict_SMILES
    return _decimer_fn


def _is_valid_smiles(smiles: str) -> bool:
    if not smiles:
        return False
    try:
        from rdkit import Chem
        return Chem.MolFromSmiles(smiles) is not None
    except Exception:
        return False


def _to_b64(img: np.ndarray) -> str | None:
    if img is None:
        return None
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf).decode() if ok else None


def _resize(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    if max(h, w) > MAX_DIM:
        scale = MAX_DIM / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)),
                         interpolation=cv2.INTER_AREA)
    return img


# ── Core processing (runs in thread pool) ─────────────────────────────────────

def _process(raw_bytes: bytes) -> dict:
    # Decode — Pillow handles JPEG, PNG, HEIC (via pillow-heif), TIFF, etc.
    try:
        pil = Image.open(io.BytesIO(raw_bytes))
        # Respect EXIF rotation so iPhone portrait photos aren't sideways
        try:
            from PIL import ImageOps
            pil = ImageOps.exif_transpose(pil)
        except Exception:
            pass
        pil = pil.convert("RGB")
        img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise ValueError(f"Could not decode image: {exc}") from exc

    img = _resize(img)

    stages: dict[str, str | None] = {"original": _to_b64(img)}
    current = img.copy()

    pipeline = [
        ("perspective", perspective_correct),
        ("deskew",      deskew),
        ("denoise",     denoise),
        ("binarize",    normalize_binarize),
    ]

    for name, fn in pipeline:
        try:
            result = fn(current)
            if result is not None and isinstance(result, np.ndarray):
                current = result
        except Exception:
            pass  # stage failed; carry forward current image unchanged
        stages[name] = _to_b64(current)

    stages["final"] = _to_b64(current)

    # Run DECIMER via a temp file (it only accepts file paths)
    smiles: str | None = None
    valid = False
    error: str | None = None
    tmp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        cv2.imwrite(tmp_path, current)
        smiles = _load_decimer()(tmp_path)
        valid = _is_valid_smiles(smiles)
    except Exception as exc:
        error = str(exc)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return {"smiles": smiles, "valid": valid, "error": error, "stages": stages}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _process, contents)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Processing failed: {exc}") from exc

    return result


@app.get("/", response_class=HTMLResponse)
async def index():
    html = Path(__file__).parent / "static" / "index.html"
    if not html.exists():
        raise HTTPException(status_code=404, detail="Frontend not found")
    return html.read_text(encoding="utf-8")


# Mount static assets (CSS, JS if split out later)
_static = Path(__file__).parent / "static"
_static.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static)), name="static")
