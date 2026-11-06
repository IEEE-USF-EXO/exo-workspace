-- Apply after overview-notes.sql and any roster assignment migrations.
begin;

alter table public.tasks add column if not exists team_ids uuid[];
alter table public.tasks disable trigger exo_guard_archived_team_tasks;
alter table public.tasks disable trigger exo_guard_archived_project_tasks;
alter table public.tasks disable trigger exo_task_activity;
update public.tasks set team_ids=array[team_id] where team_ids is null;
alter table public.tasks enable trigger exo_task_activity;
alter table public.tasks enable trigger exo_guard_archived_project_tasks;
alter table public.tasks enable trigger exo_guard_archived_team_tasks;
alter table public.tasks alter column team_ids set not null;
create index if not exists exo_tasks_team_ids_idx on public.tasks using gin(team_ids);

-- The ordered array supports filtering and keeps the first team as the existing
-- assignee/import anchor. The relation enforces foreign keys for every team.
create table if not exists public.task_teams (
  task_id uuid not null references public.tasks(id) on delete cascade,
  team_id uuid not null references public.teams(id),
  primary key(task_id,team_id)
);
create index if not exists exo_task_teams_team_idx on public.task_teams(team_id);
alter table public.task_teams enable row level security;
revoke all on public.task_teams from public,anon,authenticated;

create or replace function exo_private.task_scope_access(p_teams uuid[],p_project uuid,p_archived boolean,p_manage boolean)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from unnest(p_teams) as g(id)
    where (not exo_private.team_is_archived(g.id) or (not p_manage and (
      p_archived or not exists(select 1 from unnest(p_teams) a(id) where not exo_private.team_is_archived(a.id))
    )))
    and case when p_manage then exo_private.can_manage_in(g.id,p_project)
      else exo_private.can_work_in(g.id,p_project) end
  );
$$;
revoke all on function exo_private.task_scope_access(uuid[],uuid,boolean,boolean) from public,anon;
grant execute on function exo_private.task_scope_access(uuid[],uuid,boolean,boolean) to authenticated;

create or replace function exo_private.can_edit_task(p_task uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.tasks t where t.id=p_task
    and exo_private.task_scope_access(t.team_ids,t.project_id,t.archived_at is not null,false));
$$;

drop policy if exists exo_task_group_access on public.tasks;
create policy exo_task_group_access on public.tasks as restrictive for select to authenticated
  using (exo_private.task_scope_access(team_ids,project_id,archived_at is not null,false));
drop policy if exists exo_task_update on public.tasks;
create policy exo_task_update on public.tasks for update to authenticated
  using (exo_private.task_scope_access(team_ids,project_id,archived_at is not null,false))
  with check (exo_private.task_scope_access(team_ids,project_id,archived_at is not null,false));

create or replace function exo_private.guard_archived_team_tasks()
returns trigger language plpgsql security definer set search_path='' as $$
declare g uuid; prior uuid[] := '{}'; changed boolean; has_active boolean := false;
begin
  if tg_op='UPDATE' then
    if pg_trigger_depth()>1 and
      (to_jsonb(new)-array['archived_at','archived_by','project_archive_marker','updated_at']) =
      (to_jsonb(old)-array['archived_at','archived_by','project_archive_marker','updated_at']) then return new; end if;
    prior := old.team_ids;
    if new.team_ids=prior and new.team_id is distinct from old.team_id then
      if cardinality(prior)>1 then raise exception 'Use shared assignment to move this task'; end if;
      new.team_ids := array[new.team_id];
    end if;
  end if;
  new.team_ids := coalesce(new.team_ids,array[new.team_id]);
  if array_ndims(new.team_ids) is distinct from 1 or array_lower(new.team_ids,1)<>1
    or cardinality(new.team_ids)<>(select count(distinct id) from unnest(new.team_ids) g(id))
    or new.team_ids[1] is distinct from new.team_id then
    raise exception 'Choose distinct teams with the primary team first' using errcode='23514';
  end if;
  changed := new.team_ids is distinct from prior;
  for g in select distinct id from unnest(prior||new.team_ids) groups(id) order by id loop
    perform exo_private.lock_team_ancestors(g);
    if changed and auth.uid() is not null and not exo_private.can_manage_in(g,new.project_id) then
      raise exception 'You must manage all current and selected teams to change assignments' using errcode='42501';
    end if;
    if g=any(new.team_ids) then
      if not exo_private.team_is_archived(g) then has_active := true;
      elsif not(g=any(prior)) then raise exception 'Choose an active team'; end if;
    end if;
  end loop;
  if not has_active then raise exception 'Restore an assigned team before changing this task'; end if;
  return new;
