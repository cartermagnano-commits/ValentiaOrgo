# BYOK Railway Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Orgo AI backend to Railway on a lean image, with every LLM call running on a key the user supplies and the backend reachable only through the Vercel proxy.

**Architecture:** The local OSR models (DECIMER/MolScribe/torch/TensorFlow) come out of the deployed image — vision-only recognition is already a supported path in `_process`, so no pipeline code changes. Two new pure modules (`byok.py`, `proxy_auth.py`) hold the decision logic so it can be tested without importing `app.py`, following the precedent `prediction.py` set. An optional `api_key` parameter is threaded through every LLM call site, and a shared secret injected by a new Vercel middleware both gates the API and re-establishes the `X-Forwarded-For` trust boundary the rate limiter lost when the proxy moved off-machine.

**Tech Stack:** FastAPI + uvicorn, Next.js App Router + TypeScript, Railway (Nixpacks), Vercel, Anthropic/Parley API.

**Spec:** `docs/superpowers/specs/2026-09-03-byok-railway-deploy-design.md`

## Global Constraints

- **The LLM never does chemistry.** No task may move product prediction or reaction naming into an LLM call.
- **Run exactly one uvicorn worker.** Rate-limit buckets, hosted-quota counters, deferred-verify tokens and loaded models are all in process memory.
- **`reactivity_engine.py` and `preprocessing.py` are do-not-modify.** No task touches them.
- **`_process` and `osr_arbitration.py` are not modified** beyond threading an optional `api_key` parameter into `_process`. Their arbitration logic stays exactly as-is.
- **The API key is never logged.** `_anthropic_vision_call` logs model and base URL only (`app.py:186`); every new path inherits that.
- **New `api_key` parameters are optional and default to `None`**, so an existing local server-key setup keeps working unchanged.
- **Tests are plain Python scripts** — no pytest. One PASS/FAIL line per case, non-zero exit on failure, matching `test_prediction.py`.
- Parley base URL: `https://parley.api.mit.edu`. Anthropic base URL: `https://api.anthropic.com`. Parley key prefix: `sk-parley-`.

---

### Task 1: Lean requirements and Railway start config

Splits the dependency list so Railway installs a ~400 MB runtime instead of an ~8 GB one, and tells Railway how to start the app on `$PORT`.

**Files:**
- Modify: `requirements.txt` (full rewrite)
- Create: `requirements-osr.txt`
- Create: `railway.json`
- Modify: `.env.example`

- [ ] **Step 1: Rewrite `requirements.txt` as the lean runtime set**

`opencv-python` is swapped for `opencv-python-headless` — the GUI/X11 libraries in the former have no place on a server and are a meaningful part of the image size.

```
# Lean runtime set — what the deployed backend actually imports at module load.
# Local OSR (DECIMER/MolScribe/torch) lives in requirements-osr.txt and is
# OPTIONAL: without it, image recognition runs purely as a vision API call.
# See docs/superpowers/specs/2026-09-03-byok-railway-deploy-design.md
opencv-python-headless>=4.8.0
numpy>=1.24.0
rdkit>=2023.9.1
httpx>=0.27.0
Pillow>=10.0.0
pillow-heif>=0.13.0
fastapi>=0.100.0
uvicorn[standard]>=0.23.0
python-multipart>=0.0.6
anthropic>=0.25.0
openai>=1.30.0
python-dotenv>=1.0.0
PyJWT>=2.8.0
cryptography>=42.0.0   # asymmetric Supabase JWT verification (RS256/ES256/EdDSA)
```

- [ ] **Step 2: Create `requirements-osr.txt`**

The CPU extra-index-url is essential: without it pip resolves the CUDA torch wheel and its `nvidia-*` dependencies, which is what broke the Railway build.

```
# Local OSR readers — DECIMER (TensorFlow) and MolScribe (torch).
# Install ON TOP of requirements.txt for local development:
#     pip install -r requirements.txt -r requirements-osr.txt
# NOT installed on Railway: together these pull ~7 GB and exceed the image
# limit. Without them _process degrades to vision-only, which osr_arbitration
# already supports (see arbitrate_local's "nothing local" branch).
--extra-index-url https://download.pytorch.org/whl/cpu
decimer>=2.3.0
MolScribe>=1.1.1
torch>=2.0.0
timm==0.4.12
huggingface_hub>=0.23.0
```

- [ ] **Step 3: Create `railway.json`**

`--workers` is deliberately absent; uvicorn defaults to one, which this app requires.

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "uvicorn app:app --host 0.0.0.0 --port $PORT",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

- [ ] **Step 4: Document the new deployment variables in `.env.example`**

Append this block to the end of the file:

```
# ── Split deployment (Railway backend + Vercel frontend) ──────────────────
# Shared secret proving a request came from our own Next.js proxy. Set the
# SAME value on Railway and on Vercel. When set, the backend rejects any
# request without it (except /health, which Railway's own healthcheck probes
# directly) and trusts X-Forwarded-For for per-user rate limiting. Leave it
# UNSET for local development: the backend then behaves exactly as before.
# ORGO_PROXY_SECRET=

# Railway also needs: ORGO_ENV=dev, and NO ANTHROPIC_API_KEY — every AI call
# runs on the key the user pastes into Settings (BYOK). Vercel needs
# NEXT_PUBLIC_ORGO_API_BASE_URL=<railway url> and the same ORGO_PROXY_SECRET.
```

- [ ] **Step 5: Verify the lean set is sufficient in a clean venv**

This is the real test of this task: the three suites that avoid heavy imports must pass with only `requirements.txt` installed.

```bash
python -m venv /tmp/orgo-lean
/tmp/orgo-lean/bin/pip install -q -r requirements.txt
/tmp/orgo-lean/bin/python test_prediction.py
/tmp/orgo-lean/bin/python test_templates.py
/tmp/orgo-lean/bin/python test_askcos.py
```

Expected: all three print `N passed, 0 failed` and exit 0.

- [ ] **Step 6: Verify the app imports and degrades to vision-only in that venv**

```bash
/tmp/orgo-lean/bin/python -c "
import logging; logging.basicConfig(level=logging.INFO)
import app, time
time.sleep(3)
print('IMPORT OK')
print('decimer loaded:', app._decimer_fn is not None)
print('molscribe loaded:', app._molscribe_model is not None)
from osr_arbitration import arbitrate_local
print('arbitrate_local(None x4):', arbitrate_local(None, None, None, None))
"
```

Expected: `IMPORT OK`; both loaded flags `False`; warm-up warnings for DECIMER and MolScribe in the log; and `arbitrate_local(None x4): (None, None, True, False)` — the vision-is-source verdict.

- [ ] **Step 7: Commit**

