"""
preprocessing.py — Image preprocessing pipeline for OSR-ready images.

Pipeline stages (each is a standalone function and can be toggled via the
'steps' dict passed to run_pipeline):

  1. perspective_correct  — warp angled/tilted photos into a flat rectangle
  2. deskew               — correct small rotational tilt (< 45°)
  3. denoise              — reduce photographic noise
  4. normalize_binarize   — CLAHE contrast boost + Otsu threshold → black-on-white
"""

import os
from typing import Optional

import cv2
import numpy as np


# ── Utilities ──────────────────────────────────────────────────────────────────

def load_image(path: str) -> np.ndarray:
    """Load an image from disk. Raises ValueError if the file can't be read."""
    img = cv2.imread(path)
    if img is None:
        raise ValueError(f"Could not load image: {path}")
    return img


def _order_points(pts: np.ndarray) -> np.ndarray:
    """
    Sort 4 corner points into [top-left, top-right, bottom-right, bottom-left].

    Uses the property that top-left has the smallest (x+y) sum and bottom-right
    has the largest; top-right has the smallest (y-x) difference.
    """
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]     # top-left
    rect[2] = pts[np.argmax(s)]     # bottom-right
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # top-right
    rect[3] = pts[np.argmax(diff)]  # bottom-left
    return rect


# ── Stage 1: Perspective Correction ───────────────────────────────────────────

def perspective_correct(img: np.ndarray) -> np.ndarray:
    """
    Detect the largest quadrilateral in the image (the page or problem region)
    and warp it into a flat, front-facing rectangle.

    Algorithm:
      - Gaussian blur to suppress noise before edge detection
      - Canny edge detector finds the page boundary
      - Contours are sorted by area; we take the largest 4-sided polygon
        that covers ≥10% of the frame (smaller shapes are likely structure bonds)
      - Perspective transform maps the 4 corners to a flat output rectangle

    Falls back to the original image unchanged if no suitable quad is found
    (i.e. the photo was already flat, or no clear page boundary exists).
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)

    # Dilate edges to close small gaps in the page border contour
    kernel = np.ones((3, 3), np.uint8)
    edges = cv2.dilate(edges, kernel, iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)

    min_area = img.shape[0] * img.shape[1] * 0.10  # quad must cover ≥10% of frame
    page_quad = None
    for c in contours[:10]:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.contourArea(approx) > min_area:
            page_quad = approx
            break

    if page_quad is None:
        return img  # no clear page boundary; return original

    pts = page_quad.reshape(4, 2).astype(np.float32)
    rect = _order_points(pts)
    tl, tr, br, bl = rect

    # Output rectangle: use the longer of each pair of opposing sides
    max_width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    max_height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))

    dst = np.array(
        [[0, 0], [max_width - 1, 0], [max_width - 1, max_height - 1], [0, max_height - 1]],
        dtype=np.float32,
    )
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img, M, (max_width, max_height))


# ── Stage 2: Deskew ────────────────────────────────────────────────────────────

def deskew(img: np.ndarray) -> np.ndarray:
    """
    Correct small rotational tilt by measuring the dominant angle of lines
    in the image and rotating to align them with the horizontal axis.

    Algorithm:
      - Probabilistic Hough transform detects line segments
      - We only consider lines within ±45° of horizontal (avoids being
        confused by diagonal chemical bonds, which are common in structures)
      - The median angle across all qualifying lines is used to compute
        a rotation matrix; angles < 0.5° are ignored to avoid unnecessary resampling

    Falls back to the original if no horizontal lines are found.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    # minLineLength scales with image width so large and small images behave similarly
    min_len = max(30, img.shape[1] // 8)
    lines = cv2.HoughLinesP(edges, rho=1, theta=np.pi / 180,
                            threshold=80, minLineLength=min_len, maxLineGap=10)

    if lines is None:
        return img

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx = x2 - x1
        if dx == 0:
            continue
        angle = np.degrees(np.arctan2(y2 - y1, dx))
        if -45.0 < angle < 45.0:
            angles.append(angle)

    if not angles:
        return img

    skew = float(np.median(angles))
    if abs(skew) < 0.5:  # negligible tilt — skip rotation to avoid resampling artifacts
        return img

    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w // 2, h // 2), skew, 1.0)
    # BORDER_REPLICATE fills newly exposed edges with the nearest border pixel
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_REPLICATE)


# ── Stage 3: Denoise ───────────────────────────────────────────────────────────

