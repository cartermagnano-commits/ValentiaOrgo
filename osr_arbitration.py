"""
osr_arbitration.py — Pure decision logic for the /analyze OSR pipeline.

Inputs are already-canonicalized SMILES strings (or None) from up to five
independent reads of the same image:

  DECIMER   × {original, binarized}   (TensorFlow, single-threaded worker)
  MolScribe × {original, binarized}   (Swin transformer, own worker)
  vision    × {original}              (Claude or Ollama VLM — slow, arrives late)

Everything here is deliberately free of heavy imports (no RDKit, TF, torch,
cv2) so the decision table can be unit-tested in milliseconds without loading
any model. Canonicalization happens in app.py before anything reaches here,
so plain string equality IS structural identity.

Design constraints carried over from the July 2026 passes (see memory):
  * Never return a preliminary structure that a later read could FLIP — when
    the candidate itself is in question, block on the vision arbiter.
  * VLM-as-judge is banned; only exact canonical agreement between
    independent readers counts as verification.
"""

import logging
import re
from collections import Counter

logger = logging.getLogger(__name__)


# ── Degenerate-read filter ────────────────────────────────────────────────────

def looks_degenerate(smiles: str) -> bool:
    """True when a syntactically valid SMILES is almost certainly recognizer
    noise rather than a real structure. Both OSR models fail the same way on
    unreadable input: they don't return None, they hallucinate — DECIMER
    emits enormous unbranched alkane chains ('CCCC…' ×100), MolScribe emits
    the same small fragment repeated dozens of times ('CC=O.CC=O.…'). Left
    unfiltered, these become 'candidate structures' that poison arbitration
    and reach the user as an answer."""
    # Dummy atoms mean the reader could not resolve part of the structure —
    # on a photographed molecule that's a failed read, not an R-group. (Seen
    # live: MolScribe read '*/C1=C/…' off a pure-noise image.) The reaction
    # engine can't run templates over '*' anyway.
    if "*" in smiles:
        return True
    frags = smiles.split(".")
    if len(frags) > 12:
        return True
    if len(frags) > 1 and Counter(frags).most_common(1)[0][1] >= 4:
        return True   # same fragment 4+ times = noise, not a mixture
    # Featureless n-alkane ≥ 25 carbons: not coursework chemistry, and the
    # signature DECIMER hallucination on noise/blank regions.
    if any(re.fullmatch(r"C{25,}", frag) for frag in frags):
        return True
    return False


def plausible_or_none(smiles: str | None, source: str) -> str | None:
    """Gate a canonical OSR/vision read through the degeneracy filter."""
    if smiles and looks_degenerate(smiles):
        logger.info("%s read looks like recognizer noise — discarded: %r",
                    source, smiles[:120])
        return None
    return smiles


# ── Local arbitration (before the vision read lands) ─────────────────────────

def arbitrate_local(
    d_orig: str | None, d_bin: str | None,
    m_orig: str | None, m_bin: str | None,
) -> tuple[str | None, bool | None, bool, bool]:
    """Settle the verdict from local reads alone, when possible.

    Returns (smiles, verified, pending, defer):
      * cross-model agreement (any DECIMER read == any MolScribe read) →
        (smiles, True, False, False): instant "verified", vision unused.
      * exactly one unambiguous candidate → (smiles, None, False, True):
        show it now, verify against the in-flight vision read in the
        background (defer). The structure can't flip — only the badge.
      * anything contested (a model disagreeing with itself across
        renditions, or the two models disagreeing) or no local read at all →
        (None, None, True, False): the caller must block on vision.
    """
    d_reads = [r for r in (d_orig, d_bin) if r]
    m_reads = [r for r in (m_orig, m_bin) if r]

    # Strongest local signal: two different architectures read the same
    # structure. Uncorrelated errors make a coincidental match on a WRONG
    # structure vanishingly unlikely.
    for d in d_reads:
        if d in m_reads:
            return d, True, False, False

    d_ambiguous = bool(d_orig and d_bin and d_orig != d_bin)
    m_ambiguous = bool(m_orig and m_bin and m_orig != m_bin)
    d_cand = None if d_ambiguous else (d_orig or d_bin)
    m_cand = None if m_ambiguous else (m_orig or m_bin)

    if d_ambiguous or m_ambiguous:
        return None, None, True, False   # a reader contradicts itself → vision
    if d_cand and m_cand:
        return None, None, True, False   # models disagree → vision arbitrates
    if d_cand or m_cand:
        return (d_cand or m_cand), None, False, True   # deferred verification
    return None, None, True, False       # nothing local — vision is the source


# ── Vision-assisted resolution ────────────────────────────────────────────────

def prefer_rendition(orig_read: str, bin_read: str, digital: bool) -> str:
    """Uncorroborated tie between a model's two renditions: prefer the read
    that looks less like recognizer garbage. Hallucinated reads on noise are
    fragment soups ('C.CC.CC.…'), so fewer '.'-separated fragments wins. On a
    true tie keep the historical default — original for digital renders,
    binarized for photos (binarization repairs bad lighting)."""
    if orig_read.count(".") != bin_read.count("."):
        return orig_read if orig_read.count(".") < bin_read.count(".") else bin_read
    return orig_read if digital else bin_read


def _model_candidate(orig: str | None, bin_: str | None,
                     digital: bool) -> tuple[str | None, bool]:
    """One model's best read plus whether it contradicted itself getting there."""
    if orig and bin_ and orig != bin_:
        return prefer_rendition(orig, bin_, digital), True
    return orig or bin_, False


def resolve_with_vision(
    d_orig: str | None, d_bin: str | None,
    m_orig: str | None, m_bin: str | None,
    digital: bool, vision_read: str | None,
) -> tuple[str | None, bool | None]:
    """Settle an /analyze verdict that required the vision read.

    Returns (smiles, verified):
      * vision matches ANY local read → that read, verified True
        (two independent readers agree — same standard as arbitrate_local).
      * otherwise fall back to per-model candidates: DECIMER's pick wins a
        cross-model conflict (it is the primary reader) but is flagged
        verified=False so the UI shows "Check structure".
      * a candidate that came from a model contradicting itself across
        renditions is flagged False even when vision failed — the read is
        positively in doubt, not merely unconfirmed.
      * a single clean local candidate with a dissenting vision read → False;
        with NO vision read → None (nothing to verify against).
      * no local reads at all → the vision read itself, unverified (None).
    """
    local_reads = [r for r in (d_orig, d_bin, m_orig, m_bin) if r]
    if vision_read and vision_read in local_reads:
        return vision_read, True

    d_cand, d_split = _model_candidate(d_orig, d_bin, digital)
    m_cand, m_split = _model_candidate(m_orig, m_bin, digital)

    if d_cand and m_cand:
        if d_cand == m_cand:   # renditions differed but tiebreaks converged
            return d_cand, True
        return d_cand, False
    if d_cand or m_cand:
        chosen = d_cand or m_cand
        split = d_split if d_cand else m_split
        if split or vision_read:
            return chosen, False
        return chosen, None
    return vision_read, None
