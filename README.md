# Orgo AI — Chemical Pathway Explorer

Captures images of organic chemistry structures, recognizes them via OSR, and shows
interactive branching reaction pathways with mechanism explanations powered by Claude.

## Architecture

Two processes: a **Next.js web app** (port 3000, the UI + Supabase auth/projects)
and a **FastAPI backend** (port 8000, the chemistry API). Next.js proxies the API
routes to FastAPI via rewrites in `frontend/next.config.mjs`.

```
Next.js app (port 3000)  ──proxy──►  FastAPI API (port 8000)
    login / dashboard / projects        ├── POST /analyze   → image → SMILES (DECIMER OSR + round-trip verify)
    per-file chemistry tools            ├── GET  /structure → SMILES → SVG (RDKit)
                                        ├── POST /pathways  → branching graph (deterministic engine)
                                        ├── POST /react     → substrate + reagent → products
                                        ├── POST /explain   → engine output → prose explanation (LLM)
                                        ├── POST /stereo    → stereo/regiochem annotation (LLM, opt-in)
                                        ├── POST /assist    → grounded help for note/mechanism/retro files (LLM)
                                        └── POST /chat       → chatbot grounded in current pathway (LLM)

Ground truth layer (deterministic):
    reactivity_engine.py   — RDKit-based reaction engine (template-driven)
    reaction_classifier.py — SMARTS pattern lookup for reaction names

Explanation layer (LLM) — "Choose Your Engine" (Settings → Engine):
    Local (Ollama)  — free, keyless, runs on the user's machine
    BYOK            — user's own Anthropic/OpenAI key, sent per-request, never stored
    Hosted          — server-side key (billing deferred)
    The LLM explains engine output; it never re-derives chemistry or names reactions.
```

## Requirements

- Python 3.10+
- **Node.js 18+** — needed to build the React frontend
  - Download from https://nodejs.org (LTS version)

## Setup

### 1. Python dependencies

```bash
pip install -r requirements.txt
```

First run downloads DECIMER model weights (~500 MB, one-time).

For a reproducible install (exact versions known to work together), use the
lock file instead:

```bash
pip install -r requirements.lock
```

### 2. API key (required for AI explanations and chatbot)

The AI explanation panel and chatbot use the Claude API, which is a **paid service**.
The graph, structure recognition, and deterministic reaction engine work without a key.

**Steps:**

