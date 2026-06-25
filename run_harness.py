"""
run_harness.py — OSR accuracy test harness.

For every image in /input:
  1. Run OSR (DECIMER) on the raw, unprocessed file.
  2. Run the preprocessing pipeline and save stage images to /output/<stem>/.
  3. Run OSR on the final processed image.
  4. Validate both SMILES with RDKit.

Writes a timestamped CSV + JSON report to /results comparing raw vs processed
parse rates so you can measure how much the pipeline helps.

Usage:
    python run_harness.py

Toggle pipeline stages by editing PIPELINE_STEPS below.
"""

import csv
import json
import os
from datetime import datetime
from pathlib import Path

import cv2

from preprocessing import load_image, run_pipeline

# ── Configuration ──────────────────────────────────────────────────────────────

INPUT_DIR = "input"
OUTPUT_DIR = "output"
RESULTS_DIR = "results"

SUPPORTED_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"}

# Set any step to False to skip it in the pipeline
PIPELINE_STEPS = {
    "perspective": True,
    "deskew":      True,
    "denoise":     True,
    "binarize":    True,
}

# ── OSR + Validation ───────────────────────────────────────────────────────────

def get_smiles(image_path: str) -> str:
    """
    Call DECIMER on a saved image file and return the predicted SMILES string.
    Import is deferred because DECIMER loads a TensorFlow model on import —
    doing it lazily keeps startup fast and gives a clear error if not installed.
    """
    from DECIMER import predict_SMILES
    return predict_SMILES(image_path)


def is_valid_smiles(smiles: str) -> bool:
    """Return True if RDKit can parse the SMILES into a valid molecule object."""
    from rdkit import Chem
    if not smiles or not smiles.strip():
        return False
    return Chem.MolFromSmiles(smiles.strip()) is not None


# ── Per-image processing ───────────────────────────────────────────────────────

def process_image(img_path: Path) -> dict:
    stem = img_path.stem
    result = {
        "filename":         img_path.name,
        "raw_smiles":       "",
        "raw_valid":        False,
        "processed_smiles": "",
        "processed_valid":  False,
        "error":            "",
    }

    # -- Load ------------------------------------------------------------------
    try:
        img = load_image(str(img_path))
    except Exception as exc:
        result["error"] = f"load error: {exc}"
        print(f"  [ERROR] {exc}")
        return result

    # -- Raw OSR ---------------------------------------------------------------
    print("  [raw]       running DECIMER on original file ...")
    try:
        result["raw_smiles"] = get_smiles(str(img_path))
        result["raw_valid"]  = is_valid_smiles(result["raw_smiles"])
    except Exception as exc:
        print(f"  [raw]       DECIMER failed: {exc}")
        result["error"] += f"raw-osr: {exc}; "

    tag = "VALID" if result["raw_valid"] else "FAIL"
    print(f"  [raw]       {tag}  {result['raw_smiles']!r}")

    # -- Preprocess ------------------------------------------------------------
    print("  [pipeline]  preprocessing ...")
    img_out_dir = os.path.join(OUTPUT_DIR, stem)
    try:
        _final, _stages = run_pipeline(img, img_out_dir, stem, steps=PIPELINE_STEPS)
    except Exception as exc:
        print(f"  [pipeline]  failed: {exc}")
        result["error"] += f"pipeline: {exc}; "
        return result

    processed_path = os.path.join(img_out_dir, f"{stem}_final.png")

    # -- Processed OSR ---------------------------------------------------------
    print("  [processed] running DECIMER on preprocessed image ...")
    try:
        result["processed_smiles"] = get_smiles(processed_path)
        result["processed_valid"]  = is_valid_smiles(result["processed_smiles"])
    except Exception as exc:
        print(f"  [processed] DECIMER failed: {exc}")
        result["error"] += f"proc-osr: {exc}; "

    tag = "VALID" if result["processed_valid"] else "FAIL"
    print(f"  [processed] {tag}  {result['processed_smiles']!r}")

    return result


# ── Report writing ─────────────────────────────────────────────────────────────

def write_report(results: list) -> None:
    os.makedirs(RESULTS_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # CSV — one row per image, easy to open in Excel / pandas
    csv_path = os.path.join(RESULTS_DIR, f"report_{timestamp}.csv")
    fields = ["filename", "raw_smiles", "raw_valid",
              "processed_smiles", "processed_valid", "error"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(results)

    # JSON — includes aggregate stats for quick scripting
    total    = len(results)
    raw_ok   = sum(1 for r in results if r["raw_valid"])
    proc_ok  = sum(1 for r in results if r["processed_valid"])

    summary = {
        "timestamp":                  timestamp,
        "total_images":               total,
        "raw_valid_count":            raw_ok,
        "raw_parse_rate_pct":         round(raw_ok  / total * 100, 1) if total else 0.0,
        "processed_valid_count":      proc_ok,
        "processed_parse_rate_pct":   round(proc_ok / total * 100, 1) if total else 0.0,
        "per_image":                  results,
    }

    json_path = os.path.join(RESULTS_DIR, f"report_{timestamp}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    # Console summary table
    sep = "=" * 60
    print(f"\n{sep}")
    print(f"  RESULTS")
    print(sep)
    print(f"  {'Filename':<32} {'Raw':>6}  {'Processed':>10}")
    print(f"  {'-'*32} {'-'*6}  {'-'*10}")
    for r in results:
        raw_tag  = "VALID" if r["raw_valid"]  else "fail"
        proc_tag = "VALID" if r["processed_valid"] else "fail"
        name = r["filename"][:32]
        print(f"  {name:<32} {raw_tag:>6}  {proc_tag:>10}")
    print(sep)
    print(f"  Parse rate — raw: {raw_ok}/{total} "
          f"({summary['raw_parse_rate_pct']}%)   "
          f"processed: {proc_ok}/{total} "
          f"({summary['processed_parse_rate_pct']}%)")
    print(sep)
    print(f"\n  Reports written to:")
    print(f"    {csv_path}")
    print(f"    {json_path}\n")


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(RESULTS_DIR, exist_ok=True)

    images = sorted(
        p for p in Path(INPUT_DIR).iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXT
    )

    if not images:
        print(f"\nNo images found in '{INPUT_DIR}/'.")
        print("Drop some photos there (.jpg, .png, .tiff …) and re-run.\n")
        return

    print(f"\nFound {len(images)} image(s) in {INPUT_DIR}/\n")

    results = []
    for img_path in images:
        print("-" * 60)
        print(f"Image: {img_path.name}")
        results.append(process_image(img_path))

    write_report(results)


if __name__ == "__main__":
    main()
