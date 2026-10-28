-- Run AFTER schema.sql. Additive: existing tasks and permissions are preserved.
begin;
create table if not exists public.github_sync_tasks (
  task_id uuid primary key,
  project_id uuid not null,
  local_version bigint not null default 1,
  local_data jsonb not null,
  local_changed_at timestamptz not null,
  synced_version bigint not null default 0,
  remote_id text unique,
  remote_data jsonb,
  pending jsonb,
  last_error text,
  synced_at timestamptz
);
-- No task FK: deletion must leave a tombstone to archive the GitHub item.
create table if not exists public.github_sync_history (
  id bigint generated always as identity primary key,
  task_id uuid not null,
  direction text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists github_sync_history_task on public.github_sync_history(task_id, created_at);
create table if not exists public.github_sync_lock (
  id boolean primary key default true check (id),
  owner uuid not null,
  expires_at timestamptz not null
);
alter table public.github_sync_tasks enable row level security;
alter table public.github_sync_history enable row level security;
alter table public.github_sync_lock enable row level security;
revoke all on public.github_sync_tasks, public.github_sync_history, public.github_sync_lock from public, anon, authenticated;
grant all on public.github_sync_tasks, public.github_sync_history, public.github_sync_lock to service_role;
grant usage, select on sequence public.github_sync_history_id_seq to service_role;

create or replace function exo_private.capture_github_task()
returns trigger language plpgsql security definer set search_path = '' as $$
declare payload jsonb;
begin
  if current_setting('exo.github_sync', true) = 'incoming' then return null; end if;
  -- An assignment/milestone-only edit must not win a public-board conflict.
  if tg_op = 'UPDATE' and
    (to_jsonb(new) - array['updated_at','assignee_id','milestone_id','completed_at']) =
    (to_jsonb(old) - array['updated_at','assignee_id','milestone_id','completed_at']) then return null; end if;
  if tg_op = 'DELETE' then
    payload := to_jsonb(old) || '{"deleted":true}'::jsonb;
  else payload := to_jsonb(new) || '{"deleted":false}'::jsonb; end if;
  insert into public.github_sync_tasks(task_id, project_id, local_data, local_changed_at)
    values ((payload->>'id')::uuid, (payload->>'project_id')::uuid, payload, clock_timestamp())
    on conflict (task_id) do update set
      local_version = public.github_sync_tasks.local_version + 1,
      local_data = excluded.local_data, local_changed_at = excluded.local_changed_at;
  insert into public.github_sync_history(task_id, direction, snapshot)
    values ((payload->>'id')::uuid, lower(tg_op), payload);
  return null;
end;
$$;
drop trigger if exists exo_github_task on public.tasks;
create trigger exo_github_task after insert or update or delete on public.tasks
  for each row execute function exo_private.capture_github_task();
insert into public.github_sync_tasks(task_id, project_id, local_data, local_changed_at)
  select id, project_id, to_jsonb(t) || '{"deleted":false}'::jsonb, updated_at from public.tasks t
  on conflict do nothing;

create or replace function public.github_sync_lease(p_owner uuid, p_release boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_release then
    delete from public.github_sync_lock where id and owner = p_owner;
    return found;
  end if;
  insert into public.github_sync_lock(id, owner, expires_at)
    values (true, p_owner, clock_timestamp() + interval '180 seconds')
    on conflict (id) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where public.github_sync_lock.expires_at < clock_timestamp() or public.github_sync_lock.owner = p_owner;
  return found;
end;
$$;

create or replace function exo_private.github_team(p_name text, p_parent uuid)
returns uuid language plpgsql set search_path = '' as $$
declare ids uuid[]; result uuid;
begin
  if length(btrim(p_name)) not between 1 and 120 then raise exception 'Invalid board team name'; end if;
  select array_agg(id) into ids from public.teams
    where lower(btrim(name)) = lower(btrim(p_name)) and parent_team_id is not distinct from p_parent;
  if cardinality(ids) > 1 then raise exception 'Ambiguous team name: %', p_name; end if;
  result := ids[1];
  if result is null then
    insert into public.teams(name, parent_team_id) values (btrim(p_name), p_parent) returning id into result;
  end if;
  return result;
end;
$$;

-- Incoming changes and acknowledgement are transactional and compare versions.
-- Only the service key may execute these RPCs; browser users cannot bypass RLS.
create or replace function public.github_sync_apply(
  p_owner uuid, p_task_id uuid, p_expected bigint, p_project_id uuid,
  p_actor uuid, p_remote jsonb, p_values jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare s public.github_sync_tasks; team uuid; payload jsonb;
begin
  if not exists (select 1 from public.github_sync_lock where owner=p_owner and expires_at>clock_timestamp()) then
    raise exception 'Sync lease expired'; end if;
  if not exists (select 1 from public.projects where id=p_project_id) then raise exception 'Unknown project'; end if;
  if not exists (select 1 from public.leadership_assignments where user_id=p_actor and role='exo_chair'
    and team_id is null and project_id is null and revoked_at is null) then raise exception 'Sync actor must be an active EXO chair'; end if;
  insert into public.github_sync_tasks(task_id,project_id,local_version,local_data,local_changed_at)
    values (p_task_id,p_project_id,0,'{}', '-infinity') on conflict do nothing;
  select * into s from public.github_sync_tasks where task_id=p_task_id for update;
  if s.local_version <> p_expected or s.project_id <> p_project_id or s.pending is not null then return false; end if;
  insert into public.github_sync_history(task_id,direction,snapshot)
    values (p_task_id,'github_to_supabase',jsonb_build_object('before',s.local_data,'remote',p_remote));
  perform set_config('exo.github_sync','incoming',true);
  team := exo_private.github_team(p_values->>'team',null);
  if coalesce(p_values->>'subteam','') <> '' then
    team := exo_private.github_team(p_values->>'subteam',team);
  end if;
  insert into public.tasks(id,project_id,team_id,title,description,status,priority,due_at,created_by)
    values (p_task_id,p_project_id,team,p_values->>'title',p_values->>'description',p_values->>'status',
      p_values->>'priority',(p_values->>'due_at')::timestamptz,p_actor)
    on conflict (id) do update set team_id=excluded.team_id,title=excluded.title,description=excluded.description,
      status=excluded.status,priority=excluded.priority,due_at=excluded.due_at
    returning to_jsonb(tasks) || '{"deleted":false}'::jsonb into payload;
  -- Preserve assignee, creator and milestone on updates. Incompatible team moves
  -- are rejected by existing constraints rather than detaching private data.
  update public.github_sync_tasks set local_data=payload, local_version=p_expected+1,
    local_changed_at=(p_remote->>'changedAt')::timestamptz,
    synced_version=p_expected+1,remote_id=p_remote->>'id',remote_data=p_remote,
    last_error=null,synced_at=clock_timestamp() where task_id=p_task_id;
  perform set_config('exo.github_sync','',true);
  return true;
end;
$$;

create or replace function public.github_sync_ack(
  p_owner uuid, p_task_id uuid, p_expected bigint, p_remote jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.github_sync_lock where owner=p_owner and expires_at>clock_timestamp()) then
    raise exception 'Sync lease expired'; end if;
  update public.github_sync_tasks set remote_id=p_remote->>'id',remote_data=p_remote,
    synced_version=p_expected,pending=null,last_error=null,synced_at=clock_timestamp()
    where task_id=p_task_id and local_version>=p_expected;
  return found;
end;
$$;
revoke all on function exo_private.capture_github_task(), exo_private.github_team(text,uuid) from public,anon,authenticated;
revoke all on function public.github_sync_lease(uuid,boolean),
  public.github_sync_apply(uuid,uuid,bigint,uuid,uuid,jsonb,jsonb),
  public.github_sync_ack(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.github_sync_lease(uuid,boolean),
  public.github_sync_apply(uuid,uuid,bigint,uuid,uuid,jsonb,jsonb),
  public.github_sync_ack(uuid,uuid,bigint,jsonb) to service_role;
commit;
