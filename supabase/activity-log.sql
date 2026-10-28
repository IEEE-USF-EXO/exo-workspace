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
