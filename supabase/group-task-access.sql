-- Run after independent-teams.sql in Supabase SQL Editor, then refresh Workbench.
-- No tasks or memberships are deleted. Saved group membership controls reads as
-- well as writes, including membership changes made directly in Supabase.
begin;

drop policy if exists exo_task_group_access on public.tasks;
create policy exo_task_group_access on public.tasks as restrictive
  for select to authenticated using (exo_private.can_work_in(team_id, project_id));

-- Keep task discussions, checklists and history inside the same visibility scope.
-- These restrictive policies cannot be bypassed by an older permissive policy.
do $$
declare t text;
begin
  foreach t in array array['task_contributors','task_comments','task_checklist_items','task_activity'] loop
    execute format('drop policy if exists exo_task_group_access on public.%I', t);
    execute format('create policy exo_task_group_access on public.%I as restrictive for all to authenticated using (exo_private.can_edit_task(task_id)) with check (exo_private.can_edit_task(task_id))', t);
  end loop;
end;
$$;
drop policy if exists exo_task_group_access on public.task_dependencies;
create policy exo_task_group_access on public.task_dependencies as restrictive
  for all to authenticated
  using (exo_private.can_edit_task(task_id) and exo_private.can_edit_task(depends_on_task_id))
  with check (exo_private.can_edit_task(task_id) and exo_private.can_edit_task(depends_on_task_id));

-- Projects, team directory, milestones and resource links remain shared.
-- Existing can_work_in() includes descendant subteams of a parent membership,
-- scoped leadership, and EXO chair access to all groups.
notify pgrst, 'reload schema';
commit;
