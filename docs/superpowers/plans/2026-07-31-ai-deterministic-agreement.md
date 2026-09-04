# AI ↔ Deterministic Agreement System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every chemistry answer the joint product of the deterministic engine and the generative AI — the AI verifies template hits, fills template misses (flagged), and upgrades the image→SMILES vision arbiter to run on the user's chosen cloud model.

**Architecture:** A new pure decision module (`reaction_arbitration.py`) owns the verdict table. A new stateless endpoint (`POST /react/assess`) runs a blind-then-reconcile LLM loop through the existing engine router and returns one of four verdicts. The OSR vision arbiter gains a provider router so Claude/GPT-4o multimodal replaces the slow local VLM when configured. The frontend calls assess after rendering the deterministic result and settles a badge.

**Tech Stack:** Python 3 / FastAPI / RDKit / httpx / anthropic + openai SDKs (backend); Next.js + React JSX (frontend). Tests are plain-python scripts run directly (`python test_x.py`), matching `test_osr.py` and `test_templates.py` — there is no pytest in this project.

## Global Constraints

- **No-flip rule:** the AI must never overwrite or replace a deterministic result. It may only add a verdict, or supply a result where the engine produced none (flagged `ai_only`).
- **LLM/VLM-as-judge is banned:** verification is independent prediction plus canonical-SMILES agreement. Never prompt "do these two answers match?".
- **Canonical comparison only:** every agreement check compares RDKit canonical SMILES strings produced by `app._canonical_smiles`.
- **Graceful degradation:** any AI failure (no key, provider down, invalid output) yields verdict `unverified` and leaves the deterministic result untouched. The loop may delay a badge, never a result.
- **Engine choice respected:** all generative calls route through `EngineConfig` (local / byok / hosted) and are metered by `_enforce_hosted_quota` exactly like `/explain`.
- **Purity of `reaction_arbitration.py`:** no RDKit, no network, no `app` import. Only stdlib. Must import in milliseconds.
- **Deterministic tests must stay green:** `python test_templates.py` (27 passed) and `python test_osr.py` (45 passed) must pass unchanged after every task.
- Max total LLM calls per assess request: **3** (1 blind + up to 2 reconciliation).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `reaction_arbitration.py` (create) | Pure verdict logic: agreement detection, degeneracy gate for AI products, verdict table, candidate-list shuffling helper |
| `test_reaction_arbitration.py` (create) | Plain-python suite for the above |
| `app.py` (modify) | `_llm_complete()`, `_parse_smiles_list()`, `_vision_smiles_routed()`, `POST /react/assess`, shared OSR read helper, `engine` form field on the two image endpoints |
| `frontend/src/api.js` (modify) | `assessReaction()`; attach engine payload to image uploads |
| `frontend/src/components/VerdictBadge.jsx` (create) | Presentational badge + dispute pick-one card pair |
| `frontend/src/components/DirectReact.jsx` (modify) | Fire assess after `/react`, render badge, render `ai_only` card on template miss |
| `frontend/src/components/ReactPredict.jsx` (modify) | Same, plus show `recognition_confidence` |
| `frontend/src/components/InfoPanel.jsx` (modify) | Fire assess on branch selection, render badge in `BranchInfoView` |

---

### Task 1: Pure arbitration module

**Files:**
- Create: `C:\Orgo AI\reaction_arbitration.py`
- Test: `C:\Orgo AI\test_reaction_arbitration.py`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces:
  - `looks_degenerate_product(smiles: str) -> bool`
  - `plausible_products(smiles_list: list[str]) -> list[str]`
  - `agreement(engine_products: list[str], ai_products: list[str]) -> str | None`
  - `verdict(engine_products: list[str], ai_products: list[str], rounds_used: int, ai_failed: bool) -> tuple[str, str | None]` returning `(status, agreed_product)` where status is one of `"verified" | "disputed" | "ai_only" | "unverified"`
  - `candidate_pool(engine_products: list[str], ai_products: list[str], seed: int) -> list[str]` — deduplicated, deterministically shuffled union for the neutral reconciliation prompt

- [ ] **Step 1: Write the failing test**

Create `C:\Orgo AI\test_reaction_arbitration.py`:

```python
"""test_reaction_arbitration.py — verdict-table suite for reaction_arbitration.

Plain python (no pytest), same style as test_osr.py:
    python test_reaction_arbitration.py
"""

import sys

from reaction_arbitration import (
    agreement, candidate_pool, looks_degenerate_product, plausible_products,
    verdict,
)

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


# ── degeneracy gate ──────────────────────────────────────────────────────────
check("degenerate: dummy atom rejected", looks_degenerate_product("*CCO"), True)
check("degenerate: long alkane rejected", looks_degenerate_product("C" * 30), True)
check("degenerate: repeated fragment rejected",
      looks_degenerate_product("CC=O.CC=O.CC=O.CC=O"), True)
check("degenerate: many fragments rejected",
      looks_degenerate_product(".".join(["C"] * 13)), True)
check("degenerate: normal product accepted", looks_degenerate_product("CC(=O)CCO"), False)
check("degenerate: empty string rejected", looks_degenerate_product(""), True)
check("plausible filters the bad ones",
      plausible_products(["CC(=O)CCO", "*CCO", ""]), ["CC(=O)CCO"])

# ── agreement ────────────────────────────────────────────────────────────────
check("agreement: exact match found", agreement(["CCO", "CC=O"], ["CC=O"]), "CC=O")
check("agreement: no overlap", agreement(["CCO"], ["CC=O"]), None)
check("agreement: empty ai side", agreement(["CCO"], []), None)
check("agreement: empty engine side", agreement([], ["CCO"]), None)
check("agreement: first engine product wins ordering",
      agreement(["CCO", "CC=O"], ["CC=O", "CCO"]), "CCO")

# ── verdict table ────────────────────────────────────────────────────────────
check("verdict: round-1 agreement is verified",
      verdict(["CCO"], ["CCO"], 1, False), ("verified", "CCO"))
check("verdict: converged at round 3 still verified",
      verdict(["CCO"], ["CCO"], 3, False), ("verified", "CCO"))
check("verdict: persistent disagreement is disputed",
      verdict(["CCO"], ["CC=O"], 3, False), ("disputed", None))
check("verdict: engine empty + valid ai is ai_only",
      verdict([], ["CCO"], 1, False), ("ai_only", "CCO"))
check("verdict: engine empty + no ai is unverified",
      verdict([], [], 1, False), ("unverified", None))
check("verdict: ai failure keeps engine result unverified",
      verdict(["CCO"], [], 1, True), ("unverified", None))
check("verdict: ai produced nothing usable is unverified",
      verdict(["CCO"], [], 3, False), ("unverified", None))
check("verdict: engine empty + ai failed is unverified",
      verdict([], [], 1, True), ("unverified", None))

# ── candidate pool ───────────────────────────────────────────────────────────
pool = candidate_pool(["CCO", "CC=O"], ["CC=O", "CCC"], seed=7)
check("pool: deduplicated union", sorted(pool), ["CC=O", "CCC", "CCO"])
check("pool: deterministic for a given seed",
      candidate_pool(["CCO", "CC=O"], ["CC=O", "CCC"], seed=7), pool)
check("pool: drops degenerate candidates",
      sorted(candidate_pool(["CCO"], ["*CC"], seed=1)), ["CCO"])

print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Orgo AI" && python test_reaction_arbitration.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'reaction_arbitration'`

- [ ] **Step 3: Write the implementation**

Create `C:\Orgo AI\reaction_arbitration.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Orgo AI" && python test_reaction_arbitration.py`
Expected: PASS — `24 passed, 0 failed`

- [ ] **Step 5: Verify deterministic suites still green**

Run: `cd "C:\Orgo AI" && python test_templates.py && python test_osr.py`
Expected: `27 passed, 0 failed` and `45 passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
cd "C:\Orgo AI"
git add reaction_arbitration.py test_reaction_arbitration.py
git commit -m "Add pure reaction arbitration module with verdict table"
```

---

### Task 2: Non-streaming LLM helper and SMILES response parsing