def denoise(img: np.ndarray) -> np.ndarray:
    """
    Reduce photographic noise using Non-Local Means (NLM) denoising.

    NLM averages patches that look similar across the whole image, so it
    preserves sharp edges (bonds, labels) much better than a simple blur.

    h=10 is the filter strength:
      - raise to 15-20 for very grainy phone shots
      - lower to 5-7 if fine structure is being lost

    Note: fastNlMeansDenoisingColored is slow on large images (several seconds
    for a 12MP photo). Resize to ~1500px wide first if speed is a concern.
    """
    if len(img.shape) == 3 and img.shape[2] == 3:
        return cv2.fastNlMeansDenoisingColored(
            img, None, h=10, hColor=10, templateWindowSize=7, searchWindowSize=21
        )
    # Grayscale path
    gray = img if len(img.shape) == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    denoised = cv2.fastNlMeansDenoising(
        gray, None, h=10, templateWindowSize=7, searchWindowSize=21
    )
    return cv2.cvtColor(denoised, cv2.COLOR_GRAY2BGR)


# ── Stage 4: Contrast Normalization + Binarization ────────────────────────────

def normalize_binarize(img: np.ndarray) -> np.ndarray:
    """
    Convert to a clean black-on-white binary image suitable for OSR.

    Two-step process:
      1. CLAHE (Contrast Limited Adaptive Histogram Equalization): splits the
         image into small tiles and equalizes each one independently. This
         recovers faint bonds and atom labels in unevenly lit photos without
         blowing out already-bright regions. clipLimit=2.0 caps the amplification
         to prevent noise from being boosted too aggressively.

      2. Otsu's thresholding: automatically finds the optimal global threshold
         that separates ink pixels from background by minimizing intra-class
         variance. No manual tuning needed — it adapts to each image.

    After binarization we check the mean pixel value: if it's < 127 the image
    is dark-on-light (inverted), and we flip it so OSR always gets
    black structure on a white background.

    Output is 3-channel BGR (white BG, black structure) so it can be saved
    as a standard PNG and opened by DECIMER without any further conversion.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    _, binary = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Ensure black-on-white (most OSR models expect this orientation)
    if np.mean(binary) < 127:
        binary = cv2.bitwise_not(binary)

    binary = _despeckle(binary)

    # White margin around the structure — OSR models are trained on depictions
    # with breathing room; ink touching the frame edge hurts recognition.
    pad = max(8, int(0.03 * max(binary.shape[:2])))
    binary = cv2.copyMakeBorder(binary, pad, pad, pad, pad,
                                cv2.BORDER_CONSTANT, value=255)

    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def _despeckle(binary: np.ndarray) -> np.ndarray:
    """
    Remove tiny isolated ink blobs (sensor noise, paper grain, JPEG artifacts
    that survived thresholding) from a black-on-white binary image.

    Ink components smaller than ~0.001% of the frame are almost never part of
    a chemical structure — even a stereo-bond dot or the dot of an 'i' in an
    atom label is bigger — but they routinely confuse OSR models into
    hallucinating extra atoms.
    """
    ink = cv2.bitwise_not(binary)  # connected components of INK (white on black)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    min_area = max(6, binary.shape[0] * binary.shape[1] // 100_000)
    for i in range(1, num):
        if stats[i, cv2.CC_STAT_AREA] < min_area:
            binary[labels == i] = 255
    return binary


# ── Pipeline Runner ────────────────────────────────────────────────────────────

def run_pipeline(
    img: np.ndarray,
    output_dir: str,
    stem: str,
    steps: Optional[dict] = None,
):
    """
    Run the preprocessing pipeline and write every intermediate stage to disk.

    Args:
        img:        Input BGR image (from load_image / cv2.imread).
        output_dir: Directory where stage PNGs and the final image are written.
        stem:       Base filename used to name outputs (e.g. "scan_01").
        steps:      Dict of {stage_name: bool} controlling which stages run.
                    Omit or pass None to run all stages.

    Returns:
        (final_image, stages)
          final_image — the fully processed ndarray
          stages      — dict mapping stage label → ndarray for each completed stage
    """
    if steps is None:
        steps = {"perspective": True, "deskew": True, "denoise": True, "binarize": True}

    os.makedirs(output_dir, exist_ok=True)
    current = img.copy()
    stages = {}

    def _save(label: str, arr: np.ndarray) -> None:
        path = os.path.join(output_dir, f"{stem}_{label}.png")
        cv2.imwrite(path, arr)
        stages[label] = arr.copy()

    if steps.get("perspective", True):
        current = perspective_correct(current)
        _save("1_perspective", current)

    if steps.get("deskew", True):
        current = deskew(current)
        _save("2_deskew", current)

    if steps.get("denoise", True):
        current = denoise(current)
        _save("3_denoise", current)

    if steps.get("binarize", True):
        current = normalize_binarize(current)
        _save("4_binarize", current)

    cv2.imwrite(os.path.join(output_dir, f"{stem}_final.png"), current)
    return current, stages
