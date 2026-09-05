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

Ownership is enforced by matching the signed-in user against the row's owning column — `auth.uid() = user_id` on `projects`, `chemistry_files`, `user_settings`, and `usage_events`, and `auth.uid() = id` on `profiles`, whose primary key *is* the user id (there is no separate `user_id` column there). `profiles` rows are created automatically on signup by a trigger and never inserted directly by clients.

Re-run this file whenever it changes — it is safe to re-run top to bottom. **Treat it as a migration file, not a fresh-install script:** `create table if not exists` is a no-op on a database that already has the table, so editing a column or constraint inside a `create table` block changes nothing on an existing project. Every schema change needs its own explicit `alter table` (see the `chemistry_files_project_id_fkey` fix in the file for the pattern).

## 3. Configure Auth

In Supabase Auth settings:

- Enable Email provider.
- For immediate local testing, disable email confirmations.
- If confirmations stay enabled, users will need to confirm their email before logging in.

## 3b. Backend token verification (optional, any environment)

The FastAPI backend verifies a Supabase access token whenever the frontend sends
one, and treats a request with no token as anonymous — so this is optional in
every environment and no endpoint is gated on it. Configuring it is what lets the
backend attribute a request to a real user id (hosted-mode quota keying and the
`usage_events` log). Give it one of these (in the environment or `.env` at the
repo root — **not** `frontend/.env.local`):

- `SUPABASE_URL=https://your-project-ref.supabase.co` — the backend fetches the
  project's public JWKS and verifies RS256/ES256/EdDSA tokens. Use this for
  projects created after May 2025 (asymmetric JWT signing keys are the default).
- `SUPABASE_JWT_SECRET` — the legacy HS256 shared secret (Project Settings →
  API → JWT secret), for older projects still on the shared-secret scheme.

Setting either one enables token verification in dev too. A *present but invalid*
token is rejected with 401 either way; an absent one is simply anonymous. See
README "Production mode".

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
