-- Run after activity-log.sql (and after project-management.sql when installed).
-- Team archives never rewrite task archive flags, memberships, or hierarchy.
begin;
alter table public.teams add column if not exists archived_at timestamptz;

create or replace function exo_private.team_is_archived(p_team uuid)
returns boolean language sql stable security definer set search_path='' as $$
  with recursive parents as (
    select id,parent_team_id,archived_at from public.teams where id=p_team
    union
    select t.id,t.parent_team_id,t.archived_at from public.teams t join parents p on t.id=p.parent_team_id
  ) select exists(select 1 from parents where archived_at is not null);
$$;
revoke all on function exo_private.team_is_archived(uuid) from public,anon,authenticated;

create or replace function public.manage_team(p_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.teams;
begin
  if auth.uid() is null or not exo_private.is_admin() then
    raise exception 'EXO chair access required' using errcode='42501';
  end if;
  if p_action is null or p_action not in ('archive','restore') then raise exception 'Unknown team action'; end if;
  select * into strict target from public.teams where id=p_id for update;
  if exo_private.team_is_archived(target.parent_team_id) then
    raise exception 'Restore the parent team first';
  end if;
  update public.teams set archived_at=case when p_action='archive' then coalesce(archived_at,now()) else null end
    where id=p_id returning * into target;
  return to_jsonb(target);
end $$;
revoke all on function public.manage_team(uuid,text) from public,anon;
grant execute on function public.manage_team(uuid,text) to authenticated;

-- Lock ancestors so task writes and new subteams serialize with archive/restore.
create or replace function exo_private.lock_team_ancestors(p_team uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform t.id from public.teams t where t.id in (
    with recursive parents as (
      select id,parent_team_id from public.teams where id=p_team
      union select t.id,t.parent_team_id from public.teams t join parents p on t.id=p.parent_team_id
    ) select id from parents
  ) order by t.id for share;
end $$;
revoke all on function exo_private.lock_team_ancestors(uuid) from public,anon,authenticated;

create or replace function exo_private.guard_archived_team_tasks()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Project archive/restore triggers may update archive bookkeeping while a team
  -- is archived; these operations must remain independent and preserve history.
  if tg_op='UPDATE' and pg_trigger_depth()>1 and
    (to_jsonb(new)-array['archived_at','archived_by','project_archive_marker','updated_at']) =
    (to_jsonb(old)-array['archived_at','archived_by','project_archive_marker','updated_at']) then return new; end if;
  perform exo_private.lock_team_ancestors(new.team_id);
  if exo_private.team_is_archived(new.team_id) then
    raise exception 'Restore the team before changing its tasks';
  end if;
  if tg_op='UPDATE' and old.team_id is distinct from new.team_id then
    perform exo_private.lock_team_ancestors(old.team_id);
    if exo_private.team_is_archived(old.team_id) then raise exception 'Restore the team before moving its tasks'; end if;
  end if;
  return new;
end $$;
revoke all on function exo_private.guard_archived_team_tasks() from public,anon,authenticated;
drop trigger if exists exo_guard_archived_team_tasks on public.tasks;
create trigger exo_guard_archived_team_tasks before insert or update on public.tasks
  for each row execute function exo_private.guard_archived_team_tasks();

create or replace function exo_private.guard_archived_team_parent()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and old.parent_team_id is not distinct from new.parent_team_id then return new; end if;
  perform exo_private.lock_team_ancestors(new.parent_team_id);
  if exo_private.team_is_archived(new.parent_team_id) then
    raise exception 'Restore the parent team before adding or moving subteams';
  end if;
  return new;
end $$;
revoke all on function exo_private.guard_archived_team_parent() from public,anon,authenticated;
drop trigger if exists exo_guard_archived_team_parent on public.teams;
create trigger exo_guard_archived_team_parent before insert or update of parent_team_id on public.teams
  for each row execute function exo_private.guard_archived_team_parent();

-- Archive replaces destructive team removal for authenticated clients.
drop policy if exists exo_team_no_delete on public.teams;
create policy exo_team_no_delete on public.teams as restrictive for delete to authenticated using(false);
notify pgrst,'reload schema';
commit;
