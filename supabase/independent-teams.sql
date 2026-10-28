-- Run this WHOLE file in Supabase SQL Editor for an existing Workbench database.
-- Projects are shared across the workspace. Teams/subteams receive tasks from
-- any project without a project_teams record. Existing task data is preserved.
begin;

do $$
declare legacy record;
begin
  for legacy in select conname from pg_constraint
    where conrelid = 'public.tasks'::regclass and contype = 'f'
      and confrelid = 'public.project_teams'::regclass loop
    execute format('alter table public.tasks drop constraint %I', legacy.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid='public.tasks'::regclass and conname='exo_task_project_fk') then
    alter table public.tasks add constraint exo_task_project_fk
      foreign key (project_id) references public.projects(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.tasks'::regclass and conname='exo_task_team_fk') then
    alter table public.tasks add constraint exo_task_team_fk
      foreign key (team_id) references public.teams(id) on delete restrict;
  end if;
end;
$$;

-- Existing member SELECT policies already expose all projects. Team membership
-- and scoped leadership still control task writes through can_work_in().
-- Preserve the unused project_teams table and its rows for compatibility.
notify pgrst, 'reload schema';
commit;

-- Expect independent project/team FKs, and no FK from tasks to project_teams.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid='public.tasks'::regclass and contype='f'
order by conname;
