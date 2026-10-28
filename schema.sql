-- EXO Workbench: complete core schema for Supabase Postgres.
-- Reconstructed from the seven supplied tables and the task requirements.
-- This is NOT the unrecovered SQL attachment from the earlier chat.
-- Runs on a fresh project OR alongside the seven UUID tables supplied by you.
-- Does not drop tables or delete records. Replaces RLS policies on these 14 tables.
-- Back up an existing project before applying. Run this WHOLE file in SQL Editor.
-- Google provider credentials remain in Supabase Auth settings, never in SQL/frontend.

begin;

create schema if not exists exo_private;
revoke all on schema exo_private from public;
grant usage on schema exo_private to authenticated, service_role;

-- 1. Profiles use the same ID as Supabase Auth; no passwords/provider tokens here.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. A root team has no parent. Subteams refer to their parent team's ID.
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  parent_team_id uuid references public.teams(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (parent_team_id is distinct from id)
);

-- 3. Membership is explicit; signing in alone does not grant workspace access.
create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- 4. All workspace members can view projects; tasks select their own team scope.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  description text,
  status text not null default 'active' check (status in ('active','paused','completed','archived')),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5. Legacy project/team links are retained for compatibility and history only.
-- Task creation and permissions no longer depend on these records.
create table if not exists public.project_teams (
  project_id uuid not null references public.projects(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete restrict,
  added_at timestamptz not null default now(),
  primary key (project_id, team_id)
);

-- 6. Original role names/scopes, matching the existing database.
-- exo_chair administers the workspace; team_lead/project_lead have team scopes.
-- permanent_project_lead grants membership/read access here; its broader powers
-- need a separate agreed permission rule before any additional grants.
create table if not exists public.leadership_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('exo_chair','permanent_project_lead','team_lead','project_lead')),
  team_id uuid references public.teams(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz check (revoked_at is null or revoked_at >= created_at),
  check (
    (role in ('exo_chair','permanent_project_lead') and team_id is null and project_id is null) or
    (role = 'team_lead' and team_id is not null and project_id is null) or
    (role = 'project_lead' and team_id is not null and project_id is not null)
  )
);

-- 7. Milestones belong to projects; tasks can optionally belong to milestones.
create table if not exists public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  description text,
  due_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- These indexes also work with the existing tables in the supplied column export.
create unique index if not exists exo_milestone_project_key on public.milestones(id, project_id);
create unique index if not exists exo_project_team_key on public.project_teams(project_id, team_id);
create index if not exists exo_teams_parent_idx on public.teams(parent_team_id);
create index if not exists exo_members_user_idx on public.team_members(user_id, team_id);
create index if not exists exo_project_teams_team_idx on public.project_teams(team_id, project_id);
create index if not exists exo_leadership_user_idx on public.leadership_assignments(user_id, role) where revoked_at is null;
create index if not exists exo_leadership_scope_idx on public.leadership_assignments(project_id, team_id) where revoked_at is null;
create index if not exists exo_milestones_project_idx on public.milestones(project_id, due_at);
alter table public.projects alter column created_by set default auth.uid();
alter table public.milestones alter column created_by set default auth.uid();

-- 8. Task owner/assignee is separate from the many-to-many contributor list.
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  team_id uuid not null,
  milestone_id uuid,
  title text not null check (length(btrim(title)) between 1 and 160),
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','in_progress','blocked','review','done','cancelled')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  assignee_id uuid references public.profiles(id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exo_task_project_fk foreign key (project_id) references public.projects(id) on delete restrict,
  constraint exo_task_team_fk foreign key (team_id) references public.teams(id) on delete restrict,
  foreign key (milestone_id, project_id) references public.milestones(id, project_id) on delete restrict,
  unique (id, project_id)
);
create index if not exists exo_tasks_scope_idx on public.tasks(project_id, team_id, status);
create index if not exists exo_tasks_assignee_idx on public.tasks(assignee_id);
create index if not exists exo_tasks_due_idx on public.tasks(due_at) where status not in ('done','cancelled');
create index if not exists exo_tasks_milestone_idx on public.tasks(milestone_id, project_id);
create index if not exists exo_tasks_team_idx on public.tasks(team_id);