**Files:**
- Modify: `C:\Orgo AI\app.py` (add after `_select_stream`, around line 400)
- Test: `C:\Orgo AI\test_reaction_arbitration.py` (append parsing tests)

**Interfaces:**
- Consumes: `_select_stream(system, messages, max_tokens, engine)` and `_canonical_smiles(raw)` from `app.py`; `plausible_products` from Task 1.
- Produces:
  - `async def _llm_complete(system: str, messages: list[dict], max_tokens: int, engine: Optional[EngineConfig]) -> str` — full text of a non-streaming completion, `""` on failure.
  - `_parse_smiles_list(text: str, limit: int = 4) -> list[str]` — canonical, plausible SMILES extracted from a model reply.

- [ ] **Step 1: Write the failing test**

Append to `C:\Orgo AI\test_reaction_arbitration.py`, immediately **before** the final `print`/`sys.exit` lines:

```python
# ── response parsing (imports app; heavier, kept last) ───────────────────────
import app  # noqa: E402

check("parse: bare smiles", app._parse_smiles_list("CCO"), ["CCO"])
check("parse: prose around smiles",
      app._parse_smiles_list("The major product is CC(=O)CCO here."), ["CC(=O)CCO"])
check("parse: newline separated, order kept",
      app._parse_smiles_list("CCO\nCC=O"), ["CCO", "CC=O"])
check("parse: markdown fence stripped",
      app._parse_smiles_list("```\nCCO\n```"), ["CCO"])
check("parse: garbage yields nothing", app._parse_smiles_list("I am not sure."), [])
check("parse: empty yields nothing", app._parse_smiles_list(""), [])
check("parse: degenerate output filtered", app._parse_smiles_list("*CCO"), [])
check("parse: duplicates collapsed", app._parse_smiles_list("CCO\nOCC"), ["CCO"])
check("parse: honors limit", len(app._parse_smiles_list("CCO\nCC=O\nCCC\nCCCC\nCCCCC", limit=2)), 2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Orgo AI" && python test_reaction_arbitration.py`
Expected: FAIL — `AttributeError: module 'app' has no attribute '_parse_smiles_list'`

- [ ] **Step 3: Write the implementation**

In `C:\Orgo AI\app.py`, add immediately after the `_select_stream` function (before the `app = FastAPI(title="Orgo AI")` line):

```python
async def _llm_complete(system: str, messages: list[dict], max_tokens: int,
                        engine: Optional[EngineConfig] = None) -> str:
    """Run a generative call to completion and return its full text.

    Drains the same generator `/explain` streams, so provider routing, BYOK
    key handling, and hosted fallbacks are reused rather than duplicated.
    Returns "" on any failure — callers treat an empty reply as "the AI had
    nothing to say", which degrades to an unverified verdict.
    """
    chunks: list[str] = []
    try:
        async for frame in _select_stream(system, messages, max_tokens, engine):
            if not frame.startswith("data: "):
                continue
            payload = frame[6:].strip()
            if payload == "[DONE]":
                break
            try:
                data = json.loads(payload)
            except Exception:
                continue
            if data.get("error"):
                logger.warning("LLM completion error frame: %s", data["error"])
                return ""
            if data.get("delta"):
                chunks.append(data["delta"])
    except HTTPException:
        raise           # missing BYOK key etc. — surface as a real HTTP error
    except Exception as exc:
        logger.warning("LLM completion failed (%s): %s", type(exc).__name__, exc)
        return ""
    return "".join(chunks)


# A SMILES-ish token: the character set RDKit accepts, long enough not to
# match ordinary prose words.
_SMILES_TOKEN = re.compile(r"[A-Za-z0-9@+\-\[\]()/\\=#%\.]{2,}")


def _parse_smiles_list(text: str, limit: int = 4) -> list[str]:
    """Extract canonical, plausible product SMILES from a model reply.

    The prompt asks for SMILES-only output, but models still wrap replies in
    prose or code fences — so parse defensively: try each line whole first
    (a line IS the answer in the common case), then fall back to tokens.
    """
    if not text:
        return []
    found: list[str] = []
    for line in text.replace("```", "\n").splitlines():
        line = line.strip().strip(",;")
        if not line:
            continue
        canon = _canonical_smiles(line)
        if canon:
            found.append(canon)
            continue
        for token in _SMILES_TOKEN.findall(line):
            canon = _canonical_smiles(token)
            if canon:
                found.append(canon)
    return plausible_products(found)[:limit]
```

Add `import re` to the top-level imports in `app.py` (the module currently imports `re` locally inside `_ollama_call`; hoisting it is required here). Then extend the arbitration import block near the top:

```python
from osr_arbitration import (
    arbitrate_local, plausible_or_none, resolve_with_vision,
)
from reaction_arbitration import (
    AI_ONLY, DISPUTED, UNVERIFIED, VERIFIED, candidate_pool,
    plausible_products, verdict,
)
```

Wire the new module's logger to the same handler as `osr_arbitration`, immediately after the existing `_arb_logger` block near the top of `app.py`:

```python
_rxn_arb_logger = logging.getLogger("reaction_arbitration")
_rxn_arb_logger.setLevel(logging.INFO)
if not _rxn_arb_logger.handlers:
    _rxn_arb_logger.addHandler(logging.StreamHandler())
    _rxn_arb_logger.propagate = False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Orgo AI" && python test_reaction_arbitration.py`
Expected: PASS — `33 passed, 0 failed`

- [ ] **Step 5: Verify the app still imports and deterministic suites pass**

Run: `cd "C:\Orgo AI" && python -c "import app; print('IMPORT OK')" && python test_templates.py && python test_osr.py`
Expected: `IMPORT OK`, then `27 passed, 0 failed` and `45 passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
cd "C:\Orgo AI"
git add app.py test_reaction_arbitration.py
git commit -m "Add non-streaming LLM completion helper and SMILES reply parsing"
```

---

### Task 3: The `POST /react/assess` endpoint

**Files:**
- Modify: `C:\Orgo AI\app.py` (add near the `/react` route, after the `react` handler around line 2326; add path to `RATE_LIMIT_HEAVY` around line 421)

**Interfaces:**
- Consumes: `_llm_complete`, `_parse_smiles_list` (Task 2); `verdict`, `agreement`, `candidate_pool`, status constants (Task 1); `_enforce_hosted_quota`, `require_auth`, `EngineConfig`, `_canonical_smiles` (existing).
- Produces: `POST /react/assess` returning
  `{status, agreed_product, ai_products, engine_products, rounds, note}`.

- [ ] **Step 1: Write the failing test**

Create `C:\Orgo AI\test_assess_endpoint.py`:

```python
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
    """Returns each scripted reply in turn; records how many calls happened."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    async def __call__(self, system, messages, max_tokens, engine=None):
        self.calls += 1
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
    return result, fake.calls


# Round-1 agreement: one call, verified.
res, calls = run_assess(["CC(=O)CCO"], ["CC(=O)CCO"])
check("round-1 agreement → verified", res["status"], "verified")
check("round-1 agreement → agreed product", res["agreed_product"], "CC(=O)CCO")
check("round-1 agreement → one llm call", calls, 1)
check("round-1 agreement → rounds reported", res["rounds"], 1)

# Disagree then converge on round 2.
res, calls = run_assess(["CC(=O)CCO"], ["CCCC", "CC(=O)CCO"])
check("converged round 2 → verified", res["status"], "verified")
check("converged round 2 → two llm calls", calls, 2)
check("converged round 2 → rounds reported", res["rounds"], 2)

# Never converges: 3 calls, disputed, both candidate sets returned.
res, calls = run_assess(["CC(=O)CCO"], ["CCCC", "CCCC", "CCCC"])
check("persistent disagreement → disputed", res["status"], "disputed")
check("persistent disagreement → three llm calls", calls, 3)
check("persistent disagreement → ai candidate returned", "CCCC" in res["ai_products"], True)
check("persistent disagreement → engine candidate returned",
      res["engine_products"], ["CC(=O)CCO"])

# Template miss: engine had nothing, AI answers → ai_only, one call only.
res, calls = run_assess([], ["CC(=O)CCO"])
check("template miss → ai_only", res["status"], "ai_only")
check("template miss → product surfaced", res["agreed_product"], "CC(=O)CCO")
check("template miss → single llm call", calls, 1)

# AI silent: no reconciliation rounds are worth running.
res, calls = run_assess(["CC(=O)CCO"], [""])
check("ai silent → unverified", res["status"], "unverified")
check("ai silent → engine result preserved", res["engine_products"], ["CC(=O)CCO"])
check("ai silent → stops after one call", calls, 1)

# AI garbage every round → unverified, not disputed.
res, calls = run_assess(["CC(=O)CCO"], ["not a molecule", "still not", "nope"])
check("ai garbage → unverified", res["status"], "unverified")

# Template miss with a silent AI: nothing to show.
res, calls = run_assess([], [""])
check("miss + silent ai → unverified", res["status"], "unverified")

# Invalid substrate is a client error, not a verdict.
try:
    run_assess(["CCO"], ["CCO"], substrate="!!!not-smiles!!!")
    check("invalid substrate → 422", "no error raised", "HTTPException 422")
except app.HTTPException as exc:
    check("invalid substrate → 422", exc.status_code, 422)

print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Orgo AI" && python test_assess_endpoint.py`
Expected: FAIL — `AttributeError: module 'app' has no attribute 'AssessRequest'`

