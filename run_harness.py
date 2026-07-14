"""
run_harness.py — OSR accuracy test harness.

For every image in /input:
  1. Run OSR (DECIMER) on the raw, unprocessed file.
  2. Run the preprocessing pipeline and save stage images to /output/<stem>/.
  3. Run OSR on the final processed image.
  4. Validate both SMILES with RDKit.
  5. If /input/ground_truth.json has an entry for the file, compare both reads
     against it on CANONICAL smiles — a valid-but-wrong read counts as a miss.

ground_truth.json maps filename → expected SMILES, e.g.:
    { "aspirin.png": "CC(=O)Oc1ccccc1C(=O)O" }

Writes a timestamped CSV + JSON report to /results comparing raw vs processed
parse rates (and exact-match accuracy where ground truth is known).

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


def canonical(smiles: str) -> str | None:
    """Canonical form for exact-match comparison; None if unparseable."""
    from rdkit import Chem
    if not smiles or not smiles.strip():
        return None
    mol = Chem.MolFromSmiles(smiles.strip())
    return Chem.MolToSmiles(mol) if mol else None


def load_ground_truth() -> dict:
    """filename → canonical expected SMILES from input/ground_truth.json."""
    path = Path(INPUT_DIR) / "ground_truth.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    truth = {}
    for fname, smi in raw.items():
        canon = canonical(smi)
        if canon:
            truth[fname] = canon
        else:
            print(f"  [WARN] ground_truth.json: invalid SMILES for {fname!r}: {smi!r}")
    return truth


# ── Per-image processing ───────────────────────────────────────────────────────

def process_image(img_path: Path, expected: str | None = None) -> dict:
    stem = img_path.stem
    result = {
        "filename":         img_path.name,
        "expected_smiles":  expected or "",
        "raw_smiles":       "",
        "raw_valid":        False,
        "raw_match":        None,   # None = no ground truth for this file
        "processed_smiles": "",
        "processed_valid":  False,
        "processed_match":  None,
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
        if expected:
            result["raw_match"] = canonical(result["raw_smiles"]) == expected
    except Exception as exc:
        print(f"  [raw]       DECIMER failed: {exc}")
        result["error"] += f"raw-osr: {exc}; "

    tag = _tag(result["raw_valid"], result["raw_match"])
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
        if expected:
            result["processed_match"] = canonical(result["processed_smiles"]) == expected
    except Exception as exc:
        print(f"  [processed] DECIMER failed: {exc}")
        result["error"] += f"proc-osr: {exc}; "

    tag = _tag(result["processed_valid"], result["processed_match"])
    print(f"  [processed] {tag}  {result['processed_smiles']!r}")

    return result


def _tag(valid: bool, match: bool | None) -> str:
    if match is True:
        return "MATCH"
    if match is False:
        return "WRONG" if valid else "FAIL"
    return "VALID" if valid else "FAIL"


# ── Report writing ─────────────────────────────────────────────────────────────

def write_report(results: list) -> None:
    os.makedirs(RESULTS_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # CSV — one row per image, easy to open in Excel / pandas
    csv_path = os.path.join(RESULTS_DIR, f"report_{timestamp}.csv")
    fields = ["filename", "expected_smiles", "raw_smiles", "raw_valid", "raw_match",
              "processed_smiles", "processed_valid", "processed_match", "error"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(results)

    # JSON — includes aggregate stats for quick scripting
    total    = len(results)
    raw_ok   = sum(1 for r in results if r["raw_valid"])
    proc_ok  = sum(1 for r in results if r["processed_valid"])
    with_gt  = sum(1 for r in results if r["raw_match"] is not None
                   or r["processed_match"] is not None)
    raw_hit  = sum(1 for r in results if r["raw_match"] is True)
    proc_hit = sum(1 for r in results if r["processed_match"] is True)

    summary = {
        "timestamp":                  timestamp,
        "total_images":               total,
        "raw_valid_count":            raw_ok,
        "raw_parse_rate_pct":         round(raw_ok  / total * 100, 1) if total else 0.0,
        "processed_valid_count":      proc_ok,
        "processed_parse_rate_pct":   round(proc_ok / total * 100, 1) if total else 0.0,
        "ground_truth_images":        with_gt,
        "raw_match_count":            raw_hit,
        "raw_accuracy_pct":           round(raw_hit  / with_gt * 100, 1) if with_gt else None,
        "processed_match_count":      proc_hit,
        "processed_accuracy_pct":     round(proc_hit / with_gt * 100, 1) if with_gt else None,
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
        raw_tag  = _tag(r["raw_valid"], r["raw_match"])
        proc_tag = _tag(r["processed_valid"], r["processed_match"])
        name = r["filename"][:32]
        print(f"  {name:<32} {raw_tag:>6}  {proc_tag:>10}")
    print(sep)
    print(f"  Parse rate — raw: {raw_ok}/{total} "
          f"({summary['raw_parse_rate_pct']}%)   "
          f"processed: {proc_ok}/{total} "
          f"({summary['processed_parse_rate_pct']}%)")
    if with_gt:
        print(f"  Exact match — raw: {raw_hit}/{with_gt} "
              f"({summary['raw_accuracy_pct']}%)   "
              f"processed: {proc_hit}/{with_gt} "
              f"({summary['processed_accuracy_pct']}%)")
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

    truth = load_ground_truth()
    print(f"\nFound {len(images)} image(s) in {INPUT_DIR}/"
          f" ({len(truth)} with ground truth)\n")

    results = []
    for img_path in images:
        print("-" * 60)
        print(f"Image: {img_path.name}")
        results.append(process_image(img_path, truth.get(img_path.name)))

    write_report(results)


if __name__ == "__main__":
    main()
