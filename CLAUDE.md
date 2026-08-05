# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Orgo AI is a chemical pathway explorer: it recognizes organic structures from images
(OSR), predicts reaction products with **ASKCOS** (named by a deterministic RDKit
template engine, which also computes the branching synthesis pathways), and uses an LLM
only to *explain* that output. Two processes:

```
Next.js web app (:3000)  ──proxy──►  FastAPI backend (:8000)
  single-page workspace                chemistry API + OSR + LLM streaming
```

Next.js proxies a fixed allowlist of API paths to FastAPI via `rewrites()` in
`frontend/next.config.mjs`. If you add a backend route the frontend must call
directly, add it to `apiPaths` there too.

## Commands

Dev (Windows launcher starts both servers; frontend hot-reloads):
```
start.bat
```

Run the two processes manually (any OS):
```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload   # backend
cd frontend && npm install && npm run dev             # frontend (:3000)
```

Production: `start-prod.bat` — sets `ORGO_ENV=prod`, builds the frontend
(`npm run build` + `npm start`), binds the backend to loopback. See "Production &
auth" below. **Run exactly one uvicorn worker** — rate-limit buckets, hosted-mode
quota counters, deferred-verify tokens, and the loaded OSR models all live in
process memory.

Tests (Python, no framework — plain scripts):
```bash
python test_templates.py       # template regression suite — run before ANY change to
                               # reaction_templates.json, reagents.py, or reactivity_engine.py
python test_askcos.py          # ASKCOS client suite — run before ANY change to askcos_client.py.
                               # Offline by default (httpx.MockTransport); set ASKCOS_BASE_URL
                               # to also run one live call against the real instance.
python test_prediction.py      # ASKCOS-vs-templates decision suite — run before ANY change to
                               # prediction.py. Imports nothing heavy; runs in under a second.
python diagnose_templates.py   # firing matrix + dead-template report against the real engine
python test_osr.py             # OSR / arbitration tests
```
There is no pytest, no lint config, and no frontend test suite. To run a single
check, edit/call the relevant function inside these scripts directly.

## Architecture — the core invariant

**The LLM never does chemistry.** This boundary is the whole design and must be
preserved. Two non-LLM engines sit behind it, with a clear division of labor:

- **ASKCOS predicts products** for `/react`, `/react-from-image`, and the chat
  `run_reaction` tool. `askcos_client.py` posts to a forward predictor
  (`POST /api/forward/controller/call-sync`) and gets back ranked product SMILES with
  probabilities. It is a neural model, not a template match — but it is not an LLM, and
  it never names anything.
- **`reaction_templates.json` is still the only place reaction NAMES live** — SMARTS +
  human name. `reactivity_engine.py` (`TemplateEngine`) fires those templates via RDKit
  on every `/react` call and serves four jobs: it names any ASKCOS product it can
  independently reproduce, it **overrules ASKCOS where the two disagree**, it is the
  fallback when ASKCOS is unreachable, and a product it cannot name is a precise
  template-library gap (logged as `react_unnamed`). A product ASKCOS predicts that no
  template reproduces is reported as `"Predicted (unnamed)"` — never guessed at.
- **The disagreement guard** (`prediction.resolve_products`) is load-bearing, not a
  hedge. Measured against the live MIT instance: ASKCOS ranks a dibromo*alkene* first
  for cyclohexene + Br₂ (correct product is its rank 3) and sulfuryl chloride first for
  ethanol + SOCl₂ — both reactions the template library already gets right. So when a
  template fires and ASKCOS's **top** pick isn't among its products, the template wins.
  ASKCOS earns its place on coverage (it gets Grignards, which no template covers), not
  on beating a curated rule inside that rule's own domain. Do not "simplify" this away.
- **Low-confidence escalation**: when *no* template corroborates ASKCOS **and** its top
  probability is under `ASKCOS_TRUST_PROBABILITY` (default 0.5), nothing deterministic
  is standing behind the answer, so `/react` also asks Claude via the existing
  `_maybe_blind_guess` channel and returns it as `ai_guess` (RDKit-validated, flagged
  `unverified`) next to the prediction. This is the **only** place the LLM touches
  product prediction, it never overwrites `products`, and `low_confidence: true` is on
  the response so the UI can say so.
- `/pathways` (synthesis explorer) still runs on templates alone. ASKCOS is single-step,
  and routing the BFS through it would mean a network call per reagent per node.
- Every product returned is RDKit-validated/canonicalized before leaving the backend —
  including everything ASKCOS returns (`askcos_client._parse_outcomes`).
- The LLM (endpoints `/explain`, `/stereo`, `/assist`, `/chat`) only explains, annotates,
  and converses over engine output. It never names reactions or asserts connectivity.
  When *both* engines come up empty, `/react` may fall back to an LLM "blind guess"
  (`_maybe_blind_guess`), plus an LLM sanity check (`_maybe_sanity_check`), both clearly
  separated from the deterministic path in `app.py`.

`ASKCOS_BASE_URL` is the master switch: unset means ASKCOS is off and `/react` runs on
templates alone, exactly as it did before the integration. That is also how you A/B the
two engines. Every `/react` response carries `source: "askcos" | "templates"` saying
which one answered, and each product carries `probability` (null for template products).