- [ ] **Step 3: Write the implementation**

In `C:\Orgo AI\app.py`, add `"/react/assess"` to the `RATE_LIMIT_HEAVY` set:

```python
RATE_LIMIT_HEAVY = {
    "/analyze", "/react-from-image", "/react", "/react/assess", "/pathways",
    "/explain", "/chat", "/assist", "/stereo",
}
```

Then add this block immediately after the `react` endpoint handler:

```python
# ── /react/assess — joint AI + deterministic verdict ─────────────────────────
# The deterministic engine has already answered by the time this runs; the
# frontend calls it with whatever the engine produced (possibly nothing). The
# AI predicts INDEPENDENTLY first — it never sees the engine's answer in round
# one — and only then are the two compared. Rubber-stamping is the failure mode
# that makes verification worthless, so the blind round is load-bearing.

MAX_ASSESS_ROUNDS = 3          # 1 blind + up to 2 reconciliation
ASSESS_MAX_TOKENS = 120        # SMILES-only replies are short

_ASSESS_SYSTEM = (
    "You are an expert organic chemist predicting reaction products.\n"
    "HARD RULES:\n"
    "- Output ONLY SMILES strings, one per line. No prose, no numbering, "
    "no markdown, no explanation.\n"
    "- Give the MAJOR product first. At most 3 lines.\n"
    "- Output only the organic product(s) — omit counterions, solvent, and "
    "inorganic byproducts.\n"
    "- If you cannot determine the product, output exactly: UNKNOWN"
)


class AssessRequest(BaseModel):
    substrate_smiles: str
    reagent_smiles: str
    engine_products: list[str] = []
    engine: Optional[EngineConfig] = None


@app.post("/react/assess")
async def react_assess(req: AssessRequest, user_id: str | None = Depends(require_auth)):
    """Return the joint AI/deterministic verdict for one reaction.

    Stateless by design: the client supplies the engine's products, so the
    same endpoint serves /react, a selected pathway branch, and
    /react-from-image — and a page reload can re-ask without server state.
    """
    _enforce_hosted_quota(req.engine, user_id)

    substrate = _canonical_smiles(req.substrate_smiles.strip())
    if not substrate:
        raise HTTPException(status_code=422, detail="Invalid substrate SMILES")
    reagent = _canonical_smiles(req.reagent_smiles.strip())
    if not reagent:
        raise HTTPException(status_code=422, detail="Invalid reagent SMILES")

    if len(req.engine_products) > 12:
        raise HTTPException(status_code=413, detail="Too many engine products.")
    engine_products = plausible_products(
        [c for c in (_canonical_smiles(p) for p in req.engine_products) if c])

    # ── Round 1: blind independent prediction ────────────────────────────────
    blind_prompt = (
        f"Substrate: {substrate}\n"
        f"Reagent: {reagent}\n\n"
        "What is the major organic product of this reaction? "
        "Answer with SMILES only."
    )
    reply = await _llm_complete(
        _ASSESS_SYSTEM, [{"role": "user", "content": blind_prompt}],
        ASSESS_MAX_TOKENS, req.engine)
    ai_products = _parse_smiles_list(reply)
    rounds = 1

    # ── Rounds 2-3: neutral reconciliation ───────────────────────────────────
    # Only worth running when the AI actually produced something AND the engine
    # has a competing answer. A silent AI stays silent; a template miss is
    # already settled by the blind round.
    while (rounds < MAX_ASSESS_ROUNDS and ai_products and engine_products
           and agreement(engine_products, ai_products) is None):
        pool = candidate_pool(engine_products, ai_products, seed=rounds)
        if not pool:
            break
        listing = "\n".join(pool)
        reconcile_prompt = (
            f"Substrate: {substrate}\n"
            f"Reagent: {reagent}\n\n"
            "These are candidate products for this reaction:\n"
            f"{listing}\n\n"
            "Which single candidate is the major product? Reply with that "
            "candidate's SMILES exactly as written above. If none is correct, "
            "reply with the correct product's SMILES instead."
        )
        reply = await _llm_complete(
            _ASSESS_SYSTEM, [{"role": "user", "content": reconcile_prompt}],
            ASSESS_MAX_TOKENS, req.engine)
        rounds += 1
        picked = _parse_smiles_list(reply)
        if not picked:
            break                      # AI went silent — stop burning calls
        ai_products = picked

    ai_failed = not ai_products
    status, agreed = verdict(engine_products, ai_products, rounds, ai_failed)

    notes = {
        VERIFIED: "The AI independently predicted the same product as the "
                  "deterministic engine.",
        DISPUTED: "The AI predicted a different product. The engine's result "
                  "is shown as computed — review both and choose.",
        AI_ONLY: "No reaction template matched, so this product is the AI's "
                 "prediction alone — it has NOT been checked by the "
                 "deterministic engine.",
        UNVERIFIED: "The AI could not verify this result. The deterministic "
                    "engine's output is unchanged.",
    }
    logger.info(
        "Assess: substrate=%r reagent=%r engine=%s ai=%s rounds=%d → %s",
        substrate, reagent, engine_products, ai_products, rounds, status)

    return {
        "status": status,
        "agreed_product": agreed,
        "ai_products": ai_products,
        "engine_products": engine_products,
        "rounds": rounds,
        "note": notes[status],
    }
```

Extend the `reaction_arbitration` import in `app.py` to include `agreement`:

```python
from reaction_arbitration import (
    AI_ONLY, DISPUTED, UNVERIFIED, VERIFIED, agreement, candidate_pool,
    plausible_products, verdict,
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Orgo AI" && python test_assess_endpoint.py`
Expected: PASS — `19 passed, 0 failed`

- [ ] **Step 5: Verify all other suites still pass**

Run: `cd "C:\Orgo AI" && python test_reaction_arbitration.py && python test_templates.py && python test_osr.py`
Expected: all three green (33, 27, 45 passed)

- [ ] **Step 6: Commit**

```bash
cd "C:\Orgo AI"
git add app.py test_assess_endpoint.py
git commit -m "Add POST /react/assess with blind-then-reconcile agreement loop"
```

---

### Task 4: Engine-routed vision reads (the OSR bottleneck)

**Files:**
- Modify: `C:\Orgo AI\app.py` (add router after `_ollama_reaction_smiles`, around line 215; change the two `_vision_pool.submit` call sites and the `/analyze` + `/react-from-image` signatures)
- Test: `C:\Orgo AI\test_vision_routing.py` (create)

**Interfaces:**
- Consumes: `EngineConfig`, `_ollama_call`, `_canonical_smiles`, `plausible_or_none`, `DEFAULT_ANTHROPIC_MODEL`, `DEFAULT_OPENAI_MODEL`.
- Produces:
  - `_vision_smiles_routed(img_bytes: bytes, prompt: str, engine: Optional[EngineConfig]) -> str | None`
  - `_parse_engine_field(raw: str | None) -> Optional[EngineConfig]` — parses the optional multipart `engine` JSON field.

