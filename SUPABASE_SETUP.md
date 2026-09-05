# Supabase Setup

This frontend now uses Supabase Auth and Supabase Postgres for user-owned projects and chemistry files.

## 1. Create a Supabase project

Create a project at Supabase, then copy:

- Project URL
- anon public API key

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_ORGO_API_BASE_URL=http://127.0.0.1:8000
```

`NEXT_PUBLIC_ORGO_API_BASE_URL` is optional. It is used by Next.js rewrites so the chemistry tools can call the FastAPI backend while Next runs on its own port.

## 2. Run the SQL

Open the Supabase SQL editor and run:

```sql
-- Paste the full contents of supabase/schema.sql
```

That creates:

- `projects`
- `chemistry_files`
- `user_settings`
- `profiles` (auto-created for every signed-up user by a trigger on `auth.users`)
- `usage_events` (server-side analytics log)
- indexes
- timestamp triggers
- Row Level Security policies for select, insert, update, and delete

Ownership is enforced with `auth.uid() = user_id` on all tables. The `profiles` table rows are created automatically on signup and never inserted directly by clients.

## 3. Configure Auth

In Supabase Auth settings:

- Enable Email provider.
- For immediate local testing, disable email confirmations.
- If confirmations stay enabled, users will need to confirm their email before logging in.

## 3b. Backend token verification (production)

In production (`ORGO_ENV=prod`) the FastAPI backend verifies Supabase access
tokens itself. Give it one of these (in the environment or `.env` at the repo
root — **not** `frontend/.env.local`):

- `SUPABASE_URL=https://your-project-ref.supabase.co` — the backend fetches the
  project's public JWKS and verifies RS256/ES256/EdDSA tokens. Use this for
  projects created after May 2025 (asymmetric JWT signing keys are the default).
- `SUPABASE_JWT_SECRET` — the legacy HS256 shared secret (Project Settings →
  API → JWT secret), for older projects still on the shared-secret scheme.

Setting either one also turns auth on in dev mode. See README "Production mode".

## 4. Run locally

Start the FastAPI backend if you want the chemistry tools available:

```bash
python3 app.py
```

Start the Next.js frontend:

```bash
cd frontend
npm run dev
```

Open the frontend at:

```text
http://localhost:3000
```

The frontend is a single-page workspace at `/`. Accounts (via Supabase Auth) are an optional overlay on the localStorage-only project storage — users can work keyless or log in to sync their projects across devices.
