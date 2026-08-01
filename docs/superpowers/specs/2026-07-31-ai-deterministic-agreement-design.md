# AI ↔ Deterministic Agreement System — Design

**Date:** 2026-07-31
**Status:** Approved by Mike (pending spec review)

## Goal

Every chemistry answer Orgo AI produces is the product of the deterministic
engine and the generative AI **working in unison**: the deterministic system
(template engine, DECIMER/MolScribe, RDKit) always runs, the AI always
assesses or contributes alongside it, and the user always sees a joint
verdict. Concretely:

1. **AI verification of deterministic results** — when the template engine
   produces products, the AI independently predicts in parallel; agreement
   earns a "verified" badge.
2. **AI fallback on template miss** — when the reagent/reaction is outside
   the template library, the AI predicts the product, clearly flagged as
   *not checked by the deterministic engine*.
3. **Image → SMILES (OSR) upgraded** — the vision arbiter in the OSR
   pipeline routes through the user's chosen engine (Claude / GPT-4o
   multimodal) instead of only the slow local VLM, and `/react-from-image`
   gains the same multi-reader verification `/analyze` already has. This is
   the current accuracy/latency bottleneck.

### Non-negotiable invariants (carried over from the OSR passes)

- **No-flip rule:** the AI can never overwrite or replace a deterministic
  result. It can only add a verdict, or supply a result where the engine had
  none (flagged).
- **VLM/LLM-as-judge is banned:** verification is *independent prediction +
  canonical-SMILES agreement*, never "do these two answers match?" prompts.
- **Canonical comparison only:** all agreement checks compare RDKit
  canonical SMILES strings.
- **Graceful degradation:** any AI failure (no key, provider down, garbage
  output) degrades to today's deterministic-only behavior with an
  `unverified` badge. The AI loop can slow a badge, never a result.
- **Engine choice respected:** all generative calls route through the
  existing engine picker (local / BYOK / hosted) and are metered under the
  hosted quota exactly like `/explain`.

## Decisions made during brainstorming

| Question | Decision |
| --- | --- |
| Scope | All three: fallback on miss, verification of hits, `/react-from-image` read verification |
| Which AI | User's chosen engine (local/BYOK/hosted), hosted-quota metered |
| Disagreement | Reconcile for 2–3 rounds; if still divergent, show both candidates and let the user pick |
| Latency | Deferred, like `/analyze`: instant deterministic result + "verifying…" badge that settles |
| `/pathways` | Verify on branch selection only (one LLM call per branch the user inspects) |
| Architecture | Approach A: stateless `POST /react/assess` second call + pure `reaction_arbitration.py` module |

## Architecture

```
                    ┌────────────────────────┐
 substrate+reagent →│ TemplateEngine (RDKit) │→ products (instant, shown immediately)
                    └────────────────────────┘
                                │ frontend then calls
                                ▼
                    ┌────────────────────────┐     ┌──────────────────────┐
                    │  POST /react/assess     │────→│ _llm_complete()      │
                    │  (stateless, quota-     │     │ engine router reuse: │
                    │   metered, HEAVY tier)  │     │ Ollama/Anthropic/    │
                    └────────────────────────┘     │ OpenAI               │
                                │                   └──────────────────────┘
                                ▼
                    ┌────────────────────────┐
                    │ reaction_arbitration.py │→ verdict: verified | disputed |
                    │ (pure, no deps)         │           ai_only | unverified
                    └────────────────────────┘
```

### 1. `reaction_arbitration.py` (new, pure module)

Mirrors `osr_arbitration.py`: no RDKit, no network, no app imports. Inputs
are pre-canonicalized SMILES strings; string equality IS structural
identity. Unit-testable in milliseconds.

Responsibilities:

- `agreement(engine_products, ai_products) -> str | None` — returns the
  agreed canonical product when any AI prediction matches any engine branch
  product, else `None`.
- `verdict(...)` — the decision table producing one of:
  - `verified` — AI prediction matches an engine product (any round).
  - `disputed` — no agreement after all reconciliation rounds; both
    candidate sets returned for the pick-one UI.
  - `ai_only` — engine had no products; AI produced a valid prediction.
    Flagged "not checked by deterministic engine".
  - `unverified` — AI unavailable, failed, or produced only
    invalid/degenerate output. Deterministic result stands.
- Reuses/extends the degenerate-read gate (`looks_degenerate`-style) for AI
  product predictions.

### 2. Reconciliation loop (max 3 LLM calls)

- **Round 1 — blind.** The AI receives substrate + reagent (+ conditions)
  only. It never sees the engine's answer. This prevents sycophantic
  agreement from inflating the verified badge.
- **Rounds 2–3 — neutral candidate review.** Only if round 1 disagrees.
  All candidate products (engine's + AI's) are presented as an *unlabeled,
  shuffled* list: "Which of these is the major product of this reaction, or
  is none correct?" The prompt never reveals which candidate came from
  which source.
  - AI selects an engine product → `verified` (response records `rounds`).
  - AI holds its own candidate through round 3 → `disputed`.
- All AI outputs pass RDKit validation + canonicalization + degeneracy
  gating in `app.py` before entering arbitration.

### 3. `POST /react/assess` (new endpoint)

Request:

```json
{
  "substrate_smiles": "...",
  "reagent_smiles": "...",
  "engine_products": ["..."],      // canonical; empty = template-miss mode
  "engine": { EngineConfig }        // optional, same shape as /explain
}
```

Response:

```json
{
  "status": "verified | disputed | ai_only | unverified",
  "agreed_product": "... | null",
  "ai_products": ["..."],
  "engine_products": ["..."],
  "rounds": 1,
  "note": "human-readable explanation for the badge/tooltip"
}
```

- Auth via `require_auth`; added to `RATE_LIMIT_HEAVY`;
  `_enforce_hosted_quota` applies (each assess = 1 quota unit regardless of
  internal rounds).
- Serves all three surfaces: after `/react`, on pathway-branch selection,
  after `/react-from-image`. Stateless → survives reloads, no server-side
  session state, BYOK key stays request-scoped.
- New helper `_llm_complete(system, messages, max_tokens, engine) -> str`:
  drains the existing `_select_stream()` generator internally, so provider
  routing, BYOK handling, and hosted fallbacks are reused, not duplicated.
- Prompt requests strict SMILES-only output; response parsing reuses the
  token-extraction fallback pattern from `_ollama_call`.

### 4. Engine-aware vision reads (OSR bottleneck fix)

New router `_vision_smiles_routed(png_bytes, prompt, engine)`:

1. Hosted/BYOK **Anthropic** (multimodal Claude) or **OpenAI** (GPT-4o)
   when the engine config + keys allow — base64 image message, non-stream,
   temperature-equivalent determinism, SMILES-only prompt (reuses the
   existing `_ollama_vision_smiles` / `_ollama_reaction_smiles` prompt
   text).
2. Local Ollama vision model (existing `_ollama_call` path).
3. `None` — existing graceful degradation.

Integration:

- `/analyze` and `/react-from-image` accept an **optional `engine`
  multipart form field** (JSON, same EngineConfig shape). Frontend attaches
  `getEnginePayload()`.
- The vision read submitted by `_process` and the deferred-verify path use
  the routed call. Hosted vision reads are quota-metered.
- Expected effect: vision verdicts in seconds instead of ~58 s locally, so
  deferred badges settle fast and vision-blocked arbitration stops
  dominating latency. Accuracy of the arbiter rises (cloud multimodal ≫
  qwen2.5vl:7b on structure reading).
- Unchanged: independent-reader agreement, canonicalization, no-flip,
  degeneracy gates, `VISION_MAX_DIM` downscale, timeouts.

### 5. `/react-from-image` recognition parity

- Extract the multi-candidate read machinery from `_process` (DECIMER ×
  {original, binarized}, MolScribe × {original, binarized},
  `arbitrate_local`, vision arbitration) into a shared helper used by both
  `/analyze` and `/react-from-image`.
- `/react-from-image` response gains `recognition_confidence`
  (`high | low | unverified`) and `recognition_verified` so the UI can show
  the badge for the recognition step, then a separate assess verdict for
  the reaction step.

### 6. Frontend

- `api.js`: new `assessReaction(substrate, reagent, engineProducts)`;
  attach engine payload (FormData field) to `/analyze` and
  `/react-from-image` uploads.
- **DirectReact / ReactPredict:** render engine products instantly with a
  "verifying…" chip → settles to *AI-verified* (`verified`), *check result*
  (`disputed` collapsed summary) or stays *unverified*. `disputed` renders
  a pick-one card pair (engine product vs AI product, structures side by
  side); choosing the AI candidate marks the result "AI product — not
  template-verified".
- **Template miss:** instead of "no matching templates", show the `ai_only`
  card: product + "AI prediction — not checked by deterministic engine"
  flag.
- **PathwayExplorer / InfoPanel:** selecting a branch fires assess for that
  branch only; verdict chip on the branch detail panel.
- **MoleculeInput:** no structural change; benefits automatically from
  faster/better vision verdicts.
- Persisted results store the verdict so reopening a file doesn't re-spend
  quota (re-assess only on explicit user action).

### 7. Failure posture

| Failure | Behavior |
| --- | --- |
| No engine config / no keys / provider down | `unverified`; deterministic result untouched |
| AI returns invalid or degenerate SMILES every round | `unverified` |
| Hosted quota exhausted | 429 from assess; frontend shows quiet "verification unavailable" state |
| Vision provider fails | falls down the ladder (cloud → local → none), existing OSR degradation |
| Local mode with tiny text model | predictions usually fail validation → honest `unverified` |

### 8. Testing

- `test_reaction_arbitration.py` — plain-python suite (pattern:
  `test_osr.py`): agreement on round 1, convergence at rounds 2/3, dispute,
  degenerate AI output discarded, empty-engine (`ai_only`) mode, AI-failure
  → `unverified`.
- Template regression suite (`test_templates.py`) and OSR suites must stay
  green — this feature adds layers, it must not alter deterministic
  outputs.
- Prompt-parsing unit tests with canned LLM responses (valid SMILES, prose
  + SMILES, garbage).

## Out of scope (explicitly)

- Verifying every `/pathways` branch automatically.
- Fine-tuned/self-hosted chemistry models.
- Changing the deterministic engine's outputs based on AI feedback
  (template curation stays a human job; `disputed` results are the signal
  for it).
