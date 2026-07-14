"""
test_osr.py — Regression suite for the /analyze OSR decision logic.

Run before committing changes to osr_arbitration.py or preprocessing.py:

    python test_osr.py

Plain Python on purpose (no pytest dependency), matching test_templates.py:
one PASS/FAIL line per case, non-zero exit on any failure. Imports only
osr_arbitration (dependency-free) and preprocessing (cv2/numpy) — no
TensorFlow, torch, or model downloads, so the whole suite runs in seconds.
"""

import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np

from osr_arbitration import (
    arbitrate_local, looks_degenerate, prefer_rendition, resolve_with_vision,
)
from preprocessing import NOISE_SIGMA_SKIP, denoise, estimate_noise_sigma

failures: list[str] = []
passes = 0


def check(name: str, ok: bool, detail: str = ""):
    global passes
    if ok:
        passes += 1
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


# ── looks_degenerate ──────────────────────────────────────────────────────────

DEGENERACY_CASES = [
    # (smiles, expected, label)
    ("CCO", False, "ethanol is fine"),
    ("CC(=O)OC1=CC=CC=C1C(=O)O", False, "aspirin is fine"),
    ("CCO.O", False, "two-fragment mixture is fine"),
    ("C" * 24, False, "24-carbon alkane allowed (fatty chains exist)"),
    ("C" * 25, True, "25-carbon featureless alkane = DECIMER noise signature"),
    ("C" * 100, True, "100-carbon alkane = classic noise hallucination"),
    ("CC=O." * 3 + "CC=O", True, "same fragment ×4 = MolScribe noise signature"),
    ("CC=O.CC=O.CC=O", False, "same fragment ×3 still allowed"),
    (".".join(f"C{'C' * (i % 3)}O" for i in range(13)), True, ">12 fragments = soup"),
    ("CCCCCCCCCCCC(=O)O", False, "lauric acid (long but featured) is fine"),
    ("*/C1=C/C=C(\\C(=O)N(C)C(N)=O)C(=O)OCCCCCC1C.*c1ccc(C(=O)OCCCCCCCCC)cc1",
     True, "dummy atoms = unresolved read (live MolScribe noise hallucination)"),
    ("*CC(=O)O", True, "any wildcard atom = failed read"),
]

for smi, expected, label in DEGENERACY_CASES:
    got = looks_degenerate(smi)
    check(f"degenerate: {label}", got == expected, f"got {got} for {smi[:60]!r}")


# ── arbitrate_local ───────────────────────────────────────────────────────────
# Returns (smiles, verified, pending, defer)

A, B, C = "CCO", "CCN", "CCC"   # distinct canonical stand-ins

ARBITRATE_CASES = [
    # (d_orig, d_bin, m_orig, m_bin, expected, label)
    ((A, A, A, None), (A, True, False, False), "full agreement → verified"),
    ((A, None, A, None), (A, True, False, False), "cross-model orig agreement → verified"),
    ((A, B, None, B), (B, True, False, False),
     "DECIMER split, MolScribe corroborates one rendition → verified"),
    ((None, A, A, None), (A, True, False, False),
     "cross-rendition cross-model agreement still counts"),
    ((A, A, None, None), (A, None, False, True),
     "DECIMER-only consistent read → show now, defer verification"),
    ((A, None, None, None), (A, None, False, True), "single DECIMER read → defer"),
    ((None, None, A, None), (A, None, False, True), "single MolScribe read → defer"),
    ((A, B, None, None), (None, None, True, False),
     "DECIMER contradicts itself, no corroboration → vision arbitrates"),
    ((A, A, B, B), (None, None, True, False),
     "models consistently disagree with each other → vision arbitrates"),
    ((A, None, B, None), (None, None, True, False),
     "single reads conflict → vision arbitrates"),
    ((A, B, C, None), (None, None, True, False),
     "three-way disagreement → vision arbitrates"),
    ((A, None, B, C), (None, None, True, False),
     "MolScribe contradicts itself → vision arbitrates"),
    ((None, None, None, None), (None, None, True, False),
     "no local reads → vision is the source"),
]

