"""test_assess_endpoint.py — /react/assess wiring, with the LLM stubbed.

Plain python (no pytest):
    python test_assess_endpoint.py

The LLM is replaced with a scripted fake, so this suite exercises the loop
control flow (how many rounds run, which verdict comes out) without a network
call or a model.
"""

import asyncio
import sys

import app

_passed = 0
_failed = 0


def check(name, got, want):
    global _passed, _failed
    if got == want:
        print(f"PASS  {name}")
        _passed += 1
    else:
        print(f"FAIL  {name}\n        got:  {got!r}\n        want: {want!r}")
        _failed += 1


class FakeLLM:
    """Returns each scripted reply in turn; records how many calls happened
    and what each call was made with, so tests can assert on the prompts
    themselves — not just the outcome — and catch a leaked engine product or
    a labeled candidate pool that outcome-only checks would miss."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.seen = []   # list of (system, messages) per call, in order

    async def __call__(self, system, messages, max_tokens, engine=None):
        self.calls += 1
        self.seen.append((system, messages))
        return self.replies.pop(0) if self.replies else ""


def run_assess(engine_products, replies, substrate="CC(=O)CCBr", reagent="O"):
    """Drive the endpoint handler with a scripted LLM."""
    fake = FakeLLM(replies)
    original = app._llm_complete
    app._llm_complete = fake
    try:
        req = app.AssessRequest(
            substrate_smiles=substrate,
            reagent_smiles=reagent,
            engine_products=engine_products,
        )
        result = asyncio.run(app.react_assess(req, user_id=None))
    finally:
        app._llm_complete = original
    return result, fake.calls, fake.seen


# Round-1 agreement: one call, verified.
res, calls, _seen = run_assess(["CC(=O)CCO"], ["CC(=O)CCO"])
check("round-1 agreement → verified", res["status"], "verified")
check("round-1 agreement → agreed product", res["agreed_product"], "CC(=O)CCO")
check("round-1 agreement → one llm call", calls, 1)
check("round-1 agreement → rounds reported", res["rounds"], 1)

# Disagree then converge on round 2.
res, calls, _seen = run_assess(["CC(=O)CCO"], ["CCCC", "CC(=O)CCO"])
check("converged round 2 → verified", res["status"], "verified")
check("converged round 2 → two llm calls", calls, 2)
check("converged round 2 → rounds reported", res["rounds"], 2)

# Never converges: 3 calls, disputed, both candidate sets returned.
res, calls, seen = run_assess(["CC(=O)CCO"], ["CCCC", "CCCC", "CCCC"])
check("persistent disagreement → disputed", res["status"], "disputed")
check("persistent disagreement → three llm calls", calls, 3)
check("persistent disagreement → ai candidate returned", "CCCC" in res["ai_products"], True)
check("persistent disagreement → engine candidate returned",
      res["engine_products"], ["CC(=O)CCO"])

# ── Prompt-content tripwires ──────────────────────────────────────────────
# Outcome checks above can't catch a leaked engine product in the blind
# round, or a labeled/unlabeled-but-attributed candidate pool in the
# reconciliation round. Inspect the actual prompts sent to the LLM.
round1_system, round1_messages = seen[0]
round1_text = " ".join(m["content"] for m in round1_messages)
check("blind round 1 → does not mention engine product",
      "CC(=O)CCO" in round1_text, False)

round2_system, round2_messages = seen[1]
round2_text = " ".join(m["content"] for m in round2_messages)
check("reconciliation round 2 → includes engine candidate",
      "CC(=O)CCO" in round2_text, True)
check("reconciliation round 2 → includes AI candidate",
      "CCCC" in round2_text, True)
check("reconciliation round 2 → no attribution of candidate origin",
      any(w in round2_text.lower() for w in ("engine", "deterministic", "template")),
      False)
check("system prompt stable across rounds",
      round1_system == round2_system == app._ASSESS_SYSTEM, True)

# Template miss: engine had nothing, AI answers → ai_only, one call only.
res, calls, _seen = run_assess([], ["CC(=O)CCO"])
check("template miss → ai_only", res["status"], "ai_only")
check("template miss → product surfaced", res["agreed_product"], "CC(=O)CCO")
check("template miss → single llm call", calls, 1)

# AI silent: no reconciliation rounds are worth running.
res, calls, _seen = run_assess(["CC(=O)CCO"], [""])
check("ai silent → unverified", res["status"], "unverified")
check("ai silent → engine result preserved", res["engine_products"], ["CC(=O)CCO"])
check("ai silent → stops after one call", calls, 1)

# AI garbage every round → unverified, not disputed.
res, calls, _seen = run_assess(["CC(=O)CCO"], ["not a molecule", "still not", "nope"])
check("ai garbage → unverified", res["status"], "unverified")

# Template miss with a silent AI: nothing to show.
res, calls, _seen = run_assess([], [""])
check("miss + silent ai → unverified", res["status"], "unverified")

# Invalid substrate is a client error, not a verdict.
try:
    run_assess(["CCO"], ["CCO"], substrate="!!!not-smiles!!!")
    check("invalid substrate → 422", "no error raised", "HTTPException 422")
except app.HTTPException as exc:
    check("invalid substrate → 422", exc.status_code, 422)

print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
