-- Requires roster-memberships.sql and activity-log.sql. Run as postgres.
-- Names are member-visible; email aliases remain exclusively in exo_private.
begin;
create table if not exists public.roster_people (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check(length(btrim(display_name)) between 1 and 160)
);
alter table public.roster_people enable row level security;
revoke all on public.roster_people from public, anon, authenticated;
grant select on public.roster_people to authenticated;
grant all on public.roster_people to service_role;
drop policy if exists exo_roster_people_read on public.roster_people;
create policy exo_roster_people_read on public.roster_people for select to authenticated
  using ((select exo_private.is_member()));
alter table exo_private.roster_memberships
  add column if not exists person_id uuid references public.roster_people(id) on delete restrict;
create index if not exists exo_roster_person_idx on exo_private.roster_memberships(person_id);

create or replace view public.roster_accounts with (security_barrier=true) as
  select distinct person_id, claimed_by as user_id from exo_private.roster_memberships
  where person_id is not null and claimed_by is not null and exo_private.is_member();
create or replace view public.roster_groups with (security_barrier=true) as
  select distinct r.person_id, r.team_id from exo_private.roster_memberships r
  where r.person_id is not null and r.disabled_at is null and exo_private.is_member()
    and (r.claimed_at is null or exists(select 1 from public.team_members m
      where m.user_id=r.claimed_by and m.team_id=r.team_id));
revoke all on public.roster_accounts, public.roster_groups from public, anon, authenticated;
grant select on public.roster_accounts, public.roster_groups to authenticated, service_role;

create or replace function exo_private.person_can_access_group(p_person uuid,p_team uuid,p_project uuid)
returns boolean language sql stable security definer set search_path='' as $$
  with recursive ancestors(id,parent_team_id) as (
    select id,parent_team_id from public.teams where id=p_team
    union select t.id,t.parent_team_id from public.teams t join ancestors a on t.id=a.parent_team_id
  )
  select exists(select 1 from exo_private.roster_memberships r
    where r.person_id=p_person and r.disabled_at is null
    and ((r.team_id in(select id from ancestors)
      and (r.claimed_at is null or exists(select 1 from public.team_members m
        where m.user_id=r.claimed_by and m.team_id=r.team_id)))
      or (r.claimed_by is not null and exo_private.user_can_access_group(r.claimed_by,p_team,p_project))));
$$;
revoke all on function exo_private.person_can_access_group(uuid,uuid,uuid) from public,anon,authenticated;

alter table public.tasks add column if not exists assignee_person_id uuid
  references public.roster_people(id) on delete restrict;
create index if not exists exo_tasks_roster_assignee_idx on public.tasks(assignee_person_id);
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.tasks'::regclass
    and conname='exo_single_assignee') then
    alter table public.tasks add constraint exo_single_assignee
      check(assignee_id is null or assignee_person_id is null);
  end if;
end $$;

create or replace function exo_private.check_task_assignee()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and new.assignee_id is not distinct from old.assignee_id
    and new.assignee_person_id is not distinct from old.assignee_person_id
    and new.team_id=old.team_id and new.project_id=old.project_id then return new; end if;
  if new.assignee_person_id is not null and (new.assignee_id is not null
    or not exo_private.person_can_access_group(new.assignee_person_id,new.team_id,new.project_id)) then
    raise exception 'The roster person needs an active approval or membership for this group' using errcode='23514';
  end if;
  if new.assignee_id is not null and not exo_private.user_can_access_group(new.assignee_id,new.team_id,new.project_id) then
    raise exception 'The assignee needs access to this task group first' using errcode='23514'; end if;
  return new;
end $$;
drop trigger if exists exo_task_assignee on public.tasks;
create trigger exo_task_assignee before insert or update of assignee_id,assignee_person_id,team_id,project_id
  on public.tasks for each row execute function exo_private.check_task_assignee();

-- All selected memberships are saved with the subgroup, or all are rolled back.
create or replace function public.create_subteam_with_members(p_name text,p_description text,p_parent uuid,
  p_project uuid,p_users uuid[] default '{}',p_people uuid[] default '{}')
