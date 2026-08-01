# Orgo AI — Context Snapshot, July 31 2026

Handoff document for the **AI ↔ Deterministic Agreement** feature. Written at the
point where 10 of 11 planned tasks are complete and merged to `main`, with two
known defects still open in Task 5.

---

## 1. What this feature does

Every chemistry answer Orgo AI produces is now the joint product of the
deterministic engine and the generative AI, rather than the engine alone.

| Situation | Before | Now |
| --- | --- | --- |
| Template engine produces a product | Shown, unverified | AI independently predicts the same reaction; agreement earns an **AI-verified** badge |
| Engine and AI disagree | n/a | Up to 2 reconciliation rounds; if still divergent, both candidates shown side by side for the user to choose |
| No template matches (unknown reagent) | "No reaction templates matched" — a dead end | AI predicts the product, clearly flagged **"AI only — not checked by the deterministic engine"** |
| Image → SMILES (OSR) | Local Ollama VLM only (~58 s/read on this machine, misread a test ketone by one carbon) | Routes through the user's chosen engine: cloud multimodal (Claude / GPT-4o) → local Ollama → none |
| `/react-from-image` recognition | Single DECIMER read | Same multi-reader arbitration `/analyze` uses (DECIMER ×2 renditions + MolScribe ×2 + vision tiebreak), returns `recognition_confidence` |

### Non-negotiable invariants (enforced in code and asserted in tests)

1. **No-flip rule.** The AI can never overwrite or replace a deterministic
   result. It adds a verdict, or supplies a result where the engine had none
   (flagged). This mirrors the existing OSR rule that a dissenting vision read
   downgrades the badge but never changes the displayed structure.
2. **LLM/VLM-as-judge is banned.** Verification is *independent prediction plus
   exact canonical-SMILES agreement*, never "do these two answers match?".
   Round 1 is **blind** — the model never sees the engine's answer, because a
   model shown the answer rubber-stamps it and the badge becomes meaningless.
3. **Canonical comparison only.** All agreement checks compare RDKit canonical
   SMILES strings, so string equality *is* structural identity.
4. **Graceful degradation.** Any AI failure (no key, provider down, garbage
   output) yields `unverified` and leaves the deterministic result untouched.
   The loop can delay a badge; it can never delay or alter a result.
5. **Engine choice respected.** Every generative call routes through the
   existing engine picker (local / BYOK / hosted) and is metered by
   `_enforce_hosted_quota`, exactly like `/explain`.

---

## 2. Architecture

```
 substrate + reagent
        │
        ▼
 ┌──────────────────────┐
 │ TemplateEngine       │  RDKit SMARTS, deterministic
 │ (reactivity_engine)  │  → products render IMMEDIATELY
 └──────────┬───────────┘
            │  frontend then fires, additively
            ▼
 ┌──────────────────────┐      ┌────────────────────────┐
 │ POST /react/assess    │─────▶│ _llm_complete()        │
 │ stateless, quota-     │      │ drains _select_stream: │
 │ metered, HEAVY tier   │      │ Ollama / Anthropic /   │
 └──────────┬───────────┘      │ OpenAI (single router) │
            │                   └────────────────────────┘
            ▼
 ┌──────────────────────────────────────────┐
 │ reaction_arbitration.py (pure, stdlib)   │
 │ → verified | disputed | ai_only |        │
 │   unverified                             │
 └──────────────────────────────────────────┘
```

**The assess loop** (max 3 LLM calls, hard cap):

- **Round 1 — blind.** Model gets substrate + reagent only.
- **Rounds 2–3 — neutral reconciliation.** All candidates (engine's + AI's) are
  presented as an *unlabeled, shuffled* list via `candidate_pool(seed=rounds)`.
  The prompt never reveals which side proposed what.
- Convergence on an engine product → `verified` (with `rounds` recorded).
  Still divergent after round 3 → `disputed`, both candidate sets returned.

`/react/assess` is **stateless** by design: the client passes the engine's
products in, so one endpoint serves `/react`, a selected pathway branch, and
`/react-from-image` — and a page reload can re-ask without server state.

