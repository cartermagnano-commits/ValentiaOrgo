"""
test_prediction.py — Regression suite for the ASKCOS-vs-templates decision.

Run before committing changes to prediction.py:

    python test_prediction.py

Plain Python on purpose (matching test_templates.py): one PASS/FAIL line per
case, non-zero exit on any failure. Imports only prediction.py, so it runs in
under a second — no FastAPI, no TensorFlow, no ASKCOS instance.

This is the code that decides which chemistry a student is actually shown, so
the cases below are written from the real live-instance behavior rather than
from invented payloads. The three that matter:

  * cyclohexene + Br2  — ASKCOS ranks a dibromoALKENE first (p=0.43); the
    correct vicinal dibromide is its rank 3. The template is right.
  * ethanol + SOCl2    — ASKCOS ranks sulfuryl chloride first (p=0.83), which
    is not a reaction of ethanol at all. The template is right.
  * benzaldehyde+MeMgBr— no template exists; ASKCOS is right (p=0.986). This
    is the coverage win the whole integration is for.
"""

import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from askcos_client import Outcome
from prediction import (
    UNNAMED_REACTION, branch_products, name_products, resolve_products,
)

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


def branch(product: str, name: str = "Some Named Reaction", tid: str = "t1",
           steps: int = 1) -> dict:
    return {
        "final_product": product,
        "reaction_name": name,
        "template_id": tid,
        "steps_taken": steps,
        "execution_history": [f"Step 1 (Stable Product Finalized): {product}"],
        "steps": [],
    }


def outcome(smiles: str, prob: float, rank: int = 1) -> Outcome:
    return Outcome(smiles=smiles, probability=prob, rank=rank)


# ── ASKCOS unavailable / disabled → templates ────────────────────────────────

r = resolve_products([branch("CCCCBr")], None, None)
check("ASKCOS disabled falls back to templates", r.source == "templates", r.source)
check("disabled fallback still returns the template product",
      [p["smiles"] for p in r.products] == ["CCCCBr"], str(r.products))
check("disabled fallback is not flagged low confidence", r.low_confidence is False)

r = resolve_products([branch("CCCCBr")], None, "ReadTimeout: too slow")
check("ASKCOS failure falls back to templates", r.source == "templates", r.source)

r = resolve_products([], None, "ConnectError: refused")
check("ASKCOS failure with no templates yields nothing",
      r.products == [] and r.source == "templates", str(r))

# Template products carry no ASKCOS confidence.
r = resolve_products([branch("CCCCBr")], None, None)
check("template products have probability None",
      r.products[0]["probability"] is None, str(r.products[0]))


# ── Nothing cleared the probability floor ────────────────────────────────────

r = resolve_products([branch("CCCCBr")], [], None)
check("empty ASKCOS result prefers a template answer over nothing",
      r.source == "templates" and [p["smiles"] for p in r.products] == ["CCCCBr"], str(r))

r = resolve_products([], [], None)
check("empty ASKCOS result with no templates yields no products",
      r.products == [] and r.source == "askcos", str(r))
check("empty result is not flagged low confidence", r.low_confidence is False)


# ── Agreement → ASKCOS answers, template supplies the name ───────────────────

r = resolve_products(
    [branch("CC(O)c1ccccc1", "NaBH4 reduction: ketone → secondary alcohol", "nabh4_01")],
    [outcome("CC(O)c1ccccc1", 0.9995)], None,
)
check("agreement is reported as source=askcos", r.source == "askcos", r.source)
check("agreement borrows the template's reaction name",
      r.products[0]["reaction_name"] == "NaBH4 reduction: ketone → secondary alcohol",
      r.products[0]["reaction_name"])
check("agreement borrows the template id",
      r.products[0]["template_id"] == "nabh4_01", str(r.products[0]["template_id"]))
check("agreement carries the ASKCOS probability",
      r.products[0]["probability"] == 0.9995, str(r.products[0]["probability"]))
check("agreement is not low confidence", r.low_confidence is False)


# ── Disagreement → the curated template wins ─────────────────────────────────
# The two regressions that motivated this guard.

r = resolve_products(
    [branch("BrC1CCCCC1Br", "Br2 addition: alkene → vicinal dibromide", "br2_01")],
    [outcome("BrC1=C(Br)CCCC1", 0.4305, 1),   # wrong: a dibromoalkene
     outcome("BrC1CCCCC1", 0.2704, 2),
     outcome("BrC1CCCCC1Br", 0.1646, 3)],     # correct, but only rank 3
    None,
)
check("cyclohexene+Br2: template overrules ASKCOS's wrong top pick",
      r.source == "templates", r.source)
check("cyclohexene+Br2: the vicinal dibromide is what's shown",
      [p["smiles"] for p in r.products] == ["BrC1CCCCC1Br"], str(r.products))
check("cyclohexene+Br2: the dibromoalkene is not shown at all",
      "BrC1=C(Br)CCCC1" not in [p["smiles"] for p in r.products], str(r.products))

