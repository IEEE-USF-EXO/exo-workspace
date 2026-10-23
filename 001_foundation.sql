-- 001_foundation.sql
-- EXO workspace rework, step 1: approval gate + new domain tables.
--
-- ADDITIVE AND RE-RUNNABLE. It does not drop or rewrite any legacy data, and the
-- legacy app (workspace_state blob) keeps working for APPROVED members while the
-- new modules are built. Run in the Supabase SQL editor.
--
-- Read before running:
--   * Every existing member is grandfathered in as 'approved' (first run only).
--   * After running, bootstrap at least one admin (see section 11) or nobody can
--     approve new sign-ups.
--   * workspace_state / bom_items reads now require approval (legacy app still works).

-- =====================================================================
-- 1. Approval gate on members
-- =====================================================================
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'members' and column_name = 'status'
  ) then
    -- Added with default 'approved' so every EXISTING member keeps access...
    alter table public.members
      add column status text not null default 'approved'
      check (status in ('pending', 'approved', 'disabled'));
    -- ...then new sign-ups default to 'pending'.
    alter table public.members alter column status set default 'pending';
  end if;
end
$$;

alter table public.members add column if not exists approved_by uuid references auth.users(id) on delete set null;
alter table public.members add column if not exists approved_at timestamptz;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.members
    where user_id = auth.uid() and status = 'approved' and active = true
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.is_approved()
     and exists (select 1 from public.global_admins where user_id = auth.uid());
$$;

-- Users may edit their own profile row, but must NOT be able to approve themselves.
create or replace function public.members_protect_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- SQL editor / service role: no auth.uid(), allow (used to bootstrap the first admin).
  if auth.uid() is null then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.active := true;
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.status is distinct from old.status
     or new.active is distinct from old.active
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'Only an administrator can change membership status.';
  end if;
  return new;
end
$$;

drop trigger if exists members_protect_privileged_columns on public.members;
create trigger members_protect_privileged_columns
  before insert or update on public.members
  for each row execute function public.members_protect_privileged_columns();

-- Approved members can read the roster; everyone can always read their own row
-- (so a pending user can see "waiting for approval").
drop policy if exists "Members can read the group roster" on public.members;
drop policy if exists "Members can read the roster" on public.members;
create policy "Members can read the roster"
  on public.members for select to authenticated
  using (user_id = auth.uid() or public.is_approved());

-- Reusable updated_at trigger.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- =====================================================================
-- 2. Projects: lifecycle + Drive folder identity.
-- The configured Drive root is the authoritative project registry. Supabase
-- retains stable rows and boards, keyed by drive_folder_id, so cached projects
-- can render before Drive OAuth and reconcile safely after authentication.
-- =====================================================================
alter table public.projects add column if not exists status text not null default 'active'
  check (status in ('active', 'paused', 'completed', 'archived'));
alter table public.projects add column if not exists drive_folder_id text;
alter table public.projects add column if not exists bom_drive_file_id text;
alter table public.projects add column if not exists archived_at timestamptz;
alter table public.projects add column if not exists created_by uuid references auth.users(id) on delete set null;

create unique index if not exists projects_drive_folder_id_key
  on public.projects(drive_folder_id) where drive_folder_id is not null;

-- Drive folder ids are the stable project anchor. The partial unique index above
-- permits legacy rows without a link while preventing duplicate Drive anchors.

drop policy if exists "Authenticated users can read projects" on public.projects;
drop policy if exists "Approved members can read projects" on public.projects;
create policy "Approved members can read projects"
  on public.projects for select to authenticated using (public.is_approved());

-- Insert stays open to approved members for now because the legacy app registers
-- projects itself. Tighten to admin-only in the cleanup migration (see REWORK_PLAN).
drop policy if exists "Authenticated users can create projects" on public.projects;
drop policy if exists "Approved members can create projects" on public.projects;
create policy "Approved members can create projects"
  on public.projects for insert to authenticated with check (public.is_approved());

drop policy if exists "Admins can update projects" on public.projects;
create policy "Admins can update projects"
  on public.projects for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- 3. Groups