-- Upgrade existing installations too: CREATE TABLE IF NOT EXISTS alone would
-- leave the former composite project_teams FK in place. No records are deleted.
do $$
declare legacy record;
begin
  for legacy in select conname from pg_constraint
    where conrelid = 'public.tasks'::regclass and contype = 'f'
      and confrelid = 'public.project_teams'::regclass loop
    execute format('alter table public.tasks drop constraint %I', legacy.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid='public.tasks'::regclass and conname='exo_task_project_fk') then
    alter table public.tasks add constraint exo_task_project_fk
      foreign key (project_id) references public.projects(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.tasks'::regclass and conname='exo_task_team_fk') then
    alter table public.tasks add constraint exo_task_team_fk
      foreign key (team_id) references public.teams(id) on delete restrict;
  end if;
end;
$$;

-- 9. Multiple people can contribute to a task.
create table if not exists public.task_contributors (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  added_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists exo_contributors_user_idx on public.task_contributors(user_id);

-- 10. Dependencies are limited to the same project; a trigger prevents cycles.
create table if not exists public.task_dependencies (
  task_id uuid not null,
  depends_on_task_id uuid not null,
  project_id uuid not null,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  foreign key (task_id, project_id) references public.tasks(id, project_id) on delete cascade,
  foreign key (depends_on_task_id, project_id) references public.tasks(id, project_id) on delete cascade,
  check (task_id <> depends_on_task_id)
);
create index if not exists exo_dependency_target_idx on public.task_dependencies(depends_on_task_id);

-- 11. Task discussion. Authors can edit their own comments.
create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  body text not null check (length(btrim(body)) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists exo_comments_task_idx on public.task_comments(task_id, created_at);

-- 12. Small checklist items; independent from full task dependencies.
create table if not exists public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 300),
  is_completed boolean not null default false,
  sort_order integer not null default 0,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists exo_checklist_task_idx on public.task_checklist_items(task_id, sort_order);

-- 13. Links to resources (including future Discord messages); no bot secrets.
create table if not exists public.task_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  label text not null default '',
  url text not null check (url ~* '^https?://[^[:space:]]+$'),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists exo_links_task_idx on public.task_links(task_id);

-- 14. Task creation/update history, written by triggers, never by browser clients.
-- Deleting a task also removes its history; this is not an immutable audit archive.
create table if not exists public.task_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('created','updated')),
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists exo_activity_task_idx on public.task_activity(task_id, created_at desc);

-- Secure helper functions live outside the exposed public schema.
-- Keep exo_private OUT of Supabase's exposed Data API schemas.
create or replace function exo_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.leadership_assignments
    where user_id = (select auth.uid()) and role = 'exo_chair'
      and team_id is null and project_id is null and revoked_at is null);
$$;

create or replace function exo_private.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members where user_id = (select auth.uid()))
    or exists (select 1 from public.leadership_assignments
      where user_id = (select auth.uid()) and revoked_at is null
        and role in ('exo_chair','permanent_project_lead','project_lead','team_lead'));
$$;

