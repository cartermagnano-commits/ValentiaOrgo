"""
reaction_arbitration.py — Pure decision logic for AI/deterministic agreement.

Inputs are already-canonicalized SMILES strings (canonicalization happens in
app.py), so plain string equality IS structural identity — the same contract
osr_arbitration.py works under.

Deliberately free of heavy imports (no RDKit, no network, no app import) so
the verdict table can be unit-tested in milliseconds.

Invariants carried from the design spec:
  * The AI never overwrites a deterministic result. It contributes a verdict,
    or supplies a flagged result where the engine produced none.
  * Verification is independent prediction + exact canonical agreement.
    "Does the AI approve of this answer?" is not verification.
"""

import logging
import random
import re
from collections import Counter

logger = logging.getLogger(__name__)

# Verdict values (the four states the endpoint can return).
VERIFIED = "verified"
DISPUTED = "disputed"
AI_ONLY = "ai_only"
UNVERIFIED = "unverified"


def looks_degenerate_product(smiles: str) -> bool:
    """True when a syntactically valid SMILES is almost certainly LLM noise
    rather than a real product. Mirrors osr_arbitration.looks_degenerate: an
    LLM asked for a product occasionally emits an R-group placeholder, a
    fragment soup, or a featureless alkane chain."""
    if not smiles:
        return True
    if "*" in smiles:
        return True          # unresolved R-group — the engine can't use it either
    frags = smiles.split(".")
    if len(frags) > 12:
        return True
    if len(frags) > 1 and Counter(frags).most_common(1)[0][1] >= 4:
        return True          # same fragment 4+ times = noise, not a mixture
    if any(re.fullmatch(r"C{25,}", frag) for frag in frags):
        return True
    return False


def plausible_products(smiles_list: list[str]) -> list[str]:
    """Drop degenerate reads, preserving order and removing duplicates."""
    seen: set[str] = set()
    kept: list[str] = []
    for smi in smiles_list:
        if looks_degenerate_product(smi):
            logger.info("AI product looks like noise — discarded: %r", smi[:120])
            continue
        if smi not in seen:
            seen.add(smi)
            kept.append(smi)
    return kept


def agreement(engine_products: list[str], ai_products: list[str]) -> str | None:
    """The canonical product both sides independently arrived at, or None.

    Engine order wins: the first engine product the AI also predicted is the
    agreed answer, so the badge points at the branch the user is looking at.
    """
    ai_set = set(ai_products)
    for product in engine_products:
        if product in ai_set:
            return product
    return None


def verdict(
    engine_products: list[str],
    ai_products: list[str],
    rounds_used: int,
    ai_failed: bool,
) -> tuple[str, str | None]:
    """Settle the joint verdict. Returns (status, agreed_product).

    * agreement at any round        → (VERIFIED, product)
    * engine had products, no       → (DISPUTED, None) when the AI offered a
      agreement, AI offered a          real alternative; (UNVERIFIED, None)
      candidate                        when it offered nothing usable
    * engine had nothing, AI has    → (AI_ONLY, product) — flagged downstream
      a usable product                 as unchecked by the deterministic engine
    * AI unavailable/failed         → (UNVERIFIED, None)
    """
    if ai_failed:
        return UNVERIFIED, None

    agreed = agreement(engine_products, ai_products)
    if agreed is not None:
        return VERIFIED, agreed

    if not engine_products:
        return (AI_ONLY, ai_products[0]) if ai_products else (UNVERIFIED, None)

    # Engine has products the AI never matched. Only call that a dispute when
    # the AI actually put forward an alternative — silence is not dissent.
    if ai_products:
        return DISPUTED, None
    return UNVERIFIED, None


def candidate_pool(
    engine_products: list[str], ai_products: list[str], seed: int
) -> list[str]:
    """Deduplicated, shuffled union of all candidates for a reconciliation
    round. Shuffled so the prompt never leaks which side proposed what — a
    stable order would let the model infer the engine's answer and rubber-stamp
    it. Seeded so a given request is reproducible in logs and tests."""
    pool = plausible_products(list(engine_products) + list(ai_products))
    random.Random(seed).shuffle(pool)
    return pool
