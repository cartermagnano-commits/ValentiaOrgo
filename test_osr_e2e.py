"""End-to-end image-to-SMILES benchmark for the production OSR pipeline.

This is deliberately separate from ``test_osr.py``.  The fast suite tests
decision logic with stand-ins; this benchmark renders labeled structures,
passes the resulting PNG/JPEG bytes through ``app._process`` (preprocessing,
DECIMER, MolScribe, and arbitration), and compares the returned molecule with
the ground truth using RDKit canonicalization.

The default corpus contains 64 molecules in several chemistry classes and four
deterministic image conditions (256 cases total): clean light, clean dark,
rotated/noisy paper, and perspective/JPEG phone-like.  Synthetic depictions are
excellent regression fixtures but are not a substitute for a separately
licensed corpus of real textbook scans, handwritten structures, and phone
photos.

Examples::

    python test_osr_e2e.py --limit-molecules 2   # model/runtime smoke test
    python test_osr_e2e.py                       # full 256-case benchmark
    python test_osr_e2e.py --variants clean,dark
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("PYSTOW_HOME", str(ROOT / ".cache" / "pystow"))
os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))

import cv2
import numpy as np
from PIL import Image
from rdkit import Chem
from rdkit.Chem import AllChem, Draw


# (category, label, ground-truth SMILES).  Keep this list explicit so every
# benchmark run exercises the same structures and remains reviewable.
MOLECULES = [
    ("hydrocarbon", "hexane", "CCCCCC"),
    ("hydrocarbon", "isobutane", "CC(C)C"),
    ("hydrocarbon", "3-methylhexane", "CCC(C)CCC"),
    ("hydrocarbon", "1-hexene", "C=CCCCC"),
    ("hydrocarbon", "2-pentene", "CC=CCC"),
    ("hydrocarbon", "1-butyne", "C#CCC"),
    ("hydrocarbon", "cyclohexane", "C1CCCCC1"),
    ("hydrocarbon", "cyclohexene", "C1=CCCCC1"),
    ("oxygen", "ethanol", "CCO"),
    ("oxygen", "1-butanol", "CCCCO"),
    ("oxygen", "2-butanol", "CCC(C)O"),
    ("oxygen", "tert-butanol", "CC(C)(C)O"),
    ("oxygen", "diethyl ether", "CCOCC"),
    ("oxygen", "ethyl acetate", "CCOC(=O)C"),
    ("carbonyl", "acetone", "CC(=O)C"),
    ("carbonyl", "butanal", "CCCC=O"),
    ("carbonyl", "cyclohexanone", "O=C1CCCCC1"),
    ("carbonyl", "acetic acid", "CC(=O)O"),
    ("carbonyl", "acetamide", "CC(=O)N"),
    ("carbonyl", "acetic anhydride", "CC(=O)OC(=O)C"),
    ("nitrogen", "ethylamine", "CCN"),
    ("nitrogen", "diethylamine", "CCNCC"),
    ("nitrogen", "triethylamine", "CCN(CC)CC"),
    ("nitrogen", "acetonitrile", "CC#N"),
    ("nitrogen", "nitroethane", "CC[N+](=O)[O-]"),
    ("halogen", "1-bromobutane", "CCCCBr"),
    ("halogen", "2-chloropropane", "CC(C)Cl"),
    ("halogen", "fluorobenzene", "Fc1ccccc1"),
    ("halogen", "diiodomethane", "ICI"),
    ("sulfur_phosphorus", "ethanethiol", "CCS"),
    ("sulfur_phosphorus", "dimethyl sulfoxide", "CS(C)=O"),
    ("sulfur_phosphorus", "dimethyl sulfone", "CS(C)(=O)=O"),
    ("aromatic", "benzene", "c1ccccc1"),
    ("aromatic", "toluene", "Cc1ccccc1"),
    ("aromatic", "phenol", "Oc1ccccc1"),
    ("aromatic", "anisole", "COc1ccccc1"),
    ("aromatic", "aniline", "Nc1ccccc1"),
    ("aromatic", "benzoic acid", "O=C(O)c1ccccc1"),
    ("aromatic", "acetophenone", "CC(=O)c1ccccc1"),
    ("aromatic", "naphthalene", "c1ccc2ccccc2c1"),
    ("heterocycle", "pyridine", "n1ccccc1"),
    ("heterocycle", "furan", "o1cccc1"),
    ("heterocycle", "thiophene", "s1cccc1"),
    ("heterocycle", "imidazole", "c1ncc[nH]1"),
    ("heterocycle", "piperidine", "N1CCCCC1"),
    ("heterocycle", "morpholine", "O1CCNCC1"),
    ("stereo", "L-lactic acid", "C[C@@H](O)C(=O)O"),
    ("stereo", "L-alanine", "N[C@@H](C)C(=O)O"),
    ("stereo", "L-valine", "CC(C)[C@@H](N)C(=O)O"),
    ("stereo", "trans-difluoroethene", "F/C=C/F"),
    ("stereo", "cis-difluoroethene", "F/C=C\\F"),
    ("stereo", "borneol-like", "CC1(C)C2CCC1(C)C(O)C2"),
    ("drug_like", "aspirin", "CC(=O)Oc1ccccc1C(=O)O"),
    ("drug_like", "acetaminophen", "CC(=O)Nc1ccc(O)cc1"),
    ("drug_like", "ibuprofen", "CC(C)Cc1ccc(C(C)C(=O)O)cc1"),
    ("drug_like", "caffeine", "Cn1c(=O)c2c(ncn2C)n(C)c1=O"),
    ("drug_like", "vanillin", "COc1cc(C=O)ccc1O"),
    ("drug_like", "nicotinamide", "NC(=O)c1cccnc1"),
    ("drug_like", "benzocaine", "CCOC(=O)c1ccc(N)cc1"),
    ("drug_like", "naproxen", "COc1ccc2cc(C(C)C(=O)O)ccc2c1"),
    ("polyfunctional", "citric acid", "O=C(O)CC(O)(CC(=O)O)C(=O)O"),
    ("polyfunctional", "glucose open chain", "O=CC(O)C(O)C(O)CO"),
    ("polyfunctional", "benzyl carbamate", "NC(=O)OCC1=CC=CC=C1"),
    ("polyfunctional", "ethyl acetoacetate", "CCOC(=O)CC(=O)C"),
]

VARIANTS = ("clean", "dark", "paper", "phone")


def canonical(smiles: str | None, *, isomeric: bool = True) -> str | None:
    if not smiles:
        return None
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    try:
        mol = Chem.RemoveHs(mol)
    except Exception:
        pass
    return Chem.MolToSmiles(mol, canonical=True, isomericSmiles=isomeric)


def render(smiles: str, size: int = 640) -> np.ndarray:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"Invalid ground-truth SMILES: {smiles}")
    AllChem.Compute2DCoords(mol)
    options = Draw.MolDrawOptions()
    options.clearBackground = False
    options.padding = 0.12
    image = Draw.MolToImage(mol, size=(size, size), options=options)
    return cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)


def variant_image(base: np.ndarray, variant: str, seed: int) -> tuple[bytes, str]:
    rng = np.random.default_rng(seed)
    h, w = base.shape[:2]
    image = base.copy()

    if variant == "dark":
        image = cv2.bitwise_not(image)
    elif variant == "paper":
        angle = float(rng.uniform(-5.0, 5.0))
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        image = cv2.warpAffine(image, matrix, (w, h), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=(242, 242, 242))
        gradient = np.linspace(0.82, 1.06, w, dtype=np.float32)[None, :, None]
        image = np.clip(image.astype(np.float32) * gradient, 0, 255)
        image += rng.normal(0, 7.0, image.shape)
        image = cv2.GaussianBlur(np.clip(image, 0, 255).astype(np.uint8), (3, 3), 0.45)
    elif variant == "phone":
        margin = int(0.035 * w)
        src = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
        dst = np.float32([
            [margin + rng.integers(0, margin), rng.integers(0, margin)],
            [w - margin, margin + rng.integers(0, margin)],
            [w - rng.integers(0, margin), h - margin],
            [rng.integers(0, margin), h - rng.integers(0, margin)],
        ])
        image = cv2.warpPerspective(image, cv2.getPerspectiveTransform(src, dst), (w, h),
                                    borderMode=cv2.BORDER_CONSTANT, borderValue=(225, 220, 210))
        small = cv2.resize(image, (384, 384), interpolation=cv2.INTER_AREA)
        image = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        image = np.clip(image.astype(np.float32) + rng.normal(0, 4.0, image.shape), 0, 255).astype(np.uint8)
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 62])
        if not ok:
            raise RuntimeError("JPEG encoding failed")
        return encoded.tobytes(), "jpg"
    elif variant != "clean":
        raise ValueError(f"Unknown variant: {variant}")

    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return encoded.tobytes(), "png"


def settle_result(app: Any, result: dict[str, Any]) -> dict[str, Any]:
    pending = result.pop("_pending", None)
    if pending:
        try:
            vision = pending["future"].result(timeout=app.VISION_TIMEOUT + 10.0)
        except Exception:
            vision = None
        smiles, verified = app.resolve_with_vision(
            pending["orig"], pending["bin"], pending["ms_orig"], pending["ms_bin"],
            pending["digital"], vision,
        )
        result["smiles"] = smiles
        result["valid"] = smiles is not None
        result["verified"] = verified
        result["confidence"] = "high" if verified is True else "low" if verified is False else "unverified"
        result["reads"]["vision"] = vision

    token = result.pop("verify_token", None)
    if token:
        entry = app._PENDING_VERIFY.pop(token, None)
        if entry:
            try:
                entry["future"].result(timeout=app.VISION_TIMEOUT + 10.0)
            except Exception:
                pass
    return result


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return round(ordered[index], 3)


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    latency = [row["latency_seconds"] for row in rows]

    def rate(key: str) -> float:
        return round(100.0 * sum(bool(row[key]) for row in rows) / total, 2) if total else 0.0

    by_variant: dict[str, dict[str, Any]] = {}
    for name in VARIANTS:
        subset = [row for row in rows if row["variant"] == name]
        if subset:
            by_variant[name] = {
                "cases": len(subset),
                "exact_accuracy_pct": round(100 * sum(r["exact_match"] for r in subset) / len(subset), 2),
                "connectivity_accuracy_pct": round(100 * sum(r["connectivity_match"] for r in subset) / len(subset), 2),
                "valid_smiles_pct": round(100 * sum(r["valid_prediction"] for r in subset) / len(subset), 2),
                "median_latency_seconds": round(statistics.median(r["latency_seconds"] for r in subset), 3),
            }

    by_category: dict[str, dict[str, Any]] = {}
    categories = sorted({row["category"] for row in rows})
    for category in categories:
        subset = [row for row in rows if row["category"] == category]
        by_category[category] = {
            "cases": len(subset),
            "exact_accuracy_pct": round(100 * sum(r["exact_match"] for r in subset) / len(subset), 2),
            "connectivity_accuracy_pct": round(100 * sum(r["connectivity_match"] for r in subset) / len(subset), 2),
        }

    read_presence = Counter()
    for row in rows:
        for reader, prediction in row["reads"].items():
            if reader != "clean_digital" and prediction:
                read_presence[reader] += 1

    return {
        "cases": total,
        "molecules": len({row["label"] for row in rows}),
        "variants": sorted({row["variant"] for row in rows}),
        "exact_accuracy_pct": rate("exact_match"),
        "connectivity_accuracy_pct": rate("connectivity_match"),
        "valid_smiles_pct": rate("valid_prediction"),
        "verified_high_confidence_pct": rate("verified_high_confidence"),
        "latency_seconds": {
            "median": round(statistics.median(latency), 3) if latency else None,
            "p95": percentile(latency, 0.95),
            "max": round(max(latency), 3) if latency else None,
            "total": round(sum(latency), 3),
        },
        "reader_nonempty_counts": dict(read_presence),
        "by_variant": by_variant,
        "by_category": by_category,
    }


def write_reports(rows: list[dict[str, Any]], summary: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"osr_e2e_{stamp}.json"
    csv_path = output_dir / f"osr_e2e_{stamp}.csv"
    json_path.write_text(json.dumps({"summary": summary, "cases": rows}, indent=2), encoding="utf-8")

    flat_rows = []
    for row in rows:
        flat = {key: value for key, value in row.items() if key != "reads"}
        flat.update({f"read_{key}": value for key, value in row["reads"].items()})
        flat_rows.append(flat)
    fields = sorted({key for row in flat_rows for key in row})
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(flat_rows)
    return json_path, csv_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit-molecules", type=int, default=None)
    parser.add_argument("--variants", default=",".join(VARIANTS))
    parser.add_argument("--output-dir", default="results/osr_e2e")
    args = parser.parse_args()

    selected_variants = [value.strip() for value in args.variants.split(",") if value.strip()]
    unknown = sorted(set(selected_variants) - set(VARIANTS))
    if unknown:
        parser.error(f"unknown variants: {', '.join(unknown)}")
    molecules = MOLECULES[: args.limit_molecules] if args.limit_molecules else MOLECULES

    # Import after cache environment variables are set.  app starts model
    # warmups; queueing explicit loads behind them guarantees both completed.
    import app

    print("Warming DECIMER and MolScribe...", flush=True)
    app._executor.submit(app._load_decimer).result()
    app._molscribe_pool.submit(app._load_molscribe).result()
    print(f"Models ready. Running {len(molecules) * len(selected_variants)} cases.", flush=True)

    rows: list[dict[str, Any]] = []
    case_number = 0
    total = len(molecules) * len(selected_variants)
    for molecule_index, (category, label, expected) in enumerate(molecules):
        base = render(expected)
        expected_exact = canonical(expected, isomeric=True)
        expected_connectivity = canonical(expected, isomeric=False)
        for variant_index, variant in enumerate(selected_variants):
            case_number += 1
            raw, encoding = variant_image(base, variant, seed=10_000 + molecule_index * 31 + variant_index)
            started = time.perf_counter()
            error = ""
            try:
                result = app._executor.submit(app._process, raw).result()
                result = settle_result(app, result)
            except Exception as exc:
                result = {"smiles": None, "valid": False, "verified": None, "confidence": "error", "reads": {}}
                error = f"{type(exc).__name__}: {exc}"
            latency = time.perf_counter() - started

            predicted = result.get("smiles")
            predicted_exact = canonical(predicted, isomeric=True)
            predicted_connectivity = canonical(predicted, isomeric=False)
            row = {
                "case": case_number,
                "category": category,
                "label": label,
                "variant": variant,
                "encoding": encoding,
                "expected_smiles": expected_exact,
                "predicted_smiles": predicted_exact,
                "exact_match": predicted_exact == expected_exact,
                "connectivity_match": predicted_connectivity == expected_connectivity,
                "valid_prediction": predicted_exact is not None,
                "verified_high_confidence": result.get("verified") is True,
                "confidence": result.get("confidence"),
                "latency_seconds": round(latency, 3),
                "error": error or result.get("error") or "",
                "reads": result.get("reads", {}),
            }
            rows.append(row)
            verdict = "EXACT" if row["exact_match"] else "CONNECT" if row["connectivity_match"] else "MISS"
            print(
                f"[{case_number:03d}/{total:03d}] {verdict:7s} {latency:6.2f}s  "
                f"{variant:5s}  {label}: {predicted_exact or '<none>'}",
                flush=True,
            )

    summary = aggregate(rows)
    json_path, csv_path = write_reports(rows, summary, ROOT / args.output_dir)
    print("\n" + json.dumps(summary, indent=2), flush=True)
    print(f"\nJSON: {json_path}\nCSV:  {csv_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
