# Orgo AI — Chemical Pathway Explorer

Captures images of organic chemistry structures, recognizes them via OSR, and shows
interactive branching reaction pathways with mechanism explanations powered by Claude.

## Architecture

Two processes: a **Next.js web app** (port 3000, the UI) and a **FastAPI backend**
(port 8000, the chemistry API). Next.js proxies the API routes to FastAPI via
`frontend/middleware.ts`, which also attaches the shared-secret header the backend
requires.

```
Next.js app (port 3000)  ──proxy──►  FastAPI API (port 8000)
    single-page workspace               ├── POST /analyze   → image → SMILES (DECIMER/MolScribe OSR + round-trip verify)
    Synthesis / Reaction / Chat         ├── GET  /structure → SMILES → SVG (RDKit)
    localStorage sessions & projects    ├── POST /pathways  → branching graph (deterministic engine)
                                        ├── POST /react     → substrate + reagent → products
                                        ├── POST /explain   → engine output → prose explanation (LLM)
                                        ├── POST /stereo    → stereo/regiochem annotation (LLM, opt-in)
                                        ├── POST /assist    → grounded help for a synthesis file (LLM)
                                        └── POST /chat       → chatbot grounded in current work (LLM, tool-use)

Prediction layer (no LLM):
    askcos_client.py        — ASKCOS forward predictor; predicts products for /react
    reactivity_engine.py    — RDKit reaction engine (template-driven); names ASKCOS
                              products, overrules them on disagreement, builds /pathways,
                              and stands in when ASKCOS is down
    reaction_templates.json — all reaction SMARTS + names (the only place names live)
    prediction.py           — decides which of the two answers wins

Explanation layer (LLM) — BYOK:
    Every generative call (explain / stereo / assist / chat) runs on a key the user
    pastes into Settings (stored in the browser's localStorage) — there is no
    server-side key. The chat composer offers a per-prompt strength pick
    (Haiku / Sonnet / Opus).
    The LLM explains engine output; it never re-derives chemistry or names reactions.
```

The web app has **no accounts and no cloud**: your work (sessions, and the projects
that group them) is saved in the browser's `localStorage`. Nothing to set up, nothing
to log into.

> The backend still *contains* optional Supabase-token auth and Ollama engine
> machinery for self-hosted deployments (see "Production mode"), but the shipped
> web app does not exercise them. AI features are **BYOK**: the user pastes their
> own Anthropic (or MIT Parley) key into Settings, and it is used per-request and
> never stored server-side.

## Requirements

- Python 3.10+
- **Node.js 18+** — needed to build the React frontend
  - Download from https://nodejs.org (LTS version)

## Setup

### 1. Python dependencies

```bash
pip install -r requirements.txt -r requirements-osr.txt
```

The second file holds the local OSR readers (DECIMER, MolScribe, torch). They are
optional — without them, reading structures from images uses the vision model instead.

First run downloads DECIMER model weights (~500 MB, one-time).

For a reproducible install (exact versions known to work together), use the
lock file instead:

```bash
pip install -r requirements.lock
```

### 2. API key (required for AI explanations, stereo notes, and chat)

The generative features (explanation panel, stereochemistry notes, and chat) run on
a key you paste into the app's **Settings** — this is **BYOK**; the backend keeps no
server-side key. Structure recognition and the deterministic reaction engine work
without any key.

**Steps:**