1. Go to [console.anthropic.com](https://console.anthropic.com) and create an account
2. Navigate to **API Keys** and generate a key (starts with `sk-ant-`)
3. Add billing — the API is pay-per-use (explanations cost fractions of a cent each)
4. Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

> **Never commit `.env`** — it is listed in `.gitignore`. If you accidentally expose a key,
> rotate it immediately in the Anthropic console.

Without a key the app still works: the explanation box will show a message explaining
that the key is missing instead of crashing.

### 3. Supabase (auth + saved projects)

The web app uses Supabase for login and saving projects/files. See
[`SUPABASE_SETUP.md`](SUPABASE_SETUP.md): create a project, run `supabase/schema.sql`,
and add `frontend/.env.local` with your project URL + anon key.

### 4. Run

```bat
start.bat
```

This installs frontend deps (first run), starts the **FastAPI backend on :8000**
in its own window, and runs the **Next.js web app on :3000** in the current window.

Open **http://localhost:3000** on your computer or  
**http://\<your-LAN-IP\>:3000** on an iPhone on the same Wi-Fi.

Pick your generative-AI engine under **Settings → Engine** (the "Engine" button in
the top bar). Structure recognition and the reaction engine work with no key at all.

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
that configuration to a real network** — set `ORGO_ENV=prod`, which changes the
contract:

- The backend **refuses to start** unless `SUPABASE_JWT_SECRET` is set
  (Supabase → Project Settings → API → JWT secret). With the secret set, every
  compute and AI endpoint requires a valid Supabase login token; the frontend
  already attaches it to all API calls.
- Hosted engine mode (server-side LLM key) is metered per user:
  `HOSTED_DAILY_REQUESTS` requests per day (default 200), 429 beyond that.
  Local (Ollama) and BYOK modes are unmetered — they spend the user's own
  resources.

```bash
# Production backend — bind loopback and put a reverse proxy (or the Next.js
# server) in front; the LAN-open 0.0.0.0 bind in start.bat is for dev only.
ORGO_ENV=prod SUPABASE_JWT_SECRET=... ANTHROPIC_API_KEY=... \
  uvicorn app:app --host 127.0.0.1 --port 8000

# Production frontend
cd frontend && npm run build && npm start
```

Run exactly **one** uvicorn worker (the default): rate-limit buckets, hosted-mode
quota counters, and deferred-verification tokens live in process memory, and the
OSR models load once per process.

Only `/health`, `/engine/*`, `/structure`, and `/molfile` stay public in prod:
`/structure` is loaded via `<img src>` (which cannot carry an auth header), and
both renderers are cheap with hard input caps.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/analyze` | Upload image → `{smiles, valid, verified, confidence, stages}` |
| POST | `/predict` | `{substrate_smiles, reagent_smiles}` → product |
| POST | `/react` | `{substrate_smiles, reagent_smiles}` → all products |
| POST | `/react-from-image` | Image → recognized reaction → products |
| GET  | `/structure` | `?smiles=&width=&height=` → SVG |
| POST | `/pathways` | `{start_smiles[], target_smiles?, desired_depth?}` → graph |
| POST | `/explain` | Engine output → LLM prose explanation (streamed) |
| POST | `/stereo` | Engine product → stereo/regiochem annotation (streamed, opt-in) |
| POST | `/assist` | File content → grounded LLM help for note/mechanism/retro files |
| POST | `/chat` | Conversational chatbot with reaction context (streamed) |
| GET  | `/engine/ollama-status` | Live probe for the Local (Ollama) engine option |

Streaming endpoints accept an optional `engine` object (`{mode, provider, model, api_key}`)
selecting the generative provider. `api_key` (BYOK) is used per-request and never stored or logged.

## Adding reagents

Edit `REAGENT_LIST` at the top of `app.py` — each entry needs `name`, `smiles`, `description`.

## Adding reaction classifications

Edit `REACTION_RULES` in `reaction_classifier.py` — each rule is a tuple of
`(name, confidence, match_fn)`. Rules are checked in order; first match wins.

## Project layout

```
Orgo AI/
├── app.py                  ← FastAPI backend + all endpoints
├── reactivity_engine.py    ← deterministic reaction engine (do not modify)
├── reaction_templates.json ← all reaction SMARTS (the only place chemistry lives)
├── preprocessing.py        ← OpenCV image pipeline (do not modify)
├── reaction_classifier.py  ← SMARTS reaction-name lookup (confidence scoring)
├── requirements.txt
├── .env.example            ← optional: ANTHROPIC_API_KEY / OPENAI_API_KEY for Hosted mode
├── start.bat               ← starts FastAPI (:8000) + Next.js (:3000)
├── supabase/schema.sql     ← projects, chemistry_files, user_settings + RLS
└── frontend/               ← Next.js app (App Router, TypeScript)
    ├── app/                 ← routes: /login /signup /dashboard /projects/[id] /settings
    ├── lib/                 ← supabaseClient, database, engine (Choose Your Engine)
    └── src/
        ├── api.js           ← calls the FastAPI backend (attaches engine config)
        ├── platform/        ← DashboardPage, ProjectPage, FileEditor, EngineSettings
        └── components/      ← PathwayExplorer, DirectReact, ReactPredict, InfoPanel,
                               PathwayGraph, MoleculeInput, Chatbot, StructureView
```

## Manual test flow

1. Start both servers: `start.bat`
2. Open http://localhost:3000 and sign up / log in
3. (Optional) **Settings → Engine**: pick Local (Ollama) or paste your own key (BYOK)
4. Create a project, then a **Synthesis** file
5. In **Starting Material**: upload a photo of a ketone (e.g., 2-pentanone) or type `CC(=O)CCC`
6. Click **Analyze Pathways**; click a node or branch to see the reaction + streamed explanation
7. Click **Analyze stereochemistry** for the stereo/regiochem note
8. Try a **Mechanism** or **Molecule note** file — the AI button streams grounded help

## Design constraints

- The LLM **never names reactions or asserts connectivity** — that is always the
  deterministic engine + `reaction_classifier.py`. The LLM only explains and annotates.
- Every product shown is RDKit-validated before being returned.
- API keys never leave the server. BYOK keys are used per-request and never stored or logged.
