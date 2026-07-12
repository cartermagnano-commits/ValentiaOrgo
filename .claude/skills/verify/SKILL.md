---
name: verify
description: How to launch and drive Orgo AI for runtime verification
---

# Verifying Orgo AI

## Launch
- Backend: `python -m uvicorn app:app --host 127.0.0.1 --port 8000` from repo root
  (system Python 3.11; same as start.bat). Warm-load takes **3–4 min**: DECIMER
  then MolScribe load sequentially on a single-worker executor. Watch the log for
  `MolScribe warm-load complete` rather than polling `/health` — aggressive
  short-timeout HTTP polling (curl -m 2 in a loop) has wedged the event loop.
- Frontend: `npm run dev` in `frontend/` (Next 16, Turbopack, port 3000).
- Ollama must be running with a vision model (`qwen2.5vl:7b`) for verification paths.

## Drive
- Generate test images with RDKit: `Draw.MolToFile(Chem.MolFromSmiles('CC(=O)Oc1ccccc1C(=O)O'), 'x.png', size=(600,600))`.
- Happy path: `curl -F "file=@x.png" http://127.0.0.1:8000/analyze` → expect
  `verified: true`, `confidence: "high"`, `reads.molscribe == reads.decimer_original`.
  ~30 s per image on CPU.
- Deferred path: a blank/garbage image gives `confidence: "verifying"` + `verify_token`;
  collect with `GET /analyze/verify/{token}` (blocks up to ~5 min on the vision read;
  token is one-shot, second GET → 404).

## Gotchas (this dev machine, observed 2026-07)
- The Next dev proxy (rewrites → :8000) returned 500 `ECONNRESET` for ALL API routes
  in the Claude Code shell environment — including with the HEAD config, so not a
  config regression. Confirm on a normal `start.bat` run before treating as a bug.
- Browser UI requires Supabase login ("Opening Orgo AI..." splash, no file input
  when logged out) — headless Playwright can't get past it without credentials.
- Running uvicorn OUTSIDE the sandbox wedged its event loop (requests took 60 s+);
  the sandboxed run was fine. Prefer default (sandboxed) Bash for the backend.
