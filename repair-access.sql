-- Run the entire script in Supabase SQL Editor as postgres.
-- Repairs the helpers without changing role assignments or deleting any data.
begin;

create or replace function exo_private.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.leadership_assignments l
    where l.user_id = auth.uid()
      and l.role = 'exo_chair'
      and l.team_id is null
      and l.project_id is null
      and l.revoked_at is null
  );
$fn$;

create or replace function exo_private.is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.team_members m where m.user_id = auth.uid()
  ) or exists (
    select 1 from public.leadership_assignments l
    where l.user_id = auth.uid()
      and l.revoked_at is null
      and l.role in ('exo_chair', 'permanent_project_lead', 'team_lead', 'project_lead')
  );
$fn$;

-- Explicit trusted ownership prevents helpers from depending on their caller's RLS.
alter function exo_private.is_admin() owner to postgres;
alter function exo_private.is_member() owner to postgres;
revoke all on function exo_private.is_admin() from public, anon;
revoke all on function exo_private.is_member() from public, anon;
grant usage on schema exo_private to authenticated;
grant execute on function exo_private.is_admin() to authenticated, service_role;
grant execute on function exo_private.is_member() to authenticated, service_role;

-- A user may read their own assignments without already being considered a member.
-- This does not grant permission to insert, change, or read anyone else's roles.
alter table public.leadership_assignments enable row level security;
grant select on public.leadership_assignments to authenticated;
drop policy if exists exo_own_leadership_read on public.leadership_assignments;
create policy exo_own_leadership_read
on public.leadership_assignments for select to authenticated
using (user_id = (select auth.uid()));

-- Reproduce Jordan's authenticated request, rather than checking as the SQL owner.
select set_config('request.jwt.claim.sub', '940dbf49-22e0-405a-97ad-ce11fc6debb0', true);
set local role authenticated;

select
  auth.uid() as signed_in_user,
  exo_private.is_admin() as recognized_as_admin,
  exo_private.is_member() as recognized_as_member,
  exists (
    select 1 from public.leadership_assignments
    where user_id = auth.uid() and role = 'exo_chair'
      and team_id is null and project_id is null and revoked_at is null
  ) as role_visible_to_app;

-- Report a failed repair explicitly; any exception rolls back this transaction.
do $verify$
begin
  if not exo_private.is_admin() or not exo_private.is_member() or not exists (
    select 1 from public.leadership_assignments
    where user_id = auth.uid() and role = 'exo_chair'
      and team_id is null and project_id is null and revoked_at is null
  ) then
    raise exception 'Access verification failed. The repair was not committed. Check the role assignment and any restrictive RLS policies.';
  end if;
end;
$verify$;

commit;
