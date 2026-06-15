Image Preprocessing & OSR Test Harness

Takes messy photos of organic chemistry problems (textbook scans, phone shots,
handwritten structures) and prepares them for optical structure recognition (OSR).

## Project layout

```
Orgo AI/
├── input/          ← drop your test photos here
├── output/         ← per-image stage outputs written here automatically
├── results/        ← accuracy reports written here automatically
├── preprocessing.py  — OpenCV pipeline (perspective → deskew → denoise → binarize)
├── run_harness.py    — OSR test harness (raw vs processed, SMILES validation)
└── requirements.txt
```

## Setup

Requires Python 3.10+.

```bash
pip install -r requirements.txt
```

**First run note:** DECIMER downloads its model weights (~500 MB) on the first
call to `predict_SMILES`. This is a one-time download; subsequent runs are fast.

RDKit on PyPI (`rdkit`) requires no Conda environment — the modern PyPI package
is self-contained.

## Running

1. Drop one or more chemistry images into `input/` (`.jpg`, `.png`, `.tiff`, etc.).
2. Run:

```bash
python run_harness.py
```

That's it. The harness will:
- Run DECIMER on each **raw** image.
- Run the preprocessing pipeline on each image, saving intermediate stage PNGs to `output/<stem>/`.
- Run DECIMER on the **processed** image.
- Validate both SMILES with RDKit.
- Print a summary table and write timestamped reports to `results/`.

## Output structure

```
output/
  my_photo/
    my_photo_1_perspective.png   ← after perspective warp
    my_photo_2_deskew.png        ← after rotation correction
    my_photo_3_denoise.png       ← after noise removal
    my_photo_4_binarize.png      ← after CLAHE + Otsu threshold
    my_photo_final.png           ← same as the last enabled stage

results/
  report_20240611_143022.csv    ← one row per image
  report_20240611_143022.json   ← same data + aggregate parse rates
```

## Toggling pipeline stages

Edit `PIPELINE_STEPS` near the top of `run_harness.py`:

```python
PIPELINE_STEPS = {
    "perspective": True,
    "deskew":      True,
    "denoise":     False,   # ← skip denoising
    "binarize":    True,
}
```

## Report columns

| Column | Meaning |
|--------|---------|
| `raw_smiles` | DECIMER output for the unprocessed image |
| `raw_valid` | True if RDKit parsed it into a valid molecule |
| `processed_smiles` | DECIMER output after the pipeline |
| `processed_valid` | True if RDKit parsed the processed result |

The aggregate `*_parse_rate_pct` fields in the JSON let you compare the two
pass rates at a glance.

## Tuning tips

- **Perspective not triggering**: the quad detector requires the page to cover
  ≥10% of the frame. Crop out extreme margins before dropping in, or lower
  `min_area` in `preprocessing.py`.
- **Deskew overcorrecting**: if your images have lots of diagonal bonds,
  increase `minLineLength` in `deskew()` so short diagonal segments are ignored.
- **Denoising too slow**: `fastNlMeansDenoisingColored` runs in O(n) but is
  slow on large images. Resize to ~1500px wide before the denoise step, or
  set `"denoise": False` in `PIPELINE_STEPS`.
- **Binarization losing faint bonds**: lower `clipLimit` in the CLAHE call
  inside `normalize_binarize()` (default 2.0).