-- A parent-team member can work in its subteams; a subteam member does not
-- automatically gain write access to its parent or sibling teams.
create or replace function exo_private.can_work_in(p_team uuid, p_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive ancestors(id, parent_team_id) as (
    select id, parent_team_id from public.teams where id = p_team
    union
    select t.id, t.parent_team_id from public.teams t join ancestors a on t.id = a.parent_team_id
  )
  select exo_private.is_admin()
    or exists (select 1 from public.leadership_assignments l
      where l.user_id = (select auth.uid()) and l.revoked_at is null
        and ((l.role = 'project_lead' and l.project_id = p_project and l.team_id in (select id from ancestors))
          or (l.role = 'team_lead' and l.team_id in (select id from ancestors)
            and l.project_id is null)))
    or exists (select 1 from public.team_members m
      where m.user_id = (select auth.uid()) and m.team_id in (select id from ancestors));
$$;

create or replace function exo_private.leads_project(p_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exo_private.is_admin() or exists (select 1 from public.leadership_assignments
    where user_id = (select auth.uid()) and role = 'project_lead'
      and project_id = p_project and team_id is not null and revoked_at is null);
$$;

create or replace function exo_private.can_edit_task(p_task uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t
    where t.id = p_task and exo_private.can_work_in(t.team_id, t.project_id));
$$;

create or replace function exo_private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function exo_private.sync_task_completion()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' then new.completed_at := now();
    elsif old.status <> 'done' then new.completed_at := now();
    else new.completed_at := old.completed_at;
    end if;
  else new.completed_at := null;
  end if;
  return new;
end;
$$;

create or replace function exo_private.create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists exo_create_profile on auth.users;
create trigger exo_create_profile after insert on auth.users
  for each row execute function exo_private.create_profile();

-- Preserve profiles already edited by members; fill only missing profile rows.
insert into public.profiles(id, display_name, avatar_url)
select id, coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', ''),
  raw_user_meta_data ->> 'avatar_url' from auth.users
on conflict (id) do nothing;

-- Serialize hierarchy/dependency edits so concurrent requests cannot create cycles.
create or replace function exo_private.check_team_cycle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(814271);
  if new.parent_team_id is not null and exists (
    with recursive parents(id, parent_team_id) as (
      select id, parent_team_id from public.teams where id = new.parent_team_id
      union
      select t.id, t.parent_team_id from public.teams t join parents p on t.id = p.parent_team_id
    ) select 1 from parents where id = new.id
  ) then raise exception 'A team cannot be its own ancestor.'; end if;
  return new;
end;
$$;
drop trigger if exists exo_team_cycle on public.teams;
create trigger exo_team_cycle before insert or update of parent_team_id on public.teams
  for each row execute function exo_private.check_team_cycle();

create or replace function exo_private.check_dependency_cycle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(814272);
  if new.task_id = new.depends_on_task_id or exists (
    with recursive chain(id) as (
      select new.depends_on_task_id
      union
      select d.depends_on_task_id from public.task_dependencies d join chain c on d.task_id = c.id
    ) select 1 from chain where id = new.task_id
  ) then raise exception 'Task dependencies cannot form a cycle.'; end if;
  return new;
end;
$$;
drop trigger if exists exo_dependency_cycle on public.task_dependencies;
create trigger exo_dependency_cycle before insert on public.task_dependencies
  for each row execute function exo_private.check_dependency_cycle();

create or replace function exo_private.log_task_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare delta jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.task_activity(task_id, actor_id, action, changes)
    values (new.id, auth.uid(), 'created', jsonb_build_object('title', new.title));
  else
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)), '{}'::jsonb)
      into delta from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
      where n.value is distinct from o.value and n.key <> 'updated_at';
    if delta <> '{}'::jsonb then
      insert into public.task_activity(task_id, actor_id, action, changes)
      values (new.id, auth.uid(), 'updated', delta);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists exo_task_completion on public.tasks;
create trigger exo_task_completion before insert or update on public.tasks
  for each row execute function exo_private.sync_task_completion();
drop trigger if exists exo_task_activity on public.tasks;
create trigger exo_task_activity after insert or update on public.tasks
  for each row execute function exo_private.log_task_activity();

-- Set timestamps consistently on every write.
do $$
declare t text;
begin
  foreach t in array array['profiles','projects','milestones','tasks','task_comments','task_checklist_items'] loop
    execute format('drop trigger if exists exo_updated_at on public.%I', t);
    execute format('create trigger exo_updated_at before update on public.%I for each row execute function exo_private.touch_updated_at()', t);
  end loop;
end;
$$;

