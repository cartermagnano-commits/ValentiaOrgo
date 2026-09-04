# User profiles — Supabase accounts as an overlay on the localStorage workspace

**Date:** 2026-09-04
**Status:** approved, ready for implementation planning

## Problem

The frontend has no accounts. Per CLAUDE.md: "Projects and sessions persist in
**localStorage** (`lib/sessions.ts`) — no accounts, no Supabase in the frontend at all."
There are no `/login`, `/signup`, `/dashboard`, or `/projects/[id]` routes despite what
`SUPABASE_SETUP.md` describes.

That doc and `supabase/schema.sql` are stale scaffolding from an earlier, abandoned
design: `projects`, `chemistry_files`, and `user_settings` tables with RLS policies
already written for `auth.uid() = user_id`, but nothing in the current app creates a
Supabase client, calls Supabase Auth, or reads/writes those tables. There is no
`profiles` table at all — only auth identity would exist if you turned auth on today.

The backend, meanwhile, already has real Supabase JWT verification built and wired in:
`require_auth` (`app.py:1120`) is a FastAPI dependency already attached to all eight
chemistry endpoints (`/analyze`, `/analyze/verify/{token}`, `/pathways`, `/explain`,
`/stereo`, `/chat`, `/assist`, `/react`, `/react/assess`), and `_enforce_hosted_quota`
(`app.py:1158`) already keys its daily counters on `user_id or "anon"` (`app.py:1173`).
But `require_auth` is currently **binary**: with no `SUPABASE_URL`/`SUPABASE_JWT_SECRET`
configured (today's actual state, including the live Railway deployment — BYOK-only,
per `2026-09-03-byok-railway-deploy-design.md`), it always returns `None` regardless of
what a caller sends. If an operator sets `SUPABASE_URL`, it flips to **mandatory** —
every request needs a valid bearer token, and `ORGO_ENV=prod` refuses to boot at all
without a verification method (`app.py:1073-1080`). There is no middle state where
signed-in users get recognized while guests keep working.

The ask: real user accounts (sign up, sign in, a profile), with projects/sessions/engine
settings synced to the account instead of trapped in one browser's localStorage, without
breaking the app's current guest-usable-with-no-account character, plus enough
server-side usage tracking to support a future per-user quota and analytics.

## Decisions

| Question | Decision |
|---|---|
| What a "profile" includes | Identity + preferences + saved work — projects/sessions move from localStorage-only to Supabase-backed when signed in |
| App shape | Stays the single-page workspace (`app/page.tsx` → `Workspace.tsx`). No new routes. Auth is an overlay: a sign-in/sign-up panel + profile menu, not a gate |
| Signed-out behavior | Unchanged — exactly today's localStorage-only flow |
| Existing local data on first sign-in | One-time upload into the account, then cloud becomes the source of truth on that device |
| Auth methods | Email + password only (Supabase Auth's Email provider) |
| Data access path | Frontend talks to Supabase directly (JS client + anon key + RLS) for profile/project/settings CRUD — no new FastAPI CRUD endpoints |
| Chemistry-endpoint auth | Becomes optional-if-token-present rather than mandatory-if-configured, via a new `optional_auth` dependency replacing `require_auth` on those 8 endpoints |
| Usage tracking | Existing in-memory hosted-quota counters keep working unchanged (they already key on `user_id or "anon"`) — they just start receiving real ids. Adds a durable `usage_events` log for analytics, written server-side only |
| `ORGO_ENV=prod` hard-auth-required startup guard | Removed — no endpoint mandates a token under this design, so requiring a verification method at boot no longer matches reality. Explicitly approved; a future "sign-in required" deployment mode is a separate feature |

## Architecture

### Data model (`supabase/schema.sql`)

Revives the existing (currently unused) tables and adds two:

- **`profiles`** *(new)*: `id uuid primary key references auth.users(id) on delete cascade`,
  `display_name text`, `avatar_url text`, `created_at timestamptz default now()`.
  Populated by a trigger (`handle_new_user`) on `auth.users` insert — the standard
  Supabase recipe — so a profile row exists the moment someone signs up, with no
  client-side insert required (avoids a race between signup and first profile read).
- **`projects`, `chemistry_files`, `user_settings`** *(already defined, currently
  unused)* — used as originally designed. `user_settings.engine` holds the model pick
  (e.g. `claude-sonnet-4-6`); the BYOK API key itself is never written here — the schema
  already comments this, and it stays consistent with CLAUDE.md's BYOK design (key lives
  in browser localStorage/sessionStorage only, sent per-request, never stored server-side).