---

## 3. Files

### New

| File | Purpose |
| --- | --- |
| `reaction_arbitration.py` | Pure verdict logic — no RDKit, no network, no `app` import. Stdlib only, imports in ~20 ms. |
| `test_reaction_arbitration.py` | Verdict table + SMILES-parsing suite (35 checks) |
| `test_assess_endpoint.py` | Endpoint loop control flow with a scripted fake LLM (25 checks) |
| `test_vision_routing.py` | Provider-ladder selection + multi-reader recognition (22 checks) |
| `frontend/src/components/VerdictBadge.jsx` | `VerdictBadge`, `DisputePicker`, `AiOnlyCard` (all **named** exports) |

### Modified

| File | Change |
| --- | --- |
| `app.py` | `_llm_complete`, `_parse_smiles_list`, `POST /react/assess`, `_cloud_vision_smiles`, `_vision_smiles_routed`, `_parse_engine_field`, `_multi_reader_smiles`; `engine` multipart field on both image endpoints |
| `frontend/src/api.js` | `assessReaction()`; engine payload attached to image uploads |
| `frontend/src/components/DirectReact.jsx` | Verdict badge, dispute picker, AI-only card on template miss |
| `frontend/src/components/ReactPredict.jsx` | Recognition-confidence chip + verdict |
| `frontend/src/components/InfoPanel.jsx` | One assess per opened pathway branch |

### Contracts

`POST /react/assess`

```jsonc
// request
{ "substrate_smiles": "...", "reagent_smiles": "...",
  "engine_products": ["..."],        // empty = template-miss mode
  "engine": { /* EngineConfig, optional */ } }

// response
{ "status": "verified|disputed|ai_only|unverified",
  "agreed_product": "... | null",
  "ai_products": ["..."], "engine_products": ["..."],
  "rounds": 1, "note": "human-readable explanation" }
```

`/react-from-image` gained `recognition_confidence` (`high|low|unverified`) and
`recognition_verified` (bool | null).

---

## 4. Verified state (run 2026-07-31, immediately before this commit)

```
test_templates              27 passed, 0 failed
test_osr                    45 passed, 0 failed
test_reaction_arbitration   35 passed, 0 failed
test_assess_endpoint        25 passed, 0 failed
test_vision_routing         22 passed, 0 failed
npx tsc --noEmit            clean (no output)
```

Tests are **plain-python scripts, not pytest** — run them directly
(`python test_osr.py`). Under Git-Bash set `PYTHONUTF8=1`, or the `→` characters
in check names crash on cp1252. PowerShell defaults to UTF-8 and runs clean.

---

## 5. ⚠️ Open defects — Task 5 is NOT closed

Task 5 (`7f81408`, `/react-from-image` multi-reader recognition) is merged and
its tests pass, but its review returned two findings that were **never fixed**:

### Critical — vision timeout is wrong by 2×

`_multi_reader_smiles`'s `_collect` waits on the **vision** future with a
hardcoded `timeout=60.0`, copied from `_process`'s MolScribe guard (that 60 s
exists to catch a wedged torch call, not to bound a vision read). Every other
vision wait in the app uses `VISION_TIMEOUT` (120 s default) plus a margin —
`/analyze` uses `+10`, `/analyze/verify` uses `+30`.

**Effect:** a vision read that would have succeeded at 90 s is truncated at 60 s
and silently becomes `vision_read=None`, needlessly degrading
`recognition_confidence`. In the total-failure case it then triggers a second
full blocking `_ollama_reaction_smiles` call on the same thread.

**Fix:** use `VISION_TIMEOUT` + margin instead of the literal `60.0`. One line.

### Important — blocks the single OSR worker

The `vision_future.result()` wait happens *inside* `_react_from_image`, which
runs entirely on the single-worker `_executor` (`run_in_executor(_executor,
_react_from_image, ...)`). `_process` carries an explicit comment warning that
parking that worker on a minutes-long HTTP call "would freeze every other
`/analyze` and `/react-from-image` request" — which is exactly what now happens
whenever the local readers disagree, and that is not a rare case.

