-- Run after activity-log.sql. Project archiving preserves task history.
begin;
alter table public.tasks add column if not exists project_archive_marker boolean not null default false;
alter table public.projects add column if not exists pre_archive_status text;
create or replace function exo_private.archive_project_tasks() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='archived' and old.status<>'archived' then
  new.pre_archive_status:=old.status;
  update public.tasks set archived_at=now(),archived_by=auth.uid(),project_archive_marker=true where project_id=new.id and archived_at is null;
 elsif old.status='archived' and new.status<>'archived' then
  update public.tasks set archived_at=null,archived_by=null,project_archive_marker=false where project_id=new.id and project_archive_marker;
  new.pre_archive_status:=null;
 end if;
 return new;
end $$;
revoke all on function exo_private.archive_project_tasks() from public,anon,authenticated;
drop trigger if exists exo_project_archive_tasks on public.projects;
create trigger exo_project_archive_tasks before update of status on public.projects for each row execute function exo_private.archive_project_tasks();
create or replace function public.manage_project(p_id uuid,p_name text,p_description text,p_action text) returns void language plpgsql security definer set search_path='' as $$
declare project public.projects;
begin
 if auth.uid() is null or not exo_private.is_admin() then raise exception 'EXO chair access required' using errcode='42501'; end if;
 select * into strict project from public.projects where id=p_id for update;
 if p_action='restore' and project.status<>'archived' then return; end if;
 if p_action='edit' then update public.projects set name=btrim(p_name),description=p_description where id=p_id;
 elsif p_action='archive' then update public.projects set status='archived' where id=p_id;
 elsif p_action='restore' then update public.projects set status=coalesce(pre_archive_status,'active') where id=p_id;
 else raise exception 'Unknown project action'; end if;
end $$;
revoke all on function public.manage_project(uuid,text,text,text) from public,anon;
grant execute on function public.manage_project(uuid,text,text,text) to authenticated;
-- Serialize new task writes with project archive/restore and reject stale clients.
create or replace function exo_private.guard_archived_project_tasks()
returns trigger language plpgsql security definer set search_path='' as $$
declare project_status text;
begin
 if pg_trigger_depth() > 1 then return new; end if;
 select status into project_status from public.projects where id=new.project_id for share;
 if project_status='archived' then
  raise exception 'Restore the project before changing its tasks' using errcode='42501';
 end if;
 return new;
end $$;
revoke all on function exo_private.guard_archived_project_tasks() from public,anon,authenticated;
drop trigger if exists exo_guard_archived_project_tasks on public.tasks;
create trigger exo_guard_archived_project_tasks before insert or update on public.tasks
 for each row execute function exo_private.guard_archived_project_tasks();
notify pgrst,'reload schema';
commit;