for reads, expected, label in ARBITRATE_CASES:
    got = arbitrate_local(*reads)
    check(f"arbitrate: {label}", got == expected, f"reads={reads} got {got}")


# ── resolve_with_vision ───────────────────────────────────────────────────────
# Returns (smiles, verified)

RESOLVE_CASES = [
    # (d_orig, d_bin, m_orig, m_bin, digital, vision, expected, label)
    ((A, B, None, None, False, A), (A, True), "vision picks a DECIMER rendition"),
    ((A, B, None, None, False, B), (B, True), "vision picks the other rendition"),
    ((A, None, B, None, False, B), (B, True), "vision sides with MolScribe"),
    ((A, None, B, None, False, C), (A, False),
     "vision matches nobody → DECIMER pick, flagged low"),
    ((A, None, B, None, False, None), (A, False),
     "vision failed on a model conflict → DECIMER pick, flagged low"),
    ((A, B, None, None, False, None), (B, False),
     "vision failed on rendition split → photo default (binarized), low"),
    ((A, B, None, None, True, None), (A, False),
     "vision failed on rendition split → digital default (original), low"),
    ((A + "." + B, A, None, None, False, None), (A, False),
     "rendition split, no vision → fewer fragments wins"),
    ((A, None, None, None, False, C), (A, False), "lone read, vision dissents → low"),
    ((A, None, None, None, False, None), (A, None),
     "lone read, vision failed → unverified"),
    ((None, None, None, None, False, A), (A, None),
     "vision is sole source → unverified"),
    ((None, None, None, None, False, None), (None, None), "nothing anywhere"),
]

for args, expected, label in RESOLVE_CASES:
    got = resolve_with_vision(*args)
    check(f"resolve: {label}", got == expected, f"args={args} got {got}")


# ── prefer_rendition ──────────────────────────────────────────────────────────

check("prefer: fewer fragments wins",
      prefer_rendition("CCO.C.C", "CCO", digital=False) == "CCO")
check("prefer: tie → binarized for photos",
      prefer_rendition(A, B, digital=False) == B)
check("prefer: tie → original for digital",
      prefer_rendition(A, B, digital=True) == A)


# ── denoise noise gate ────────────────────────────────────────────────────────

rng = np.random.default_rng(42)

# Clean synthetic "document": white page, black line art. Noise floor ≈ 0.
clean = np.full((400, 400, 3), 245, dtype=np.uint8)
clean[100:104, 50:350] = 20          # horizontal bond
clean[100:300, 198:202] = 20         # vertical bond
sigma_clean = estimate_noise_sigma(clean)
check("noise: clean page measures below skip threshold",
      sigma_clean < NOISE_SIGMA_SKIP, f"sigma={sigma_clean:.2f}")
check("noise: denoise skips clean image (returns input untouched)",
      denoise(clean) is clean)

# Same page + heavy sensor noise: estimate should track the injected sigma.
noisy = np.clip(clean.astype(np.float64) + rng.normal(0, 12, clean.shape), 0, 255).astype(np.uint8)
sigma_noisy = estimate_noise_sigma(noisy)
check("noise: grainy page measures above skip threshold",
      sigma_noisy > NOISE_SIGMA_SKIP, f"sigma={sigma_noisy:.2f}")
check("noise: estimate tracks injected sigma (±50%)",
      6.0 < sigma_noisy < 18.0, f"sigma={sigma_noisy:.2f} vs injected 12")
denoised = denoise(noisy)
check("noise: denoise actually runs on grainy image",
      denoised is not noisy and estimate_noise_sigma(denoised) < sigma_noisy,
      f"before={sigma_noisy:.2f} after={estimate_noise_sigma(denoised):.2f}")


# ── Summary ───────────────────────────────────────────────────────────────────

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
