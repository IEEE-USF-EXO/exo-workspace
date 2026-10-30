-- Run the WHOLE script in Supabase SQL Editor as postgres.
-- Moves every existing task, including archived tasks, to the exo-leg PROJECT.
-- Preserves groups, people, progress, dates, comments, and historical events.
-- This does NOT release old team/subteam references for deletion.
-- Referenced milestones and task dependency scopes move with the tasks.
do $move$
declare target uuid; matches integer; moved integer;
begin
  if current_user <> 'postgres' then
    raise exception 'Run this one-off migration as postgres in SQL Editor';
  end if;
  lock table public.projects, public.teams, public.milestones, public.tasks,
    public.task_dependencies in share row exclusive mode;
  select count(*), (array_agg(id))[1] into matches,target from public.projects
    where lower(btrim(name))='exo-leg';
  if matches<>1 then
    raise exception 'Expected exactly one project named exo-leg; found %. No tasks moved.', matches;
  end if;
  if exists(select 1 from public.projects where id=target and status='archived') then
    raise exception 'Restore the exo-leg project before moving tasks into it';
  end if;
  if exists(select 1 from public.tasks t where t.project_id<>target
    and t.assignee_id is not null
    and not exo_private.user_can_access_group(t.assignee_id,t.team_id,target)) then
    raise exception 'An existing assignee lacks access in exo-leg. Review their group membership before moving tasks.';
  end if;
  if exists(select 1 from public.tasks t where t.project_id<>target
    and t.assignee_person_id is not null
    and not exo_private.person_can_access_group(t.assignee_person_id,t.team_id,target)) then
    raise exception 'A roster assignee lacks group access in exo-leg. Review their approval before moving tasks.';
  end if;

  -- All referencing rows change within ONE statement, so the immediate
  -- composite foreign keys see a consistent final project scope.
  with milestones_moved as (
    update public.milestones m set project_id=target
    where m.project_id<>target and exists(select 1 from public.tasks t where t.milestone_id=m.id)
    returning m.id
  ), dependencies_moved as (
    update public.task_dependencies d set project_id=target where d.project_id<>target
    returning d.task_id
  ), tasks_moved as (
    update public.tasks t set project_id=target,project_archive_marker=false
    where t.project_id<>target returning t.id
  ) select count(*) into moved from tasks_moved;
  if exists(select 1 from public.tasks where project_id<>target) then
    raise exception 'Not all tasks reached exo-leg; the move was rolled back';
  end if;
  raise notice 'Moved % tasks into exo-leg. Groups and assignees were preserved.',moved;
end;
$move$;

select p.name as project, count(*) as total_tasks,
  count(*) filter(where t.archived_at is null) as active_tasks,
  count(*) filter(where t.archived_at is not null) as archived_tasks
from public.tasks t join public.projects p on p.id=t.project_id
group by p.id,p.name order by p.name;