Treat `reactivity_engine.py` and `preprocessing.py` as sensitive — the README marks
them "do not modify." The ASKCOS integration deliberately did not touch either; it calls
`run_for_reagent` through its existing public API. Prefer adding a template or reagent
over changing engine logic.

## Backend (`app.py`, ~single large module)

- **OSR pipeline** (`_process`): image → `preprocessing.py` (OpenCV: perspective,
  deskew, denoise, binarize) → DECIMER + MolScribe reads → `osr_arbitration.py` picks
  the best SMILES, with optional vision-model (Anthropic/Ollama) round-trip verification.
  Models are lazy-loaded and warmed once (`_load_decimer`/`_load_molscribe`).
- **LLM streaming**: `_select_stream` / `_sse_stream` dispatch to Anthropic, OpenAI,
  OpenAI-compatible (chat-completions), or Ollama backends and stream SSE. An optional
  per-request `EngineConfig` (`{mode, provider, model, api_key}`) selects the provider;
  BYOK `api_key` is used per-request and never stored or logged.
- **Chat tools**: `/chat` supports Anthropic tool-use (`_stream_anthropic_tools` →
  `_execute_chat_tool`) so the chatbot can call the real engine mid-conversation.
  An image-bearing turn can't carry tools (the gateway drops image blocks on the
  tools endpoint), so it goes to `_image_reaction_then_explain`, which runs OSR +
  the engine itself. `use_engine: false` (the composer's **Direct** toggle) skips
  both paths and streams a plain model answer with no grounding context —
  the escape hatch when OSR misreads the picture.
- **Product prediction**: `_predict_products` (async) and `_askcos_outcomes_sync` (for
  the threaded image pipeline) run ASKCOS and the template engine *concurrently* — the
  templates are needed either way — then hand both to `prediction.resolve_products`,
  the single place the ASKCOS-vs-templates decision is made. That logic lives in
  `prediction.py` rather than here so it can be tested without importing this module
  (and with it TensorFlow/DECIMER/MolScribe, ~2 min). Every ASKCOS failure mode
  (timeout, connection error, non-2xx, unparseable payload) becomes `AskcosUnavailable`
  and degrades to templates; it is never fatal to a request.
- **Guardrails**: `_rate_limit` middleware (two tiers — 60/min compute, 600/min for the
  cheap render endpoints `/structure` + `/molfile`), payload caps in `_guard_messages`,
  and `_enforce_hosted_quota` (`HOSTED_DAILY_REQUESTS`/day per user in hosted mode).

Adding a reagent: append to `REAGENT_LIST` in `reagents.py` (`name`, `smiles`,
`description`, `conditions` — the condition tags are matched against template
conditions). Then run `test_templates.py`.

Adding/curating a reaction *name*: still `reaction_templates.json`. Watch the logs for
`TEMPLATE_GAP endpoint=react_unnamed` — that is ASKCOS telling you exactly which real
transformations your name library is missing.

## Frontend (`frontend/`, Next.js App Router + TypeScript)

**The frontend is a single-page, localStorage-only workspace.** README.md now matches
this, but `SUPABASE_SETUP.md` still describes the older multi-route Supabase login flow
(kept only as a self-hosted prod-auth reference). Trust the code:

- Entry is `app/page.tsx` → `src/platform/Workspace.tsx`. There are **no** `/login`,
  `/signup`, `/dashboard`, or `/projects/[id]` routes despite what the docs say.
- Projects and sessions persist in **localStorage** (`lib/sessions.ts`) — no accounts,
  no Supabase in the frontend at all.
- Three tools in the workspace: **Synthesis** (reagent routes), **Reaction** (predict
  products from typed molecules or a photo), **Chat**.
- Engine is effectively **hosted-only** from the UI: `lib/engine.ts` sends
  `{mode:'hosted', provider:'anthropic'}` with a per-prompt model pick
  (Haiku / Sonnet / Opus — `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`).
- `src/api.js` calls the backend; `src/components/` holds the chemistry UI
  (`PathwayExplorer`, `PathwayGraph` via `@xyflow/react`, `StructureView`, `MoleculeInput`).

The backend still contains the full Supabase-auth + Ollama/BYOK machinery; the frontend
just no longer exercises most of it.

## Production & auth (`ORGO_ENV=prod`)

- In dev, auth is **off** by default (`require_auth` returns `None`), so everything works
  keyless out of the box. Never expose that config to a real network.
- Setting `SUPABASE_URL` (JWKS verification, RS256/ES256/EdDSA — projects since May 2025)
  or `SUPABASE_JWT_SECRET` (legacy HS256) enables auth — and in prod the backend
  **refuses to start** without one. `/health`, `/engine/*`, `/structure`, `/molfile`
  stay public (the last two are loaded via `<img src>` and can't carry an auth header).
- LLM keys: `ANTHROPIC_API_KEY` (+ optional `OPENAI_API_KEY`) enable Hosted mode.
  `HOSTED_ANTHROPIC_MODEL` (default `claude-haiku-4-5`) and `ANTHROPIC_VISION_MODEL`
  (default `claude-sonnet-4-6`) tune the models. `ANTHROPIC_BASE_URL` supports gateway
  keys (e.g. MIT Parley). See `.env.example`. Never commit `.env`.

## LLM / model notes

Model IDs used here: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`. When
touching anything Claude/Anthropic-related (models, pricing, streaming, tool use),
consult the `claude-api` skill rather than answering from memory.