```bash
git add requirements.txt requirements-osr.txt railway.json .env.example
git commit -m "Lean runtime requirements and Railway start config

Railway installed the CUDA torch wheel because requirements.txt carried no
index URL, and TensorFlow came along with decimer — an ~8 GB image past the
build limit, with no start command and no \$PORT handling.

Local OSR moves to requirements-osr.txt. Without it _process degrades to
vision-only, which arbitrate_local already treats as a first-class path."
```

---

### Task 2: `byok.py` — route an Anthropic-family key to its base URL

A pure module so the routing rule is testable without importing `app.py` (which loads cv2, rdkit and FastAPI and kicks off model warm-ups). Same reasoning that put `prediction.py` in its own file.

**Files:**
- Create: `byok.py`
- Test: `test_byok.py`

**Interfaces:**
- Produces: `anthropic_base_url(api_key: str | None, server_base_url: str | None = None) -> str` and `PARLEY_BASE_URL` / `ANTHROPIC_BASE_URL` constants. Tasks 5 and 6 import both.

- [ ] **Step 1: Write the failing test**

Create `test_byok.py`:

```python
"""
test_byok.py — BYOK key-routing suite.

Run before committing changes to byok.py:

    python test_byok.py

Plain Python (matching test_prediction.py): one PASS/FAIL line per case,
non-zero exit on any failure. Imports only byok.py — no FastAPI, no cv2.

The rule under test is load-bearing: a Parley gateway key sent to
api.anthropic.com is rejected, and a real Anthropic key sent to the Parley
gateway is equally rejected. Routing by prefix is what lets one BYOK field
accept both.
"""

import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from byok import ANTHROPIC_BASE_URL, PARLEY_BASE_URL, anthropic_base_url

failures: list[str] = []
passes = 0


def check(name: str, ok: bool, detail: str = ""):
    global passes
    if ok:
        passes += 1
        print(f"  PASS  {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name}  {detail}")


print("\nBYOK key routing\n")

check("a Parley key routes to the Parley gateway",
      anthropic_base_url("sk-parley-v1-abc123") == PARLEY_BASE_URL,
      anthropic_base_url("sk-parley-v1-abc123"))

check("a real Anthropic key routes to api.anthropic.com",
      anthropic_base_url("sk-ant-api03-abc123") == ANTHROPIC_BASE_URL,
      anthropic_base_url("sk-ant-api03-abc123"))

check("an unrecognized key shape defaults to api.anthropic.com",
      anthropic_base_url("some-other-key") == ANTHROPIC_BASE_URL,
      anthropic_base_url("some-other-key"))

# A BYOK key must NOT inherit the server's gateway base URL: a real Anthropic
# key sent to Parley is rejected, which is the whole reason for prefix routing.
check("a BYOK key ignores the server's configured base URL",
      anthropic_base_url("sk-ant-api03-abc", server_base_url=PARLEY_BASE_URL) == ANTHROPIC_BASE_URL,
      anthropic_base_url("sk-ant-api03-abc", server_base_url=PARLEY_BASE_URL))

check("a Parley BYOK key still routes to Parley when the server points elsewhere",
      anthropic_base_url("sk-parley-v1-abc", server_base_url=ANTHROPIC_BASE_URL) == PARLEY_BASE_URL,
      anthropic_base_url("sk-parley-v1-abc", server_base_url=ANTHROPIC_BASE_URL))

print("\nServer-key fallback (no BYOK key)\n")

check("no key falls back to the server's configured base URL",
      anthropic_base_url(None, server_base_url="https://gateway.example") == "https://gateway.example",
      anthropic_base_url(None, server_base_url="https://gateway.example"))

check("no key and no server base URL defaults to api.anthropic.com",
      anthropic_base_url(None) == ANTHROPIC_BASE_URL,
      anthropic_base_url(None))

check("an empty key is treated as absent, not as an unrecognized key",
      anthropic_base_url("", server_base_url="https://gateway.example") == "https://gateway.example",
      anthropic_base_url("", server_base_url="https://gateway.example"))

check("a trailing slash on the server base URL is stripped",
      anthropic_base_url(None, server_base_url="https://gateway.example/") == "https://gateway.example",
      anthropic_base_url(None, server_base_url="https://gateway.example/"))

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python test_byok.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'byok'`

- [ ] **Step 3: Write the implementation**

Create `byok.py`:

```python
"""
byok.py — where a user-supplied Anthropic-family key's traffic should go.

Split out of app.py so the rule is testable without importing FastAPI, cv2
and the OSR model warm-ups (the same reason prediction.py is its own module).

The rule: a BYOK key routes by its own prefix and NEVER inherits the server's
ANTHROPIC_BASE_URL. A gateway like MIT Parley rejects a real Anthropic key,
and api.anthropic.com rejects a Parley key — so a server configured for one
must not drag a user's key of the other kind along with it.
"""

from __future__ import annotations

ANTHROPIC_BASE_URL = "https://api.anthropic.com"
PARLEY_BASE_URL = "https://parley.api.mit.edu"
PARLEY_KEY_PREFIX = "sk-parley-"


def anthropic_base_url(api_key: str | None, server_base_url: str | None = None) -> str:
    """Base URL for an Anthropic-family call.

    With a BYOK `api_key`, route by key prefix and ignore `server_base_url`
    entirely. Without one, fall back to the server's configured gateway, or
    to api.anthropic.com when none is set.
    """
    if api_key:
        return PARLEY_BASE_URL if api_key.startswith(PARLEY_KEY_PREFIX) else ANTHROPIC_BASE_URL
    return (server_base_url or ANTHROPIC_BASE_URL).rstrip("/")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python test_byok.py`
Expected: `9 passed, 0 failed`, exit 0

- [ ] **Step 5: Commit**

```bash
git add byok.py test_byok.py
git commit -m "Add byok module: route a user key to its own gateway

A BYOK key must not inherit the server's ANTHROPIC_BASE_URL — Parley
rejects a real Anthropic key and vice versa. Pure module so the rule is
testable without importing app.py, following prediction.py's precedent."
```

---

### Task 3: `proxy_auth.py` — the proxy trust boundary

Holds both halves of the trust decision: whether a request came from our proxy, and whether its `X-Forwarded-For` can therefore be believed.

**Files:**
- Create: `proxy_auth.py`
- Test: `test_proxy_auth.py`

**Interfaces:**
- Produces: `proxy_authorized(header_value, expected_secret, path) -> bool`, `resolve_client_ip(peer, forwarded, trusted) -> str`, `LOOPBACK_IPS: set[str]`, `PROXY_SECRET_HEADER: str`, `EXEMPT_PATHS: frozenset[str]`. Task 4 imports all of them.

- [ ] **Step 1: Write the failing test**

Create `test_proxy_auth.py`:

```python
"""
test_proxy_auth.py — proxy trust-boundary suite.

Run before committing changes to proxy_auth.py:

    python test_proxy_auth.py

Plain Python (matching test_prediction.py): one PASS/FAIL line per case,
non-zero exit on any failure. Imports only proxy_auth.py.

Two rules, one secret. Splitting the frontend onto Vercel broke the old
"trust X-Forwarded-For only from a loopback peer" rule — from Vercel the peer
is never loopback, so every user collapsed into ONE rate-limit bucket. The
shared secret restores the boundary: it proves the request came from our
proxy, which is exactly when the forwarded IP can be believed.
"""

import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from proxy_auth import (
    EXEMPT_PATHS, LOOPBACK_IPS, PROXY_SECRET_HEADER,
    proxy_authorized, resolve_client_ip,
)

failures: list[str] = []
passes = 0


def check(name: str, ok: bool, detail: str = ""):
    global passes
    if ok:
        passes += 1
        print(f"  PASS  {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name}  {detail}")


print("\nproxy_authorized — access control\n")

check("the right secret is authorized",
      proxy_authorized("s3cret", "s3cret", "/react") is True)

check("the wrong secret is rejected",
      proxy_authorized("wrong", "s3cret", "/react") is False)

check("a missing header is rejected when a secret is configured",
      proxy_authorized(None, "s3cret", "/react") is False)

check("an empty header is rejected when a secret is configured",
      proxy_authorized("", "s3cret", "/react") is False)

# Unset secret = feature off. This preserves the keyless local workflow
# CLAUDE.md documents; the backend must not lock itself out by default.
check("no configured secret authorizes everything (local dev)",
      proxy_authorized(None, None, "/react") is True)

check("an empty configured secret also counts as unset",
      proxy_authorized(None, "", "/react") is True)

print("\nproxy_authorized — /health exemption\n")

# Railway's healthcheck probes the backend DIRECTLY and carries no proxy
# header. Requiring the secret on /health would fail every deploy.
check("/health is exempt with no header",
      proxy_authorized(None, "s3cret", "/health") is True)

check("/health is exempt with a wrong header",
      proxy_authorized("wrong", "s3cret", "/health") is True)

check("/health is in the exempt set",
      "/health" in EXEMPT_PATHS)

check("a non-exempt path is still gated",
      proxy_authorized(None, "s3cret", "/analyze") is False)

check("the header name is the one the middleware will send",
      PROXY_SECRET_HEADER == "x-orgo-proxy-secret", PROXY_SECRET_HEADER)

print("\nresolve_client_ip — rate-limit bucketing\n")

# The bug this fixes: from Vercel the peer is an egress IP, never loopback,
# so without trust every user shares one bucket.
check("a trusted proxy's forwarded IP is used",
      resolve_client_ip("52.9.1.1", "203.0.113.7", trusted=True) == "203.0.113.7")

check("two different forwarded IPs give two different buckets",
      resolve_client_ip("52.9.1.1", "203.0.113.7", trusted=True)
      != resolve_client_ip("52.9.1.1", "203.0.113.8", trusted=True))

check("the FIRST hop is taken from a multi-hop forwarded chain",
      resolve_client_ip("52.9.1.1", "203.0.113.7, 70.0.0.1", trusted=True) == "203.0.113.7")

check("surrounding whitespace in the chain is stripped",
      resolve_client_ip("52.9.1.1", "  203.0.113.7 , 70.0.0.1", trusted=True) == "203.0.113.7")

# Without trust, an untrusted caller must not be able to spoof its way into
# a fresh bucket — this is why the secret gates the trust flag.
check("an untrusted caller's forwarded header is ignored",
      resolve_client_ip("198.51.100.5", "203.0.113.7", trusted=False) == "198.51.100.5")

check("a trusted peer with no forwarded header falls back to the peer",
      resolve_client_ip("52.9.1.1", None, trusted=True) == "52.9.1.1")

check("a trusted peer with an empty forwarded header falls back to the peer",
      resolve_client_ip("52.9.1.1", "", trusted=True) == "52.9.1.1")

check("a forwarded header of only commas falls back to the peer",
      resolve_client_ip("52.9.1.1", " , ", trusted=True) == "52.9.1.1")

check("an unknown peer stays 'unknown'",
      resolve_client_ip("unknown", None, trusted=False) == "unknown")

check("loopback is still recognized for the local-dev path",
      "127.0.0.1" in LOOPBACK_IPS and "::1" in LOOPBACK_IPS)

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python test_proxy_auth.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'proxy_auth'`

- [ ] **Step 3: Write the implementation**

Create `proxy_auth.py`:

```python
"""
proxy_auth.py — is this request from our own proxy, and can we believe its
forwarded client IP?

Split out of app.py so both rules are testable without importing FastAPI,
cv2 and the OSR warm-ups (see prediction.py for the same reasoning).

Background: the rate limiter used to trust X-Forwarded-For only from a
loopback peer, which held while the Next.js proxy ran on the same machine.
With the frontend on Vercel and the backend on Railway the peer is an egress
IP that is never loopback, so the header was ignored and every user collapsed
into ONE shared bucket. Widening the trust unconditionally is not an option:
the Railway URL is public, so any caller could spoof the header.

ORGO_PROXY_SECRET settles both questions at once. The proxy attaches it to
every forwarded request; its presence both authorizes the request and marks
the forwarded IP as trustworthy.
"""

from __future__ import annotations

import hmac

# Header the Next.js middleware attaches. Lowercase: ASGI header lookups are
# case-insensitive but Starlette normalizes to lowercase.
PROXY_SECRET_HEADER = "x-orgo-proxy-secret"

# Railway's healthcheck probes the backend directly and carries no proxy
# header, so gating /health would fail every deploy. It exposes only booleans
# about which models loaded.
EXEMPT_PATHS = frozenset({"/health"})

LOOPBACK_IPS = {"127.0.0.1", "::1", "localhost"}


def proxy_authorized(header_value: str | None, expected_secret: str | None,
                     path: str) -> bool:
    """True when this request may proceed.

    An unset `expected_secret` disables the check entirely — that is the
    keyless local-development path, and the backend must never lock itself
    out by default.
    """
    if not expected_secret:
        return True
    if path in EXEMPT_PATHS:
        return True
    if not header_value:
        return False
    return hmac.compare_digest(header_value, expected_secret)


def resolve_client_ip(peer: str, forwarded: str | None, trusted: bool) -> str:
    """Rate-limit bucket key: the real client IP when we can believe it.

    `trusted` says the request demonstrably came from our proxy — either a
    loopback peer (local dev) or a valid proxy secret. Only then is the
    forwarded chain believed; otherwise an untrusted caller could spoof a
    fresh bucket per request and walk past the limiter.
    """
    if trusted and forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return peer
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python test_proxy_auth.py`
Expected: `21 passed, 0 failed`, exit 0

- [ ] **Step 5: Commit**

