-- EXO role alignment: preserves the four original role names and all records.
-- Run the entire file in Supabase SQL Editor. Does not reset tables or policies.
-- The is_admin helper grants workspace administration to exo_chair.
-- permanent_project_lead remains a read-access role until further powers are defined.
begin;

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

revoke all on function exo_private.is_admin() from public, anon;
grant execute on function exo_private.is_admin() to authenticated, service_role;
revoke all on function exo_private.is_member() from public, anon;
grant execute on function exo_private.is_member() to authenticated, service_role;
revoke all on function exo_private.can_work_in(uuid, uuid) from public, anon;
grant execute on function exo_private.can_work_in(uuid, uuid) to authenticated, service_role;
revoke all on function exo_private.leads_project(uuid) from public, anon;
grant execute on function exo_private.leads_project(uuid) to authenticated, service_role;
revoke all on function exo_private.can_edit_task(uuid) from public, anon;
grant execute on function exo_private.can_edit_task(uuid) to authenticated, service_role;

-- Your profile ID from the supplied error/screenshot (Jordan Martin).
insert into public.leadership_assignments (user_id, role)
select p.id, 'exo_chair'
from public.profiles p
where p.id = '940dbf49-22e0-405a-97ad-ce11fc6debb0'::uuid
  and not exists (
    select 1 from public.leadership_assignments l
    where l.user_id = p.id and l.role = 'exo_chair'
      and l.team_id is null and l.project_id is null and l.revoked_at is null
  );

commit;

select p.display_name, l.user_id, l.role, l.revoked_at
from public.leadership_assignments l
join public.profiles p on p.id = l.user_id
where p.id = '940dbf49-22e0-405a-97ad-ce11fc6debb0'::uuid
  and l.role = 'exo_chair' and l.revoked_at is null;
