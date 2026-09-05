# User Profiles (Supabase Accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Supabase accounts (sign up, sign in, a profile) to the
localStorage-only workspace, syncing projects/sessions/engine settings to the cloud when
signed in, while guests keep working exactly as today.

**Architecture:** Frontend talks to Supabase directly (JS client + anon key + Row Level
Security) for all profile/project/settings data — no new backend CRUD endpoints. The
FastAPI backend gains one new thing: an `optional_auth` dependency that recognizes a
signed-in caller's token without requiring one, feeding the existing hosted-quota
counters and a new `usage_events` analytics log.

**Tech Stack:** Next.js/TypeScript frontend (`@supabase/supabase-js`), FastAPI/Python
backend (existing `PyJWT` verification, `httpx` for the one service-role write), Supabase
Postgres + Auth.

**Spec:** `docs/superpowers/specs/2026-09-04-user-profiles-design.md`

## Global Constraints

- Email + password only — no OAuth in this pass.
- No new backend CRUD endpoints for profiles/projects/sessions/settings — the frontend
  uses the Supabase client directly, guarded by RLS.
- The Supabase **service-role key** is backend-only, used for exactly one thing (the
  `usage_events` insert), never sent to the client, never logged.
- The BYOK Anthropic API key never touches Supabase or any table added here.
- `optional_auth`: present valid token → real user id; absent token → `None`
  (anonymous); present invalid token → 401 (never silently downgrades to anonymous);
  verification unconfigured (`AUTH_ENABLED` false) → always `None`.
- The `ORGO_ENV=prod` "refuse to boot without a verification method" guard is removed —
  no endpoint mandates a token under this design.
- `_enforce_hosted_quota`'s in-memory counters are unchanged — they already key on
  `user_id or "anon"`; only the value they receive stops always being `None`.
- Migration of existing localStorage data to a new account happens once per **browser**
  (a local flag), not once per account — a documented, accepted limitation.
- Out of scope (do not build): OAuth providers, a "sign-in required" deployment mode,
  moving hosted-quota storage into the database, cross-device migration merging, an
  admin/analytics UI over `usage_events`.

---

## File Structure

**Backend:**
- Modify: `supabase/schema.sql` — add `profiles`, `usage_events`, a signup trigger, and
  fix a latent FK bug (`chemistry_files.project_id` cascade)
- Modify: `SUPABASE_SETUP.md` — note the new tables and the (still manual) apply step
- Modify: `app.py` — `optional_auth` replaces `require_auth`; new `_log_usage_event` /
  `_post_usage_event`
- Modify: `.env.example` — `SUPABASE_SERVICE_ROLE_KEY`
- Create: `test_auth.py` — offline unit test for `optional_auth`
- Create: `test_usage_events.py` — offline unit test for the usage-log write path
- Create: `test_supabase_rls.py` — RLS isolation check; requires a real Supabase project
  (skips itself otherwise), run manually once before calling this feature done

**Frontend:**
- Modify: `frontend/package.json` — add `@supabase/supabase-js`
- Modify: `frontend/.env.example` (or `SUPABASE_SETUP.md` if no such file exists yet) —
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Create: `frontend/lib/supabase.ts` — the one Supabase client instance
- Create: `frontend/lib/sessionStore.ts` — the `SessionStore` interface
- Create: `frontend/lib/localSessionStore.ts` — wraps existing `lib/sessions.ts` to match it
- Create: `frontend/lib/cloudSessionStore.ts` — Supabase-backed implementation
- Create: `frontend/lib/migrate.ts` — one-time local→cloud upload
- Create: `frontend/lib/auth.tsx` — `AuthProvider` / `useAuth()`
- Create: `frontend/lib/cloudSettings.ts` — reads/writes `user_settings.engine`
- Create: `frontend/src/platform/AccountPage.tsx` — sign-in/sign-up + profile panel
- Modify: `frontend/src/platform/NavRail.tsx` — add the Account rail button
- Modify: `frontend/lib/sessions.ts` — `View` gains `'account'`
- Modify: `frontend/src/platform/Workspace.tsx` — render the account view; storage calls
  go through `useAuth().store` instead of the static `lib/sessions.ts` functions
- Modify: `frontend/app/page.tsx` — wrap `<Workspace />` in `<AuthProvider>`
- Modify: `frontend/src/api.js` — attach `Authorization: Bearer <token>` when signed in
- Modify: `frontend/src/platform/SettingsPage.tsx` — push the model preference to
  `user_settings` when signed in

---

### Task 1: Supabase schema — profiles, usage_events, and a cascade fix

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `SUPABASE_SETUP.md`

**Interfaces:**
- Produces: tables `public.profiles(id, display_name, avatar_url, created_at)` and
  `public.usage_events(id, user_id, endpoint, created_at)`, both RLS-enabled; a
  `handle_new_user()` trigger populating `profiles` on signup. `chemistry_files.project_id`
  now `on delete set null` instead of `on delete cascade`.

This task has no automated test — RLS enforcement is a Postgres property, not
application logic (see Task 4). Verification here is a careful read plus the manual
apply step documented below.

- [ ] **Step 1: Fix the latent cascade bug**

Open `supabase/schema.sql`. Find:

```sql
create table if not exists public.chemistry_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
```

Replace with:

```sql
create table if not exists public.chemistry_files (
  id uuid primary key default gen_random_uuid(),
  -- set null (not cascade): deleting a project must keep its sessions and
  -- just ungroup them — matches frontend/lib/sessions.ts's deleteProject,
  -- which keeps sessions and clears their projectId. The original "on
  -- delete cascade" here was never exercised (nothing wrote to this table
  -- yet), so this fixes it before any real data exists.
  project_id uuid references public.projects(id) on delete set null,
```

- [ ] **Step 2: Append the new tables, trigger, and policies**

Append to the end of `supabase/schema.sql`:

```sql
-- ── Profiles ──────────────────────────────────────────────────────────────
-- Auto-created for every signed-up user by the trigger below — no client
-- insert needed, so there's no race between signup and first profile read.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamp with time zone default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can select own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can select own profile"
on public.profiles for select
using (auth.uid() = id);

create policy "Users can update own profile"
on public.profiles for update
using (auth.uid() = id)
with check (auth.uid() = id);
-- No insert/delete policy: rows are created only by the trigger below and
-- removed only by the auth.users cascade above — never directly by a client.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ── Usage analytics log ──────────────────────────────────────────────────
-- Written server-side only (app.py's _post_usage_event, using
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS). Users may read their own
-- log; nothing but the service role may write to it, so a client can't
-- spoof or erase its own usage.
create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  endpoint text not null,
  created_at timestamp with time zone default now()
);

create index if not exists usage_events_user_id_created_at_idx
  on public.usage_events(user_id, created_at desc);

alter table public.usage_events enable row level security;

drop policy if exists "Users can select own usage" on public.usage_events;
create policy "Users can select own usage"
on public.usage_events for select
using (auth.uid() = user_id);
-- Deliberately no insert/update/delete policy for anon/authenticated.
```

- [ ] **Step 3: Update `SUPABASE_SETUP.md`**