```bash
git add proxy_auth.py test_proxy_auth.py
git commit -m "Add proxy_auth module: shared-secret trust boundary

Moving the frontend to Vercel broke X-Forwarded-For trust (the peer is
never loopback), collapsing all users into one rate-limit bucket. The
shared secret proves a request came from our proxy, which both authorizes
it and makes its forwarded IP believable. /health stays exempt so
Railway's own healthcheck still passes."
```

---

### Task 4: Wire the proxy trust boundary into `app.py`

**Files:**
- Modify: `app.py:716-738` (`_LOOPBACK_IPS`, `_client_ip`)
- Modify: `app.py:739-750` (`_rate_limit` middleware)

**Interfaces:**
- Consumes: `proxy_auth.proxy_authorized`, `proxy_auth.resolve_client_ip`, `proxy_auth.LOOPBACK_IPS`, `proxy_auth.PROXY_SECRET_HEADER` from Task 3.

- [ ] **Step 1: Add the import and the configured secret**

Add to the import block near `from prediction import (...)` at `app.py:73`:

```python
from proxy_auth import (
    LOOPBACK_IPS, PROXY_SECRET_HEADER, proxy_authorized, resolve_client_ip,
)
```

Then, immediately above `_LOOPBACK_IPS` at `app.py:718`, add:

```python
# Shared secret proving a request came from our own Next.js proxy. Unset
# means the check is off — the keyless local-development default.
ORGO_PROXY_SECRET = os.environ.get("ORGO_PROXY_SECRET") or None
```

- [ ] **Step 2: Replace `_LOOPBACK_IPS` and `_client_ip`**

Delete `_LOOPBACK_IPS = {"127.0.0.1", "::1", "localhost"}` at `app.py:718` (it now lives in `proxy_auth`) and replace the whole `_client_ip` function at `app.py:721-737` with:

```python
def _client_ip(request, trusted: bool) -> str:
    """Best-effort real client IP, for rate-limit bucketing.

    Browser traffic arrives through the Next.js proxy, so request.client.host
    is the proxy's address for every user — keying the limiter on it collapses
    all clients into ONE shared bucket. The proxy sets X-Forwarded-For with the
    real client; `trusted` says we may believe it, which holds when the peer is
    loopback (proxy on this machine) or the request carried a valid
    ORGO_PROXY_SECRET (proxy on Vercel). A remote caller with neither cannot
    spoof the header to dodge the limit.
    """
    peer = request.client.host if request.client else "unknown"
    trusted = trusted or peer in LOOPBACK_IPS
    return resolve_client_ip(peer, request.headers.get("x-forwarded-for"), trusted)
```

- [ ] **Step 3: Gate the middleware on the secret and pass the trust flag**

In `_rate_limit` at `app.py:740`, insert the authorization check at the top of the function body, and thread `authorized` into the `_client_ip` call. The function begins:

```python
@app.middleware("http")
async def _rate_limit(request, call_next):
    path = request.url.path

    # Access control before anything else: without the shared secret this
    # request did not come through our proxy. /health is exempt — Railway's
    # healthcheck probes the backend directly and carries no header.
    authorized = proxy_authorized(
        request.headers.get(PROXY_SECRET_HEADER), ORGO_PROXY_SECRET, path)
    if not authorized:
        return JSONResponse(
            status_code=403,
            content={"detail": "This API is reachable only through the Orgo AI app."},
        )

    # /analyze/verify/{token} holds a server connection for minutes while it
    # waits on the vision model — it must count against the heavy budget too.
    if path in RATE_LIMIT_HEAVY or path.startswith("/analyze/verify/"):
        limit, tier = RATE_LIMIT_HEAVY_MAX, "heavy"
    elif path in RATE_LIMIT_LIGHT:
        limit, tier = RATE_LIMIT_LIGHT_MAX, "light"
    else:
        return await call_next(request)

    key = f"{tier}:{_client_ip(request, authorized)}"
```

Leave the rest of the function (bucket trimming, the 429, `call_next`) exactly as it is.

- [ ] **Step 4: Verify the wiring with a live server**

The two pure rules are already covered by `test_proxy_auth.py`; this step confirms `app.py` actually uses them.

```bash
ORGO_PROXY_SECRET=testsecret /tmp/orgo-lean/bin/python -m uvicorn app:app --port 8899 &
sleep 8
echo "--- /health with no secret (expect 200) ---"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8899/health
echo "--- /pathways with no secret (expect 403) ---"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8899/pathways \
  -H 'Content-Type: application/json' -d '{"smiles":"CCO"}'
echo "--- /pathways with the wrong secret (expect 403) ---"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8899/pathways \
  -H 'Content-Type: application/json' -H 'x-orgo-proxy-secret: nope' -d '{"smiles":"CCO"}'
echo "--- /pathways with the right secret (expect NOT 403) ---"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8899/pathways \
  -H 'Content-Type: application/json' -H 'x-orgo-proxy-secret: testsecret' -d '{"smiles":"CCO"}'
kill %1
```

Expected: `200`, `403`, `403`, then any non-403 status.

- [ ] **Step 5: Confirm the unset-secret default still works**

```bash
/tmp/orgo-lean/bin/python -m uvicorn app:app --port 8898 &
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8898/pathways \
  -H 'Content-Type: application/json' -d '{"smiles":"CCO"}'
kill %1
```

Expected: a non-403 status — with no secret configured the gate is off.

- [ ] **Step 6: Commit**

```bash
git add app.py
git commit -m "Require the proxy secret and fix rate-limit bucketing

Rejects any request that did not come through our proxy (403), exempting
/health for Railway's healthcheck, and uses that same signal to decide
whether X-Forwarded-For can be trusted — restoring per-user rate-limit
buckets on the split deployment."
```

---

### Task 5: Thread BYOK through the vision path

Photo recognition becomes purely a vision API call, so this is the path that must run on the user's key.

**Files:**
- Modify: `app.py:168-215` (`_anthropic_vision_call`)
- Modify: `app.py:265-274` (`_vision_call`)
- Modify: `app.py:277-295` (`_vision_smiles`)
- Modify: `app.py:298-318` (`_vision_reaction_smiles`)
- Modify: `app.py:1721` (`_process` signature), `app.py:1755` (the vision submit)
- Modify: `app.py:3023` (`_react_from_image` signature), `app.py:3094, 3107, 3143, 3180` (its vision calls)
- Modify: `app.py:1934` (`/analyze`), `app.py:3311` (`/react-from-image`)
- Modify: `app.py:2694` (`_image_reaction_then_explain` — uses the engine it already receives)

**Interfaces:**
- Consumes: `byok.anthropic_base_url` from Task 2.
- Produces: `_process(raw_bytes, api_key=None)` and `_react_from_image(raw_bytes, api_key=None)`; both endpoints accept an `api_key` form field.

- [ ] **Step 1: Import the routing helper**