-- RLS policy replacement is intentional: old permissive policies must not bypass
-- this access model. Applies only to the named application tables below.
-- Workspace information and references are shared; task contents follow group scope.
-- Visitors with only the public anon key get NO rows/access.
do $$
declare t text; p record;
begin
  foreach t in array array['profiles','teams','team_members','projects','project_teams',
    'leadership_assignments','milestones','tasks','task_contributors','task_dependencies',
    'task_comments','task_checklist_items','task_links','task_activity'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    if t <> 'profiles' then
      execute format('create policy exo_member_read on public.%I for select to authenticated using ((select exo_private.is_member()))', t);
    end if;
  end loop;
end;
$$;

-- Restrictive policies also constrain any permissive author/admin policies.
-- Task links remain shared references, independently of task-content visibility.
create policy exo_task_group_access on public.tasks as restrictive
  for select to authenticated using (exo_private.can_work_in(team_id, project_id));
do $$
declare t text;
begin
  foreach t in array array['task_contributors','task_comments','task_checklist_items','task_activity'] loop
    execute format('create policy exo_task_group_access on public.%I as restrictive for all to authenticated using (exo_private.can_edit_task(task_id)) with check (exo_private.can_edit_task(task_id))', t);
  end loop;
end;
$$;
create policy exo_task_group_access on public.task_dependencies as restrictive
  for all to authenticated
  using (exo_private.can_edit_task(task_id) and exo_private.can_edit_task(depends_on_task_id))
  with check (exo_private.can_edit_task(task_id) and exo_private.can_edit_task(depends_on_task_id));

create policy exo_profile_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select exo_private.is_member()));
grant update(display_name, avatar_url) on public.profiles to authenticated;
create policy exo_profile_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Organization and permissions changes are restricted to global admins.
-- First admin is bootstrapped by the owner in SQL Editor (instructions below).
do $$
declare t text;
begin
  foreach t in array array['teams','team_members','projects','project_teams','leadership_assignments'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format('create policy exo_admin_write on public.%I for all to authenticated using ((select exo_private.is_admin())) with check ((select exo_private.is_admin()))', t);
  end loop;
end;
$$;

grant insert, delete on public.milestones to authenticated;
grant update(name, description, due_at) on public.milestones to authenticated;
create policy exo_milestone_insert on public.milestones for insert to authenticated
  with check (exo_private.leads_project(project_id) and created_by = (select auth.uid()));
create policy exo_milestone_update on public.milestones for update to authenticated
  using (exo_private.leads_project(project_id)) with check (exo_private.leads_project(project_id));
create policy exo_milestone_delete on public.milestones for delete to authenticated
  using (exo_private.leads_project(project_id));

grant insert, delete on public.tasks to authenticated;
-- Prevent clients rewriting task identity, project scope, authorship, or timestamps.
-- Moving tasks between teams/projects is deferred to an explicitly checked server operation.
grant update(title, description, status, priority, assignee_id, due_at, milestone_id) on public.tasks to authenticated;
create policy exo_task_insert on public.tasks for insert to authenticated
  with check (exo_private.can_work_in(team_id, project_id) and created_by = (select auth.uid()));
create policy exo_task_update on public.tasks for update to authenticated
  using (exo_private.can_work_in(team_id, project_id))
  with check (exo_private.can_work_in(team_id, project_id));
create policy exo_task_delete on public.tasks for delete to authenticated
  using (exo_private.can_work_in(team_id, project_id));

grant insert, delete on public.task_contributors to authenticated;
create policy exo_contributor_insert on public.task_contributors for insert to authenticated
  with check (exo_private.can_edit_task(task_id) and added_by = (select auth.uid()));
create policy exo_contributor_delete on public.task_contributors for delete to authenticated
  using (exo_private.can_edit_task(task_id));

-- Dependency changes are delete-and-insert, making the cycle guard unambiguous.
grant insert, delete on public.task_dependencies to authenticated;
create policy exo_dependency_insert on public.task_dependencies for insert to authenticated
  with check (exo_private.can_edit_task(task_id) and created_by = (select auth.uid()));
create policy exo_dependency_delete on public.task_dependencies for delete to authenticated
  using (exo_private.can_edit_task(task_id));

grant insert, delete on public.task_comments to authenticated;
grant update(body) on public.task_comments to authenticated;
create policy exo_comment_insert on public.task_comments for insert to authenticated
  with check ((select exo_private.is_member()) and author_id = (select auth.uid()));
create policy exo_comment_update on public.task_comments for update to authenticated
  using ((select exo_private.is_member()) and author_id = (select auth.uid()))
  with check ((select exo_private.is_member()) and author_id = (select auth.uid()));
create policy exo_comment_delete on public.task_comments for delete to authenticated
  using ((select exo_private.is_member()) and (author_id = (select auth.uid()) or (select exo_private.is_admin())));

grant insert, delete on public.task_checklist_items to authenticated;
grant update(title, is_completed, sort_order) on public.task_checklist_items to authenticated;
create policy exo_checklist_insert on public.task_checklist_items for insert to authenticated
  with check (exo_private.can_edit_task(task_id) and created_by = (select auth.uid()));
create policy exo_checklist_update on public.task_checklist_items for update to authenticated
  using (exo_private.can_edit_task(task_id)) with check (exo_private.can_edit_task(task_id));
create policy exo_checklist_delete on public.task_checklist_items for delete to authenticated
  using (exo_private.can_edit_task(task_id));

grant insert, delete on public.task_links to authenticated;
grant update(label, url) on public.task_links to authenticated;
create policy exo_link_insert on public.task_links for insert to authenticated
  with check (exo_private.can_edit_task(task_id) and created_by = (select auth.uid()));
create policy exo_link_update on public.task_links for update to authenticated
  using (exo_private.can_edit_task(task_id)) with check (exo_private.can_edit_task(task_id));
create policy exo_link_delete on public.task_links for delete to authenticated
  using (exo_private.can_edit_task(task_id));

-- Explicit function ACLs; trigger functions are not browser-callable RPCs.
revoke all on all functions in schema exo_private from public, anon, authenticated;
grant execute on function exo_private.is_admin() to authenticated, service_role;
grant execute on function exo_private.is_member() to authenticated, service_role;
grant execute on function exo_private.can_work_in(uuid, uuid) to authenticated, service_role;
grant execute on function exo_private.leads_project(uuid) to authenticated, service_role;
grant execute on function exo_private.can_edit_task(uuid) to authenticated, service_role;

commit;

-- Verification: this lists the 14 core tables (unrelated existing tables may remain).
select tablename, rowsecurity from pg_tables where schemaname = 'public'
  and tablename in ('profiles','teams','team_members','projects','project_teams',
    'leadership_assignments','milestones','tasks','task_contributors','task_dependencies',
    'task_comments','task_checklist_items','task_links','task_activity')
order by tablename;

-- NEXT: after signing in with Google at least once, find your user in Auth > Users.
-- Run the following separately in SQL Editor, substituting your real UUID:
-- insert into public.leadership_assignments(user_id, role)
-- values ('YOUR-AUTH-USER-UUID'::uuid, 'exo_chair');
-- Never implement first-user-auto-admin or let browser clients self-assign roles.
-- Then create teams/projects and add team_members. Tasks select a project and
-- team/subteam independently; no project_teams records are needed.
-- This schema does not configure Google OAuth, seed sample data, or connect the UI.


-- Activity and archive extension (also provided separately for existing installs).
-- Run the whole file in Supabase SQL Editor. Additive; no task/history deletion.
begin;
alter table public.tasks add column if not exists archived_at timestamptz;
alter table public.tasks add column if not exists archived_by uuid;
create index if not exists exo_tasks_archive_idx on public.tasks(archived_at);
alter table public.task_activity add column if not exists actor_name text;
alter table public.task_activity add column if not exists task_title text;
alter table public.task_activity add column if not exists project_id uuid;
alter table public.task_activity add column if not exists team_id uuid;
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.task_activity'::regclass
    and contype='c' and pg_get_constraintdef(oid) like '%action%' loop
    execute format('alter table public.task_activity drop constraint %I',c.conname);
  end loop;
end $$;
alter table public.task_activity add constraint exo_activity_action_check
  check(action in ('created','updated','archived','restored'));
update public.task_activity a set actor_name=coalesce(a.actor_name,(select display_name from public.profiles where id=a.actor_id),'Administration / system'),
  task_title=coalesce(a.task_title,t.title),project_id=coalesce(a.project_id,t.project_id),team_id=coalesce(a.team_id,t.team_id)
from public.tasks t
where a.task_id=t.id
  and (a.task_title is null or a.actor_name is null);
update public.task_activity a set task_title=t.title,project_id=t.project_id,team_id=t.team_id,
  actor_name=coalesce(a.actor_name,'Administration / system') from public.tasks t where a.task_id=t.id and a.task_title is null;

create table if not exists public.workspace_activity (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null, entity_id text not null, entity_label text not null,
  action text not null check(action in ('created','updated','deleted','archived','restored')),
  actor_id uuid, actor_name text not null, project_id uuid, team_id uuid,
  changes jsonb not null default '{}', created_at timestamptz not null default now(),
  task_activity_id uuid unique
);
create index if not exists exo_workspace_history_idx on public.workspace_activity(created_at desc,id desc);
create index if not exists exo_workspace_history_project_idx on public.workspace_activity(project_id,created_at desc,id desc);
alter table public.workspace_activity enable row level security;
revoke all on public.workspace_activity from public,anon,authenticated;
grant select on public.workspace_activity to authenticated;
grant all on public.workspace_activity to service_role;
drop policy if exists exo_chair_history on public.workspace_activity;
create policy exo_chair_history on public.workspace_activity for select to authenticated using ((select exo_private.is_admin()));

create or replace function exo_private.can_manage_in(p_team uuid,p_project uuid)
returns boolean language sql stable security definer set search_path='' as $$
  with recursive ancestors(id,parent_team_id) as (
    select id,parent_team_id from public.teams where id=p_team
    union select t.id,t.parent_team_id from public.teams t join ancestors a on t.id=a.parent_team_id
  ) select exo_private.is_admin() or exists(select 1 from public.leadership_assignments l
    where l.user_id=auth.uid() and l.revoked_at is null and l.team_id in(select id from ancestors)
    and ((l.role='team_lead' and l.project_id is null) or (l.role='project_lead' and l.project_id=p_project)));
$$;
revoke all on function exo_private.can_manage_in(uuid,uuid) from public,anon;
grant execute on function exo_private.can_manage_in(uuid,uuid) to authenticated,service_role;

create or replace function exo_private.user_can_access_group(p_user uuid,p_team uuid,p_project uuid)
returns boolean language sql stable security definer set search_path='' as $$
  with recursive ancestors(id,parent_team_id) as (
    select id,parent_team_id from public.teams where id=p_team
    union select t.id,t.parent_team_id from public.teams t join ancestors a on t.id=a.parent_team_id
  ) select exists(select 1 from public.team_members where user_id=p_user and team_id in(select id from ancestors))
    or exists(select 1 from public.leadership_assignments where user_id=p_user and revoked_at is null
      and ((role='exo_chair' and team_id is null and project_id is null)
        or (team_id in(select id from ancestors) and ((role='team_lead' and project_id is null) or (role='project_lead' and project_id=p_project)))));
$$;
create or replace function exo_private.check_task_assignee()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and new.assignee_id is not distinct from old.assignee_id
    and new.team_id=old.team_id and new.project_id=old.project_id then return new; end if;
  if new.assignee_id is not null and not exo_private.user_can_access_group(new.assignee_id,new.team_id,new.project_id) then
    raise exception 'The assignee needs access to this task group first' using errcode='23514'; end if;
  return new;
end $$;
drop trigger if exists exo_task_assignee on public.tasks;
create trigger exo_task_assignee before insert or update of assignee_id,team_id,project_id on public.tasks
  for each row execute function exo_private.check_task_assignee();
revoke all on function exo_private.user_can_access_group(uuid,uuid,uuid),exo_private.check_task_assignee() from public,anon,authenticated;

-- Restrictive rules also constrain older permissive policies still installed.
drop policy if exists exo_task_lead_create on public.tasks;
create policy exo_task_lead_create on public.tasks as restrictive for insert to authenticated
  with check(exo_private.can_manage_in(team_id,project_id) and archived_at is null and archived_by is null);
revoke update,delete on public.tasks from authenticated;
revoke update(title,description,status,priority,assignee_id,due_at,milestone_id,archived_at,archived_by) on public.tasks from authenticated;
grant update(status) on public.tasks to authenticated;
drop policy if exists exo_task_no_delete on public.tasks;
create policy exo_task_no_delete on public.tasks as restrictive for delete to authenticated using(false);

create or replace function exo_private.guard_task_progress()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.archived_at is not null and new.status is distinct from old.status then
    raise exception 'Restore this task before changing progress' using errcode='42501';
  end if;
  if auth.uid() is not null and not exo_private.can_manage_in(old.team_id,old.project_id)
    and (old.archived_at is not null or old.status='cancelled' or new.status='cancelled') then
    raise exception 'Only a lead or chair can change archived or cancelled tasks' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists exo_guard_task_progress on public.tasks;
create trigger exo_guard_task_progress before update on public.tasks for each row execute function exo_private.guard_task_progress();

create or replace function public.manage_task(p_task uuid,p_expected timestamptz,p_values jsonb)
returns setof public.tasks language plpgsql security definer set search_path='' as $$
declare existing public.tasks;
begin
  select * into existing from public.tasks where id=p_task for update;
  if auth.uid() is null or existing.id is null or not exo_private.can_manage_in(existing.team_id,existing.project_id) then
    raise exception 'Only a scoped lead or chair can manage this task' using errcode='42501'; end if;
  if existing.updated_at is distinct from p_expected then raise exception 'This task changed. Refresh and try again.' using errcode='40001'; end if;
  if existing.archived_at is not null and p_values-array['archived']<>'{}'::jsonb then
    raise exception 'Restore this task before editing it' using errcode='42501'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or
    p_values-array['title','description','status','priority','assignee_id','due_at','milestone_id','archived']<>'{}'::jsonb then
    raise exception 'Unsupported task fields'; end if;
  return query update public.tasks t set
    title=case when p_values?'title' then p_values->>'title' else t.title end,
    description=case when p_values?'description' then p_values->>'description' else t.description end,
    status=case when p_values?'status' then p_values->>'status' else t.status end,
    priority=case when p_values?'priority' then p_values->>'priority' else t.priority end,
    assignee_id=case when p_values?'assignee_id' then (p_values->>'assignee_id')::uuid else t.assignee_id end,
    due_at=case when p_values?'due_at' then (p_values->>'due_at')::timestamptz else t.due_at end,
    milestone_id=case when p_values?'milestone_id' then (p_values->>'milestone_id')::uuid else t.milestone_id end,
    archived_at=case when not(p_values?'archived') then t.archived_at when (p_values->>'archived')::boolean then coalesce(t.archived_at,clock_timestamp()) else null end,
    archived_by=case when not(p_values?'archived') then t.archived_by when (p_values->>'archived')::boolean then coalesce(t.archived_by,auth.uid()) else null end
    where t.id=p_task returning t.*;
end $$;
revoke all on function public.manage_task(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.manage_task(uuid,timestamptz,jsonb) to authenticated,service_role;

create or replace function exo_private.log_task_activity()
returns trigger language plpgsql security definer set search_path='' as $$
declare delta jsonb; event text;
begin
  if tg_op='INSERT' then
    select jsonb_object_agg(key,jsonb_build_object('from',null,'to',value)) into delta
      from jsonb_each(to_jsonb(new)) where key not in ('created_at','updated_at','id');
    event:='created';
  else
    select coalesce(jsonb_object_agg(n.key,jsonb_build_object('from',o.value,'to',n.value)),'{}') into delta
      from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key=n.key
      where n.value is distinct from o.value and n.key<>'updated_at';
    if delta='{}'::jsonb then return new; end if;
    event:=case when old.archived_at is null and new.archived_at is not null then 'archived'
      when old.archived_at is not null and new.archived_at is null then 'restored' else 'updated' end;
  end if;
  insert into public.task_activity(task_id,actor_id,actor_name,task_title,project_id,team_id,action,changes)
    values(new.id,auth.uid(),coalesce(nullif((select display_name from public.profiles where id=auth.uid()),''),case when auth.uid() is null then 'Administration / system' else 'Workspace member' end),new.title,new.project_id,new.team_id,event,delta);
  return new;
end $$;

create or replace function exo_private.mirror_task_history()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.workspace_activity(entity_type,entity_id,entity_label,action,actor_id,actor_name,project_id,team_id,changes,created_at,task_activity_id)
    values('tasks',new.task_id::text,new.task_title,new.action,new.actor_id,coalesce(new.actor_name,'Administration / system'),new.project_id,new.team_id,new.changes,new.created_at,new.id)
    on conflict(task_activity_id) do nothing;
  return new;
end $$;
drop trigger if exists exo_mirror_task_history on public.task_activity;
create trigger exo_mirror_task_history after insert on public.task_activity for each row execute function exo_private.mirror_task_history();
insert into public.workspace_activity(entity_type,entity_id,entity_label,action,actor_id,actor_name,project_id,team_id,changes,created_at,task_activity_id)
  select 'tasks',task_id::text,coalesce(task_title,'Task'),action,actor_id,coalesce(actor_name,'Administration / system'),project_id,team_id,changes,created_at,id
  from public.task_activity on conflict(task_activity_id) do nothing;

create or replace function exo_private.capture_workspace_activity()
returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb:='{}'; after_row jsonb:='{}'; payload jsonb; delta jsonb; label text; entity text;
  project uuid; team uuid; task uuid;
begin
  if tg_op<>'INSERT' then before_row:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then after_row:=to_jsonb(new); end if;
  payload:=case when tg_op='DELETE' then before_row else after_row end;
  select coalesce(jsonb_object_agg(k,jsonb_build_object('from',before_row->k,'to',after_row->k)),'{}') into delta
    from (select jsonb_object_keys(before_row||after_row) k) keys
    where before_row->k is distinct from after_row->k and k not in('updated_at','created_at');
  if delta='{}'::jsonb then return null; end if;
  project:=(payload->>'project_id')::uuid; team:=(payload->>'team_id')::uuid; task:=(payload->>'task_id')::uuid;
  entity:=coalesce(payload->>'id',concat_ws(':',payload->>'task_id',payload->>'team_id',payload->>'project_id',payload->>'user_id',payload->>'depends_on_task_id'));
  label:=coalesce(nullif(payload->>'name',''),nullif(payload->>'display_name',''),nullif(payload->>'title',''),nullif(payload->>'label',''));
  if tg_table_name='team_members' or tg_table_name='leadership_assignments' then
    label:=coalesce((select display_name from public.profiles where id=(payload->>'user_id')::uuid),'Member')
      ||case when team is null then '' else ' · '||coalesce((select name from public.teams where id=team),'Group') end
      ||case when payload?'role' then ' · '||(payload->>'role') else '' end;
  elsif task is not null then
    select t.project_id,t.team_id,t.title into project,team,label from public.tasks t where t.id=task;
  elsif tg_table_name='projects' then project:=(payload->>'id')::uuid;
  elsif tg_table_name='teams' then team:=(payload->>'id')::uuid;
  end if;
  insert into public.workspace_activity(entity_type,entity_id,entity_label,action,actor_id,actor_name,project_id,team_id,changes)
    values(tg_table_name,entity,coalesce(nullif(label,''),replace(tg_table_name,'_',' ')),case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,auth.uid(),
      coalesce(nullif((select display_name from public.profiles where id=auth.uid()),''),case when auth.uid() is null then 'Administration / system' else 'Workspace member' end),project,team,delta);
  return null;
end $$;
-- Map INSERT/UPDATE/DELETE to readable action names without changing data.
-- Install one trigger on each source table; the audit table never audits itself.
do $$ declare t text; begin
  foreach t in array array['profiles','teams','team_members','projects','project_teams','leadership_assignments','milestones','task_contributors','task_dependencies','task_comments','task_checklist_items','task_links'] loop
    execute format('drop trigger if exists exo_workspace_history on public.%I',t);
    execute format('create trigger exo_workspace_history after insert or update or delete on public.%I for each row execute function exo_private.capture_workspace_activity()',t);
  end loop;
end $$;
drop trigger if exists exo_workspace_task_delete on public.tasks;
create trigger exo_workspace_task_delete after delete on public.tasks for each row execute function exo_private.capture_workspace_activity();
revoke all on function exo_private.guard_task_progress(),exo_private.mirror_task_history(),exo_private.capture_workspace_activity(),exo_private.log_task_activity() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