- [ ] **Step 1: Write the failing test**

Create `C:\Orgo AI\test_vision_routing.py`:

```python
"""test_vision_routing.py — vision provider selection, no network calls.

Plain python (no pytest):
    python test_vision_routing.py
"""

import os
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


# ── engine field parsing ─────────────────────────────────────────────────────
check("engine field: None stays None", app._parse_engine_field(None), None)
check("engine field: empty stays None", app._parse_engine_field(""), None)
check("engine field: junk stays None", app._parse_engine_field("{not json"), None)
parsed = app._parse_engine_field('{"mode":"hosted","provider":"anthropic"}')
check("engine field: mode parsed", parsed.mode, "hosted")
check("engine field: provider parsed", parsed.provider, "anthropic")

# ── provider selection: which backend does the router reach for? ─────────────
calls = []


def fake_cloud(img, prompt, provider, model, api_key):
    calls.append(("cloud", provider, model))
    return "CCO"


def fake_ollama(img, prompt):
    calls.append(("ollama", None, None))
    return "CC=O"


orig_cloud, orig_ollama = app._cloud_vision_smiles, app._ollama_call
orig_anthropic = os.environ.get("ANTHROPIC_API_KEY")
app._cloud_vision_smiles, app._ollama_call = fake_cloud, fake_ollama
try:
    # Local mode must never reach the cloud, even with a key configured.
    os.environ["ANTHROPIC_API_KEY"] = "sk-test"
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="local"))
    check("local mode → ollama", [c[0] for c in calls], ["ollama"])

    # Hosted with a server key → cloud.
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="hosted", provider="anthropic"))
    check("hosted+key → cloud anthropic", [(c[0], c[1]) for c in calls], [("cloud", "anthropic")])

    # BYOK carries the caller's key.
    calls.clear()
    app._vision_smiles_routed(
        b"x", "p",
        app.EngineConfig(mode="byok", provider="openai", api_key="sk-user", model="gpt-4o"))
    check("byok openai → cloud openai", [(c[0], c[1]) for c in calls], [("cloud", "openai")])
    check("byok passes model through", calls[0][2], "gpt-4o")

    # BYOK without a key can't reach the cloud — fall to local.
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="byok", provider="openai"))
    check("byok w/o key → ollama", [c[0] for c in calls], ["ollama"])

    # Hosted with NO server key at all → local fallback.
    os.environ.pop("ANTHROPIC_API_KEY", None)
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="hosted", provider="anthropic"))
    check("hosted w/o key → ollama", [c[0] for c in calls], ["ollama"])

    # No engine config at all → current behavior (local).
    calls.clear()
    app._vision_smiles_routed(b"x", "p", None)
    check("no engine → ollama", [c[0] for c in calls], ["ollama"])

    # Cloud failure falls through to local rather than returning nothing.
    os.environ["ANTHROPIC_API_KEY"] = "sk-test"
    app._cloud_vision_smiles = lambda *a, **k: None
    calls.clear()
    got = app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="hosted", provider="anthropic"))
    check("cloud failure → ollama fallback", [c[0] for c in calls], ["ollama"])
    check("cloud failure → local read returned", got, "CC=O")
finally:
    app._cloud_vision_smiles, app._ollama_call = orig_cloud, orig_ollama
    if orig_anthropic is None:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    else:
        os.environ["ANTHROPIC_API_KEY"] = orig_anthropic

print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Orgo AI" && python test_vision_routing.py`
Expected: FAIL — `AttributeError: module 'app' has no attribute '_parse_engine_field'`

- [ ] **Step 3: Write the implementation**

In `C:\Orgo AI\app.py`, add after `_ollama_reaction_smiles` (before the "Choose Your Engine" section):

```python
# ── Vision provider routing ──────────────────────────────────────────────────
# The local VLM is the OSR pipeline's slowest and least accurate arbiter
# (~58 s per read on a dev machine, and it has misread a test ketone by a
# carbon). Cloud multimodal models answer in seconds and read structures far
# better, so when the user's engine choice gives us one, use it — and fall
# back down the ladder (cloud → local → none) so a missing key or a provider
# outage degrades exactly as it does today.

VISION_MAX_TOKENS = 256


def _cloud_vision_smiles(img_bytes: bytes, prompt: str, provider: str,
                         model: str | None, api_key: str | None) -> str | None:
    """One-shot multimodal read via Anthropic or OpenAI. None on any failure."""
    b64 = base64.b64encode(img_bytes).decode()
    try:
        if provider == "openai":
            import openai
            client = openai.OpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"])
            resp = client.chat.completions.create(
                model=model or DEFAULT_OPENAI_MODEL,
                max_tokens=VISION_MAX_TOKENS,
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ]}],
            )
            text = (resp.choices[0].message.content or "").strip()
        else:
            import anthropic
            client = anthropic.Anthropic(api_key=api_key or os.environ["ANTHROPIC_API_KEY"])
            resp = client.messages.create(
                model=model or DEFAULT_ANTHROPIC_MODEL,
                max_tokens=VISION_MAX_TOKENS,
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": prompt},
                ]}],
            )
            text = "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception as exc:
        logger.warning("Cloud vision read failed (%s: %s)", type(exc).__name__, exc)
        return None

    logger.info("Cloud vision (%s) raw response: %r", provider, text[:300])
    result = plausible_or_none(_canonical_smiles(text), "CloudVision")
    if result:
        return result
    for candidate in _SMILES_TOKEN.findall(text):
        result = plausible_or_none(_canonical_smiles(candidate), "CloudVision")
        if result:
            return result
    return None


def _vision_smiles_routed(img_bytes: bytes, prompt: str,
                          engine: Optional[EngineConfig] = None) -> str | None:
    """Read SMILES from an image using the best vision model the engine
    selection allows: cloud multimodal → local Ollama VLM → None.

    Local mode never reaches the cloud even when a server key exists — the
    user asked for local. Note engine.model is only meaningful for the cloud
    branch: in local mode it names a TEXT model, so the Ollama path resolves
    its own vision model instead.
    """
    mode = (engine.mode or "hosted").lower() if engine else None
    if engine is not None and mode != "local":
        provider = (engine.provider or "anthropic").lower()
        if mode == "byok":
            if engine.api_key:
                read = _cloud_vision_smiles(img_bytes, prompt, provider,
                                            engine.model, engine.api_key)
                if read:
                    return read
        else:  # hosted — server key
            env_key = "OPENAI_API_KEY" if provider == "openai" else "ANTHROPIC_API_KEY"
            if os.environ.get(env_key):
                read = _cloud_vision_smiles(img_bytes, prompt, provider,
                                            engine.model, None)
                if read:
                    return read
    return _ollama_call(img_bytes, prompt)


def _parse_engine_field(raw: str | None) -> Optional[EngineConfig]:
    """Parse the optional `engine` multipart field on image uploads.

    Malformed input is ignored rather than fatal: a bad engine field should
    cost the user a faster vision model, not their upload.
    """
    if not raw:
        return None
    try:
        return EngineConfig(**json.loads(raw))
    except Exception as exc:
        logger.warning("Ignoring malformed engine field (%s)", type(exc).__name__)
        return None
```

Note `_cloud_vision_smiles` uses `_SMILES_TOKEN` and `EngineConfig`, both defined **later** in the file — that is fine because they are resolved at call time, not import time. `_parse_engine_field` likewise.

Now route the existing vision calls through it. Change `_ollama_vision_smiles` and `_ollama_reaction_smiles` to take an optional engine:

```python
def _ollama_vision_smiles(img_bytes: bytes, engine=None) -> str | None:
    """Extract all molecule SMILES from an image, ignoring reaction notation.
    Used by the /analyze pipeline as a DECIMER cross-check."""
    return _vision_smiles_routed(
        img_bytes,
        "You are an expert chemist. The image shows chemical structures, possibly alongside "
        "reaction notation.\n\n"
        "Extract SMILES for every actual chemical molecule present. Ignore:\n"
        "  - Reaction arrows (→, ->, ⟶, curved electron-flow arrows)\n"
        "  - Question marks (?) indicating unknown products\n"
        "  - Plus signs (+) as separators — use a period (.) instead\n"
        "  - Text annotations: 'heat', 'Δ', 'hν', solvent names, temperatures\n\n"
        "Output ONLY the SMILES string. Separate multiple molecules with '.'. "
        "No explanation, no prose, no markdown.",
        engine,
    )
```