In the section describing what running `schema.sql` creates (currently listing
`projects`, `chemistry_files`, `user_settings`, indexes, triggers, RLS policies), add
`profiles` and `usage_events` to that list, and add one sentence noting `profiles` rows
are created automatically by a trigger on signup — no separate step needed. Also correct
the "Routes" list at the bottom (`/login`, `/signup`, `/dashboard`, `/projects/[projectId]`)
to say accounts are an overlay on the single-page workspace (`/`), not separate routes —
this doc currently describes an abandoned multi-route design that the rest of this plan
does not revive.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql SUPABASE_SETUP.md
git commit -m "schema: add profiles + usage_events, fix chemistry_files cascade bug"
```

---

### Task 2: Backend — `optional_auth` replaces `require_auth`

**Files:**
- Modify: `app.py:1049-1129` (auth config block + `require_auth` definition), and all 10
  call sites of `Depends(require_auth)`
- Modify: `.env.example`
- Test: `test_auth.py` (new)

**Interfaces:**
- Produces: `async def optional_auth(authorization: str = Header(default="")) -> str | None`
  — same signature shape `require_auth` had, so every existing
  `Depends(require_auth)` / `user_id: str | None = Depends(require_auth)` call site
  becomes `Depends(optional_auth)` with no other change.
- Produces: module-level `SUPABASE_URL: str | None` and `SUPABASE_SERVICE_ROLE_KEY: str | None`
  (used by Task 3).

- [ ] **Step 1: Write the failing test**

Create `test_auth.py`:

```python
"""
test_auth.py — Regression suite for optional_auth (app.py).

Run before committing changes to the auth section of app.py:

    python test_auth.py

Plain Python on purpose (matching test_templates.py): one PASS/FAIL line per
case, non-zero exit on any failure. Imports app.py directly — the only
top-level heavy import there is cv2 (see
docs/superpowers/specs/2026-09-03-byok-railway-deploy-design.md), so this
stays fast and needs no live Supabase project: HS256 verification is a local
computation (no JWKS network call), which is exactly the path exercised here.
"""

import asyncio
import sys

import jwt
from fastapi import HTTPException

import app

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    if ok:
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


def run(authorization: str):
    return asyncio.run(app.optional_auth(authorization=authorization))


TEST_SECRET = "test-secret-do-not-use-in-prod"


def make_token(secret: str = TEST_SECRET, **claims) -> str:
    payload = {"sub": "user-123", "aud": "authenticated", **claims}
    return jwt.encode(payload, secret, algorithm="HS256")


# ── AUTH_ENABLED, with a valid HS256 secret configured ────────────────────────
app.AUTH_ENABLED = True
app.SUPABASE_JWT_SECRET = TEST_SECRET
app.SUPABASE_JWKS_URL = None

result = run(f"Bearer {make_token()}")
check("valid token returns the real user id", result == "user-123", repr(result))

result = run("")
check("no Authorization header returns None (anonymous), not a 401",
      result is None, repr(result))

try:
    run("Bearer not-a-real-jwt")
    check("a garbage token 401s (doesn't silently return None)", False)
except HTTPException as exc:
    check("a garbage token 401s", exc.status_code == 401, repr(exc))

try:
    run(f"Bearer {make_token(secret='wrong-secret')}")
    check("a token signed with the wrong secret 401s", False)
except HTTPException as exc:
    check("a token signed with the wrong secret 401s", exc.status_code == 401, repr(exc))

check("a non-Bearer Authorization header is treated as anonymous",
      run("Basic dXNlcjpwYXNz") is None)

# ── AUTH_ENABLED false: nothing can be verified, so always anonymous ─────────
app.AUTH_ENABLED = False

result = run(f"Bearer {make_token()}")
check("AUTH_ENABLED false returns None even with a well-formed token",
      result is None, repr(result))

