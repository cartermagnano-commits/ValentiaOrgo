create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.chemistry_files (
  id uuid primary key default gen_random_uuid(),
  -- set null (not cascade): deleting a project must keep its sessions and
  -- just ungroup them — matches frontend/lib/sessions.ts's deleteProject,
  -- which keeps sessions and clears their projectId. The original "on
  -- delete cascade" here was never exercised (nothing wrote to this table
  -- yet), so this fixes it before any real data exists.
  project_id uuid references public.projects(id) on delete set null,
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  type text not null check (
    type in (
      'synthesis',
      'direct_reaction',
      'predict_reaction',
      'mechanism',
      'retrosynthesis',
      'molecule_note',
      'chat'
    )
  ),
  content jsonb default '{}',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Per-user, non-secret preferences (e.g. "Choose Your Engine" mode/provider/model/tier).
-- BYOK API keys are NEVER stored here — they live client-side (sessionStorage) only.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  engine jsonb default '{}',
  updated_at timestamp with time zone default now()
);

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists projects_updated_at_idx on public.projects(updated_at desc);
create index if not exists chemistry_files_project_id_idx on public.chemistry_files(project_id);
create index if not exists chemistry_files_user_id_idx on public.chemistry_files(user_id);
create index if not exists chemistry_files_updated_at_idx on public.chemistry_files(updated_at desc);

alter table public.projects enable row level security;
alter table public.chemistry_files enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "Users can manage own settings" on public.user_settings;
create policy "Users can manage own settings"
on public.user_settings for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can select own projects" on public.projects;
drop policy if exists "Users can insert own projects" on public.projects;
drop policy if exists "Users can update own projects" on public.projects;
drop policy if exists "Users can delete own projects" on public.projects;

create policy "Users can select own projects"
on public.projects for select
using (auth.uid() = user_id);

create policy "Users can insert own projects"
on public.projects for insert
with check (auth.uid() = user_id);

create policy "Users can update own projects"
on public.projects for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own projects"
on public.projects for delete
using (auth.uid() = user_id);

drop policy if exists "Users can select own chemistry files" on public.chemistry_files;
drop policy if exists "Users can insert own chemistry files" on public.chemistry_files;
drop policy if exists "Users can update own chemistry files" on public.chemistry_files;
drop policy if exists "Users can delete own chemistry files" on public.chemistry_files;

create policy "Users can select own chemistry files"
on public.chemistry_files for select
using (auth.uid() = user_id);

create policy "Users can insert own chemistry files"
on public.chemistry_files for insert
with check (auth.uid() = user_id);

create policy "Users can update own chemistry files"
on public.chemistry_files for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own chemistry files"
on public.chemistry_files for delete
using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

drop trigger if exists set_chemistry_files_updated_at on public.chemistry_files;
create trigger set_chemistry_files_updated_at
before update on public.chemistry_files
for each row
execute function public.set_updated_at();

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