Apply the same change to `_ollama_reaction_smiles` — add the `engine=None` parameter and swap `_ollama_call(img_bytes, ...)` for `_vision_smiles_routed(img_bytes, ..., engine)`, leaving its prompt text unchanged.

Thread the engine through `_process` and its callers:

1. `def _process(raw_bytes: bytes, engine=None) -> dict:`
2. Inside, change the submit to:
   `vision_future = _vision_pool.submit(_ollama_vision_smiles, _vision_png(img), engine)`
3. `def _react_from_image(raw_bytes: bytes, engine=None) -> dict:` and pass `engine` to each of the four `_ollama_reaction_smiles(_img_bytes)` call sites → `_ollama_reaction_smiles(_img_bytes, engine)`.

Update both endpoint signatures to accept the optional field:

```python
@app.post("/analyze", dependencies=[Depends(require_auth)])
async def analyze(file: UploadFile = File(...), engine: str | None = Form(default=None)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8 MB).")
    engine_cfg = _parse_engine_field(engine)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _process, contents, engine_cfg)
    ...
```

and

```python
@app.post("/react-from-image", dependencies=[Depends(require_auth)])
async def react_from_image(file: UploadFile = File(...), engine: str | None = Form(default=None)):
    ...
    engine_cfg = _parse_engine_field(engine)
    result = await loop.run_in_executor(_executor, _react_from_image, contents, engine_cfg)
```

Add `Form` to the FastAPI import line:

```python
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Orgo AI" && python test_vision_routing.py`
Expected: PASS — `14 passed, 0 failed`

- [ ] **Step 5: Verify every suite still passes and the app imports**

Run: `cd "C:\Orgo AI" && python -c "import app; print('IMPORT OK')" && python test_osr.py && python test_templates.py && python test_reaction_arbitration.py && python test_assess_endpoint.py`
Expected: `IMPORT OK` then all four suites green

- [ ] **Step 6: Commit**

```bash
cd "C:\Orgo AI"
git add app.py test_vision_routing.py
git commit -m "Route OSR vision reads through the user's chosen engine"
```

---

### Task 5: `/react-from-image` recognition parity

**Files:**
- Modify: `C:\Orgo AI\app.py` (extract shared reader helper from `_process`; use it in `_react_from_image`)

**Interfaces:**
- Consumes: `_decode_upload`, `_normalize_polarity`, `_repair_and_binarize`, `_decimer_read`, `_molscribe_read`, `arbitrate_local`, `resolve_with_vision`, `_vision_png`, `_ollama_vision_smiles` (all existing).
- Produces: `_multi_reader_smiles(img, current, digital, engine) -> tuple[str | None, bool | None, dict]` returning `(smiles, verified, reads)`. Used by `_react_from_image`; `_process` keeps its own deferred-token flow.

- [ ] **Step 1: Write the failing test**

Append to `C:\Orgo AI\test_vision_routing.py`, before the final `print`/`sys.exit`:

```python
# ── multi-reader recognition used by /react-from-image ───────────────────────
import numpy as np  # noqa: E402

blank = np.full((80, 120, 3), 255, dtype=np.uint8)

orig_dec, orig_ms, orig_vis = app._decimer_read, app._molscribe_read, app._ollama_vision_smiles
try:
    # Cross-model agreement → verified without consulting vision at all.
    vision_used = []
    app._decimer_read = lambda arr: "CCO"
    app._molscribe_read = lambda arr: "CCO"
    app._ollama_vision_smiles = lambda b, e=None: vision_used.append(1) or "CCC"
    smiles, verified, reads = app._multi_reader_smiles(blank, blank, True, None)
    check("multi-reader: agreement → smiles", smiles, "CCO")
    check("multi-reader: agreement → verified", verified, True)
    check("multi-reader: agreement → vision unused", vision_used, [])

    # Cross-model conflict → vision arbitrates and its read is recorded.
    app._decimer_read = lambda arr: "CCO"
    app._molscribe_read = lambda arr: "CC=O"
    app._ollama_vision_smiles = lambda b, e=None: "CC=O"
    smiles, verified, reads = app._multi_reader_smiles(blank, blank, True, None)
    check("multi-reader: conflict → vision arbitrates", smiles, "CC=O")
    check("multi-reader: conflict → verified true on vision agreement", verified, True)
    check("multi-reader: vision read recorded", reads["vision"], "CC=O")

    # Every reader fails → no structure, no crash.
    app._decimer_read = lambda arr: None
    app._molscribe_read = lambda arr: None
    app._ollama_vision_smiles = lambda b, e=None: None
    smiles, verified, reads = app._multi_reader_smiles(blank, blank, True, None)
    check("multi-reader: total failure → None", smiles, None)
    check("multi-reader: total failure → unverified", verified, None)
finally:
    app._decimer_read, app._molscribe_read, app._ollama_vision_smiles = orig_dec, orig_ms, orig_vis
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Orgo AI" && python test_vision_routing.py`
Expected: FAIL — `AttributeError: module 'app' has no attribute '_multi_reader_smiles'`

- [ ] **Step 3: Write the implementation**

In `C:\Orgo AI\app.py`, add after `_molscribe_read`:

```python
def _multi_reader_smiles(img: np.ndarray, current: np.ndarray, digital: bool,
                         engine=None) -> tuple[str | None, bool | None, dict]:
    """Read a structure with every available reader and arbitrate.

    Same multi-candidate scheme /analyze uses — DECIMER and MolScribe each read
    the original and the binarized rendition, and the vision model arbitrates
    only when the local readers conflict. Unlike /analyze this blocks on the
    vision read rather than deferring it: /react-from-image has no badge to
    settle later, and its caller needs one settled structure to feed the
    template engine.

    Returns (smiles, verified, reads).
    """
    vision_future = _vision_pool.submit(_ollama_vision_smiles, _vision_png(img), engine)
    ms_orig_future = _molscribe_pool.submit(_molscribe_read, img)
    ms_bin_future = None if digital else _molscribe_pool.submit(_molscribe_read, current)

    orig_read = bin_read = None
    try:
        if digital:
            orig_read = _decimer_read(img)
            if not orig_read:
                bin_read = _decimer_read(current)
        else:
            bin_read = _decimer_read(current)
            orig_read = _decimer_read(img)
    except Exception as exc:
        logger.warning("DECIMER read failed (%s): %s", type(exc).__name__, exc)

    def _collect(future, label):
        if future is None:
            return None
        try:
            return future.result(timeout=60.0)
        except Exception as exc:
            logger.warning("%s read not collected (%s): %s", label, type(exc).__name__, exc)
            return None

    ms_orig = _collect(ms_orig_future, "MolScribe/original")
    ms_bin = _collect(ms_bin_future, "MolScribe/binarized")

    smiles, verified, pending, defer = arbitrate_local(orig_read, bin_read, ms_orig, ms_bin)
    vision_read = None
    if pending or defer:
        # defer would mean "settle in the background" on /analyze; here there is
        # no later round-trip, so collect the verdict now.
        vision_read = _collect(vision_future, "Vision")
        smiles, verified = resolve_with_vision(
            orig_read, bin_read, ms_orig, ms_bin, digital, vision_read)
    else:
        vision_future.cancel()

    reads = {
        "decimer_original": orig_read, "decimer_binarized": bin_read,
        "molscribe": ms_orig, "molscribe_binarized": ms_bin,
        "vision": vision_read, "clean_digital": digital,
    }
    return smiles, verified, reads
```

Then in `_react_from_image`, replace the single-DECIMER recognition block (the section from `# 2. OSR via DECIMER` through the `if not recognized_smiles:` Ollama-fallback pair) with:

