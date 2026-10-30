-- Read-only preflight. Run the WHOLE file in Supabase SQL Editor as postgres.
-- Lists subteams only. Every root team (parent_team_id IS NULL) is excluded.
-- Counts are direct references, not inherited access. Nothing is deleted.
select t.id, p.name as parent_team, t.name as subteam,
  (select count(*) from public.teams c where c.parent_team_id=t.id) as child_groups,
  (select count(*) from public.tasks x where x.team_id=t.id) as tasks_including_archived,
  (select count(*) from public.team_members m where m.team_id=t.id) as direct_memberships_removed_on_delete,
  (select count(*) from public.leadership_assignments l where l.team_id=t.id) as leadership_rows_removed_on_delete,
  (select count(*) from public.project_teams l where l.team_id=t.id) as legacy_project_links,
  (select count(*) from exo_private.roster_memberships r where r.team_id=t.id) as roster_approvals_including_disabled
from public.teams t join public.teams p on p.id=t.parent_team_id
order by p.name,t.name,t.id;

-- Check the actual installed foreign keys; existing projects may differ from
-- the repository's schema. RESTRICT/NO ACTION block deletion; CASCADE deletes
-- referencing rows. This also finds any extra tables added outside this repo.
select n.nspname as referencing_schema, c.relname as referencing_table,
  fk.conname as constraint_name, pg_get_constraintdef(fk.oid) as definition
from pg_constraint fk
join pg_class c on c.oid=fk.conrelid
join pg_namespace n on n.oid=c.relnamespace
where fk.contype='f' and fk.confrelid='public.teams'::regclass
order by n.nspname,c.relname,fk.conname;
