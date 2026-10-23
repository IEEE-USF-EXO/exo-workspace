-- Phase 3 additive metadata migration.
-- Legacy state.files carries team and note values that Drive cannot reconstruct.
create table if not exists public.file_meta (
  drive_file_id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  team text not null default 'Shared',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists file_meta_project_idx on public.file_meta(project_id);
alter table public.file_meta enable row level security;

drop policy if exists "Approved members read file metadata" on public.file_meta;
create policy "Approved members read file metadata"
  on public.file_meta for select to authenticated
  using (public.is_approved());

drop policy if exists "Approved members write file metadata" on public.file_meta;
create policy "Approved members write file metadata"
  on public.file_meta for all to authenticated
  using (public.is_approved()) with check (public.is_approved());