Blocking itself is correct for this endpoint (unlike `/analyze` it has no second
round-trip to defer into), but it should happen **off** the executor thread —
release the executor and await the future at the async endpoint layer, the way
`/analyze` does.

**Deliberate tradeoff, not a bug:** on instant cross-model agreement the vision
future is cancelled and never awaited, so the common path is unaffected.

### Task 11 was never run

No runtime verification against the live app, and these are still un-updated:

- `README.md` — no entry for `POST /react/assess`
- Project memory (`project_architecture.md`) — no July 31 paragraph
- `frontend/lib/engine.ts` header comment still claims "structure recognition and
  the reaction engine always run free & keyless", which the engine payload on
  image uploads made stale

---

## 6. Deferred items (recorded, none blocking)

| Item | Note |
| --- | --- |
| `DirectReact`'s `reactDirect` await is not sequence-guarded | **Pre-existing**, not introduced here. A late run-1 response can `setResult` over run 2. |
| `verdict()` takes an unused `rounds_used` parameter | Dead parameter; the caller owns round-exhaustion logic |
| 3-char all-letter SMILES scraped from *prose* are dropped | e.g. "The product is CCO here." → `unverified` rather than a wrong answer. Cannot fix by lowering the length threshold: uppercase English words `CON`/`SON`/`ION` are themselves valid SMILES chains. Whole-line replies (the common case) are unaffected. |
| Quota charged before input validation | Malformed SMILES burns hosted quota with zero LLM calls |
| `_multi_reader_smiles` duplicates ~35 lines of `_process` | Extraction was deliberately scoped out to keep `_process`'s deferred-token flow untouched |
| `VerdictBadge` note only exposed via hover `title` | Not screen-reader-robust; consistent with existing house style |

---

## 7. Process notes

Built with superpowers subagent-driven development: brainstorm → spec → plan →
per-task implementer + reviewer, fix loops on every Critical/Important finding.

- Spec: `docs/superpowers/specs/2026-07-31-ai-deterministic-agreement-design.md`
- Plan: `docs/superpowers/plans/2026-07-31-ai-deterministic-agreement.md`
- Ledger: `.superpowers/sdd/2026-07-31-ai-deterministic-agreement/progress.md`
  (git-ignored; names every commit, review verdict, fix round, and adjudication)

Tasks 3/6/7 ran as one parallel wave and 8/9/10 as another, on disjoint files,
committing with `git commit <paths> -m` (pathspec form) so concurrent agents
could not sweep each other's work into mislabeled commits.

**Defects the reviews caught that the plan itself introduced** — worth knowing,
because they were my errors, not the implementers':

- Unquoted `Optional[EngineConfig]` forward reference that would `NameError` at
  import
- A racy test asserting a fake vision function "never ran", when the
  implementation deliberately submits that future early for latency overlap
- Guard-before-reset ordering that let one pathway branch display a previous
  branch's verdict
- A `assessSeq` guard that only invalidated when a *new* call fired, so a
  partially-recognized second upload could inherit the first upload's verdict

One reviewer recommendation was **rejected on adjudication**: swapping the
token-fallback length heuristic for a "structural character" test. Its premise
was factually wrong — `_SMILES_STRUCTURAL_CHAR` is `[0-9\[\]=#()]`, and `CCO`
contains none of them, so the proposed alternative would have rejected `CCO`
too, not preserved it. The delivered gate is an **OR** (structural char *or*
length ≥ 4), i.e. strictly more permissive than what was proposed.

---

## 8. Resuming

1. Fix the Task 5 `VISION_TIMEOUT` mismatch (one line, clear correct value).
2. Decide on the executor-blocking issue — real, but arguably acceptable while
   `/react-from-image` traffic is low.
3. Run Task 11: launch the app, exercise the five flows in the plan's Task 11
   step 1, then update `README.md` and project memory.
4. Consider the final whole-branch review across all 11 tasks, which the process
   would normally run and which has not happened.

The ledger names every commit, so `git log` plus that file is enough to pick this
up cold.
