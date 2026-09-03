# BYOK deploy — a lean Railway backend running on the user's own key

**Date:** 2026-09-03
**Status:** approved, ready for implementation planning

## Problem

Deploying the backend to Railway fails, and two separate causes are tangled together.

**The build never finishes.** `requirements.txt` asks for `torch>=2.0.0` with no index
URL, so Railway resolves the CUDA wheel and its `nvidia-*` dependencies. Combined with
the TensorFlow that `decimer` pulls in, plus `torch`, `torchvision`, `opencv-python`,
`keras`, `scikit-image` and `gensim` pinned in `requirements.lock`, the installed image
lands somewhere around 8 GB — past Railway's ceiling. `requirements.lock` does carry
`--extra-index-url https://download.pytorch.org/whl/cpu`, but Nixpacks installs
`requirements.txt`, so that CPU pin never applies.

**Nothing tells Railway how to start the app.** There is no `Procfile`, `railway.json`
or `nixpacks.toml`, and `app.py` has no `if __name__ == "__main__"` block, so Nixpacks'
best guess (`python app.py`) imports the module and exits. `$PORT` is never read
anywhere in `app.py`, so even a correct start command would fail Railway's healthcheck
against a hardcoded `:8000`.

Underneath both sits a third problem. `ORGO_ENV=prod` refuses to boot without Supabase
(`app.py:795-802`), but the frontend is localStorage-only with no auth at all, so
Railway must run `ORGO_ENV=dev` — where `require_auth` returns `None` and every endpoint
is public. Shipping a server-side `ANTHROPIC_API_KEY` behind an open API means anyone
who finds the URL can spend it.

The answer to all three: **make every AI call run on a key the user supplies**, and stop
shipping the local OSR models the image can't afford.

## Decisions

| Question | Decision |
|---|---|
| Local OSR on Railway | Not installed. Photo recognition becomes purely a vision API call |
| `_process` / `osr_arbitration.py` changes | **None.** Vision-only is already a supported path |
| Key source | User-supplied, per request. No server-side `ANTHROPIC_API_KEY` on Railway |
| Key format | Parley (`sk-parley-*`) for now; real Anthropic keys work by the same prefix routing |
| Key storage | Browser localStorage. Sent per request, never persisted or logged server-side |
| BYOK coverage | **Every** LLM path — vision, chat tool-use, explanations, blind-guess, sanity-check |
| Frontend/backend split | Railway (backend) + Vercel (frontend), wired by `NEXT_PUBLIC_ORGO_API_BASE_URL` |

## Architecture

### Vision-only OSR needs no pipeline changes

This is the load-bearing discovery, and it is why this change is small.

The heavy imports are already lazy — `torch`, `DECIMER` and `molscribe` are imported
*inside* `_load_decimer()` (`app.py:1369`) and `_load_molscribe()` (`app.py:1407`), not
at module scope. The only top-level heavy import is `cv2` (`app.py:48`).

Both warm-ups already catch and degrade. The comment at `app.py:1382` states the
intent directly: *"without DECIMER the /analyze OSR path degrades to the vision-model
fallback, and every non-image feature still works."*

Inside `_process`, the DECIMER reads sit in a `try/except` (`app.py:1796-1808`) that
sets `error` and leaves both reads `None`; `_molscribe_read` swallows its own load
failure and returns `None`; `_collect` catches everything else. So with the packages
absent, `arbitrate_local(None, None, None, None)` is reached — and
`osr_arbitration.py:106` returns `(None, None, True, False)` under the comment
*"nothing local — vision is the source."* The docstring at `osr_arbitration.py:82`
names the case explicitly: *"no local read at all → the caller must block on vision."*

**Vision-only is a designed-for mode of the existing pipeline, not a degradation we are
inventing.** Removing the packages is sufficient; `_process` and `osr_arbitration.py`
are not touched.

The preprocessing stages (perspective, deskew, denoise, binarize) still run and still
populate the stage images the UI displays. They no longer feed a local reader, but the
vision read already worked from `_vision_png(img)` rather than the binarized rendition
(`app.py:1755`), so recognition input is unchanged.

What is genuinely lost is the cross-reader agreement signal: with one reader there is no
second architecture to agree with, so the instant `verified` badge never fires and
confidence resolves through the vision path alone. That is inherent to vision-only
recognition and is accepted.

### Threading the key

BYOK exists but was deliberately scoped to prose. `app.py:322-324` says so: *"The engine
picker (local / byok / hosted) ONLY powers generative explanations and chat. Structure
recognition uses the server-side ANTHROPIC_API_KEY when present."* `EngineConfig`
(`app.py:358-363`) already carries `mode`, `provider`, `model` and a request-scoped
`api_key`.

The pattern to replicate is already written, in `_stream_anthropic` (`app.py:400-405`):

```python
if api_key:
    # BYOK: don't inherit the server's ANTHROPIC_BASE_URL (a gateway like
    # Parley would reject a real Anthropic key). Route by key prefix.
    base_url = ("https://parley.api.mit.edu" if api_key.startswith("sk-parley-")
                else "https://api.anthropic.com")
    client = anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url)
```

Every path below gains an optional `api_key` parameter and reuses that prefix routing.
The parameter is optional throughout, so a locally-configured server key keeps working
exactly as it does today.

**Vision path** — `_anthropic_vision_call` (`app.py:168`) currently reads
`os.environ['ANTHROPIC_API_KEY']` directly at `app.py:190`, and `_vision_call`
(`app.py:265`) *gates* on that env var at `app.py:270` before falling through to Ollama.
Both need the key passed in, and the gate becomes `api_key or os.environ.get(...)`.
`_vision_smiles` (`app.py:277`), `_vision_reaction_smiles` (`app.py:298`) and `_process`
(`app.py:1721`) thread it to the `_vision_pool.submit` at `app.py:1755`.