1. Go to [console.anthropic.com](https://console.anthropic.com) and create an account
2. Navigate to **API Keys** and generate a key (starts with `sk-ant-`)
3. Add billing — the API is pay-per-use (explanations cost fractions of a cent each)
4. Start the app (see below), open **Settings**, and paste the key in. It is saved in
   this browser's `localStorage` (`orgo.engine.apiKey`) and sent with each request,
   never stored on the server.

An MIT Parley gateway key (`sk-parley-...`) works the same way — the backend routes it
to the Parley gateway instead of `api.anthropic.com` by its prefix (`byok.py`).

Without a key the app still works: structure recognition, the pathway graph, and the
reaction engine run as usual; only the generative text panels report that the key is
missing instead of crashing.

### 3. Run

```bat
start.bat
```

This installs frontend deps (first run), starts the **FastAPI backend on :8000**
in its own window, and runs the **Next.js web app on :3000** in the current window.

Open **http://localhost:3000** on your computer or
**http://\<your-LAN-IP\>:3000** on an iPhone on the same Wi-Fi.

Paste your API key into **Settings** to enable the generative features, and pick a
model strength per message in the chat composer if you like; structure recognition
and the reaction engine need no key at all.

### Development mode

`start.bat` already runs both servers with hot reload (`next dev`). To run them
separately:

```bash
# Terminal 1 — backend API
uvicorn app:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 — Next.js web app (proxies /analyze, /pathways, … to :8000)
cd frontend
npm install
npm run dev
```

Then open **http://localhost:3000**.

### Production mode

Local dev runs with auth optional so the app works out of the box. **Never expose
that configuration to a real network** — run `start-prod.bat` (or replicate what
it does), which sets `ORGO_ENV=prod` and changes the contract:

- The backend **refuses to start** unless it can verify Supabase login tokens.
  Set one (or both) of:
  - `SUPABASE_URL` — your project URL. Tokens are verified against the project's
    public JWKS endpoint. This is what you want for projects created after
    May 2025, which sign tokens with asymmetric keys (RS256/ES256/EdDSA).
  - `SUPABASE_JWT_SECRET` — the legacy HS256 shared secret (Supabase → Project
    Settings → API → JWT secret), for older projects that haven't migrated.

  With auth enabled, every compute and AI endpoint requires a valid Supabase login
  token. **The shipped web app does not send one** (it has no login flow), so
  enabling prod auth requires wiring a Supabase session and attaching its bearer
  token to the API calls in `frontend/src/api.js` — treat prod auth as a
  self-hosting integration point, not a turnkey feature.
- Hosted engine mode (server-side LLM key) is metered per user:
  `HOSTED_DAILY_REQUESTS` requests per day (default 200), 429 beyond that.

```bat
:: Windows — builds the frontend, then starts uvicorn on 127.0.0.1:8000 and
:: `next start` on :3000. Configuration comes from the environment or .env.
start-prod.bat
```

```bash
# Manual equivalent — bind loopback and put a reverse proxy (or the Next.js
# server) in front; the LAN-open 0.0.0.0 bind in start.bat is for dev only.
ORGO_ENV=prod SUPABASE_URL=https://<ref>.supabase.co ANTHROPIC_API_KEY=... \
  uvicorn app:app --host 127.0.0.1 --port 8000

# Production frontend
cd frontend && npm run build && npm start
```

Run exactly **one** uvicorn worker (the default): rate-limit buckets, hosted-mode
quota counters, and deferred-verification tokens live in process memory, and the
OSR models load once per process.

Only `/health`, `/engine/*`, `/structure`, and `/molfile` stay public in prod:
`/structure` is loaded via `<img src>` (which cannot carry an auth header). Both
renderers have hard input caps and sit in a second, looser rate-limit tier
(600/min per IP vs 60/min for compute endpoints — a pathway graph legitimately
renders hundreds of tiles). `/health` and `/engine/*` are cheap cached probes
and expose no user data.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/analyze` | Upload image → `{smiles, valid, verified, confidence, stages}` |
| GET  | `/analyze/verify/{token}` | Finish deferred round-trip verification for an `/analyze` result |
| POST | `/react` | `{substrate_smiles, reagent_smiles}` → all products |
| POST | `/react-from-image` | Image → recognized reaction → products |
| GET  | `/structure` | `?smiles=&width=&height=` → SVG |
| GET  | `/molfile` | `?smiles=` → MDL molfile |
| POST | `/pathways` | `{start_smiles[], target_smiles?, desired_depth?}` → graph |
| POST | `/explain` | Engine output → LLM prose explanation (streamed) |
| POST | `/stereo` | Engine product → stereo/regiochem annotation (streamed, opt-in) |
| POST | `/assist` | File content → grounded LLM help for a synthesis file |
| POST | `/chat` | Conversational chatbot with reaction context and engine tool-use (streamed). `use_engine: false` answers straight from the model — no tools, no OSR on attached images |
| GET  | `/health` | Liveness probe |
| GET  | `/engine/ollama-status` | Live probe for a self-hosted Ollama engine (unused by the shipped UI) |
| GET  | `/engine/usage` | Per-mode request counters |
| GET  | `/engine/template-gaps` | Substrate/reagent pairs where no template fired |

Streaming endpoints accept an optional `engine` object (`{mode, provider, model, api_key}`)
selecting the generative provider. The shipped UI always sends
`{mode:'byok', provider:'anthropic', model?, api_key}`, with `api_key` read from the
user's Settings; it is used per-request and never stored or logged by the backend.

## Adding reagents

Edit `REAGENT_LIST` in `reagents.py` — each entry needs `name`, `smiles`,
`description`, and `conditions` (tags matched against template conditions).

## Testing

```bash
python test_templates.py      # template regression suite — run before committing
                              # changes to reaction_templates.json, reagents.py,
                              # or reactivity_engine.py
python test_askcos.py         # ASKCOS client suite — run before committing changes to
                              # askcos_client.py. Offline by default; set ASKCOS_BASE_URL
                              # to also run one live call against the real instance.
python test_prediction.py     # ASKCOS-vs-templates decision suite — run before committing
                              # changes to prediction.py
python diagnose_templates.py  # firing matrix + dead-template report (real engine)
python test_osr.py            # OSR recognition / arbitration tests
```

Products come from ASKCOS; reaction *names* still come from the template that reproduces
them (`name` in `reaction_templates.json`) — there is no separate classifier, and no LLM
involvement. A product no template reproduces is labeled `Predicted (unnamed)` rather
than guessed at.

**Where the two engines disagree, the template wins.** ASKCOS is broad but not always
right: on the live MIT instance it ranks a dibromo*alkene* first for cyclohexene + Br₂
and sulfuryl chloride first for ethanol + SOCl₂, both of which the template library
already handles correctly. So a firing template overrules ASKCOS's top pick. ASKCOS's
value is coverage — it answers Grignards and everything else no one wrote a template
for. When *neither* engine is confident (no template fires and ASKCOS is below
`ASKCOS_TRUST_PROBABILITY`), `/react` additionally asks Claude and returns it as a
clearly-labeled unverified `ai_guess` beside the prediction — never as the product.

## Project layout

```
Orgo AI/
├── app.py                  ← FastAPI backend + all endpoints
├── askcos_client.py        ← ASKCOS forward-predictor client (product prediction)
├── prediction.py           ← ASKCOS-vs-templates decision (which answer wins)
├── reactivity_engine.py    ← deterministic reaction engine (do not modify)
├── reaction_templates.json ← all reaction SMARTS (the only place reaction names live)
├── reagents.py             ← reagent catalog (name, SMILES, condition tags)
├── osr_arbitration.py      ← picks the best SMILES across OSR reads (+ optional vision)
├── preprocessing.py        ← OpenCV image pipeline (do not modify)
├── test_templates.py       ← template regression suite (run before template edits)
├── test_askcos.py          ← ASKCOS client suite (run before askcos_client.py edits)
├── test_prediction.py      ← engine-arbitration suite (run before prediction.py edits)
├── diagnose_templates.py   ← firing matrix / dead-template diagnostic
├── test_osr.py             ← OSR / arbitration tests
├── requirements.txt        ← lean runtime deps (installed on Railway)
├── requirements-osr.txt    ← local OSR readers (DECIMER, MolScribe, torch) — dev only
├── railway.json            ← Railway start command + healthcheck
├── byok.py                 ← routes a BYOK key by prefix (Parley gateway vs. Anthropic)
├── proxy_auth.py           ← verifies the frontend's shared-secret header
├── .env.example            ← server-side keys + optional prod/auth and engine overrides
├── start.bat               ← starts FastAPI (:8000) + Next.js (:3000) for dev
├── start-prod.bat          ← production launcher (see "Production mode")
├── supabase/schema.sql     ← optional Supabase schema for self-hosted prod auth
└── frontend/               ← Next.js app (App Router, TypeScript)
    ├── app/                 ← single route: page.tsx → the Workspace
    ├── lib/                 ← sessions (localStorage store), engine (BYOK payload),
    │                          exports, clipboard
    └── src/
        ├── api.js           ← calls the FastAPI backend (attaches the engine config)
        ├── platform/        ← Workspace, ChatPanel, Toast, banners
        └── components/      ← PathwayExplorer, PathwayGraph, StructureView,
                               MoleculeInput, InfoPanel, MolDrawer
```

The Workspace has three tools — **Synthesis** (reagent routes from a starting
molecule), **Reaction** (a chat surface that predicts products from typed molecules or
a photographed reaction), and **Chat** — plus a **Projects** view that groups sessions.
All state lives in `localStorage` via `frontend/lib/sessions.ts`.

## Manual test flow

1. Start both servers: `start.bat`
2. Open http://localhost:3000 (no login — the app opens ready to use)
3. Click **Synthesis**
4. In **Starting Material**: upload a photo of a ketone (e.g., 2-pentanone) or type `CC(=O)CCC`
5. Click **Analyze Pathways**; click a node or branch to see the reaction + streamed explanation
6. Click **Analyze stereochemistry** for the stereo/regiochem note
7. Open the **Assistant** drawer to ask about the route, set your stockroom, or run pathways by chat
8. Try the **Reaction** tool: type "react t-BuBr with NaOH" or photograph a reaction

## Design constraints

- The LLM **never names reactions or asserts connectivity**. Products come from ASKCOS,
  names from the deterministic template engine. The LLM only explains and annotates.
- Every product shown is RDKit-validated before being returned — ASKCOS output included.
- ASKCOS is **optional**. Leave `ASKCOS_BASE_URL` unset and `/react` runs on the template
  engine alone, exactly as before. Every `/react` response reports which engine answered
  (`source: "askcos" | "templates"`), so the two are never silently confused.
- API keys never leave the server. BYOK keys (self-hosting only) are used per-request
  and never stored or logged.