```python
    # 2. OSR — multi-reader recognition with arbitration, same as /analyze.
    recognized_smiles, recognition_verified, reads = _multi_reader_smiles(
        img, current, digital, engine)
    logger.info("Recognition: %r (verified=%s)", recognized_smiles, recognition_verified)

    # Encode once for the reaction-specific vision fallbacks below.
    _img_bytes = _vision_png(current)

    if not recognized_smiles:
        logger.info("No reader produced a structure — calling reaction-aware vision parse")
        recognized_smiles = _ollama_reaction_smiles(_img_bytes, engine)
        logger.info("Vision (empty-read fallback) returned: %r", recognized_smiles)
    if not recognized_smiles:
        return {"error": "No structure recognized in the image.", "products": [],
                "recognition_confidence": "unverified"}
```

Add the confidence fields to **every** `return` in `_react_from_image` that carries `recognized_smiles`, using the shared helper:

```python
        "recognition_confidence": _confidence_label(recognition_verified),
        "recognition_verified": recognition_verified,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Orgo AI" && python test_vision_routing.py`
Expected: PASS — `22 passed, 0 failed`

- [ ] **Step 5: Verify every suite and import**

Run: `cd "C:\Orgo AI" && python -c "import app; print('IMPORT OK')" && python test_osr.py && python test_templates.py && python test_reaction_arbitration.py && python test_assess_endpoint.py`
Expected: `IMPORT OK` and all suites green

- [ ] **Step 6: Commit**

```bash
cd "C:\Orgo AI"
git add app.py test_vision_routing.py
git commit -m "Give /react-from-image the same multi-reader verification as /analyze"
```

---

### Task 6: Frontend API client

**Files:**
- Modify: `C:\Orgo AI\frontend\src\api.js`

**Interfaces:**
- Consumes: `POST /react/assess` (Task 3), `engine` form field (Task 4), `getEnginePayload()` (existing).
- Produces: `assessReaction(substrateSMILES, reagentSMILES, engineProducts) -> Promise<{status, agreed_product, ai_products, engine_products, rounds, note}>`.

- [ ] **Step 1: Add the client function and attach engine to uploads**

In `C:\Orgo AI\frontend\src\api.js`, replace the two image-upload functions and add the assess call:

```javascript
export async function analyzeImage(file) {
  const form = new FormData()
  form.append('file', file)
  // Lets the backend arbitrate the OSR read with the user's chosen (often much
  // faster and more accurate) vision model instead of the local VLM.
  form.append('engine', JSON.stringify(getEnginePayload()))
  const res = await fetch(BASE + '/analyze', {
    method: 'POST',
    headers: await authHeaders(),
    body: form,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Analyze failed')
  }
  return res.json()
}
```

```javascript
export async function reactFromImage(file) {
  const form = new FormData()
  form.append('file', file)
  form.append('engine', JSON.stringify(getEnginePayload()))
  const res = await fetch(BASE + '/react-from-image', {
    method: 'POST',
    headers: await authHeaders(),
    body: form,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Prediction failed')
  }
  return res.json()
}
```

Add after `reactDirect`:

```javascript
// Ask the AI to independently assess a reaction the deterministic engine has
// already answered (or failed to answer). Returns a verdict, never a
// replacement result — see docs/superpowers/specs for the no-flip rule.
export async function assessReaction(substrateSMILES, reagentSMILES, engineProducts) {
  return post('/react/assess', {
    substrate_smiles: substrateSMILES,
    reagent_smiles: reagentSMILES,
    engine_products: engineProducts ?? [],
    engine: getEnginePayload(),
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "C:\Orgo AI\frontend" && npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
cd "C:\Orgo AI"
git add frontend/src/api.js
git commit -m "Add assessReaction client and attach engine choice to image uploads"
```

---

### Task 7: Verdict badge component

**Files:**
- Create: `C:\Orgo AI\frontend\src\components\VerdictBadge.jsx`

**Interfaces:**
- Consumes: `StructureView` (existing component), `lucide-react` icons.
- Produces: two default-ish exports used by Tasks 8–10:
  - `VerdictBadge({ verdict, loading })` — the inline chip.
  - `DisputePicker({ verdict, onChoose })` — the pick-one card pair, rendered only for `status === 'disputed'`.
  - `AiOnlyCard({ verdict })` — the flagged AI-only product card for template misses.

- [ ] **Step 1: Create the component**

Create `C:\Orgo AI\frontend\src\components\VerdictBadge.jsx`:

```jsx
import { AlertTriangle, BadgeCheck, Bot, HelpCircle } from 'lucide-react'
import StructureView from './StructureView'

const STYLES = {
  verified:   { bg: 'rgba(63,185,80,0.15)',  fg: 'var(--success)', border: 'rgba(63,185,80,0.35)' },
  disputed:   { bg: 'rgba(210,153,34,0.15)', fg: '#d29922',        border: 'rgba(210,153,34,0.35)' },
  ai_only:    { bg: 'rgba(88,166,255,0.15)', fg: '#58a6ff',        border: 'rgba(88,166,255,0.35)' },
  unverified: { bg: 'var(--card)',           fg: 'var(--muted)',   border: 'var(--border)' },
}

const LABELS = {
  verified:   'AI-verified',
  disputed:   'Check result',
  ai_only:    'AI only — not engine-checked',
  unverified: 'Not verified',
}

const ICONS = {
  verified:   BadgeCheck,
  disputed:   AlertTriangle,
  ai_only:    Bot,
  unverified: HelpCircle,
}

function chipStyle(style) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: style.bg, color: style.fg, border: `1px solid ${style.border}`,
    borderRadius: 20, fontSize: 10, fontWeight: 700, padding: '2px 10px',
    whiteSpace: 'nowrap',
  }
}

/** Inline chip showing the joint AI/deterministic verdict. */
export function VerdictBadge({ verdict, loading }) {
  if (loading) {
    return (
      <span style={chipStyle(STYLES.unverified)} title="The AI is independently predicting this reaction">
        <span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} /> Verifying…
      </span>
    )
  }
  if (!verdict) return null
  const style = STYLES[verdict.status] ?? STYLES.unverified
  const Icon = ICONS[verdict.status] ?? HelpCircle
  return (
    <span style={chipStyle(style)} title={verdict.note || ''}>
      <Icon size={11} /> {LABELS[verdict.status] ?? 'Not verified'}
    </span>
  )
}

/** Shown when the engine and the AI never converged: the user decides. */
export function DisputePicker({ verdict, onChoose }) {
  if (!verdict || verdict.status !== 'disputed') return null
  const engine = verdict.engine_products?.[0]
  const ai = verdict.ai_products?.[0]
  if (!engine || !ai) return null

  const card = (label, smiles, sub, accent) => (
    <div style={{
      flex: 1, minWidth: 200, background: 'var(--card)',
      border: `1px solid ${accent}`, borderRadius: 8, padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: accent }}>{label}</div>
      <div style={{ background: '#fff', borderRadius: 6, padding: 6, display: 'flex', justifyContent: 'center' }}>
        <StructureView smiles={smiles} width={220} height={120} />
      </div>
      <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text)' }}>{smiles}</code>
      <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.5 }}>{sub}</div>
      {onChoose && (
        <button className="export-chip" onClick={() => onChoose(smiles)}>Use this product</button>
      )}
    </div>
  )

  return (
    <div style={{
      border: '1px solid rgba(210,153,34,0.35)', background: 'rgba(210,153,34,0.06)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 12, color: '#d29922', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <AlertTriangle size={14} /> The engine and the AI disagree
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        They were re-asked {verdict.rounds} time{verdict.rounds !== 1 ? 's' : ''} and still
        reached different products. Both are shown — pick the one you judge correct.
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {card('Deterministic engine (SMARTS templates)', engine,
              'Computed by matched reaction templates.', 'var(--success)')}
        {card('AI prediction', ai,
              'Predicted by the AI; no template produced it.', '#58a6ff')}
      </div>
    </div>
  )
}

/** Template miss: the AI answered where the engine could not. */
export function AiOnlyCard({ verdict }) {
  if (!verdict || verdict.status !== 'ai_only' || !verdict.agreed_product) return null
  const smiles = verdict.agreed_product
  return (
    <div style={{
      border: '1px solid rgba(88,166,255,0.35)', background: 'rgba(88,166,255,0.06)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 12, color: '#58a6ff', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Bot size={14} /> AI prediction — not checked by the deterministic engine
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        No reaction template matched this substrate and reagent, so the engine could not
        compute a product. The structure below is the AI&apos;s prediction alone. Treat it as a
        starting point, not a verified result.
      </div>
      <div style={{ background: '#fff', borderRadius: 6, padding: 8, display: 'flex', justifyContent: 'center' }}>
        <StructureView smiles={smiles} width={280} height={150} />
      </div>
      <code style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text)' }}>{smiles}</code>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "C:\Orgo AI\frontend" && npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
cd "C:\Orgo AI"
git add frontend/src/components/VerdictBadge.jsx
git commit -m "Add verdict badge, dispute picker, and AI-only product card"
```