returns setof public.teams language plpgsql security definer set search_path='' as $$
declare new_team public.teams; person uuid; account_id uuid;
begin
  if auth.uid() is null or not exo_private.can_manage_in(p_parent,p_project) then
    raise exception 'Only a scoped lead or chair can create this subgroup' using errcode='42501'; end if;
  if not exists(select 1 from public.projects where id=p_project and status<>'archived') then
    raise exception 'Choose an active project'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120
    or coalesce(cardinality(p_users),0)+coalesce(cardinality(p_people),0)>500 then
    raise exception 'Invalid group name or member selection'; end if;
  if exists(select 1 from unnest(p_users) u where u is null
    or not exists(select 1 from public.profiles where id=u)
    or (not exo_private.is_admin() and not exo_private.user_can_access_group(u,p_parent,p_project)))
    or exists(select 1 from unnest(p_people) p where p is null
    or not exists(select 1 from public.roster_people where id=p)
    or not exists(select 1 from exo_private.roster_memberships where person_id=p and disabled_at is null)
    or (not exo_private.is_admin() and not exo_private.person_can_access_group(p,p_parent,p_project))) then
    raise exception 'Choose people within your parent group' using errcode='42501'; end if;
  insert into public.teams(name,description,parent_team_id)
    values(btrim(p_name),nullif(btrim(p_description),''),p_parent) returning * into new_team;
  insert into public.team_members(team_id,user_id)
    select new_team.id,u from (select distinct unnest(p_users) as u) selected on conflict do nothing;
  for person in select distinct unnest(p_people) loop
    insert into exo_private.roster_memberships(email,team_id,person_id,source)
      select distinct r.email,new_team.id,person,'Subgroup member selection'
      from exo_private.roster_memberships r where r.person_id=person and r.disabled_at is null
      on conflict(email,team_id) do nothing;
    for account_id in select distinct u.id from auth.users u
      join exo_private.roster_memberships r on lower(btrim(u.email))=r.email
      where r.person_id=person and r.disabled_at is null order by u.id
    loop perform exo_private.apply_roster_memberships(account_id); end loop;
  end loop;
  return next new_team;
end $$;
revoke all on function public.create_subteam_with_members(text,text,uuid,uuid,uuid[],uuid[]) from public,anon;
grant execute on function public.create_subteam_with_members(text,text,uuid,uuid,uuid[],uuid[]) to authenticated,service_role;
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
    p_values-array['title','description','status','priority','assignee_id','assignee_person_id','due_at','milestone_id','archived']<>'{}'::jsonb then
    raise exception 'Unsupported task fields'; end if;
  return query update public.tasks t set
    title=case when p_values?'title' then p_values->>'title' else t.title end,
    description=case when p_values?'description' then p_values->>'description' else t.description end,
    status=case when p_values?'status' then p_values->>'status' else t.status end,
    priority=case when p_values?'priority' then p_values->>'priority' else t.priority end,
    assignee_id=case when p_values?'assignee_id' then (p_values->>'assignee_id')::uuid else t.assignee_id end,
    assignee_person_id=case when p_values?'assignee_person_id' then (p_values->>'assignee_person_id')::uuid else t.assignee_person_id end,
    due_at=case when p_values?'due_at' then (p_values->>'due_at')::timestamptz else t.due_at end,
    milestone_id=case when p_values?'milestone_id' then (p_values->>'milestone_id')::uuid else t.milestone_id end,
    archived_at=case when not(p_values?'archived') then t.archived_at when (p_values->>'archived')::boolean then coalesce(t.archived_at,clock_timestamp()) else null end,
    archived_by=case when not(p_values?'archived') then t.archived_by when (p_values->>'archived')::boolean then coalesce(t.archived_by,auth.uid()) else null end
    where t.id=p_task returning t.*;
end $$;
revoke all on function public.manage_task(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.manage_task(uuid,timestamptz,jsonb) to authenticated,service_role;

commit;