print(f"\n{len(failures)} failing" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python test_auth.py`
Expected: `ModuleNotFoundError`/`AttributeError` — `app.optional_auth` does not exist yet
(only `app.require_auth` does).

- [ ] **Step 3: Replace the auth config block**

In `app.py`, find (the block immediately before `_jwks_client = None`):

```python
# Optional Supabase JWT auth. Enabled when either verification method is
# configured; disabled otherwise so local dev works out of the box. When
# enabled, protected endpoints require a valid Supabase access token (the
# frontend attaches `Authorization: Bearer <token>` to all API calls).
#
#   SUPABASE_JWT_SECRET — legacy shared-secret projects (HS256).
#   SUPABASE_URL / SUPABASE_JWKS_URL — projects on JWT signing keys, the
#     Supabase default since May 2025: tokens are RS256/ES256/EdDSA and are
#     verified against the project's public JWKS endpoint. SUPABASE_URL is the
#     same value the frontend uses as NEXT_PUBLIC_SUPABASE_URL.
#
# A project mid-migration can set both; the token's alg header picks the path.
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")
SUPABASE_JWKS_URL = os.environ.get("SUPABASE_JWKS_URL") or (
    f"{os.environ['SUPABASE_URL'].rstrip('/')}/auth/v1/.well-known/jwks.json"
    if os.environ.get("SUPABASE_URL") else None
)
AUTH_ENABLED = bool(SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)

# Deployment mode. "dev" (default) keeps auth optional for local use. "prod"
# refuses to start without a token-verification method, so the API can never
# reach a real network with auth silently disabled — the failure is at boot,
# not after someone finds the open endpoint.
ORGO_ENV = os.environ.get("ORGO_ENV", "dev").lower()
IS_PROD = ORGO_ENV in ("prod", "production")
if IS_PROD and not AUTH_ENABLED:
    raise RuntimeError(
        "ORGO_ENV=prod requires a way to verify Supabase tokens: set SUPABASE_URL "
        "(project URL — tokens verified via its public JWKS; Supabase default "
        "since May 2025) and/or SUPABASE_JWT_SECRET (legacy HS256 shared secret). "
        "Without one, every endpoint would be unauthenticated. Set one, or run "
        "with ORGO_ENV=dev for local development."
    )

_jwks_client = None
```

Replace with:

```python
# Supabase JWT auth — OPTIONAL per request, not gated on deployment mode.
# Verifies a token when the caller presents one (real user_id, used for
# hosted-quota keying and the usage_events analytics log — see
# _log_usage_event below); a caller with no token is anonymous, exactly as
# before accounts existed. This is what lets signed-in and guest use
# coexist — see optional_auth() below and
# docs/superpowers/specs/2026-09-04-user-profiles-design.md.
#
#   SUPABASE_JWT_SECRET — legacy shared-secret projects (HS256).
#   SUPABASE_URL / SUPABASE_JWKS_URL — projects on JWT signing keys, the
#     Supabase default since May 2025: tokens are RS256/ES256/EdDSA and are
#     verified against the project's public JWKS endpoint. SUPABASE_URL is the
#     same value the frontend uses as NEXT_PUBLIC_SUPABASE_URL.
#
# A project mid-migration can set both; the token's alg header picks the path.
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")
SUPABASE_JWKS_URL = os.environ.get("SUPABASE_JWKS_URL") or (
    f"{SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else None
)
AUTH_ENABLED = bool(SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)

# Backend-only credential, used ONLY to write to usage_events (see
# _post_usage_event) — it bypasses Row Level Security, so it must never be
# sent to the client or logged. Everything else the frontend does against
# Supabase (profiles/projects/chemistry_files/user_settings) goes through
# the client-side anon key instead, guarded by RLS in supabase/schema.sql.
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Deployment mode. Historically "prod" refused to boot without a
# token-verification method configured; that guard is gone now that no
# endpoint mandates a token (optional_auth degrades to anonymous instead of
# rejecting). ORGO_ENV is kept for anything else that wants to distinguish
# environments.
ORGO_ENV = os.environ.get("ORGO_ENV", "dev").lower()
IS_PROD = ORGO_ENV in ("prod", "production")

_jwks_client = None
```

- [ ] **Step 4: Replace `require_auth` with `optional_auth`**

Find:

```python
async def require_auth(authorization: str = Header(default="")):
    if not AUTH_ENABLED:
        return None  # auth disabled (dev)
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    try:
        return await asyncio.to_thread(_verify_token, authorization[7:])
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
```

Replace with:

```python
async def optional_auth(authorization: str = Header(default="")):
    """Verify a Supabase access token when one is presented; anonymous
    (None) when absent — regardless of whether verification is configured.
    A PRESENT-but-invalid token still 401s: silently downgrading a rejected
    token to anonymous would let a broken verification path misattribute a
    signed-in user's calls to "anon" without anyone noticing.
    """
    if not AUTH_ENABLED or not authorization.startswith("Bearer "):
        return None
    try:
        return await asyncio.to_thread(_verify_token, authorization[7:])
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
```

- [ ] **Step 5: Update every call site**

```bash
sed -i '' 's/Depends(require_auth)/Depends(optional_auth)/g' app.py
grep -n "require_auth" app.py   # expect: no matches
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python test_auth.py`
Expected: `All checks passed`, exit code 0.

- [ ] **Step 7: Regression-check the untouched suites**

Run: `python test_prediction.py && python test_askcos.py && python test_templates.py`
Expected: all still pass — this task touches only the auth section, nothing these
suites exercise.

- [ ] **Step 8: Document the new env var**

In `.env.example`, in the "Production" section near the existing `SUPABASE_URL` /
`SUPABASE_JWT_SECRET` comments, add:

```
# SUPABASE_SERVICE_ROLE_KEY=...     # backend-only; used ONLY to write usage_events
#                                    # (bypasses RLS — never expose this to the frontend)
```

- [ ] **Step 9: Commit**

```bash
git add app.py test_auth.py .env.example
git commit -m "auth: optional_auth replaces mandatory require_auth on chemistry endpoints"
```

---

### Task 3: Backend — usage_events analytics log

**Files:**
- Modify: `app.py` (add `_log_usage_event`/`_post_usage_event`; call the former from 9
  chemistry endpoints)
- Test: `test_usage_events.py` (new)

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Task 2); `user_id: str | None`
  from each endpoint's `optional_auth` dependency.
- Produces: `def _log_usage_event(endpoint: str, user_id: str | None) -> None` — called at
  the top of each endpoint body, fire-and-forget.

- [ ] **Step 1: Write the failing test**

Create `test_usage_events.py`:

```python
"""
test_usage_events.py — Regression suite for the usage_events write path.

Run before committing changes to _post_usage_event in app.py:

    python test_usage_events.py

Matches test_askcos.py's approach: drives the real function through an
injected httpx.MockTransport (via _post_usage_event's `transport` test seam),
so no live Supabase project is needed and nothing here touches the network.
"""

import asyncio
import sys

import httpx

import app

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    if ok:
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


app.SUPABASE_URL = "https://example.supabase.co"
app.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key"

captured = []


def handler(request: httpx.Request) -> httpx.Response:
    captured.append(request)
    return httpx.Response(201, json=[{"id": 1}])


asyncio.run(app._post_usage_event("react", "user-123", transport=httpx.MockTransport(handler)))

check("posted exactly one request", len(captured) == 1, str(len(captured)))
if captured:
    req = captured[0]
    check("posts to the usage_events REST path",
          req.url.path == "/rest/v1/usage_events", str(req.url))
    check("carries the service-role key as apikey and bearer",
          req.headers.get("apikey") == "test-service-role-key"
          and req.headers.get("authorization") == "Bearer test-service-role-key",
          str(dict(req.headers)))
    import json
    body = json.loads(req.content)
    check("body carries user_id and endpoint",
          body == {"user_id": "user-123", "endpoint": "react"}, str(body))

# ── Failure modes must never raise ────────────────────────────────────────────

def raising_handler(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)

try:
    asyncio.run(app._post_usage_event(
        "react", "user-123", transport=httpx.MockTransport(raising_handler)))
    check("a network failure is swallowed, not raised", True)
except Exception as exc:
    check("a network failure is swallowed, not raised", False, repr(exc))


def erroring_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(500, json={"message": "internal error"})

try:
    asyncio.run(app._post_usage_event(
        "react", "user-123", transport=httpx.MockTransport(erroring_handler)))
    check("a 500 response is swallowed, not raised", True)
except Exception as exc:
    check("a 500 response is swallowed, not raised", False, repr(exc))

# ── _log_usage_event: the no-op guards ────────────────────────────────────────

app.SUPABASE_URL = None
app.SUPABASE_SERVICE_ROLE_KEY = None
check("no Supabase config configured → _log_usage_event does not schedule anything",
      app._log_usage_event("react", "user-123") is None)

app.SUPABASE_URL = "https://example.supabase.co"
app.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key"
check("anonymous caller (user_id=None) → _log_usage_event does not schedule anything",
      app._log_usage_event("react", None) is None)

print(f"\n{len(failures)} failing" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python test_usage_events.py`
Expected: `AttributeError: module 'app' has no attribute '_post_usage_event'`

- [ ] **Step 3: Implement `_log_usage_event` / `_post_usage_event`**

In `app.py`, immediately after the `_enforce_hosted_quota` function (the block ending
`_hosted_usage[key] = _hosted_usage.get(key, 0) + 1`), add:

```python
# ── Usage analytics log (Supabase) ────────────────────────────────────────────
# Separate from _enforce_hosted_quota above: that meters ONLY hosted-mode
# generative calls against the daily cap. This logs every chemistry-endpoint
# call from a SIGNED-IN user (any engine mode, including BYOK and templates
# alone) for analytics. Anonymous calls are not logged: there is no user_id
# to attach them to.


def _log_usage_event(endpoint: str, user_id: str | None) -> None:
    """Fire-and-forget: schedules the write as a background task so a slow or
    unreachable Supabase project can never add latency to the caller's actual
    response. Never raises."""
    if not user_id or not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return
    asyncio.create_task(_post_usage_event(endpoint, user_id))


async def _post_usage_event(endpoint: str, user_id: str,
                            transport: "httpx.BaseTransport | None" = None) -> None:
    """The actual write. `transport` is a test seam only (see
    test_usage_events.py) — production calls always leave it None. Uses
    SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level Security, so this is
    the one path in the app allowed to write usage_events; it must never be
    logged or exposed to a client."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0, transport=transport) as client:
            resp = await client.post(
                f"{SUPABASE_URL.rstrip('/')}/rest/v1/usage_events",
                json={"user_id": user_id, "endpoint": endpoint},
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
    except Exception:
        logger.warning("usage_events log failed for endpoint=%s", endpoint, exc_info=True)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python test_usage_events.py`
Expected: `All checks passed`, exit code 0.

- [ ] **Step 5: Wire the call into each chemistry endpoint**

Add `_log_usage_event("<name>", user_id)` as the first statement of each endpoint body
below. `/analyze` and `/pathways` currently declare auth via
`dependencies=[Depends(optional_auth)]` without capturing `user_id` — change those two
to capture it as a parameter, matching the other endpoints.

`/analyze` (`app.py`, decorator + signature):

```python
@app.post("/analyze")
async def analyze(file: UploadFile = File(...), engine: str | None = Form(default=None),
                  user_id: str | None = Depends(optional_auth)):
    _log_usage_event("analyze", user_id)
    contents = await file.read()
```

`/pathways`:

```python
@app.post("/pathways")
async def pathways(req: PathwaysRequest, user_id: str | None = Depends(optional_auth)):
    _log_usage_event("pathways", user_id)
    from rdkit import Chem
```

`/explain`, `/stereo`, `/chat`, `/assist`, `/react/assess` (same shape — shown once for
`/explain`; apply identically to the other four, using each one's own endpoint name and
existing first line):

```python
async def explain(req: ExplainRequest, user_id: str | None = Depends(optional_auth)):
    _log_usage_event("explain", user_id)
    _enforce_hosted_quota(req.engine, user_id)
```

(`/stereo` → `_log_usage_event("stereo", user_id)`; `/chat` → `"chat"`; `/assist` →
`"assist"`; `/react/assess` → `_log_usage_event("react/assess", user_id)`, function name
`react_assess`.)

`/react`:

```python
async def react(req: ReactRequest, user_id: str | None = Depends(optional_auth)):
    """Return all predicted products for a given substrate + reagent SMILES pair."""
    _log_usage_event("react", user_id)
    core = await _react_core(req.substrate_smiles, req.reagent_smiles)
```

`/react-from-image`:

```python
async def react_from_image(file: UploadFile = File(...),
                           engine: str | None = Form(default=None),
                           user_id: str | None = Depends(optional_auth)):
    _log_usage_event("react-from-image", user_id)
    contents = await file.read()
```

`/analyze/verify/{token}` intentionally gets no logging call — it only polls for an
already-in-flight vision read, not a fresh chemistry action.

- [ ] **Step 6: Re-run the full offline suite**

Run: `python test_auth.py && python test_usage_events.py && python test_prediction.py && python test_askcos.py && python test_templates.py`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app.py test_usage_events.py
git commit -m "analytics: log signed-in chemistry-endpoint usage to Supabase"
```

---

### Task 4: RLS isolation check (manual gate, requires a real Supabase project)

**Files:**
- Create: `test_supabase_rls.py`

**Interfaces:**
- Consumes: `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY` env vars pointing at a Supabase
  project with Task 1's `schema.sql` applied and email confirmation disabled (per
  `SUPABASE_SETUP.md` step 3).

This is the one task in this plan that cannot be verified by running code in this repo
alone — RLS is enforced by Postgres, not application logic, so "the SQL reads correctly"
is not evidence it works. **Do not consider the user-profiles feature done until this
has been run against a real project and passed.**

- [ ] **Step 1: Write the script**

Create `test_supabase_rls.py`:

```python
"""
test_supabase_rls.py — Confirms Row Level Security actually isolates users.

Run against a REAL Supabase project with supabase/schema.sql applied and
email confirmations disabled (SUPABASE_SETUP.md, step 3):

    TEST_SUPABASE_URL=https://your-project.supabase.co \
    TEST_SUPABASE_ANON_KEY=your-anon-key \
    python test_supabase_rls.py

Skipped (not failed) when those env vars are unset. See
docs/superpowers/specs/2026-09-04-user-profiles-design.md, Testing.

Creates two throwaway accounts, has one write rows, then asserts the other
account's token cannot read, update, or delete them, that neither can write
to usage_events (service-role only), and that each account's signup trigger
created exactly its own profiles row.

Test accounts accumulate in auth.users — delete them from the Supabase
dashboard after running. Not automated here; out of scope for a one-time
verification gate.
"""

import json
import os
import sys
import uuid

import httpx

BASE = os.environ.get("TEST_SUPABASE_URL", "").rstrip("/")
ANON_KEY = os.environ.get("TEST_SUPABASE_ANON_KEY", "")

if not BASE or not ANON_KEY:
    print("SKIP  set TEST_SUPABASE_URL and TEST_SUPABASE_ANON_KEY to run this suite")
    sys.exit(0)

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    if ok:
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


def sign_up(email: str, password: str) -> tuple[str, str]:
    resp = httpx.post(
        f"{BASE}/auth/v1/signup",
        json={"email": email, "password": password},
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    data = resp.json()
    return data["access_token"], data["user"]["id"]


def rest(token: str) -> httpx.Client:
    return httpx.Client(
        base_url=f"{BASE}/rest/v1",
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )


stamp = uuid.uuid4().hex[:8]
token_a, user_a = sign_up(f"rls-test-a-{stamp}@example.com", "test-password-123!")
token_b, user_b = sign_up(f"rls-test-b-{stamp}@example.com", "test-password-123!")

with rest(token_a) as client_a, rest(token_b) as client_b:
    created = client_a.post("/projects", json={
        "user_id": user_a, "name": "RLS test project", "description": "",
    })
    check("user A can create their own project", created.status_code == 201, created.text)
    project_a_id = created.json()[0]["id"]

    leaked = client_b.get("/projects", params={"id": f"eq.{project_a_id}"})
    check("user B's read of user A's project returns nothing",
          leaked.status_code == 200 and leaked.json() == [], leaked.text)

    blocked_update = client_b.patch(
        "/projects", params={"id": f"eq.{project_a_id}"}, json={"name": "hijacked"})
    reread = client_a.get("/projects", params={"id": f"eq.{project_a_id}"})
    check("user B's update of user A's project has no effect",
          reread.status_code == 200 and reread.json()[0]["name"] == "RLS test project",
          f"update_status={blocked_update.status_code} reread={reread.text}")

    blocked_delete = client_b.delete("/projects", params={"id": f"eq.{project_a_id}"})
    still_there = client_a.get("/projects", params={"id": f"eq.{project_a_id}"})
    check("user B's delete of user A's project has no effect",
          still_there.status_code == 200 and len(still_there.json()) == 1,
          f"delete_status={blocked_delete.status_code}")

    spoofed = client_a.post("/usage_events", json={"user_id": user_a, "endpoint": "react"})
    check("a user token cannot insert into usage_events (service-role only)",
          spoofed.status_code in (401, 403), spoofed.text)

    own_profile = client_a.get("/profiles", params={"id": f"eq.{user_a}"})
    check("signup's trigger created a profile row for user A",
          own_profile.status_code == 200 and len(own_profile.json()) == 1, own_profile.text)

    others_profile = client_b.get("/profiles", params={"id": f"eq.{user_a}"})
    check("user B's read of user A's profile returns nothing",
          others_profile.status_code == 200 and others_profile.json() == [], others_profile.text)

    client_a.delete("/projects", params={"id": f"eq.{project_a_id}"})

print(f"\n{len(failures)} failing" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
```

- [ ] **Step 2: Create a real (or free-tier) Supabase project and apply the schema**

In the Supabase dashboard: create a project, open the SQL editor, paste the full
contents of `supabase/schema.sql`, run it. Under Auth settings, enable the Email
provider and disable email confirmations (`SUPABASE_SETUP.md`, step 3) so this script's
sign-ups return a usable session immediately.

- [ ] **Step 3: Run it**

```bash
TEST_SUPABASE_URL=https://your-project.supabase.co \
TEST_SUPABASE_ANON_KEY=your-anon-key \
python test_supabase_rls.py
```

Expected: `All checks passed`, exit code 0. If anything fails, do not proceed to Tasks
5-11 until the schema/policies are fixed and this passes — those tasks build the
frontend on top of the assumption that RLS actually isolates users.

- [ ] **Step 4: Delete the two test accounts**

In the Supabase dashboard → Authentication → Users, delete the two `rls-test-*` accounts
created by this run.

- [ ] **Step 5: Commit**

```bash
git add test_supabase_rls.py
git commit -m "test: add RLS isolation check for the Supabase schema"
```

---

### Task 5: Frontend — Supabase client

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/lib/supabase.ts`

**Interfaces:**
- Produces: `export const supabase: SupabaseClient` — the one client instance every
  later frontend task imports.

- [ ] **Step 1: Add the dependency**

In `frontend/package.json`, add to `"dependencies"`:

```json
    "@supabase/supabase-js": "^2.45.0",
```

Run: `cd frontend && npm install`
Expected: installs cleanly, `frontend/package-lock.json` (or equivalent) updates.

- [ ] **Step 2: Create the client module**

Create `frontend/lib/supabase.ts`:

```typescript
// Single Supabase client for the browser — Auth plus direct table access
// (profiles/projects/chemistry_files/user_settings), guarded by Row Level
// Security. See docs/superpowers/specs/2026-09-04-user-profiles-design.md.
//
// NEXT_PUBLIC_* vars are safe to ship to the browser: the anon key grants no
// access by itself — RLS (auth.uid() = user_id on every table) is the actual
// boundary. See supabase/schema.sql.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

if (!url || !anonKey) {
  // Accounts are optional — the app works keyless/accountless out of the
  // box (see CLAUDE.md) — so this can't throw. A client built on placeholder
  // values fails every auth/db call at request time instead, which
  // AuthProvider (lib/auth.tsx) surfaces as an ordinary sign-in error rather
  // than a crashed page.
  console.warn(
    'NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY not set — ' +
    'sign-in is unavailable; the app still works fully signed-out.',
  )
}

export const supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder')
```

- [ ] **Step 3: Document the new env vars**

Add a `frontend/.env.example` if one does not already exist (check first: `ls frontend/.env.example`).
If it doesn't exist, create it with:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

If `frontend/.env.example` already exists, add those two lines to it instead of
overwriting the file.

- [ ] **Step 4: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds (the placeholder fallback in Step 2 means this builds even with no
`.env.local` present). There is no frontend test suite (CLAUDE.md) — a clean build is
the verification for every frontend task in this plan.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/lib/supabase.ts frontend/.env.example
git commit -m "frontend: add the Supabase client"
```

---

### Task 6: Frontend — `SessionStore` interface (local + cloud implementations)

**Files:**
- Create: `frontend/lib/sessionStore.ts`
- Create: `frontend/lib/localSessionStore.ts`
- Create: `frontend/lib/cloudSessionStore.ts`

**Interfaces:**
- Consumes: `Session`, `Project` types and the existing sync functions from
  `frontend/lib/sessions.ts` (unchanged): `loadSessions`, `saveSession`, `deleteSession`,
  `loadProjects`, `createProject`, `updateProject`, `deleteProject`, `clearAll`,
  `autoTitle`. Consumes `supabase` from Task 5.
- Produces: `interface SessionStore { loadSessions, saveSession, deleteSession,
  loadProjects, createProject, updateProject, deleteProject, clearAll }` (all async),
  `export const localSessionStore: SessionStore`, and
  `export function makeCloudSessionStore(userId: string): SessionStore` — both consumed
  by Task 8 (`lib/auth.tsx`) and Task 10 (`Workspace.tsx`).

- [ ] **Step 1: Define the interface**

Create `frontend/lib/sessionStore.ts`:

```typescript
// The storage backend Workspace.tsx reads/writes through — one
// implementation per account state. Signed out uses localSessionStore
// (frontend/lib/sessions.ts, unchanged); signed in uses a
// makeCloudSessionStore(userId) built on Supabase + RLS. Workspace never
// calls lib/sessions.ts's storage functions directly once this lands — see
// docs/superpowers/specs/2026-09-04-user-profiles-design.md.
import type { Project, Session } from './sessions'

export interface SessionStore {
  loadSessions(): Promise<Session[]>
  saveSession(session: Session): Promise<Session>
  deleteSession(id: string): Promise<void>
  loadProjects(): Promise<Project[]>
  createProject(name: string, description?: string): Promise<Project>
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description'>>): Promise<Project | null>
  deleteProject(id: string): Promise<void>
  clearAll(): Promise<void>
}
```

- [ ] **Step 2: Wrap the existing localStorage code**

Create `frontend/lib/localSessionStore.ts`:

```typescript
// Wraps the existing synchronous localStorage functions to match
// SessionStore's async shape — no behavior change from before this feature.
import {
  clearAll, createProject, deleteProject, deleteSession,
  loadProjects, loadSessions, saveSession, updateProject,
} from './sessions'
import type { SessionStore } from './sessionStore'

export const localSessionStore: SessionStore = {
  loadSessions: async () => loadSessions(),
  saveSession: async session => saveSession(session),
  deleteSession: async id => deleteSession(id),
  loadProjects: async () => loadProjects(),
  createProject: async (name, description) => createProject(name, description),
  updateProject: async (id, patch) => updateProject(id, patch),
  deleteProject: async id => deleteProject(id),
  clearAll: async () => clearAll(),
}
```

- [ ] **Step 3: Implement the cloud store**

Create `frontend/lib/cloudSessionStore.ts`:

```typescript
// Supabase-backed SessionStore — one instance per signed-in user id. Every
// query is scoped by Row Level Security (auth.uid() = user_id), enforced in
// Postgres regardless of what this code sends; see supabase/schema.sql and
// test_supabase_rls.py.
import { supabase } from './supabase'
import { autoTitle } from './sessions'
import type { Project, Session } from './sessions'
import type { SessionStore } from './sessionStore'

type ChemistryFileRow = {
  id: string
  project_id: string | null
  title: string
  type: Session['tool']
  content: Session['content']
  created_at: string
  updated_at: string
}

type ProjectRow = {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

function rowToSession(row: ChemistryFileRow): Session {
  return {
    id: row.id,
    tool: row.type,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    content: row.content,
    projectId: row.project_id,
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function makeCloudSessionStore(userId: string): SessionStore {
  return {
    async loadSessions() {
      const { data, error } = await supabase
        .from('chemistry_files')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) throw error
      return (data as ChemistryFileRow[]).map(rowToSession)
    },

    async saveSession(session) {
      const title = autoTitle(session)
      const { data, error } = await supabase
        .from('chemistry_files')
        .upsert({
          id: session.id,
          user_id: userId,
          project_id: session.projectId ?? null,
          title,
          type: session.tool,
          content: session.content,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw error
      return rowToSession(data as ChemistryFileRow)
    },

    async deleteSession(id) {
      const { error } = await supabase.from('chemistry_files').delete().eq('id', id)
      if (error) throw error
    },

    async loadProjects() {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) throw error
      return (data as ProjectRow[]).map(rowToProject)
    },

    async createProject(name, description = '') {
      const { data, error } = await supabase
        .from('projects')
        .insert({ user_id: userId, name: name.trim(), description: description.trim() })
        .select()
        .single()
      if (error) throw error
      return rowToProject(data as ProjectRow)
    },

    async updateProject(id, patch) {
      const { data, error } = await supabase
        .from('projects')
        .update({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single()
      if (error) return null
      return rowToProject(data as ProjectRow)
    },

    async deleteProject(id) {
      // No manual "ungroup" step needed: chemistry_files.project_id is
      // `on delete set null` (supabase/schema.sql), so Postgres does it.
      const { error } = await supabase.from('projects').delete().eq('id', id)
      if (error) throw error
    },

    async clearAll() {
      const { error: filesError } = await supabase
        .from('chemistry_files').delete().eq('user_id', userId)
      if (filesError) throw filesError
      const { error: projectsError } = await supabase
        .from('projects').delete().eq('user_id', userId)
      if (projectsError) throw projectsError
    },
  }
}
```

- [ ] **Step 4: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds — nothing imports these two new stores yet, so this only checks
they're internally type-correct.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/sessionStore.ts frontend/lib/localSessionStore.ts frontend/lib/cloudSessionStore.ts
git commit -m "frontend: add SessionStore interface with local and cloud implementations"
```

---

### Task 7: Frontend — one-time local→cloud migration

**Files:**
- Create: `frontend/lib/migrate.ts`

**Interfaces:**
- Consumes: `localSessionStore` (Task 6), `SessionStore` (Task 6).
- Produces: `export function hasMigrated(): boolean`,
  `export async function migrateLocalToCloud(cloud: SessionStore): Promise<void>` —
  called from Task 8's `AuthProvider` on sign-in.

- [ ] **Step 1: Implement it**

Create `frontend/lib/migrate.ts`:

```typescript
// One-time upload of this BROWSER's local projects/sessions into a
// newly-signed-in account. Local data is left in place, untouched — this
// only stops being read from once migration completes.
//
// Known limitation (accepted — see the design spec): the migrated flag is
// per-browser, not per-account, so only the FIRST account that ever signs in
// on a given browser gets that browser's local history. A different account
// signing in later on the same browser will not be re-offered it.
import { localSessionStore } from './localSessionStore'
import type { SessionStore } from './sessionStore'

const MIGRATED_KEY = 'orgo.migrated.v1'

export function hasMigrated(): boolean {
  try {
    return window.localStorage.getItem(MIGRATED_KEY) === 'true'
  } catch {
    return true  // storage unavailable — nothing we can do, don't retry forever
  }
}

function markMigrated(): void {
  try { window.localStorage.setItem(MIGRATED_KEY, 'true') } catch { /* best effort */ }
}

export async function migrateLocalToCloud(cloud: SessionStore): Promise<void> {
  if (hasMigrated()) return
  try {
    const [localProjects, localSessions] = await Promise.all([
      localSessionStore.loadProjects(),
      localSessionStore.loadSessions(),
    ])
    // Projects first — sessions reference them by id, and the cloud store
    // mints new project ids on insert, so references must be remapped.
    const idMap = new Map<string, string>()
    for (const project of localProjects) {
      const created = await cloud.createProject(project.name, project.description)
      idMap.set(project.id, created.id)
    }
    for (const session of localSessions) {
      await cloud.saveSession({
        ...session,
        projectId: session.projectId ? (idMap.get(session.projectId) ?? null) : null,
      })
    }
    markMigrated()
  } catch (err) {
    // Best-effort: a failed migration must not block sign-in. The flag is
    // deliberately NOT set here, so the next sign-in retries.
    console.error('Local-to-cloud migration failed', err)
  }
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/migrate.ts
git commit -m "frontend: add one-time local-to-cloud migration on first sign-in"
```

---

### Task 8: Frontend — `AuthProvider` / `useAuth`

**Files:**
- Create: `frontend/lib/auth.tsx`
- Modify: `frontend/app/page.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 5), `localSessionStore` / `makeCloudSessionStore` (Task 6),
  `migrateLocalToCloud` (Task 7).
- Produces: `export function AuthProvider({ children }): JSX.Element`,
  `export function useAuth(): { user: User | null; loading: boolean; store: SessionStore;
  signUp; signIn; signOut }` — consumed by Task 9 (`AccountPage`) and Task 10
  (`Workspace.tsx`).

- [ ] **Step 1: Implement the provider**

Create `frontend/lib/auth.tsx`:

```typescript
'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session as SupabaseSession, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { localSessionStore } from './localSessionStore'
import { makeCloudSessionStore } from './cloudSessionStore'
import { migrateLocalToCloud } from './migrate'
import type { SessionStore } from './sessionStore'

type AuthContextValue = {
  user: User | null
  loading: boolean
  store: SessionStore
  signUp: (email: string, password: string) => Promise<{ error: string | null }>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  // Guards against re-running migration on every token refresh
  // (onAuthStateChange fires for those too, not just sign-in).
  const migratingFor = useRef<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session: SupabaseSession | null) => {
      setUser(session?.user ?? null)
      if (session?.user && migratingFor.current !== session.user.id) {
        migratingFor.current = session.user.id
        migrateLocalToCloud(makeCloudSessionStore(session.user.id))
      }
      if (!session?.user) migratingFor.current = null
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const store: SessionStore = user ? makeCloudSessionStore(user.id) : localSessionStore

  async function signUp(email: string, password: string) {
    const { error } = await supabase.auth.signUp({ email, password })
    return { error: error?.message ?? null }
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, loading, store, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
```

- [ ] **Step 2: Wrap the app**

Modify `frontend/app/page.tsx` — replace:

```tsx
import Workspace from '../src/platform/Workspace'

export default function HomePage() {
  return <Workspace />
}
```

with:

```tsx
import Workspace from '../src/platform/Workspace'
import { AuthProvider } from '../lib/auth'

export default function HomePage() {
  return (
    <AuthProvider>
      <Workspace />
    </AuthProvider>
  )
}
```

- [ ] **Step 3: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds. `Workspace` does not call `useAuth()` yet (Task 10), so this only
confirms the provider itself compiles and wraps cleanly.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/auth.tsx frontend/app/page.tsx
git commit -m "frontend: add AuthProvider/useAuth wrapping the workspace"
```

---

### Task 9: Frontend — Account page + nav entry

**Files:**
- Create: `frontend/src/platform/AccountPage.tsx`
- Modify: `frontend/src/platform/NavRail.tsx`
- Modify: `frontend/lib/sessions.ts` (`View` type + `VIEWS` array)

**Interfaces:**
- Consumes: `useAuth()` (Task 8).
- Produces: `AccountPage` component; `View` gains `'account'`, consumed by Task 10.

- [ ] **Step 1: Add `'account'` to the `View` type**

In `frontend/lib/sessions.ts`, find:

```typescript
export type View = 'tool' | 'chats' | 'projects' | 'project' | 'settings'
```

Replace with:

```typescript
export type View = 'tool' | 'chats' | 'projects' | 'project' | 'settings' | 'account'
```

Find:

```typescript
const VIEWS: View[] = ['tool', 'chats', 'projects', 'project', 'settings']
```

Replace with:

```typescript
const VIEWS: View[] = ['tool', 'chats', 'projects', 'project', 'settings', 'account']
```

- [ ] **Step 2: Create the page**

Create `frontend/src/platform/AccountPage.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { LogOut, Mail } from 'lucide-react'
import { useAuth } from '../../lib/auth'

export default function AccountPage() {
  const { user, loading, signIn, signUp, signOut } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return null

  if (user) {
    return (
      <div className="page">
        <div className="page-head">
          <h1 className="page-title">Account</h1>
        </div>
        <section className="settings-section">
          <h2>Signed in</h2>
          <p className="settings-blurb">
            <Mail size={14} /> {user.email}
          </p>
          <p className="settings-blurb">
            Your projects, chats, and engine preferences sync to this account.
          </p>
          <div className="settings-row">
            <button className="btn-quiet" onClick={() => signOut()}>
              <LogOut size={15} />
              Sign out
            </button>
          </div>
        </section>
      </div>
    )
  }

  async function submit() {
    setError(null)
    setInfo(null)
    setBusy(true)
    const result = mode === 'signup' ? await signUp(email, password) : await signIn(email, password)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    if (mode === 'signup') setInfo('Check your email to confirm your account, then sign in.')
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Account</h1>
      </div>
      <section className="settings-section">
        <h2>{mode === 'signin' ? 'Sign in' : 'Create an account'}</h2>
        <p className="settings-blurb">
          Optional — everything already works without an account, saved to this browser
          only. Signing in syncs your projects and chats to the cloud and moves this
          browser&apos;s existing work there the first time you sign in.
        </p>
        <div className="settings-row">
          <input
            type="email"
            className="settings-input"
            value={email}
            placeholder="you@example.com"
            autoComplete="email"
            onChange={e => setEmail(e.target.value)}
            aria-label="Email"
          />
        </div>
        <div className="settings-row">
          <input
            type="password"
            className="settings-input"
            value={password}
            placeholder="Password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            onChange={e => setPassword(e.target.value)}
            aria-label="Password"
          />
        </div>
        <div className="settings-row">
          <button className="btn-quiet" disabled={busy || !email || !password} onClick={submit}>
            {mode === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
          <button
            className="btn-quiet"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null) }}
          >
            {mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
          </button>
        </div>
        {error && <div className="settings-note"><p>{error}</p></div>}
        {info && <div className="settings-note"><p>{info}</p></div>}
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Add the rail button**

In `frontend/src/platform/NavRail.tsx`, add `User` to the `lucide-react` import:

```tsx
import {
  Archive, Beaker, FlaskConical, MessagesSquare, Network,
  PanelLeft, Plus, Settings, User,
} from 'lucide-react'
```

Immediately after the Settings button (the last button in `rail-group`, before its
closing `</div>`), add:

```tsx
        <button
          className={`rail-btn${view === 'account' ? ' active' : ''}`}
          data-label="Account"
          aria-label="Account"
          aria-current={view === 'account' ? 'page' : undefined}
          onClick={() => onView('account')}
        >
          <User size={19} />
        </button>
```

- [ ] **Step 4: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds. `Workspace.tsx` doesn't render `AccountPage` yet (Task 10) or import
it, so a strict build may warn about an unused export — that's fine, it will be consumed
next task.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/platform/AccountPage.tsx frontend/src/platform/NavRail.tsx frontend/lib/sessions.ts
git commit -m "frontend: add the Account page and nav rail entry"
```

---

### Task 10: Frontend — wire `Workspace.tsx` to `useAuth().store`

**Files:**
- Modify: `frontend/src/platform/Workspace.tsx`

**Interfaces:**
- Consumes: `useAuth()` (Task 8), `AccountPage` (Task 9).

This is the one real refactor of existing code the feature requires: every place
`Workspace.tsx` currently calls `lib/sessions.ts`'s storage functions directly
(`loadSessions`, `saveSession`, `deleteSession`, `loadProjects`, `createProject`,
`updateProject`, `deleteProject`, `clearAll`) switches to the async `store` from
`useAuth()`. `createSession`, `hasRealContent`, `loadUiState`, `saveUiState` are pure or
device-scoped and are unaffected.

- [ ] **Step 1: Update imports**

At the top of `frontend/src/platform/Workspace.tsx`, replace:

```tsx
import {
  Project,
  Session,
  View,
  clearAll,
  createProject,
  createSession,
  deleteProject,
  deleteSession,
  hasRealContent,
  loadProjects,
  loadSessions,
  loadUiState,
  saveSession,
  saveUiState,
  updateProject,
} from '../../lib/sessions'
```

with:

```tsx
import {
  Project,
  Session,
  View,
  createSession,
  hasRealContent,
  loadUiState,
  saveUiState,
} from '../../lib/sessions'
import { useAuth } from '../../lib/auth'
```

- [ ] **Step 2: Get the active store**

Inside `export default function Workspace() {`, immediately after the existing
`useState` declarations (before the `useEffect` that hydrates from storage), add:

```tsx
  const { store } = useAuth()
```

- [ ] **Step 3: Make the hydration effect async and store-dependent**

Replace:

```tsx
  useEffect(() => {
    const storedSessions = loadSessions()
    const storedProjects = loadProjects()
    setSessions(storedSessions)
    setProjects(storedProjects)

    const ui = loadUiState()
    // A project that has since been deleted must not resurrect a filtered view.
    const projectId = ui?.projectId && storedProjects.some(p => p.id === ui.projectId)
      ? ui.projectId : null
    // Empty sessions are never persisted, so a missing id just means the last
    // session held no work — reopen its tool with a fresh one.
    const restored = ui?.sessionId ? storedSessions.find(s => s.id === ui.sessionId) : undefined

    setActiveProjectId(projectId)
    // The project page needs a project; without one, fall back to the list.
    setView(ui?.view === 'project' && !projectId ? 'projects' : ui?.view ?? 'tool')
    setSidebarOpen(ui?.sidebarOpen ?? false)
    setActive(restored ?? createSession(ui?.tool ?? 'chat', projectId))
    setHydrated(true)
  }, [])
```

with:

```tsx
  // localStorage/Supabase reads aren't available synchronously — load once
  // on mount, and again whenever the active store changes (sign-in/sign-out
  // swap it), restoring whatever the user was last looking at.
  useEffect(() => {
    let cancelled = false
    async function hydrate() {
      const [storedSessions, storedProjects] = await Promise.all([
        store.loadSessions(), store.loadProjects(),
      ])
      if (cancelled) return
      setSessions(storedSessions)
      setProjects(storedProjects)

      const ui = loadUiState()
      // A project that has since been deleted must not resurrect a filtered view.
      const projectId = ui?.projectId && storedProjects.some(p => p.id === ui.projectId)
        ? ui.projectId : null
      // Empty sessions are never persisted, so a missing id just means the last
      // session held no work — reopen its tool with a fresh one.
      const restored = ui?.sessionId ? storedSessions.find(s => s.id === ui.sessionId) : undefined

      setActiveProjectId(projectId)
      // The project page needs a project; without one, fall back to the list.
      setView(ui?.view === 'project' && !projectId ? 'projects' : ui?.view ?? 'tool')
      setSidebarOpen(ui?.sidebarOpen ?? false)
      setActive(restored ?? createSession(ui?.tool ?? 'chat', projectId))
      setHydrated(true)
    }
    hydrate()
    return () => { cancelled = true }
  }, [store])
```

- [ ] **Step 4: Update `persistIfReal`**

Replace:

```tsx
  function persistIfReal(session: Session) {
    if (!hasRealContent(session)) return session
    const saved = saveSession(session)
    setSessions(prev => [saved, ...prev.filter(s => s.id !== saved.id)])
    return saved
  }
```

with:

```tsx
  async function persistIfReal(session: Session): Promise<Session> {
    if (!hasRealContent(session)) return session
    const saved = await store.saveSession(session)
    setSessions(prev => [saved, ...prev.filter(s => s.id !== saved.id)])
    return saved
  }
```

- [ ] **Step 5: Update the unmount cleanup effect**

Replace:

```tsx
  useEffect(() => () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      const latest = activeRef.current
      if (latest && hasRealContent(latest)) saveSession(latest)
    }
  }, [])
```

with:

```tsx
  useEffect(() => () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      const latest = activeRef.current
      // Fire-and-forget: a cleanup function can't be awaited.
      if (latest && hasRealContent(latest)) store.saveSession(latest).catch(() => {})
    }
  }, [store])
```

- [ ] **Step 6: Update `mergeAndSave`**

Replace:

```tsx
  function mergeAndSave(data: Record<string, unknown>) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content: { ...(current.content as Record<string, unknown>), ...data } as SessionContent }
    setActive(persistIfReal(next))
  }
```

with:

```tsx
  function mergeAndSave(data: Record<string, unknown>) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content: { ...(current.content as Record<string, unknown>), ...data } as SessionContent }
    setActive(next)
    persistIfReal(next).then(setActive)
  }
```

- [ ] **Step 7: Update `removeSession`, `handleCreateProject`, `handleDeleteProject`, `handleClearAll`**

Replace:

```tsx
  function removeSession(session: Session) {
    if (!window.confirm(`Delete "${session.title || 'this session'}"?`)) return
    deleteSession(session.id)
    setSessions(prev => prev.filter(s => s.id !== session.id))
    if (active?.id === session.id) setActive(createSession(session.tool, activeProjectId))
  }
```

with:

```tsx
  async function removeSession(session: Session) {
    if (!window.confirm(`Delete "${session.title || 'this session'}"?`)) return
    await store.deleteSession(session.id)
    setSessions(prev => prev.filter(s => s.id !== session.id))
    if (active?.id === session.id) setActive(createSession(session.tool, activeProjectId))
  }
```

Replace:

```tsx
  function handleCreateProject(name: string, description: string) {
    const project = createProject(name, description)
    setProjects(prev => [project, ...prev])
    setActiveProjectId(project.id)
    setView('project')
  }
```

with:

```tsx
  async function handleCreateProject(name: string, description: string) {
    const project = await store.createProject(name, description)
    setProjects(prev => [project, ...prev])
    setActiveProjectId(project.id)
    setView('project')
  }
```

Replace:

```tsx
  function handleDeleteProject(project: Project) {
    if (!window.confirm(`Delete project "${project.name}"? Its chats are kept in Chats.`)) return
    deleteProject(project.id)
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setSessions(loadSessions())
    if (activeProjectId === project.id) {
      setActiveProjectId(null)
      if (view === 'project') setView('projects')
    }
  }
```

with:

```tsx
  async function handleDeleteProject(project: Project) {
    if (!window.confirm(`Delete project "${project.name}"? Its chats are kept in Chats.`)) return
    await store.deleteProject(project.id)
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setSessions(await store.loadSessions())
    if (activeProjectId === project.id) {
      setActiveProjectId(null)
      if (view === 'project') setView('projects')
    }
  }
```

Replace:

```tsx
  function handleClearAll() {
    if (!window.confirm('Delete every chat and project stored in this browser? This cannot be undone.')) return
    clearAll()
    setSessions([])
    setProjects([])
    setActiveProjectId(null)
    setActive(createSession('chat', null))
    setView('tool')
  }
```

with:

```tsx
  async function handleClearAll() {
    const message = user
      ? 'Delete every chat and project in your account? This cannot be undone.'
      : 'Delete every chat and project stored in this browser? This cannot be undone.'
    if (!window.confirm(message)) return
    await store.clearAll()
    setSessions([])
    setProjects([])
    setActiveProjectId(null)
    setActive(createSession('chat', null))
    setView('tool')
  }
```

This last change references `user` — add it alongside `store` in Step 2:

```tsx
  const { user, store } = useAuth()
```

- [ ] **Step 8: Update `ProjectPage`'s inline project-edit callback**

Find (inside the `view === 'project'` render block):

```tsx
            onEdit={patch => {
              const updated = updateProject(activeProject.id, patch)
              if (updated) setProjects(prev => prev.map(p => (p.id === updated.id ? updated : p)))
            }}
```

Replace with:

```tsx
            onEdit={async patch => {
              const updated = await store.updateProject(activeProject.id, patch)
              if (updated) setProjects(prev => prev.map(p => (p.id === updated.id ? updated : p)))
            }}
```

- [ ] **Step 9: Render the account view**

Import the new page near the top with the other page imports:

```tsx
import AccountPage from './AccountPage'
```

Find:

```tsx
      {view === 'settings' && (
        <main className="workspace-main page-main">
          <SettingsPage sessions={sessions} projects={projects} onClearAll={handleClearAll} />
        </main>
      )}
```

Add immediately after it:

```tsx

      {view === 'account' && (
        <main className="workspace-main page-main">
          <AccountPage />
        </main>
      )}
```

- [ ] **Step 10: Build and fix any callback-type friction**

Run: `cd frontend && npm run build`

`handleClearAll`, `removeSession`, and `handleDeleteProject` are now `async` (returning
`Promise<void>`), passed to props like `onClearAll: () => void`. TypeScript allows this —
a function returning any value, including a Promise, is assignable to a `() => void`
parameter. If the build nonetheless flags one of `SettingsPage`, `ProjectsPage`, or
`ProjectPage`'s prop types as incompatible, fix it at the call site with a synchronous
wrapper, e.g.:

```tsx
onDeleteSession={session => { removeSession(session) }}
```

rather than changing those components' prop types.

Expected: build succeeds.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/platform/Workspace.tsx
git commit -m "frontend: wire Workspace to the active SessionStore (local or cloud)"
```

---

### Task 11: Frontend — attach the auth token to backend calls

**Files:**
- Modify: `frontend/src/api.js`

**Interfaces:**
- Consumes: `supabase` (Task 5).

- [ ] **Step 1: Add the helper and wire it into every raw fetch**

At the top of `frontend/src/api.js`, add the import and helper:

```javascript
import { supabase } from '../lib/supabase'
```

Immediately after the `BASE` constant, add:

```javascript
// Supabase session token, when signed in — attached to every backend call so
// optional_auth (app.py) can recognize the caller. Absent when signed out;
// the backend then treats the request as anonymous, exactly as before
// accounts existed.
async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}
```

Update `post`:

```javascript
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Request failed')
  }
  return res.json()
}
```

Update `analyzeImage`'s fetch call:

```javascript
  const res = await fetch(BASE + '/analyze', {
    method: 'POST',
    headers: await authHeaders(),
    body: form,
  })
```

Update `verifyAnalysis`:

```javascript
export async function verifyAnalysis(token) {
  const res = await fetch(`${BASE}/analyze/verify/${encodeURIComponent(token)}`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Verification failed')
  }
  return res.json()
}
```

Update `reactFromImage`'s fetch call:

```javascript
  const res = await fetch(BASE + '/react-from-image', {
    method: 'POST',
    headers: await authHeaders(),
    body: form,
  })
```

Update `streamSSE`:

```javascript
async function streamSSE(path, body, onDelta, onToolEvent = null) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.js
git commit -m "frontend: attach the Supabase access token to backend calls when signed in"
```

---

### Task 12: Frontend — sync the engine model preference to `user_settings`

**Files:**
- Create: `frontend/lib/cloudSettings.ts`
- Modify: `frontend/lib/auth.tsx`
- Modify: `frontend/src/platform/SettingsPage.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 5); `loadPreferredModel`/`savePreferredModel` (existing,
  `frontend/lib/engine.ts`, unchanged); `useAuth()` (Task 8).
- Produces: `loadCloudModel(userId): Promise<string | null>`,
  `saveCloudModel(userId, model): Promise<void>`.

This keeps `lib/engine.ts`'s existing synchronous local-first API exactly as-is (it's
used from `getEnginePayload()` on every AI call — no async refactor there) and layers a
best-effort cloud sync on top, only exercised when signed in. The BYOK API key itself
(`orgo.engine.apiKey`) is untouched by this task and never written to Supabase — only
the model *name* preference syncs, matching the spec's explicit line that the API key
never touches any new table.

- [ ] **Step 1: Implement the cloud read/write helpers**

Create `frontend/lib/cloudSettings.ts`:

```typescript
// Reads/writes user_settings.engine — the one row of non-secret preference
// each account carries (currently just the preferred model). The BYOK API
// key is NEVER read or written here — see supabase/schema.sql's comment on
// user_settings and docs/superpowers/specs/2026-09-04-user-profiles-design.md.
import { supabase } from './supabase'

export async function loadCloudModel(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('engine')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  const engine = data.engine as { model?: string } | null
  return engine?.model ?? null
}

export async function saveCloudModel(userId: string, model: string): Promise<void> {
  await supabase
    .from('user_settings')
    .upsert({ user_id: userId, engine: { model }, updated_at: new Date().toISOString() })
}
```

- [ ] **Step 2: Pull the cloud preference on sign-in**

In `frontend/lib/auth.tsx`, add the import:

```typescript
import { loadCloudModel, saveCloudModel } from './cloudSettings'
import { loadPreferredModel, savePreferredModel } from './engine'
```

Add this function above `AuthProvider`:

```typescript
// Account preference wins on sign-in if one was ever saved; otherwise this
// browser's current local pick becomes the account's first saved preference.
async function syncModelPreferenceOnSignIn(userId: string): Promise<void> {
  try {
    const cloudModel = await loadCloudModel(userId)
    if (cloudModel) {
      savePreferredModel(cloudModel)
    } else {
      await saveCloudModel(userId, loadPreferredModel())
    }
  } catch (err) {
    console.error('Engine-preference sync failed', err)
  }
}
```

In the `onAuthStateChange` handler, find:

```typescript
      if (session?.user && migratingFor.current !== session.user.id) {
        migratingFor.current = session.user.id
        migrateLocalToCloud(makeCloudSessionStore(session.user.id))
      }
```

Replace with:

```typescript
      if (session?.user && migratingFor.current !== session.user.id) {
        migratingFor.current = session.user.id
        migrateLocalToCloud(makeCloudSessionStore(session.user.id))
        syncModelPreferenceOnSignIn(session.user.id)
      }
```

- [ ] **Step 3: Push changes while signed in**

In `frontend/src/platform/SettingsPage.tsx`, add the imports:

```tsx
import { useAuth } from '../../lib/auth'
import { saveCloudModel } from '../../lib/cloudSettings'
```

Find:

```tsx
  const [model, setModel] = useState(() => loadPreferredModel())
```

Add immediately after it:

```tsx
  const { user } = useAuth()
```

Find:

```tsx
  function pick(next: string) {
    setModel(next)
    savePreferredModel(next)
  }
```

Replace with:

```tsx
  function pick(next: string) {
    setModel(next)
    savePreferredModel(next)
    if (user) saveCloudModel(user.id, next).catch(() => {})
  }
```

- [ ] **Step 4: Verify it builds**

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/cloudSettings.ts frontend/lib/auth.tsx frontend/src/platform/SettingsPage.tsx
git commit -m "frontend: sync the engine model preference to user_settings when signed in"
```

---

## Manual end-to-end verification (after all tasks)

No frontend test suite exists (CLAUDE.md). After Task 12, verify by hand — via the `run`
skill or manually:

1. Start both processes (`uvicorn app:app --reload` and `cd frontend && npm run dev`)
   with a real Supabase project's `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`
   in `frontend/.env.local`.
2. Signed out: confirm the app behaves exactly as before — create a chat, refresh, it's
   still there (localStorage).
3. Sign up in the Account panel with a throwaway email; confirm (or disable email
   confirmation on the test project, per `SUPABASE_SETUP.md`).
4. Sign in: confirm the chat created in step 2 now appears (migrated), and that new
   chats/projects created while signed in persist across a refresh.
5. Sign out, sign back in: confirm cloud data is still there and no duplicate migration
   occurred (check the `chemistry_files`/`projects` row counts in the Supabase
   dashboard, or just visually confirm no duplicated sessions).
6. In the Supabase dashboard, confirm a `usage_events` row was written for at least one
   chemistry action taken while signed in.
7. In Settings, switch the preferred model while signed in, sign out, sign back in (or
   open a second browser and sign into the same account): confirm the model preference
   followed the account rather than staying per-browser.