- **`usage_events`** *(new)*: `id bigint generated always as identity primary key`,
  `user_id uuid references auth.users(id) on delete cascade`, `endpoint text not null`,
  `created_at timestamptz default now()`. Index on `(user_id, created_at)`.

RLS stays "own rows only," matching the existing `projects`/`chemistry_files` policies
(`auth.uid() = user_id`). `usage_events` gets a `select`-own policy (for a future "my
usage" view) but **no** insert/update policy for `anon`/`authenticated` — only a
service-role key can write there, so a signed-in user cannot inflate or erase their own
usage log through the client.

### Frontend: overlay, not a rebuild

- `frontend/lib/supabase.ts` *(new)* — a single Supabase JS client instance, reading
  `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Session persistence uses
  the SDK's own storage key, distinct from the `orgo.*` namespace `lib/sessions.ts` and
  `lib/engine.ts` already use, so nothing collides.
- An auth context plus a small sign-in/sign-up panel (email + password, two modes),
  surfaced from the nav bar next to where `SettingsPage` (`Workspace.tsx:13,384`) already
  lives — that file is already a panel-in-workspace, not a modal, so this follows the
  same pattern rather than introducing a new UI primitive. Signed-in state swaps that
  entry for a profile menu (email, sign out).
- **Signed-out**: `lib/sessions.ts` is untouched in behavior.
- **Signed-in**: `lib/sessions.ts` is refactored behind a `SessionStore` interface with
  two implementations — the existing localStorage code (unchanged), and a new
  Supabase-backed store (CRUD against `projects`/`chemistry_files` via the client from
  `lib/supabase.ts`, guarded by RLS). `Workspace.tsx` selects the active store from auth
  state. This is the one real refactor of existing code the feature requires — everything
  else is additive.
- **Migration on first sign-in**: on the first successful sign-in on a given browser
  (tracked by a local flag — a per-device concern, not a per-account one, so it does not
  belong in the DB), existing localStorage projects/sessions/engine settings are bulk
  uploaded into Supabase under the new `user_id`, then the active store flips to cloud.
  Local data is left in place untouched (not deleted) as an incidental backup.
  - **Accepted limitation**: if the same account later signs in on a second device that
    has its own different local history, that device's local data is imported too and
    can duplicate rather than merge against the first device's cloud data. Not solved in
    this pass — noted as a conscious call.
- `src/api.js`'s `post()` (and the multipart calls) gain an `Authorization: Bearer
  <token>` header when a Supabase session exists, alongside the existing engine-payload
  plumbing (`getEnginePayload()`, `frontend/lib/engine.ts`) — no change to
  `frontend/middleware.ts`'s allowlist, since this only adds a header to paths already
  proxied.

### Backend: `optional_auth` replaces `require_auth` on chemistry endpoints

New dependency in `app.py`, replacing `Depends(require_auth)` on all eight chemistry
endpoints listed above:

- Bearer token present and `AUTH_ENABLED` (verification is possible) → verify via the
  existing `_verify_token` (`app.py:1096`); valid → real `user_id`; **invalid → 401**
  (a rejected token must not silently downgrade to anonymous — that would misattribute
  quota/usage to "anon" while the caller believes they are signed in).
- No bearer token → `None` (anonymous), regardless of `AUTH_ENABLED` — guests work the
  same whether or not the backend operator has configured Supabase.
- `AUTH_ENABLED` false (no verification method configured at all) → always `None`, same
  as `require_auth` today, since there is no way to verify anything.

`_enforce_hosted_quota` needs no code change — it already does the right thing once
`user_id` starts being real instead of always `None`/"anon". The in-memory counters stay
in-memory, per CLAUDE.md's existing documented rationale ("abuse protection, not
billing" — `app.py` comments above `_hosted_usage`); this spec does not move quota
enforcement to the database.

New: on every chemistry-endpoint call where `optional_auth` returns a real `user_id`,
the backend fires a best-effort insert into `usage_events` — `{user_id, endpoint,
created_at}` — using a new backend-only `SUPABASE_SERVICE_ROLE_KEY` env var. This is the
one deliberate exception to "direct client + RLS everywhere": usage logging must be
authoritative, not self-reported by the browser, so it has to happen server-side with a
key that bypasses RLS. The key is never sent to the frontend and is scoped in use to
this one insert path. The write is wrapped in try/except and logged-and-swallowed on
failure — it must never fail or slow the user's actual request, matching the existing
"never fatal to a request" treatment of ASKCOS failures (CLAUDE.md).

The `ORGO_ENV=prod` startup guard at `app.py:1073-1080` (refuses to boot without a
verification method) is removed, since no endpoint mandates a token under this design —
keeping it would force every prod deployment to configure Supabase even for operators
who don't want accounts at all.

### New environment variables

- Frontend: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (already
  documented in `SUPABASE_SETUP.md`, just not currently consumed by any code).
- Backend: `SUPABASE_SERVICE_ROLE_KEY` *(new)* — set alongside the existing
  `SUPABASE_URL` wherever the backend runs (e.g. Railway). Backend-only secret, never
  exposed to the browser; distinct concern from `ANTHROPIC_API_KEY`, which CLAUDE.md
  says must stay unset on Railway — this key grants DB access, not LLM spend.

## Security

- **RLS is the actual security boundary for profile/project/settings data, not the anon
  key.** The anon key grants no special access by itself; Postgres enforces
  `auth.uid() = user_id` regardless of what the client claims. The two ways this pattern
  breaks are forgetting to enable RLS on a table, or a buggy policy — both are checked
  explicitly in Testing below, not just assumed from the schema reading correctly.
- **The service-role key is the one credential in this design that bypasses RLS**, and
  it is scoped narrowly: used only for the `usage_events` insert path, only server-side,
  never logged, never sent to the client. It must not be reused for any other query.
- **A rejected/invalid bearer token 401s rather than silently falling back to
  anonymous** (see `optional_auth` above) — otherwise a bug that breaks token
  verification would be invisible: users would appear to sign in fine client-side while
  every server-side call silently misattributes to "anon."
- **Removing the `ORGO_ENV=prod` hard-auth-required guard changes existing documented
  behavior.** Previously, a prod deployment with `SUPABASE_URL` set locked out all
  anonymous callers; under this design it does not, by design (guests keep working
  everywhere). Anyone wanting "signed-in required" enforcement needs a separate,
  not-yet-built mode.
- **The BYOK API key is unaffected by any of this** — it continues to never touch
  Supabase or any new table; `user_settings.engine` stores only the model preference.

## Testing

No pytest, no framework — plain scripts, matching the existing suites
(`test_templates.py`, `test_askcos.py`, `test_prediction.py`).

- **RLS isolation**: a script that creates two Supabase test users and confirms user B
  cannot read or write user A's `profiles`/`projects`/`chemistry_files` rows, and that
  neither user can insert into `usage_events` directly (only the service role can).
  Run against a real (or local) Supabase project before calling this done — do not infer
  isolation from the policy SQL reading correctly.
- **`optional_auth` unit test** (new plain script, same style as `test_prediction.py`):
  valid token → real `user_id`; absent token → `None`; malformed/invalid token → 401;
  `AUTH_ENABLED` false → always `None` regardless of token.
- **Usage-event write failure doesn't break the request**: simulate a Supabase-insert
  failure (bad service key / unreachable) and confirm the chemistry endpoint still
  returns its normal response, with the failure only logged.
- **Migration**: seed localStorage with existing projects/sessions, sign up, confirm
  they land in Supabase under the new `user_id` and the UI keeps showing them
  post-migration.
- Frontend: manual verification via the `run`/`verify` skill (no frontend test suite
  exists per CLAUDE.md).

## Out of scope

- OAuth / social sign-in (Google etc.) — email+password only for this pass
- A "sign-in required" deployment mode (replacing the removed prod hard-gate)
- Moving hosted-quota enforcement itself into the database — stays in-memory
- Merging (rather than duplicate-importing) local data from a second device signing
  into an already-migrated account
- An admin/analytics UI reading `usage_events` — this spec only makes the log exist
- Any change to `reactivity_engine.py`, `preprocessing.py`, ASKCOS, or template logic