---

### Task 8: Wire the verdict into DirectReact

**Files:**
- Modify: `C:\Orgo AI\frontend\src\components\DirectReact.jsx`

**Interfaces:**
- Consumes: `assessReaction` (Task 6); `VerdictBadge`, `DisputePicker`, `AiOnlyCard` (Task 7).
- Produces: no exports; user-visible behavior only.

- [ ] **Step 1: Add imports**

In `C:\Orgo AI\frontend\src\components\DirectReact.jsx`, update the imports at the top:

```jsx
import { useRef, useState } from 'react'
import MoleculeInput from './MoleculeInput'
import StructureView from './StructureView'
import { AiOnlyCard, DisputePicker, VerdictBadge } from './VerdictBadge'
import { assessReaction, reactDirect } from '../api'
```

- [ ] **Step 2: Add verdict state and fire assess after the engine answers**

Replace the component's state block and `handleRun` with:

```jsx
export default function DirectReact({ initialSubstrate, initialReagent, initialResult, onSave } = {}) {
  const [substrate, setSubstrate] = useState(initialSubstrate ?? '')
  const [reagent,   setReagent]   = useState(initialReagent ?? '')
  const [result,    setResult]    = useState(initialResult ?? null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [verdict,   setVerdict]   = useState(null)
  const [verifying, setVerifying] = useState(false)
  // Bumped per run so a slow verdict from a previous reaction can't land on
  // the current one.
  const assessSeq = useRef(0)

  const canRun = substrate.trim() && reagent.trim() && !loading

  async function handleRun() {
    if (!canRun) return
    setLoading(true)
    setError(null)
    setResult(null)
    setVerdict(null)
    const seq = ++assessSeq.current
    try {
      const data = await reactDirect(substrate.trim(), reagent.trim())
      setResult(data)
      onSave?.({
        reactants: [substrate.trim()],
        reagents: reagent.trim(),
        predictedProducts: data.products?.map(p => p.smiles) ?? [],
        result: data,
      })
      // The engine has answered; now let the AI weigh in alongside it. A
      // template miss still gets assessed — that's the AI-only path.
      setVerifying(true)
      assessReaction(substrate.trim(), reagent.trim(), data.products?.map(p => p.smiles) ?? [])
        .then(v => { if (assessSeq.current === seq) setVerdict(v) })
        .catch(() => { /* verification is best-effort; engine result stands */ })
        .finally(() => { if (assessSeq.current === seq) setVerifying(false) })
    } catch (e) {
      setError(e.message || 'Reaction failed')
    } finally {
      setLoading(false)
    }
  }
```

Update `handleClear` to reset the new state:

```jsx
  function handleClear() {
    assessSeq.current++
    setSubstrate('')
    setReagent('')
    setResult(null)
    setError(null)
    setVerdict(null)
    setVerifying(false)
  }
```

- [ ] **Step 3: Render the badge and the two special cards**

In the results block, add the badge to the divider row — insert immediately after the `{result.environment}` span:

```jsx
            <VerdictBadge verdict={verdict} loading={verifying} />
```

Then, immediately after the closing `</div>` of the products list (still inside the `result && !loading && result.products?.length > 0` block), add:

```jsx
          {verdict?.status === 'disputed' && (
            <div style={{ marginTop: 14 }}>
              <DisputePicker verdict={verdict} />
            </div>
          )}
```

Finally, replace the template-miss handling. The current code sets an error string when `products` is empty; instead render the AI-only card. Delete these lines from `handleRun`:

```jsx
      if (!data.products?.length) {
        setError('No reaction templates matched this substrate/reagent combination.')
      }
```

and add a new block after the results block in the JSX:

```jsx
      {/* Template miss: the engine had nothing, so the AI's answer (clearly
          flagged) is better than an empty screen. */}
      {result && !loading && !result.products?.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 12, color: 'var(--muted)',
          }}>
            No reaction template matched this pair.
            <VerdictBadge verdict={verdict} loading={verifying} />
          </div>
          <AiOnlyCard verdict={verdict} />
        </div>
      )}
```

- [ ] **Step 4: Typecheck**

Run: `cd "C:\Orgo AI\frontend" && npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 5: Commit**

```bash
cd "C:\Orgo AI"
git add frontend/src/components/DirectReact.jsx
git commit -m "Show joint AI/engine verdict in DirectReact"
```

---

### Task 9: Wire the verdict into ReactPredict

**Files:**
- Modify: `C:\Orgo AI\frontend\src\components\ReactPredict.jsx`

**Interfaces:**
- Consumes: `assessReaction` (Task 6); `VerdictBadge`, `DisputePicker`, `AiOnlyCard` (Task 7); `recognition_confidence` from the `/react-from-image` response (Task 5).
- Produces: no exports; user-visible behavior only.

- [ ] **Step 1: Add imports and verdict state**

In `C:\Orgo AI\frontend\src\components\ReactPredict.jsx`, add to the imports:

```jsx
import { AiOnlyCard, DisputePicker, VerdictBadge } from './VerdictBadge'
import { assessReaction, reactFromImage } from '../api'
```

(replacing the existing `import { reactFromImage } from '../api'`), and ensure `useRef` is imported from `react` alongside `useState`.

Inside the component, next to the existing `result` state, add:

```jsx
  const [verdict,   setVerdict]   = useState(null)
  const [verifying, setVerifying] = useState(false)
  const assessSeq = useRef(0)
```

- [ ] **Step 2: Fire assess after recognition succeeds**

In the handler that calls `reactFromImage` (around line 132), after `setResult(data)` and the existing `onSave` call, add:

```jsx
      // Recognition and the template engine have both run; ask the AI to
      // assess the same reaction independently.
      if (data.substrate_smiles && data.reagent_smiles) {
        const seq = ++assessSeq.current
        setVerifying(true)
        assessReaction(data.substrate_smiles, data.reagent_smiles,
                       data.products?.map(p => p.smiles) ?? [])
          .then(v => { if (assessSeq.current === seq) setVerdict(v) })
          .catch(() => { /* best-effort */ })
          .finally(() => { if (assessSeq.current === seq) setVerifying(false) })
      }
```

Also reset the verdict wherever the component clears `result` (the start of the upload handler): add `setVerdict(null)` next to the existing `setResult(null)`.

- [ ] **Step 3: Render recognition confidence and the verdict**

Next to the `result.recognized_smiles` display (around line 312), add a recognition chip immediately after the `<CopyButton text={result.recognized_smiles} />`:

```jsx
                {result.recognition_confidence && (
                  <span
                    title="How the structure readers agreed on this SMILES"
                    style={{
                      fontSize: 10, fontWeight: 700, borderRadius: 20, padding: '2px 10px',
                      color: result.recognition_confidence === 'high' ? 'var(--success)' : 'var(--muted)',
                      border: '1px solid var(--border)', whiteSpace: 'nowrap',
                    }}
                  >
                    {result.recognition_confidence === 'high' ? 'Readers agree'
                      : result.recognition_confidence === 'low' ? 'Readers disagree — check structure'
                      : 'Unverified read'}
                  </span>
                )}
```

In the products header row (around line 357), add the badge after the product count text:

```jsx
                <VerdictBadge verdict={verdict} loading={verifying} />
```

After the products list block, add:

```jsx
              {verdict?.status === 'disputed' && (
                <div style={{ marginTop: 14 }}><DisputePicker verdict={verdict} /></div>
              )}