Add near the `from prediction import (...)` block at `app.py:73`:

```python
from byok import anthropic_base_url
```

- [ ] **Step 2: Give `_anthropic_vision_call` the key**

Change its signature at `app.py:168` and the two lines that resolve the base URL and the auth header. The docstring gains a line about BYOK; everything else in the body is untouched.

```python
def _anthropic_vision_call(img_bytes: bytes, prompt: str,
                           api_key: str | None = None) -> str | None:
```

Replace the `base = ...` line at `app.py:184` with:

```python
    # A BYOK key routes by its own prefix and never inherits the server's
    # gateway (Parley rejects a real Anthropic key, and vice versa).
    base = anthropic_base_url(api_key, os.environ.get("ANTHROPIC_BASE_URL"))
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
```

Replace the `headers=` line at `app.py:190` with:

```python
            headers={"Authorization": f"Bearer {key}"},
```

The `logger.info("Claude vision call → model=%s url=%s", ...)` line at `app.py:186` stays exactly as it is — model and URL only, never the key.

- [ ] **Step 3: Give `_vision_call` the key and widen its gate**

Replace `app.py:265-274` with:

```python
def _vision_call(img_bytes: bytes, prompt: str,
                 api_key: str | None = None) -> str | None:
    """Route a vision read to the best available backend: Claude when a key is
    available — the caller's BYOK key first, else a server-side
    ANTHROPIC_API_KEY (which may point at a gateway like MIT Parley) — falling
    back to local Ollama otherwise or on any Claude failure."""
    if api_key or os.environ.get("ANTHROPIC_API_KEY"):
        result = _anthropic_vision_call(img_bytes, prompt, api_key)
        if result:
            return result
    return _ollama_call(img_bytes, prompt)
```

- [ ] **Step 4: Pass the key through both prompt wrappers**

In `_vision_smiles` (`app.py:277`) and `_vision_reaction_smiles` (`app.py:298`), add `api_key: str | None = None` to each signature and pass it as the third argument to `_vision_call`. **Do not touch the prompt strings** — both carry comments warning that the wording is load-bearing against the Parley content filter.

```python
def _vision_smiles(img_bytes: bytes, api_key: str | None = None) -> str | None:
```

Its `return _vision_call(` call gains a trailing argument after the prompt string:

```python
        api_key,
    )
```

Apply the same two changes to `_vision_reaction_smiles`.

- [ ] **Step 5: Thread the key into `_process`**

Change the signature at `app.py:1721`:

```python
def _process(raw_bytes: bytes, api_key: str | None = None) -> dict:
```

and the vision submit at `app.py:1755`:

```python
    vision_future = _vision_pool.submit(_vision_smiles, _vision_png(img), api_key)
```

Nothing else in `_process` changes — the DECIMER/MolScribe branches and `arbitrate_local` stay exactly as they are.

- [ ] **Step 6: Thread the key into `_react_from_image`**

Change the signature at `app.py:3023`:

```python
def _react_from_image(raw_bytes: bytes, api_key: str | None = None) -> dict:
```

and add `api_key` as the second argument to each of the four `_vision_reaction_smiles(_img_bytes)` calls at `app.py:3094, 3107, 3143, 3180`:

```python
_vision_reaction_smiles(_img_bytes, api_key)
```

- [ ] **Step 7: Accept the key on both image endpoints**

Add `Form` to the FastAPI import at `app.py:50`:

```python
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
```

Change `/analyze` at `app.py:1934-1935`:

```python
@app.post("/analyze", dependencies=[Depends(require_auth)])
async def analyze(file: UploadFile = File(...),
                  api_key: str | None = Form(default=None)):
```

and its executor call at `app.py:1942`:

```python
        result = await loop.run_in_executor(_executor, _process, contents, api_key)
```

Change `/react-from-image` at `app.py:3311-3313`:

```python
@app.post("/react-from-image")
async def react_from_image(file: UploadFile = File(...),
                           api_key: str | None = Form(default=None),
                           user_id: str | None = Depends(require_auth)):
```

and its executor call at `app.py:3321`:

```python
        result = await loop.run_in_executor(_executor, _react_from_image, contents, api_key)
```

- [ ] **Step 8: Use the engine's key in the chat image path**

`_image_reaction_then_explain` (`app.py:2694`) already receives `engine: Optional[EngineConfig]`, so no signature change is needed. Near the top of its body, before the first vision call, add:

```python
    vision_key = engine.api_key if engine else None
```

and pass `vision_key` as the second argument to every `_vision_reaction_smiles` call inside it.

- [ ] **Step 9: Verify no key can reach the logs**

```bash
grep -n "api_key" app.py | grep -i "logger\|logging\|print"
```

Expected: no output. If any line matches, remove the key from that log call.

- [ ] **Step 10: Verify the app still imports and the suites pass**

```bash
/tmp/orgo-lean/bin/python -c "import app; print('IMPORT OK')"
/tmp/orgo-lean/bin/python test_byok.py
/tmp/orgo-lean/bin/python test_proxy_auth.py
/tmp/orgo-lean/bin/python test_prediction.py
```

Expected: `IMPORT OK` and all three suites `0 failed`.

- [ ] **Step 11: Commit**

```bash
git add app.py
git commit -m "Route vision reads through the caller's BYOK key

With the local OSR readers out of the deployed image, photo recognition is
purely a vision API call — so it has to run on the user's key rather than a
server-side one. _vision_call now accepts a key, routes it by prefix, and
falls back to the server key when none is supplied."
```

---

### Task 6: Thread BYOK through chat tools and one-shot completions

Without this, BYOK chat silently loses `run_reaction`, and the low-confidence escalation CLAUDE.md calls load-bearing goes quiet.

**Files:**
- Modify: `app.py:419-430` (`_anthropic_complete`)
- Modify: `app.py:996-1010` (`_maybe_blind_guess`), `app.py:1028-1045` (`_maybe_sanity_check`)
- Modify: `app.py:1239-1247` (`_stream_anthropic_tools`)
- Modify: `app.py:2789-2795` (the tool-path dispatch gate)

**Interfaces:**
- Consumes: `byok.anthropic_base_url` (imported in Task 5).

- [ ] **Step 1: Give `_anthropic_complete` the key**

Change its signature at `app.py:419` and its client construction at `app.py:426`:

```python
async def _anthropic_complete(system: str, user: str, max_tokens: int,
                              model: str | None = None,
                              api_key: str | None = None) -> str:
```

```python
    key = api_key or os.environ["ANTHROPIC_API_KEY"]
    client = anthropic.AsyncAnthropic(
        api_key=key,
        base_url=anthropic_base_url(api_key, os.environ.get("ANTHROPIC_BASE_URL")),
    )
```

- [ ] **Step 2: Pass the key through the two escalation helpers**

