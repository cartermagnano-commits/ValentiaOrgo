# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Orgo AI is a chemical pathway explorer: it recognizes organic structures from images
(OSR), computes branching reaction pathways with a **deterministic** RDKit engine, and
uses an LLM only to *explain* that output. Two processes:

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
python diagnose_templates.py   # firing matrix + dead-template report against the real engine
python test_osr.py             # OSR / arbitration tests
```
There is no pytest, no lint config, and no frontend test suite. To run a single
check, edit/call the relevant function inside these scripts directly.

## Architecture — the core invariant

**Chemistry is deterministic; the LLM never does chemistry.** This boundary is the
whole design and must be preserved:

- `reaction_templates.json` is the **only** place reactions live — SMARTS + human name.
- `reactivity_engine.py` (`TemplateEngine`) fires those templates via RDKit. It is the
  ground-truth engine. Reaction *names* come from whichever template fired; there is no
  separate classifier.
- Every product returned is RDKit-validated/canonicalized before leaving the backend.
- The LLM (endpoints `/explain`, `/stereo`, `/assist`, `/chat`) only explains, annotates,
  and converses over engine output. It never names reactions or asserts connectivity.
  When the engine has no template match, `/react` may fall back to an LLM "blind guess"
  (`_maybe_blind_guess`) and an LLM sanity check (`_maybe_sanity_check`), both clearly
  separated from the deterministic path in `app.py`.

Treat `reactivity_engine.py` and `preprocessing.py` as sensitive — the README marks
them "do not modify." Prefer adding a template or reagent over changing engine logic.

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
- **Guardrails**: `_rate_limit` middleware (two tiers — 60/min compute, 600/min for the
  cheap render endpoints `/structure` + `/molfile`), payload caps in `_guard_messages`,
  and `_enforce_hosted_quota` (`HOSTED_DAILY_REQUESTS`/day per user in hosted mode).

Adding a reagent: append to `REAGENT_LIST` in `reagents.py` (`name`, `smiles`,
`description`, `conditions` — the condition tags are matched against template
conditions). Then run `test_templates.py`.

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
