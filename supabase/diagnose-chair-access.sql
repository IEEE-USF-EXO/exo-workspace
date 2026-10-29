-- Read-only: run in Supabase SQL Editor as postgres.
-- Each SELECT produces a result set. No roles or permissions are changed.
begin transaction read only;

-- Match the intended person's exact profile ID; names need not be unique.
select p.id as user_id, p.display_name,
  l.id as assignment_id, l.role, l.team_id, l.project_id, l.revoked_at,
  coalesce(l.role = 'exo_chair' and l.team_id is null
    and l.project_id is null and l.revoked_at is null, false) as valid_chair_assignment
from public.profiles p
left join public.leadership_assignments l on l.user_id = p.id
order by p.display_name, p.id, l.created_at;

-- Existing databases can have constraints absent from the local CREATE TABLE.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.leadership_assignments'::regclass;
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'leadership_assignments';

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('leadership_assignments', 'profiles', 'team_members')
order by tablename, policyname;

select p.oid::regprocedure as function_name, r.rolname as owner,
  p.prosecdef as security_definer, p.proconfig,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where n.nspname = 'exo_private' and p.proname in ('is_admin', 'is_member');

select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'leadership_assignments'
order by grantee, privilege_type;
commit;