**Chat tool-use** — `_stream_anthropic_tools` (`app.py:1239`) hardcodes the server key at
`app.py:1246`, and the dispatch at `app.py:2790` gates the whole tool loop on
`mode == "hosted"` *and* a server key. Without this, BYOK chat silently loses
`run_reaction` — a headline feature. The gate widens to admit BYOK with a key.

**Escalation** — `_anthropic_complete` (`app.py:419`) uses the server key at
`app.py:426`, and feeds `_maybe_blind_guess` (`app.py:996`) and `_maybe_sanity_check`
(`app.py:1030`). CLAUDE.md calls the low-confidence escalation load-bearing, so it gets
the key too.

**Call sites to update:** `_process` (one submit), the chat image path
(`app.py:3094, 3107, 3143, 3180`), and the `/analyze` and `/react-from-image` endpoints.

### Frontend

`getEnginePayload()` in `frontend/lib/engine.ts` is a single choke point — every
`/explain`, `/stereo` and `/chat` body goes through it. `EnginePayload` gains
`mode: 'byok'` and `api_key`, and the function reads the key from localStorage under
`orgo.engine.apiKey`, following the existing `orgo.chat.model` pattern in the same file.

Settings gains a field to paste a Parley key, stating plainly that it is stored in the
browser, sent with each request, and never persisted server-side. With no key saved, AI
features are visibly unavailable rather than silently failing — the chemistry engine
(typed reactions, pathways) is keyless and keeps working regardless.

`/analyze` and `/react-from-image` are multipart uploads, so the key travels as a form
field there rather than in a JSON body.

### Deployment

`requirements.txt` becomes the lean runtime set: `rdkit`, `numpy`,
`opencv-python-headless` (swapped from `opencv-python` — no GUI/X11 libraries belong on
a server), `fastapi`, `uvicorn[standard]`, `httpx`, `anthropic`, `openai`, `Pillow`,
`pillow-heif`, `python-multipart`, `python-dotenv`, `PyJWT`, `cryptography`.

A new `requirements-osr.txt` holds `decimer`, `MolScribe`, `torch`, `timm` and
`huggingface_hub` with the CPU extra-index-url, so local development keeps the full
multi-reader pipeline. `requirements.lock` stays as the pinned known-good local record.

`railway.json` supplies the start command, honoring `$PORT` and running exactly one
worker — CLAUDE.md requires it, because rate-limit buckets, hosted-quota counters and
deferred-verify tokens all live in process memory:

```
uvicorn app:app --host 0.0.0.0 --port $PORT
```

with `/health` as the healthcheck path. Railway runs `ORGO_ENV=dev` with no
`ANTHROPIC_API_KEY` set. Vercel sets `NEXT_PUBLIC_ORGO_API_BASE_URL` to the Railway URL;
because the frontend proxies server-side through `rewrites()` in `next.config.mjs`, the
browser only ever talks to its own origin, so the hardcoded localhost CORS list at
`app.py:685-689` stays irrelevant.

On Railway, `/health` reports `hosted_key_configured`, `decimer_ready` and
`molscribe_ready` all `false` (`app.py:1528-1536`). Nothing in the frontend reads those
three fields — the status banner only checks reachability — so this is cosmetic and no
change is needed. Hosted-quota metering is likewise unaffected: `_enforce_hosted_quota`
returns early for any non-hosted mode (`app.py:886`), so BYOK calls are correctly
unmetered.

## Security

**The API is unauthenticated.** `ORGO_ENV=dev` means `require_auth` returns `None` and
every endpoint is open to anyone with the URL. Removing the server key is what makes
that acceptable: there is no longer a credential behind the API worth stealing. What
remains exposed is compute — ASKCOS calls and RDKit work — bounded by the existing
`_rate_limit` middleware. Authenticating the API is deliberately out of scope here and
should be its own piece of work before any real launch.

**A pasted key in localStorage is readable by any XSS on the origin.** This is the
standard BYOK tradeoff, accepted here because a Parley key is scoped and rotatable. It
is recorded as a decision rather than left as an accident.

**The key must never be logged.** `_anthropic_vision_call` logs model and base URL at
`app.py:186` and must keep logging only those. `EngineConfig` already documents the key
as request-scoped and never stored; the new paths inherit that contract.

## Testing

No pytest, no framework — plain scripts, matching the existing suites.

- **Clean-venv install** from the new `requirements.txt`, then `test_prediction.py`,
  `test_askcos.py` and `test_templates.py`. This proves the lean set is sufficient:
  those three deliberately import nothing heavy, and `test_prediction.py` runs in under
  a second.
- **Vision-only degradation** — import `app` in that clean venv and confirm the DECIMER
  and MolScribe warm-ups log their warnings without raising, and that `arbitrate_local`
  with four `None`s returns the vision-is-source verdict.
- **Key routing** — a new plain-script test asserting `sk-parley-*` routes to
  `https://parley.api.mit.edu`, any other key to `https://api.anthropic.com`, and an
  absent key falls back to the server env var. Covers the vision, tools and completion
  paths, since all three now share the pattern.
- **No key leakage** — assert the key never appears in emitted log records.

## Out of scope

- Authenticating the public API (Supabase, shared secret, or otherwise)
- Supporting providers other than Anthropic/Parley for BYOK
- Restoring cross-reader agreement on Railway
- Deploying the frontend, beyond setting `NEXT_PUBLIC_ORGO_API_BASE_URL`
