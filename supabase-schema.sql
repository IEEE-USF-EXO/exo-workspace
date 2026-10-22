-- EXO Dashboard database schema.
-- This file includes the dashboard tables plus shared membership and BOM
-- workflow tables reserved for collaboration features.
-- Run it in the Supabase SQL editor. All statements are safe to re-run.

create table if not exists public.projects (
  id text primary key,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id text not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.members(user_id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.global_admins (
  user_id uuid primary key references public.members(user_id) on delete cascade,
  title text not null default 'Chair',
  created_at timestamptz not null default now()
);

create table if not exists public.bom_items (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(id) on delete cascade,
  item_id text not null,
  subsystem text not null default '',
  component text not null,
  purpose text not null default '',
  quantity numeric not null default 1 check (quantity >= 0),
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  extended_cost numeric generated always as (
    case when unit_cost is null then null else quantity * unit_cost end
  ) stored,
  supplier text not null default '',
  cost_basis text not null default 'Baseline',
  stage text not null default 'Baseline',
  source text not null default 'Supabase',
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bom_change_requests (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(id) on delete cascade,
  bom_item_id uuid references public.bom_items(id) on delete set null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  proposed_data jsonb not null,
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by uuid not null references auth.users(id) on delete cascade,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text not null default '',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.bom_audit_log (
  id bigint generated always as identity primary key,
  project_id text not null references public.projects(id) on delete cascade,
  bom_item_id uuid references public.bom_items(id) on delete set null,
  action text not null,
  request_id uuid references public.bom_change_requests(id) on delete set null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create table if not exists public.workspace_state (
  id integer primary key check (id = 1),
  data jsonb not null default jsonb_build_object(
    'version', 1,
    'projects', jsonb_build_array(),
    'files', jsonb_build_array(),
    'projectDrawings', jsonb_build_object(),
    'projectUpdates', jsonb_build_object(),
    'resources', jsonb_build_array(),
    'bom', jsonb_build_object(),
    'bomEntries', jsonb_build_array()
  ),
  updated_at timestamptz not null default now()
);

create table if not exists public.board_view_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  board_id text not null,
  page_id text not null,
  camera_x double precision not null,
  camera_y double precision not null,
  camera_z double precision not null check (camera_z > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, board_id, page_id)
);

alter table public.bom_items add column if not exists purpose text not null default '';
alter table public.bom_items add column if not exists stage text not null default 'Baseline';
alter table public.workspace_state
  alter column data set default jsonb_build_object(
    'version', 1,
    'projects', jsonb_build_array(),
    'files', jsonb_build_array(),
    'projectDrawings', jsonb_build_object(),
    'projectUpdates', jsonb_build_object(),
    'resources', jsonb_build_array(),
    'bom', jsonb_build_object(),
    'bomEntries', jsonb_build_array()
  );
alter table public.board_view_state enable row level security;

create index if not exists bom_items_project_id_idx
  on public.bom_items(project_id);

create index if not exists bom_change_requests_project_status_idx
  on public.bom_change_requests(project_id, status);

create or replace function public.is_global_admin()
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.global_admins where user_id = auth.uid()
  );
$$;

alter table public.projects enable row level security;
alter table public.members enable row level security;
alter table public.project_members enable row level security;
alter table public.global_admins enable row level security;
alter table public.bom_items enable row level security;
alter table public.bom_change_requests enable row level security;
alter table public.bom_audit_log enable row level security;
alter table public.workspace_state enable row level security;

drop policy if exists "Authenticated users can read projects" on public.projects;
create policy "Authenticated users can read projects"
  on public.projects for select to authenticated
  using (true);

drop policy if exists "Members can read the group roster" on public.members;
create policy "Members can read the group roster"
  on public.members for select to authenticated
  using (active = true and user_id = auth.uid());

drop policy if exists "Users can register themselves" on public.members;
create policy "Users can register themselves"
  on public.members for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update their profile" on public.members;
create policy "Users can update their profile"
  on public.members for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Chairs can manage the group roster" on public.members;
create policy "Chairs can manage the group roster"
  on public.members for all to authenticated
  using (public.is_global_admin())
  with check (public.is_global_admin());

drop policy if exists "Users can read their memberships" on public.project_members;
create policy "Users can read their memberships"
  on public.project_members for select to authenticated
  using (user_id = auth.uid() or public.is_global_admin());

drop policy if exists "Admins can manage memberships" on public.project_members;
create policy "Admins can manage memberships"
  on public.project_members for all to authenticated
  using (public.is_global_admin())
  with check (public.is_global_admin());

drop policy if exists "Chairs can read global admins" on public.global_admins;
create policy "Chairs can read global admins"
  on public.global_admins for select to authenticated
  using (user_id = auth.uid() or public.is_global_admin());

drop policy if exists "Chairs can manage global admins" on public.global_admins;
create policy "Chairs can manage global admins"
  on public.global_admins for all to authenticated
  using (public.is_global_admin())
  with check (public.is_global_admin());

drop policy if exists "Authenticated users can read BOM" on public.bom_items;
create policy "Authenticated users can read BOM"
  on public.bom_items for select to authenticated
  using (true);

drop policy if exists "Admins can manage BOM" on public.bom_items;
create policy "Admins can manage BOM"
  on public.bom_items for all to authenticated
  using (public.is_global_admin())
  with check (public.is_global_admin());

drop policy if exists "Authenticated users can submit BOM changes" on public.bom_change_requests;
create policy "Authenticated users can submit BOM changes"
  on public.bom_change_requests for insert to authenticated
  with check (submitted_by = auth.uid());

drop policy if exists "Users can read BOM change requests" on public.bom_change_requests;
create policy "Users can read BOM change requests"
  on public.bom_change_requests for select to authenticated
  using (submitted_by = auth.uid() or public.is_global_admin());

drop policy if exists "Admins can review BOM change requests" on public.bom_change_requests;
create policy "Admins can review BOM change requests"
  on public.bom_change_requests for update to authenticated
  using (public.is_global_admin())
  with check (public.is_global_admin());

drop policy if exists "Admins can read BOM audit log" on public.bom_audit_log;
create policy "Admins can read BOM audit log"
  on public.bom_audit_log for select to authenticated
  using (public.is_global_admin());

drop policy if exists "Authenticated users can read workspace state" on public.workspace_state;
create policy "Authenticated users can read workspace state"
  on public.workspace_state for select to authenticated
  using (true);

drop policy if exists "Authenticated users can create workspace state" on public.workspace_state;
create policy "Authenticated users can create workspace state"
  on public.workspace_state for insert to authenticated
  with check (id = 1);

drop policy if exists "Authenticated users can update workspace state" on public.workspace_state;
create policy "Authenticated users can update workspace state"
  on public.workspace_state for update to authenticated
  using (id = 1)
  with check (id = 1);

drop policy if exists "Users can read their board view state" on public.board_view_state;
create policy "Users can read their board view state"
  on public.board_view_state for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can create their board view state" on public.board_view_state;
create policy "Users can create their board view state"
  on public.board_view_state for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update their board view state" on public.board_view_state;
create policy "Users can update their board view state"
  on public.board_view_state for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

insert into public.projects (id, name, description)
values
  ('exo', 'EXO', 'Lower-limb exoskeleton'),
  ('pid-spoon', 'PID Spoon', 'Stabilized assistive utensil')
on conflict (id) do update
set name = excluded.name,
    description = excluded.description;

insert into public.workspace_state (id, data)
values (
  1,
  jsonb_build_object(
    'version', 1,
    'projects', jsonb_build_array(
      jsonb_build_object('id', 'exo', 'name', 'EXO', 'description', 'Lower-limb exoskeleton'),
      jsonb_build_object('id', 'pid-spoon', 'name', 'PID Spoon', 'description', 'Stabilized assistive utensil')
    ),
    'files', jsonb_build_array(),
    'projectDrawings', jsonb_build_object(),
    'projectUpdates', jsonb_build_object(),
    'resources', jsonb_build_array(),
    'bom', jsonb_build_object(),
    'bomEntries', jsonb_build_array()
  )
)
on conflict (id) do nothing;

update public.workspace_state
set data = data || jsonb_build_object('projectUpdates', '{}'::jsonb)
where not (data ? 'projectUpdates');

-- app.js listens for workspace_state changes through Supabase Realtime.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_state'
  ) then
    alter publication supabase_realtime add table public.workspace_state;
  end if;
end
$$;
