-- Apply after team-management.sql and group-task-access.sql.
begin;

create table if not exists public.overview_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  team_id uuid references public.teams(id),
  author_id uuid not null default auth.uid() references public.profiles(id),
  body text not null check (length(btrim(body)) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists exo_overview_notes_scope_idx
  on public.overview_notes(project_id, team_id, created_at desc, id desc);

create or replace function exo_private.can_access_overview_note(p_project uuid,p_team uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exo_private.is_member()
    and exists(select 1 from public.projects p where p.id=p_project and p.status<>'archived')
    and (p_team is null or (
      not exo_private.team_is_archived(p_team) and exo_private.can_work_in(p_team,p_project)
    ));
$$;
revoke all on function exo_private.can_access_overview_note(uuid,uuid) from public,anon;
grant execute on function exo_private.can_access_overview_note(uuid,uuid) to authenticated;

alter table public.overview_notes enable row level security;
revoke all on public.overview_notes from public,anon,authenticated;
grant select,insert(project_id,team_id,body),update(body),delete on public.overview_notes to authenticated;
drop policy if exists exo_overview_notes_read on public.overview_notes;
create policy exo_overview_notes_read on public.overview_notes for select to authenticated
  using (exo_private.can_access_overview_note(project_id,team_id));
drop policy if exists exo_overview_notes_post on public.overview_notes;
create policy exo_overview_notes_post on public.overview_notes for insert to authenticated
  with check (author_id=(select auth.uid()) and exo_private.can_access_overview_note(project_id,team_id)
    and (team_id is not null or (select exo_private.is_admin())));
drop policy if exists exo_overview_notes_edit on public.overview_notes;
create policy exo_overview_notes_edit on public.overview_notes for update to authenticated
  using (author_id=(select auth.uid()) and exo_private.can_access_overview_note(project_id,team_id)
    and (team_id is not null or (select exo_private.is_admin())))
  with check (author_id=(select auth.uid()) and exo_private.can_access_overview_note(project_id,team_id)
    and (team_id is not null or (select exo_private.is_admin())));
drop policy if exists exo_overview_notes_delete on public.overview_notes;
create policy exo_overview_notes_delete on public.overview_notes for delete to authenticated
  using (exo_private.can_access_overview_note(project_id,team_id)
    and (author_id=(select auth.uid()) or (select exo_private.is_admin())));
drop trigger if exists exo_updated_at on public.overview_notes;
create trigger exo_updated_at before update on public.overview_notes
  for each row execute function exo_private.touch_updated_at();

-- Existing comment policies still require the task's group and the author.
-- Archived discussions remain readable but cannot receive posts or edits.
create or replace function exo_private.can_write_task_comment(p_task uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.tasks t join public.projects p on p.id=t.project_id
    where t.id=p_task and t.archived_at is null and p.status<>'archived'
      and exists (
        select 1 from jsonb_array_elements_text(coalesce(to_jsonb(t)->'team_ids',jsonb_build_array(t.team_id))) g(id)
        where not exo_private.team_is_archived(g.id::uuid)
          and exo_private.can_work_in(g.id::uuid,t.project_id)
      )
  );
$$;
revoke all on function exo_private.can_write_task_comment(uuid) from public,anon;
grant execute on function exo_private.can_write_task_comment(uuid) to authenticated;
drop policy if exists exo_task_comment_active_insert on public.task_comments;
create policy exo_task_comment_active_insert on public.task_comments as restrictive for insert to authenticated
  with check (exo_private.can_write_task_comment(task_id));
drop policy if exists exo_task_comment_active_update on public.task_comments;
create policy exo_task_comment_active_update on public.task_comments as restrictive for update to authenticated
  using (exo_private.can_write_task_comment(task_id))
  with check (exo_private.can_write_task_comment(task_id));

do $$
declare relation text;
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime' and not puballtables) then
    foreach relation in array array['overview_notes','task_comments'] loop
      if not exists (select 1 from pg_publication_tables
        where pubname='supabase_realtime' and schemaname='public' and tablename=relation) then
        execute format('alter publication supabase_realtime add table public.%I',relation);
      end if;
    end loop;
  end if;
end;
$$;

notify pgrst,'reload schema';
commit;