Add `api_key: str | None = None` as the last parameter of `_maybe_blind_guess` (`app.py:996`) and `_maybe_sanity_check` (`app.py:1028`), and forward it on their `_anthropic_complete` calls at `app.py:1005` and `app.py:1038`:

```python
        raw = await _anthropic_complete(system, user, max_tokens=300, api_key=api_key)
```

```python
        raw = await _anthropic_complete(system, user, max_tokens=150, api_key=api_key)
```

Each helper's early return guard currently reads `if not os.environ.get("ANTHROPIC_API_KEY"):` — widen both to admit a BYOK key:

```python
    if not (api_key or os.environ.get("ANTHROPIC_API_KEY")):
```

- [ ] **Step 3: Give `ReactRequest` an engine field**

`/react` has no way to receive a key today — `ReactRequest` (`app.py:3223-3225`) carries only the two SMILES strings. Add the field:

```python
class ReactRequest(BaseModel):
    substrate_smiles: str
    reagent_smiles: str
    engine: Optional[EngineConfig] = None   # BYOK key for the escalation paths
```

- [ ] **Step 4: Forward the key from all six call sites**

In `/react` (`app.py:3266`), add this immediately after the `core = await _react_core(...)` line:

```python
    byok_key = req.engine.api_key if req.engine else None
```

Then add `api_key=byok_key` to the three calls at `app.py:3276`, `app.py:3292` and `app.py:3297`:

```python
        ai_guess = await _maybe_blind_guess(substrate, reagent, user_id, api_key=byok_key)
```

```python
            sanity_check = await _maybe_sanity_check(substrate, reagent, products, user_id,
                                                     api_key=byok_key)
```

In `react_from_image` (`app.py:3312`) the `api_key` form field added in Task 5 is already in scope, so the three calls at `app.py:3332`, `app.py:3339` and `app.py:3342` take it directly:

```python
            result["ai_guess"] = await _maybe_blind_guess(
                result["substrate_smiles"], result["reagent_smiles"], user_id,
                api_key=api_key)
```

```python
            result["sanity_check"] = await _maybe_sanity_check(
                result["substrate_smiles"], result["reagent_smiles"],
                result["products"], user_id, api_key=api_key)
```

Verify all six are updated:

```bash
grep -n "_maybe_blind_guess(\|_maybe_sanity_check(" app.py
```

Expected: the two `async def` definitions plus six call sites, every call site passing `api_key=`.

- [ ] **Step 5: Give `_stream_anthropic_tools` the key**

Change its signature at `app.py:1239` and its client at `app.py:1246`:

```python
async def _stream_anthropic_tools(system: str, messages: list[dict], max_tokens: int,
                                  surface: str, model: str | None = None,
                                  explain: bool = True,
                                  api_key: str | None = None):
```

```python
    key = api_key or os.environ["ANTHROPIC_API_KEY"]
    client = anthropic.AsyncAnthropic(
        api_key=key,
        base_url=anthropic_base_url(api_key, os.environ.get("ANTHROPIC_BASE_URL")),
    )
```

- [ ] **Step 6: Widen the tool-path dispatch gate**

The gate at `app.py:2789-2791` currently admits only hosted mode with a server key, which would silently drop `run_reaction` for every BYOK user. Replace that condition with:

```python
    byok_key = req.engine.api_key if req.engine else None
    if (surface_runs_reactions and not has_images
            and ((mode == "hosted" and os.environ.get("ANTHROPIC_API_KEY"))
                 or (mode == "byok" and byok_key))):
        _record_usage(mode, "anthropic")
        stream = _with_error_frames(_stream_anthropic_tools(
            system_prompt + _CHAT_TOOLS_SYSTEM, messages, 800,
            req.surface, model=req.engine.model if req.engine else None,
```

and add `api_key=byok_key,` to that `_stream_anthropic_tools(...)` argument list, keeping the existing `explain=` argument as-is.

Note `_record_usage("hosted", ...)` becomes `_record_usage(mode, ...)` so BYOK calls are attributed to BYOK rather than counted as hosted.

- [ ] **Step 7: Confirm hosted-quota metering still skips BYOK**

```bash
grep -n "def _enforce_hosted_quota" -A 6 app.py
```

Expected: the `if mode != "hosted": return` early exit is still the first branch, so BYOK calls stay unmetered. No change needed — this is a verification step.

- [ ] **Step 8: Verify the app imports and the suites pass**

```bash
/tmp/orgo-lean/bin/python -c "import app; print('IMPORT OK')"
/tmp/orgo-lean/bin/python test_prediction.py
/tmp/orgo-lean/bin/python test_askcos.py
/tmp/orgo-lean/bin/python test_templates.py
```

Expected: `IMPORT OK` and all three suites `0 failed`.

- [ ] **Step 9: Commit**

```bash
git add app.py
git commit -m "Run chat tools and escalations on the caller's key

BYOK previously covered only prose, so a BYOK user silently lost
run_reaction and the low-confidence escalation. Both now accept a
request-scoped key and route it by prefix; BYOK calls are attributed to
byok in the usage counters rather than to hosted."
```

---

### Task 7: Frontend — store the key and send it

**Files:**
- Modify: `frontend/lib/engine.ts`
- Modify: `frontend/src/api.js:18-29` (`analyzeImage`), `:47-60` (`reactFromImage`)

**Interfaces:**
- Produces: `loadApiKey(): string`, `saveApiKey(key: string): void`, and a `getEnginePayload()` that returns `mode: 'byok'` with an `api_key`. Task 9 imports `loadApiKey` and `saveApiKey`.

- [ ] **Step 1: Rewrite the header comment and `EnginePayload` in `frontend/lib/engine.ts`**

Replace the file's top comment block and the `EnginePayload` interface with:

```typescript
// Generative engine selection — BYOK. Every AI call runs on a key the user
// pastes into Settings; the deployed backend has no server-side key at all.
// The key lives in this browser's localStorage and rides along with each
// request, never persisted server-side (see EngineConfig in app.py).
//
// Only the *generative* features use this — explanations, chat, and (since
// local OSR is no longer deployed) structure recognition. The reaction engine
// and pathway search are deterministic and run free & keyless.

export interface EnginePayload {
  mode: 'byok'
  provider: 'anthropic'
  model?: string | null
  api_key?: string
}
```

- [ ] **Step 2: Add the key accessors**

Append to `frontend/lib/engine.ts`, following the `MODEL_KEY` pattern already in the file:

```typescript
// The user's own API key. A Parley gateway key (sk-parley-…) or a real
// Anthropic key both work — the backend routes by prefix. Stored per-browser,
// never sent anywhere but our own backend.
const API_KEY_KEY = 'orgo.engine.apiKey'

export function loadApiKey(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(API_KEY_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveApiKey(key: string): void {
  try {
    const trimmed = key.trim()
    if (trimmed) window.localStorage.setItem(API_KEY_KEY, trimmed)
    else window.localStorage.removeItem(API_KEY_KEY)
  } catch { /* storage unavailable — the key just won't persist */ }
}
```