-- =====================================================================
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id) on delete cascade, -- null = club-wide group
  name text not null,
  description text not null default '',
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.members(user_id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'lead')),
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- Symmetric "these two groups collaborate" link. Stored once, smaller id first.
create table if not exists public.group_links (
  group_a uuid not null references public.groups(id) on delete cascade,
  group_b uuid not null references public.groups(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (group_a, group_b),
  check (group_a < group_b)
);

create index if not exists groups_project_idx on public.groups(project_id);
create index if not exists group_members_user_idx on public.group_members(user_id);

-- =====================================================================
-- 4. Tasks and dependencies
-- =====================================================================
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(id) on delete cascade,
  group_id uuid references public.groups(id) on delete set null,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done')),
  assignee_id uuid references public.members(user_id) on delete set null,
  due_date date,
  -- Door left open for the GitHub project board (and anything else) later.
  external_source text,
  external_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists tasks_external_key
  on public.tasks(external_source, external_id) where external_source is not null;
create index if not exists tasks_project_idx on public.tasks(project_id, status);
create index if not exists tasks_group_idx on public.tasks(group_id);

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- "task_id cannot finish until depends_on_task_id is done". Cycle checks live in the app.
create table if not exists public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

-- =====================================================================
-- 5. Activity log (what integrations will read from later)
-- =====================================================================
create table if not exists public.events (
  id bigint generated always as identity primary key,
  project_id text references public.projects(id) on delete set null,
  group_id uuid references public.groups(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  type text not null,                       -- e.g. 'task.completed'
  entity_type text not null default '',     -- e.g. 'task'
  entity_id text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_project_created_idx on public.events(project_id, created_at desc);
create index if not exists events_group_created_idx on public.events(group_id, created_at desc);

-- =====================================================================
-- 6. Updates feed and resources (replace blob fields)
-- =====================================================================
create table if not exists public.updates (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id) on delete cascade,
  group_id uuid references public.groups(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_name text not null default '',
  body text not null,
  created_at timestamptz not null default now(),
  check (project_id is not null or group_id is not null)
);

create index if not exists updates_project_idx on public.updates(project_id, created_at desc);
create index if not exists updates_group_idx on public.updates(group_id, created_at desc);

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(id) on delete cascade,
  team text not null default 'Shared',
  title text not null,
  url text not null,
  description text not null default '',
  basis text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists resources_project_idx on public.resources(project_id);

-- =====================================================================
-- 7. Boards: one row per Tldraw record (replaces projectDrawings blob)
-- =====================================================================
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(id) on delete cascade,
  group_id uuid references public.groups(id) on delete set null,
  name text not null,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists boards_project_idx on public.boards(project_id);

create or replace function public.ensure_default_project_board()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.boards (project_id, name, created_by)
  values (new.id, 'Main board', new.created_by)
  on conflict do nothing;
  return new;
end
$$;

drop trigger if exists projects_default_board on public.projects;
create trigger projects_default_board
  after insert on public.projects
  for each row execute function public.ensure_default_project_board();

create sequence if not exists public.board_record_rev_seq;

create table if not exists public.board_records (
  board_id uuid not null references public.boards(id) on delete cascade,
  record_id text not null,                  -- Tldraw record id, e.g. 'shape:abc'
  type_name text not null,                  -- 'page' | 'shape' | 'asset' | 'binding'
  page_id text,                             -- resolved by the client at write time; null for assets
  data jsonb not null,                      -- the full Tldraw record
  deleted boolean not null default false,   -- tombstone so catch-up sees removals
  rev bigint not null default nextval('public.board_record_rev_seq'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (board_id, record_id)
);

create index if not exists board_records_catchup_idx on public.board_records(board_id, rev);
create index if not exists board_records_page_idx on public.board_records(board_id, page_id);

create or replace function public.board_records_touch()
returns trigger
language plpgsql
as $$
begin
  new.rev := nextval('public.board_record_rev_seq');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$$;

drop trigger if exists board_records_touch on public.board_records;
create trigger board_records_touch
  before insert or update on public.board_records
  for each row execute function public.board_records_touch();

-- Backup bookkeeping: lets every client agree whether a backup is needed.
create table if not exists public.board_backups (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  content_hash text not null,
  record_count integer not null default 0,
  drive_file_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists board_backups_board_idx on public.board_backups(board_id, created_at desc);

-- =====================================================================
-- 8. Row Level Security (trust model: approved members can read AND write;
--    admins manage membership and hard-delete)
-- =====================================================================
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_links enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.events enable row level security;
alter table public.updates enable row level security;
alter table public.resources enable row level security;
alter table public.boards enable row level security;
alter table public.board_records enable row level security;
alter table public.board_backups enable row level security;

do $$
declare
  t text;
begin
  -- Tables where approved members get full read/write/delete.
  foreach t in array array[
    'groups', 'group_members', 'group_links', 'tasks', 'task_dependencies',
    'updates', 'resources', 'boards'
  ]
  loop
    execute format('drop policy if exists "Approved members read" on public.%I', t);
    execute format('create policy "Approved members read" on public.%I for select to authenticated using (public.is_approved())', t);
    execute format('drop policy if exists "Approved members insert" on public.%I', t);
    execute format('create policy "Approved members insert" on public.%I for insert to authenticated with check (public.is_approved())', t);
    execute format('drop policy if exists "Approved members update" on public.%I', t);
    execute format('create policy "Approved members update" on public.%I for update to authenticated using (public.is_approved()) with check (public.is_approved())', t);
    execute format('drop policy if exists "Approved members delete" on public.%I', t);
    execute format('create policy "Approved members delete" on public.%I for delete to authenticated using (public.is_approved())', t);
  end loop;
end
$$;

-- board_records: read/insert/update for approved members; hard delete is admin-only
-- (normal deletion is a tombstone: update ... set deleted = true).
drop policy if exists "Approved members read" on public.board_records;
create policy "Approved members read" on public.board_records
  for select to authenticated using (public.is_approved());
drop policy if exists "Approved members insert" on public.board_records;
create policy "Approved members insert" on public.board_records
  for insert to authenticated with check (public.is_approved());
drop policy if exists "Approved members update" on public.board_records;
create policy "Approved members update" on public.board_records
  for update to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "Admins purge board records" on public.board_records;
create policy "Admins purge board records" on public.board_records
  for delete to authenticated using (public.is_admin());

-- board_backups: read + insert only.
drop policy if exists "Approved members read" on public.board_backups;
create policy "Approved members read" on public.board_backups
  for select to authenticated using (public.is_approved());
drop policy if exists "Approved members insert" on public.board_backups;
create policy "Approved members insert" on public.board_backups
  for insert to authenticated with check (public.is_approved());

-- events: append-only. Actors can only log as themselves.
drop policy if exists "Approved members read" on public.events;
create policy "Approved members read" on public.events
  for select to authenticated using (public.is_approved());
drop policy if exists "Approved members insert" on public.events;
create policy "Approved members insert" on public.events
  for insert to authenticated with check (public.is_approved() and actor_id = auth.uid());

-- =====================================================================
-- 9. Close the legacy tables to unapproved users (legacy app keeps working
--    for approved members)
-- =====================================================================
drop policy if exists "Authenticated users can read workspace state" on public.workspace_state;
create policy "Authenticated users can read workspace state"
  on public.workspace_state for select to authenticated using (public.is_approved());

drop policy if exists "Authenticated users can update workspace state" on public.workspace_state;
create policy "Authenticated users can update workspace state"
  on public.workspace_state for update to authenticated
  using (id = 1 and public.is_approved())
  with check (id = 1 and public.is_approved());

drop policy if exists "Authenticated users can create workspace state" on public.workspace_state;
create policy "Authenticated users can create workspace state"
  on public.workspace_state for insert to authenticated
  with check (id = 1 and public.is_approved());

drop policy if exists "Authenticated users can read BOM" on public.bom_items;
create policy "Authenticated users can read BOM"
  on public.bom_items for select to authenticated using (public.is_approved());

-- =====================================================================
-- 10. Storage bucket for small, hot board assets (images, previews)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('board-assets', 'board-assets', false)
on conflict (id) do nothing;

drop policy if exists "Approved members read board assets" on storage.objects;
create policy "Approved members read board assets"
  on storage.objects for select to authenticated
  using (bucket_id = 'board-assets' and public.is_approved());

drop policy if exists "Approved members upload board assets" on storage.objects;
create policy "Approved members upload board assets"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'board-assets' and public.is_approved());

drop policy if exists "Approved members update board assets" on storage.objects;
create policy "Approved members update board assets"
  on storage.objects for update to authenticated
  using (bucket_id = 'board-assets' and public.is_approved());

-- =====================================================================
-- 11. Realtime publication (tables that clients subscribe to for row changes)
--     Board diffs travel over Broadcast, so board_records is NOT added here.
-- =====================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'updates'
  ) then
    alter publication supabase_realtime add table public.updates;
  end if;
end
$$;

-- =====================================================================
-- 12. BOOTSTRAP THE FIRST ADMIN (edit the email, then run this part by itself)
-- =====================================================================
-- update public.members
--    set status = 'approved', approved_at = now()
--  where email = 'you@example.com';
-- insert into public.global_admins (user_id, title)
--   select user_id, 'Chair' from public.members where email = 'you@example.com'
--   on conflict (user_id) do nothing;
