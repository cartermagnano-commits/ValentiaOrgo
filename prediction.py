"""
prediction.py — how an ASKCOS run and a template run become one answer.

ASKCOS answers "what comes out" but has no notion of what the reaction is
CALLED. The template engine has exactly that, so it runs on every request and
serves three purposes at once: it names any ASKCOS product it can independently
reproduce, it overrules ASKCOS where the two disagree, and it is the fallback
when ASKCOS is unreachable. A product it cannot name is a precise signal that
the template library has a gap.

The LLM is not involved in any of this. Naming stays deterministic.

Pure decision logic, deliberately kept out of app.py: this is the code that
decides which chemistry a student is shown, so it needs to be testable without
importing the FastAPI app (and with it TensorFlow, DECIMER and MolScribe).
See test_prediction.py.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

UNNAMED_REACTION = "Predicted (unnamed)"

# An ASKCOS prediction below this confidence that NO template corroborates is
# treated as a guess rather than an answer, and /react asks Claude as well.
# Measured against the live instance: a confident reduction or substitution
# lands ~0.99, while the flatly wrong predictions (SOCl2 → sulfuryl chloride,
# Br2 → dibromoalkene) sat far below that.
DEFAULT_TRUST_PROBABILITY = 0.5


def trust_probability() -> float:
    """Read at call time so tests and deployments can vary it."""
    try:
        return float(os.environ.get("ASKCOS_TRUST_PROBABILITY", DEFAULT_TRUST_PROBABILITY))
    except ValueError:
        logger.warning("Invalid ASKCOS_TRUST_PROBABILITY — using %s", DEFAULT_TRUST_PROBABILITY)
        return DEFAULT_TRUST_PROBABILITY


@dataclass
class Prediction:
    """Outcome of one substrate/reagent prediction."""
    products: list[dict]
    source: str                      # "askcos" | "templates" — which engine answered
    low_confidence: bool = False     # uncorroborated AND below the trust floor


def branch_products(branches: list[dict]) -> list[dict]:
    """Template-engine branches → the /react product shape."""
    return [
        {
            "smiles":            b["final_product"],
            "reaction_name":     b["reaction_name"],
            "template_id":       b["template_id"],
            "steps_taken":       b["steps_taken"],
            "execution_history": b["execution_history"],
            # No template branch carries an ASKCOS confidence.
            "probability":       None,
        }
        for b in branches
    ]


def name_products(outcomes: list, branches: list[dict]) -> list[dict]:
    """ASKCOS outcomes → the /react product shape, named via the templates.

    A product the engine also produced borrows that branch's name, template id
    and step history wholesale. Anything else is reported honestly as unnamed
    rather than guessed at.
    """
    by_product = {b["final_product"]: b for b in branches}
    products: list[dict] = []
    for outcome in outcomes:
        branch = by_product.get(outcome.smiles)
        if branch is not None:
            product = {
                "smiles":            outcome.smiles,
                "reaction_name":     branch["reaction_name"],
                "template_id":       branch["template_id"],
                "steps_taken":       branch["steps_taken"],
                "execution_history": branch["execution_history"],
            }
        else:
            product = {
                "smiles":            outcome.smiles,
                "reaction_name":     UNNAMED_REACTION,
                "template_id":       None,
                # ASKCOS predicts the overall transformation in one shot; it
                # exposes no intermediates, so this is a single step by
                # construction. Mechanism is /explain's job, not the engine's.
                "steps_taken":       1,
                "execution_history": [
                    f"Step 1 (Stable Product Finalized): {outcome.smiles}"
                ],
            }
        product["probability"] = outcome.probability
        products.append(product)
    return products


def needs_sanity_check(products: list[dict], low_confidence: bool) -> bool:
    """Whether an LLM plausibility check is worth the latency it costs.

    The check is a full model round-trip appended to a request whose answer is
    already computed — measured at ~2.4s through the Parley gateway, against a
    ~3.4s ASKCOS call. It earns that only where nothing deterministic vouches
    for the product. A curated template that named the product already did, and
    the template library outranks the LLM everywhere else in this codebase; a
    second opinion there buys nothing but a slower page.

    Both excluded cases belong to the blind-guess path instead: no products at
    all, and a low-confidence prediction, are escalated to Claude directly by
    the caller rather than merely checked.
    """
    if not products or low_confidence:
        return False
    return any(p["reaction_name"] == UNNAMED_REACTION for p in products)


def resolve_products(branches: list[dict], outcomes: list | None,
                     failure: str | None) -> Prediction:
    """Combine a template run and an ASKCOS run into one answer.

    `outcomes` is None when ASKCOS was disabled or failed (`failure` says
    which). Shared by the sync and async prediction paths so both make the
    same call in every case.

    The curated template library beats ASKCOS wherever the two disagree. That
    is not a hedge — it is measured. Against the live instance, ASKCOS put a
    dibromo*alkene* on top for cyclohexene + Br2 (correct product ranked 3rd)
    and sulfuryl chloride on top for ethanol + SOCl2, both reactions the
    template library already got right. ASKCOS earns its place on coverage,
    not on beating a hand-written rule inside that rule's own domain.
    """
    if outcomes is None:
        if failure:
            logger.warning("ASKCOS unavailable (%s) — falling back to templates", failure)
        return Prediction(branch_products(branches), "templates")

    if not outcomes:
        # ASKCOS answered but nothing cleared the probability floor. If the
        # templates know this reaction, showing their answer beats showing
        # nothing.
        if branches:
            logger.info("ASKCOS returned no confident product — using template result")
            return Prediction(branch_products(branches), "templates")
        return Prediction([], "askcos")

    template_products = {b["final_product"] for b in branches}

    # Disagreement guard: a template fired, but ASKCOS's best answer is not one
    # of the products it produced. Trust the curated rule.
    if template_products and outcomes[0].smiles not in template_products:
        logger.info(
            "ASKCOS top product %s absent from template products %s — preferring templates",
            outcomes[0].smiles, sorted(template_products),
        )
        return Prediction(branch_products(branches), "templates")

    # Either the templates corroborate ASKCOS's top pick, or they had nothing
    # to say. Uncorroborated AND unconfident is the case worth escalating to
    # Claude — no deterministic source is standing behind the answer.
    low_confidence = (
        not template_products
        and outcomes[0].probability < trust_probability()
    )
    if low_confidence:
        logger.info("ASKCOS top product %s uncorroborated at p=%.3f — flagging low confidence",
                    outcomes[0].smiles, outcomes[0].probability)

    return Prediction(name_products(outcomes, branches), "askcos",
                      low_confidence=low_confidence)