- [ ] **Step 3: Send the key in `getEnginePayload`**

Replace the existing `getEnginePayload` at the end of the file:

```typescript
// The object attached to /explain, /stereo, and /chat request bodies.
// Without a model the server's default decides what runs.
export function getEnginePayload(modelOverride?: string | null): EnginePayload {
  const key = loadApiKey()
  return {
    mode: 'byok',
    provider: 'anthropic',
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(key ? { api_key: key } : {}),
  }
}
```

- [ ] **Step 4: Send the key on both image uploads**

`/analyze` and `/react-from-image` are multipart, so the key travels as a form field rather than in a JSON body. In `frontend/src/api.js`, update the import at line 1:

```javascript
import { getEnginePayload, loadApiKey } from '../lib/engine'
```

In `analyzeImage`, after `form.append('file', file)`:

```javascript
  const apiKey = loadApiKey()
  if (apiKey) form.append('api_key', apiKey)
```

Add the same two lines to `reactFromImage` after its own `form.append('file', file)`.

- [ ] **Step 5: Send the engine config on `/react`**

Task 6 added an `engine` field to `ReactRequest` so the low-confidence escalation can run on the user's key. `reactDirect` must now supply it:

```javascript
export async function reactDirect(substrateSMILES, reagentSMILES) {
  return post('/react', {
    substrate_smiles: substrateSMILES,
    reagent_smiles: reagentSMILES,
    engine: getEnginePayload(),
  })
}
```

- [ ] **Step 6: Verify the frontend compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. If `EnginePayload`'s `mode` change surfaces a type error at a call site, fix that call site — it means somewhere still asserts `'hosted'`.

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/engine.ts frontend/src/api.js
git commit -m "Send the user's own key with every AI request

The deployed backend has no server-side key, so the engine payload
switches to BYOK and the key rides along from localStorage. Image
uploads are multipart, so it goes as a form field there."
```

---

### Task 8: Frontend — the proxy middleware

`rewrites()` cannot add request headers, so the API paths move to middleware that injects the shared secret server-side.

**Files:**
- Create: `frontend/middleware.ts`
- Modify: `frontend/next.config.mjs`

- [ ] **Step 1: Create `frontend/middleware.ts`**

The path list is the same allowlist `next.config.mjs` used, kept in one place and exported so the config can stay in sync.

```typescript
// Server-side proxy to the FastAPI backend.
//
// This replaces the rewrites() rules for API paths because rewrites CANNOT
// add request headers, and the backend now requires a shared secret proving
// the request came from us. The secret is read from a NON-public env var, so
// it stays on the server and never reaches the browser.
//
// The backend uses the same header to decide whether X-Forwarded-For can be
// trusted for per-user rate limiting — see proxy_auth.py.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const apiBase = process.env.NEXT_PUBLIC_ORGO_API_BASE_URL ?? 'http://127.0.0.1:8000'

export function middleware(request: NextRequest) {
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, apiBase)

  const headers = new Headers(request.headers)
  const secret = process.env.ORGO_PROXY_SECRET
  if (secret) headers.set('x-orgo-proxy-secret', secret)

  return NextResponse.rewrite(url, { request: { headers } })
}

// Every backend path the app calls. Keep in sync with apiPaths in
// next.config.mjs. /structure and /molfile are loaded via <img src> but still
// travel through this proxy, so they need the header like any other path.
export const config = {
  matcher: [
    '/analyze',
    '/analyze/verify/:token*',
    '/predict',
    '/structure',
    '/molfile',
    '/pathways',
    '/explain',
    '/stereo',
    '/chat',
    '/assist',
    '/react',
    '/react/assess',
    '/react-from-image',
    '/engine/:path*',
    '/health',
  ],
}
```

- [ ] **Step 2: Remove the superseded rewrites**

The middleware now proxies every path the `rewrites()` block used to. Replace the whole body of `frontend/next.config.mjs` with:

```javascript
// API proxying lives in middleware.ts, NOT here: rewrites() cannot add the
// x-orgo-proxy-secret request header the backend requires. The matcher in
// middleware.ts is the path allowlist that used to live in this file.

/** @type {import('next').NextConfig} */
const nextConfig = {}

export default nextConfig
```

- [ ] **Step 3: Verify the frontend builds**

```bash
cd frontend && npm run build
```

Expected: a successful build, and the output lists `middleware` among the compiled routes.

- [ ] **Step 4: Verify the proxy end-to-end against a local backend**

```bash
ORGO_PROXY_SECRET=testsecret /tmp/orgo-lean/bin/python -m uvicorn app:app --port 8000 &
sleep 8
cd frontend && ORGO_PROXY_SECRET=testsecret npm start &
sleep 10
echo "--- through the proxy (expect 200) ---"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/pathways \
  -H 'Content-Type: application/json' -d '{"smiles":"CCO"}'
echo "--- direct to the backend, no secret (expect 403) ---"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8000/pathways \
  -H 'Content-Type: application/json' -d '{"smiles":"CCO"}'
kill %1 %2
```

Expected: `200` through the proxy, `403` direct. This is the whole mechanism working.

- [ ] **Step 5: Commit**

```bash
git add frontend/middleware.ts frontend/next.config.mjs
git commit -m "Proxy the API through middleware to inject the shared secret

rewrites() cannot add request headers, so the path allowlist moves to
middleware.ts, which attaches x-orgo-proxy-secret from a server-only env
var. The browser never sees the value."
```

---

### Task 9: Frontend — the API key field in Settings

**Files:**
- Modify: `frontend/src/platform/SettingsPage.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `loadApiKey`, `saveApiKey` from Task 7.

- [ ] **Step 1: Import the accessors and add key state**

In `frontend/src/platform/SettingsPage.tsx`, extend the existing import from `../../lib/engine` to include `loadApiKey` and `saveApiKey`, and add `useEffect`/`useState` to the React import if they are not already there.

Inside the component, above the existing `pick` function:

```tsx
  const [apiKey, setApiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)

  // localStorage is unavailable during SSR, so read it after mount.
  useEffect(() => { setApiKey(loadApiKey()) }, [])

  function commitKey(next: string) {
    setApiKey(next)
    saveApiKey(next)
    setKeySaved(true)
    window.setTimeout(() => setKeySaved(false), 1800)
  }
```

- [ ] **Step 2: Add the section**

Insert this as the **first** `<section>` inside the page `<div>`, above the existing `Default model` section — it is the setting without which nothing else works:

```tsx
      <section className="settings-section">
        <h2>API key</h2>
        <p className="settings-blurb">
          AI features — explanations, chat, and reading structures from photos —
          run on your own key. Paste an MIT Parley key (<code>sk-parley-…</code>)
          or an Anthropic key; we route it to the right place automatically.
        </p>
        <div className="settings-row">
          <input
            type="password"
            className="settings-input"
            value={apiKey}
            placeholder="sk-parley-…"
            autoComplete="off"
            spellCheck={false}
            onChange={e => setApiKey(e.target.value)}
            onBlur={e => commitKey(e.target.value)}
            aria-label="Your API key"
          />
          <button className="btn-quiet" onClick={() => commitKey(apiKey)}>
            Save
          </button>
        </div>
        <div className="settings-note">
          {keySaved
            ? 'Saved.'
            : apiKey
              ? 'Stored in this browser only. Sent with each request, never saved on our server.'
              : 'Without a key, drawing structures and predicting reactions still work — they run on the deterministic engine, no AI needed.'}
        </div>
      </section>
```

- [ ] **Step 3: Style the input**

Append to `frontend/src/App.css`:

```css
.settings-input {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.7rem;
  font-family: inherit;
  font-size: 0.9rem;
  color: inherit;
  background: var(--surface-2, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--border, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
}

.settings-input:focus {
  outline: 2px solid var(--accent, #4a6cf7);
  outline-offset: 1px;
}
```

If `--surface-2`, `--border` or `--accent` are not defined in this stylesheet, the fallbacks in each `var()` apply and no further change is needed.

- [ ] **Step 4: Verify it compiles and builds**

```bash
cd frontend && npx tsc --noEmit && npm run build
```

Expected: no type errors, successful build.

- [ ] **Step 5: Verify the key round-trips in the running app**

Start both processes, open `http://localhost:3000`, go to Settings, paste `sk-parley-test123`, and confirm:
1. The note changes to `Saved.` then to the "Stored in this browser only" text.
2. Reloading the page keeps the value in the field.
3. `localStorage.getItem('orgo.engine.apiKey')` in the browser console returns `sk-parley-test123`.
4. Clearing the field and blurring removes the entry (`localStorage.getItem(...)` returns `null`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/platform/SettingsPage.tsx frontend/src/App.css
git commit -m "Add the API key field to Settings

Placed first: it is the setting without which the AI features do nothing.
Says plainly that the key stays in this browser, and that the
deterministic chemistry works without one."
```

---

### Task 10: Update the docs to match the deployment

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Correct the engine description in `CLAUDE.md`**

The Frontend section currently says the engine is "effectively **hosted-only** from the UI" and that `lib/engine.ts` sends `{mode:'hosted', provider:'anthropic'}`. Replace that bullet with:

```markdown
- Engine is **BYOK**: `lib/engine.ts` sends `{mode:'byok', provider:'anthropic',
  api_key}` with the key the user pastes into Settings (stored in localStorage
  under `orgo.engine.apiKey`), plus a per-prompt model pick (Haiku / Sonnet /
  Opus — `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`). The
  backend routes the key by prefix: `sk-parley-*` to the MIT Parley gateway,
  anything else to `api.anthropic.com` (`byok.py`).
```

Also update the OSR bullet in the Backend section, which claims DECIMER + MolScribe always run, to note they are optional:

```markdown
- **OSR pipeline** (`_process`): image → `preprocessing.py` (OpenCV: perspective,
  deskew, denoise, binarize) → DECIMER + MolScribe reads → `osr_arbitration.py` picks
  the best SMILES, with optional vision-model (Anthropic/Ollama) round-trip verification.
  Models are lazy-loaded and warmed once (`_load_decimer`/`_load_molscribe`).
  **The local readers are optional** — they live in `requirements-osr.txt` and are not
  installed on Railway. Without them `arbitrate_local` returns its "nothing local"
  verdict and the vision model is the sole reader.
```

- [ ] **Step 2: Add a deployment section to `CLAUDE.md`**

Insert after the "Production & auth" section:

```markdown
## Split deployment (Railway + Vercel)

Backend on Railway, frontend on Vercel. `railway.json` supplies the start command
(`uvicorn app:app --host 0.0.0.0 --port $PORT`, one worker) and `/health` as the
healthcheck.

Railway installs `requirements.txt` only — the lean runtime. `requirements-osr.txt`
(DECIMER, MolScribe, torch) is for local development: together they pull ~7 GB and
blow the image limit, and without them recognition degrades to a vision API call,
which `osr_arbitration` already treats as a first-class path.

`ORGO_PROXY_SECRET` must match on both hosts. `frontend/middleware.ts` attaches it to
every proxied request; the backend rejects anything without it (403) and uses the same
signal to decide whether `X-Forwarded-For` can be trusted for rate-limit bucketing.
`/health` is exempt — Railway's healthcheck probes the backend directly. Leave the
variable unset locally and everything behaves as before.

**Do not set `ANTHROPIC_API_KEY` on Railway.** Every AI call runs on the user's own
key. The API has no per-user auth: the proxy secret authenticates the frontend, not
individual people.
```

- [ ] **Step 3: Fix the `README.md` install instructions**

Find the `pip install -r requirements.txt` line and replace it with:

```markdown
    pip install -r requirements.txt -r requirements-osr.txt
```

with a following line: `The second file holds the local OSR readers (DECIMER, MolScribe, torch). They are optional — without them, reading structures from images uses the vision model instead.`

- [ ] **Step 4: Verify no stale claims remain**

```bash
grep -n "hosted-only\|mode:'hosted'\|mode: 'hosted'" CLAUDE.md README.md
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the split deployment and the BYOK switch

CLAUDE.md still described the frontend as hosted-only and the local OSR
readers as always present; both changed."
```

---

## Deployment checklist (run after Task 10)

Not a code task — the settings a human sets in each dashboard.

**Railway:**
- `ORGO_ENV=dev`
- `ORGO_PROXY_SECRET=<generate: openssl rand -hex 32>`
- `ASKCOS_BASE_URL=https://askcos.mit.edu` (optional; unset falls back to templates)
- **No** `ANTHROPIC_API_KEY`
- Confirm the deploy log shows the DECIMER and MolScribe warm-up warnings — that is the lean image behaving correctly, not an error.

**Vercel:**
- `NEXT_PUBLIC_ORGO_API_BASE_URL=<the Railway public URL>`
- `ORGO_PROXY_SECRET=<the same value as Railway>` — **not** `NEXT_PUBLIC_`-prefixed, or it leaks to the browser.

**Verify after deploy:**
1. `curl <railway-url>/health` → 200.
2. `curl -X POST <railway-url>/pathways -H 'Content-Type: application/json' -d '{"smiles":"CCO"}'` → 403.
3. The same call through the Vercel URL → 200.
4. In the app with no key saved: typed reactions and pathways work; AI features report a missing key.
5. Paste a Parley key in Settings, then explain a reaction and upload a structure photo — both succeed.
