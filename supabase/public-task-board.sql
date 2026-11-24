-- Apply after shared-tasks.sql. Public summaries are deliberately separate
-- from membership-scoped source tables and their write/discussion policies.
begin;

-- These owner-executed views intentionally bypass source-table RLS to publish
-- only the fields below. Run as the migration owner (postgres). Do not add
-- profile, roster, comment, link, or activity columns to these projections.
create or replace view public.public_tasks with (security_barrier = true) as
select id, project_id, team_id, team_ids, title, description, status, priority,
       due_at, completed_at, created_at, updated_at, archived_at
from public.tasks;

create or replace view public.public_task_teams with (security_barrier = true) as
select id, name, parent_team_id, archived_at from public.teams;

create or replace view public.public_task_projects with (security_barrier = true) as
select id, name, status from public.projects;

revoke all on public.public_tasks, public.public_task_teams,
  public.public_task_projects from public, anon, authenticated;
grant select on public.public_tasks, public.public_task_teams,
  public.public_task_projects to anon, authenticated;

comment on view public.public_tasks is
  'Public read-only task summaries. Internal discussions, references, and identities remain membership-scoped.';
commit;