r = resolve_products(
    [branch("CCCl", "SOCl2: alcohol → alkyl chloride", "socl2_01")],
    [outcome("O=S(=O)(Cl)Cl", 0.8251, 1)],    # sulfuryl chloride — not a reaction of ethanol
    None,
)
check("ethanol+SOCl2: template overrules a confidently wrong ASKCOS answer",
      r.source == "templates", r.source)
check("ethanol+SOCl2: the alkyl chloride is what's shown",
      [p["smiles"] for p in r.products] == ["CCCl"], str(r.products))
check("a high ASKCOS probability does not override a firing template",
      r.source == "templates", "0.83 should still lose to a template")

# Partial agreement: ASKCOS's TOP pick matching is what counts.
r = resolve_products(
    [branch("CCCl", "SOCl2: alcohol → alkyl chloride")],
    [outcome("CCCl", 0.7, 1), outcome("CCBr", 0.2, 2)],
    None,
)
check("top-pick agreement keeps the full ranked ASKCOS list",
      r.source == "askcos" and [p["smiles"] for p in r.products] == ["CCCl", "CCBr"], str(r))
check("the extra ASKCOS-only product is reported as unnamed",
      r.products[1]["reaction_name"] == UNNAMED_REACTION, r.products[1]["reaction_name"])


# ── No template → ASKCOS answers, unnamed ────────────────────────────────────

r = resolve_products([], [outcome("CC(O)c1ccccc1", 0.986)], None)
check("benzaldehyde+MeMgBr: ASKCOS fills a template gap",
      r.source == "askcos" and r.products[0]["smiles"] == "CC(O)c1ccccc1", str(r))
check("an uncorroborated product is labeled unnamed, not guessed at",
      r.products[0]["reaction_name"] == UNNAMED_REACTION, r.products[0]["reaction_name"])
check("an unnamed product has no template id",
      r.products[0]["template_id"] is None, str(r.products[0]["template_id"]))
check("an unnamed product is a single step",
      r.products[0]["steps_taken"] == 1, str(r.products[0]["steps_taken"]))
check("a confident uncorroborated product is NOT low confidence",
      r.low_confidence is False, "0.986 is above the trust floor")


# ── Low confidence → escalate to Claude ──────────────────────────────────────

r = resolve_products([], [outcome("CCO", 0.30)], None)
check("uncorroborated AND unconfident is flagged low confidence",
      r.low_confidence is True, str(r))
check("a low-confidence prediction is still returned alongside the flag",
      [p["smiles"] for p in r.products] == ["CCO"], str(r.products))

r = resolve_products([branch("CCO", "Some Named Reaction")], [outcome("CCO", 0.30)], None)
check("a template corroborating a low-probability pick clears the flag",
      r.low_confidence is False, "template agreement is corroboration")

# Exactly at the floor counts as trusted (the comparison is strict <).
r = resolve_products([], [outcome("CCO", 0.5)], None)
check("a probability exactly at the trust floor is not low confidence",
      r.low_confidence is False, str(r.low_confidence))

r = resolve_products([], [outcome("CCO", 0.4999)], None)
check("just below the trust floor is low confidence",
      r.low_confidence is True, str(r.low_confidence))

_saved = os.environ.get("ASKCOS_TRUST_PROBABILITY")
os.environ["ASKCOS_TRUST_PROBABILITY"] = "0.99"
r = resolve_products([], [outcome("CCO", 0.95)], None)
check("ASKCOS_TRUST_PROBABILITY raises the escalation bar",
      r.low_confidence is True, "0.95 should be low against a 0.99 floor")
os.environ["ASKCOS_TRUST_PROBABILITY"] = "not-a-number"
r = resolve_products([], [outcome("CCO", 0.6)], None)
check("an invalid ASKCOS_TRUST_PROBABILITY falls back to the default",
      r.low_confidence is False, "0.6 is above the 0.5 default")
if _saved is None:
    os.environ.pop("ASKCOS_TRUST_PROBABILITY", None)
else:
    os.environ["ASKCOS_TRUST_PROBABILITY"] = _saved


# ── Shape helpers ────────────────────────────────────────────────────────────

b = branch_products([branch("CCCl", "SOCl2: alcohol → alkyl chloride", "socl2_01", 2)])[0]
check("branch_products preserves every field the frontend reads",
      set(b) == {"smiles", "reaction_name", "template_id", "steps_taken",
                 "execution_history", "probability"}, str(sorted(b)))
check("branch_products preserves steps_taken", b["steps_taken"] == 2, str(b["steps_taken"]))

n = name_products([outcome("CCO", 0.7)], [])[0]
check("name_products emits the same keys as branch_products",
      set(n) == set(b), str(sorted(n)))
check("an unnamed product still gets a readable execution_history",
      n["execution_history"] == ["Step 1 (Stable Product Finalized): CCO"],
      str(n["execution_history"]))


# ── Summary ──────────────────────────────────────────────────────────────────

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