```

And in the empty-products branch (around line 368), add the AI-only card after the existing message:

```jsx
              <AiOnlyCard verdict={verdict} />
```

- [ ] **Step 4: Typecheck**

Run: `cd "C:\Orgo AI\frontend" && npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 5: Commit**

```bash
cd "C:\Orgo AI"
git add frontend/src/components/ReactPredict.jsx
git commit -m "Show recognition confidence and joint verdict in ReactPredict"
```

---

### Task 10: Verify a pathway branch on selection

**Files:**
- Modify: `C:\Orgo AI\frontend\src\components\InfoPanel.jsx` (`BranchInfoView`, lines 141–232)

**Interfaces:**
- Consumes: `assessReaction` (Task 6); `VerdictBadge`, `DisputePicker` (Task 7).
- Produces: no exports; user-visible behavior only.

- [ ] **Step 1: Add imports**

In `C:\Orgo AI\frontend\src\components\InfoPanel.jsx`, add to the existing api import:

```jsx
import { assessReaction, streamExplanation, streamNodeExplanation, streamStereo } from '../api'
```

and add the badge import:

```jsx
import { DisputePicker, VerdictBadge } from './VerdictBadge'
```

- [ ] **Step 2: Assess the selected branch**

Inside `BranchInfoView`, add state next to the existing `explanation`/`stereo` state:

```jsx
  const [verdict, setVerdict] = useState(null)
  const [verifying, setVerifying] = useState(false)
```

Then add a second effect after the existing explanation effect (keyed the same way, so switching branches re-runs it):

```jsx
  // One assess call per branch the user actually opens — verifying every
  // branch in a pathway search would mean dozens of LLM calls per search.
  useEffect(() => {
    if (!branch?.product_smiles) return
    const substrate = branch.steps?.[0]?.smiles ?? substrateSMILES
    const reagentSmiles = branch.reagent?.smiles
    if (!substrate || !reagentSmiles) return
    let stale = false
    setVerdict(null)
    setVerifying(true)
    assessReaction(substrate, reagentSmiles, [branch.product_smiles])
      .then(v => { if (!stale) setVerdict(v) })
      .catch(() => { /* best-effort; the engine result stands */ })
      .finally(() => { if (!stale) setVerifying(false) })
    return () => { stale = true }
  }, [branch?.id, branch?.product_smiles, substrateSMILES])
```

- [ ] **Step 3: Render the badge and dispute picker**

In the "Reaction" header block, put the badge beside the reaction name — replace:

```jsx
        <div className="rxn-name-badge">
          <span className={`confidence-dot ${CONF_CLASS[cls.confidence] ?? 'conf-unknown'}`} />
          {cls.name}
        </div>
```

with:

```jsx
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="rxn-name-badge">
            <span className={`confidence-dot ${CONF_CLASS[cls.confidence] ?? 'conf-unknown'}`} />
            {cls.name}
          </div>
          <VerdictBadge verdict={verdict} loading={verifying} />
        </div>
```

Then, immediately after the "Product" block's closing `</div>`, add:

```jsx
      {verdict?.status === 'disputed' && <DisputePicker verdict={verdict} />}
```

- [ ] **Step 4: Typecheck**

Run: `cd "C:\Orgo AI\frontend" && npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 5: Full backend suite re-run**

Run: `cd "C:\Orgo AI" && python test_reaction_arbitration.py && python test_assess_endpoint.py && python test_vision_routing.py && python test_osr.py && python test_templates.py`
Expected: all five suites green

- [ ] **Step 6: Commit**

```bash
cd "C:\Orgo AI"
git add frontend/src/components/InfoPanel.jsx
git commit -m "Verify a pathway branch with the AI when the user selects it"
```

---

### Task 11: Runtime verification and documentation

**Files:**
- Modify: `C:\Orgo AI\README.md`
- Modify: `C:\Users\m_blo\.claude\projects\C--Orgo-AI\memory\project_architecture.md`

- [ ] **Step 1: Launch the app and exercise the flows**

Use the project's `verify` skill (`.claude/skills/verify/SKILL.md`) to start backend + frontend. Then check, in the browser:

1. **Direct Reaction, template hit** — substrate `CC(=O)CCBr`, reagent `CC(C)[N-]C(C)C.[Li+]`. Products appear immediately; a "Verifying…" chip appears and settles.
2. **Direct Reaction, template miss** — substrate `c1ccccc1`, reagent `CC(=O)Cl`. Instead of only an error, the AI-only card appears with its "not checked by the deterministic engine" flag (assuming a reachable engine).
3. **Image upload** — upload a structure image on the Substrate input. Confirm the badge settles and, with a hosted/BYOK engine selected, that the backend log shows `Cloud vision (…) raw response` rather than a minute-long local read.
4. **Pathway branch** — run a pathway search, click a branch, confirm the verdict chip appears in the info panel.
5. **Engine off** — set Settings → Engine to Local with Ollama stopped; confirm reactions still work and the badge reads "Not verified" with no crash.

- [ ] **Step 2: Document the endpoint in the README**

In `C:\Orgo AI\README.md`, find the endpoint list and add a line for the new endpoint alongside `/react`:

```markdown
- `POST /react/assess` — joint AI + deterministic verdict for one reaction (`verified` / `disputed` / `ai_only` / `unverified`); stateless, engine-routed, hosted-quota metered
```

- [ ] **Step 3: Update the project memory file**

In `C:\Users\m_blo\.claude\projects\C--Orgo-AI\memory\project_architecture.md`, append a new dated paragraph before the closing `**Why:**` block:

```markdown
**July 31 2026 AI/deterministic agreement pass:** `reaction_arbitration.py` (pure, stdlib-only; `test_reaction_arbitration.py` is its suite) owns the verdict table — `verified` / `disputed` / `ai_only` / `unverified`. `POST /react/assess` (stateless, HEAVY rate tier, hosted-quota metered) runs a **blind** round-1 AI prediction (the model never sees the engine's answer — prevents rubber-stamping), then up to 2 reconciliation rounds over an unlabeled shuffled candidate pool; 3 LLM calls max. `_llm_complete()` drains `_select_stream()` so provider routing/BYOK is reused, never duplicated. The AI can never overwrite an engine result (no-flip rule holds, same as OSR). OSR vision reads now route through `_vision_smiles_routed()`: cloud multimodal (Claude/GPT-4o via the user's engine choice) → local Ollama VLM → None, which is the fix for the ~58 s local vision bottleneck; `/analyze` and `/react-from-image` take an optional `engine` multipart field. `/react-from-image` gained `_multi_reader_smiles()` (shared DECIMER+MolScribe+vision arbitration) and returns `recognition_confidence`. Frontend: `assessReaction()` in api.js, `VerdictBadge.jsx` (badge + `DisputePicker` + `AiOnlyCard`), wired into DirectReact, ReactPredict, and InfoPanel's `BranchInfoView` (one assess per opened branch, not per search).
```

- [ ] **Step 4: Commit**

```bash
cd "C:\Orgo AI"
git add README.md
git commit -m "Document /react/assess endpoint"
```

---

## Self-Review Notes

Checked against the spec:

- Spec §1 (arbitration module) → Task 1. Spec §2 (reconciliation loop) → Task 3. Spec §3 (endpoint, `_llm_complete`) → Tasks 2–3. Spec §4 (engine-aware vision) → Task 4. Spec §5 (`/react-from-image` parity) → Task 5. Spec §6 (frontend) → Tasks 6–10. Spec §7 (failure posture) → covered by the `unverified` paths tested in Tasks 1/3 and the local-engine check in Task 11. Spec §8 (testing) → Tasks 1–5 each ship their suite.
- Names are consistent across tasks: `_llm_complete`, `_parse_smiles_list`, `_vision_smiles_routed`, `_cloud_vision_smiles`, `_parse_engine_field`, `_multi_reader_smiles`, `assessReaction`, `VerdictBadge` / `DisputePicker` / `AiOnlyCard`.
- `_confidence_label` (added in the pre-existing audit commit) is reused in Task 5 rather than redefined.