end $$;

create or replace function exo_private.sync_task_teams()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  delete from public.task_teams where task_id=new.id and not(team_id=any(new.team_ids));
  insert into public.task_teams(task_id,team_id)
    select new.id,g from unnest(new.team_ids) g on conflict do nothing;
  return null;
end $$;
revoke all on function exo_private.sync_task_teams() from public,anon,authenticated;
drop trigger if exists exo_sync_task_teams on public.tasks;
create trigger exo_sync_task_teams after insert or update of team_id,team_ids on public.tasks
  for each row execute function exo_private.sync_task_teams();
insert into public.task_teams(task_id,team_id)
  select t.id,g from public.tasks t cross join lateral unnest(t.team_ids) g on conflict do nothing;

create or replace function exo_private.guard_task_progress()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.archived_at is not null and new.status is distinct from old.status then
    raise exception 'Restore this task before changing progress' using errcode='42501';
  end if;
  if auth.uid() is not null and (old.archived_at is not null or old.status='cancelled' or new.status='cancelled')
    and not exo_private.task_scope_access(old.team_ids,old.project_id,false,true) then
    raise exception 'Only a lead or chair can change archived or cancelled tasks' using errcode='42501';
  end if;
  return new;
end $$;

create or replace function exo_private.can_write_task_comment(p_task uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.tasks t join public.projects p on p.id=t.project_id
    where t.id=p_task and t.archived_at is null and p.status<>'archived'
      and exists(select 1 from unnest(t.team_ids) g where not exo_private.team_is_archived(g)
        and exo_private.can_work_in(g,t.project_id))
  );
$$;

-- Use a typed task record so the same RPC supports installations with and
-- without the optional roster assignee column.
create or replace function public.manage_task(p_task uuid,p_expected timestamptz,p_values jsonb)
returns setof public.tasks language plpgsql security definer set search_path='' as $$
declare existing public.tasks; revised public.tasks; fields text;
begin
  select * into existing from public.tasks where id=p_task for update;
  if auth.uid() is null or existing.id is null or
    not exo_private.task_scope_access(existing.team_ids,existing.project_id,false,true) then
    raise exception 'Only a scoped lead or chair can manage this task' using errcode='42501';
  end if;
  if existing.updated_at is distinct from p_expected then
    raise exception 'This task changed. Refresh and try again.' using errcode='40001';
  end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or
    p_values-array['title','description','status','priority','assignee_id','assignee_person_id','team_id','team_ids','due_at','milestone_id','archived']<>'{}'::jsonb
    or (p_values?'assignee_person_id' and not(to_jsonb(existing)?'assignee_person_id')) then
    raise exception 'Unsupported task fields';
  end if;
  if existing.archived_at is not null and p_values-array['archived']<>'{}'::jsonb then
    raise exception 'Restore this task before editing it' using errcode='42501';
  end if;
  if p_values?'archived' then
    if exists(select 1 from unnest(existing.team_ids) g where not exo_private.can_manage_in(g,existing.project_id)) then
      raise exception 'You must manage all assigned teams to archive or restore this task' using errcode='42501';
    end if;
    p_values := (p_values-'archived') || case when (p_values->>'archived')::boolean
      then jsonb_build_object('archived_at',coalesce(existing.archived_at,clock_timestamp()),'archived_by',coalesce(existing.archived_by,auth.uid()))
      else '{"archived_at":null,"archived_by":null}'::jsonb end;
  end if;
  if p_values?'team_ids' and not(p_values?'team_id') then
    p_values := p_values || jsonb_build_object('team_id',p_values->'team_ids'->0);
  end if;
  revised := jsonb_populate_record(existing,p_values);
  select string_agg(format('%I=($1).%I',key,key),',') into fields from jsonb_object_keys(p_values) key;
  if fields is null then return next existing; return; end if;
  return query execute 'update public.tasks set '||fields||' where id=$2 returning *' using revised,p_task;
end $$;
revoke all on function public.manage_task(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.manage_task(uuid,timestamptz,jsonb) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
