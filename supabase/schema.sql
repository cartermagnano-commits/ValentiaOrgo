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
  project_id uuid references public.projects(id) on delete cascade,
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
