-- Apply after shared-tasks.sql. Sending stays disabled until the worker is configured.
begin;

create table if not exists exo_private.task_email_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into exo_private.task_email_settings default values on conflict do nothing;

create table if not exists exo_private.task_emails (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  recipient_id uuid not null,
  email text not null,
  state text not null default 'pending' check (state in ('pending','sent','failed','skipped')),
  next_attempt timestamptz not null default now(),
  first_attempt timestamptz,
  lease uuid,
  sent_at timestamptz,
  provider_id text,
  failure text,
  unique (task_id,recipient_id),
  unique (task_id,email)
);
alter table exo_private.task_emails
  add column if not exists task_title text,
  add column if not exists task_due_at timestamptz;
create index if not exists exo_task_email_due on exo_private.task_emails(next_attempt) where state='pending';
create index if not exists exo_task_email_sent on exo_private.task_emails(sent_at) where state='sent';

create table if not exists exo_private.task_email_slots (
  day date not null,
  delivery_id uuid not null references exo_private.task_emails(id),
  primary key(day,delivery_id)
);
revoke all on exo_private.task_email_settings,exo_private.task_emails,exo_private.task_email_slots
  from public,anon,authenticated;

create or replace function exo_private.task_email_recipients(p_task public.tasks)
returns table(user_id uuid,email text) language plpgsql stable security definer set search_path='' as $$
declare roster_ids uuid[] := '{}';
begin
  if p_task.archived_at is not null or p_task.status='cancelled' or not exists (
    select 1 from public.projects p where p.id=p_task.project_id and p.status<>'archived'
  ) then return; end if;
  if to_regclass('exo_private.roster_memberships') is not null and to_jsonb(p_task)->>'assignee_person_id' is not null then
    execute 'select coalesce(array_agg(distinct claimed_by),array[]::uuid[])
      from exo_private.roster_memberships where person_id=$1 and claimed_by is not null and disabled_at is null'
      into roster_ids using (to_jsonb(p_task)->>'assignee_person_id')::uuid;
  end if;
  return query
  with recursive assigned_tree(id) as (
    select g.id from unnest(p_task.team_ids) g(id) where not exo_private.team_is_archived(g.id)
    union
    select t.id from public.teams t join assigned_tree a on t.parent_team_id=a.id where t.archived_at is null
  ), recipients(id) as (
    select m.user_id from public.team_members m join assigned_tree a on a.id=m.team_id
    union select p_task.assignee_id
    union select unnest(roster_ids)
  )
  select distinct on (lower(btrim(u.email))) u.id, lower(btrim(u.email))
  from recipients r join auth.users u on u.id=r.id
  where nullif(btrim(u.email),'') is not null and u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until<=now())
    and exists (
      select 1 from unnest(p_task.team_ids) g(id)
      where not exo_private.team_is_archived(g.id)
        and exo_private.user_can_access_group(u.id,g.id,p_task.project_id)
    )
  order by lower(btrim(u.email)),u.id;
end $$;
revoke all on function exo_private.task_email_recipients(public.tasks) from public,anon,authenticated;

create or replace function exo_private.queue_task_email()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if current_setting('exo.task_email',true)='on' and
    (select enabled from exo_private.task_email_settings where singleton) then
    insert into exo_private.task_emails(task_id,recipient_id,email)
      select new.id,r.user_id,r.email from exo_private.task_email_recipients(new) r
      on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function exo_private.queue_task_email() from public,anon,authenticated;
drop trigger if exists exo_queue_task_email on public.tasks;
create trigger exo_queue_task_email after insert on public.tasks
  for each row execute function exo_private.queue_task_email();

-- Run the insert under the caller's existing task policies. Imports still use
-- the normal table endpoint, and retries with the same IDs do not fire the trigger.
create or replace function public.create_notified_tasks(p_tasks jsonb)
returns setof public.tasks language plpgsql security invoker set search_path='' as $$
declare roster_column text := ''; roster_value text := '';
begin
  if auth.uid() is null or jsonb_typeof(p_tasks) is distinct from 'array' then
    raise exception 'Expected a signed-in task creator and an array of tasks';
  end if;
  if jsonb_array_length(p_tasks) not between 1 and 100
    or exists (select 1 from jsonb_array_elements(p_tasks) r where r->>'id' is null) then
    raise exception 'Expected 1 to 100 tasks with IDs';
  end if;
  if exists (
    select 1 from pg_attribute where attrelid='public.tasks'::regclass
      and attname='assignee_person_id' and not attisdropped
  ) then
    roster_column := ',assignee_person_id';
    roster_value := ',t.assignee_person_id';
  end if;
  perform set_config('exo.task_email','on',true);
  execute 'insert into public.tasks(id,title,description,status,priority,due_at,project_id,team_id,team_ids,assignee_id,created_by'||roster_column||')
    select t.id,t.title,t.description,t.status,t.priority,t.due_at,t.project_id,t.team_id,t.team_ids,t.assignee_id,auth.uid()'||roster_value||'
    from jsonb_populate_recordset(null::public.tasks,$1) t on conflict(id) do nothing'
    using p_tasks;
  perform set_config('exo.task_email','off',true);
  return query select t.* from public.tasks t join jsonb_array_elements(p_tasks) r on t.id=(r->>'id')::uuid
    where t.created_by=auth.uid();
end $$;
revoke all on function public.create_notified_tasks(jsonb) from public,anon;
grant execute on function public.create_notified_tasks(jsonb) to authenticated;

create or replace function public.task_email_usage()
returns jsonb language sql stable security definer set search_path='' as $$
  select case when not exo_private.is_member() then null else jsonb_build_object(
    'enabled',(select enabled from exo_private.task_email_settings where singleton),
    'sent_today',(select count(*) from exo_private.task_emails
      where sent_at >= date_trunc('day',now(),'UTC') and state='sent'),
    'pending',(select count(*) from exo_private.task_emails where state='pending'),
    'daily_limit',100
  ) end;
$$;
revoke all on function public.task_email_usage() from public,anon;
grant execute on function public.task_email_usage() to authenticated;

drop function if exists public.claim_task_email();
create function public.claim_task_email()
returns table(id uuid,task_id uuid,email text,lease uuid,task_title text,task_due_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare candidate exo_private.task_emails;
  utc_day date := (clock_timestamp() at time zone 'UTC')::date;
  month_start date := date_trunc('month',utc_day::timestamp)::date;
  has_room boolean;
begin
  if not (select enabled from exo_private.task_email_settings where singleton) then return; end if;
  perform pg_advisory_xact_lock(hashtext('exo-task-email-quota'));
  update exo_private.task_emails q set state='failed', failure='Retry window expired', lease=null
    where q.state='pending' and q.next_attempt<=now() and q.first_attempt<=now()-interval '23 hours';
  has_room := (select count(*) from exo_private.task_email_slots s where s.day=utc_day)<100
    and (select count(*) from exo_private.task_email_slots s where s.day>=month_start)<3000;
  loop
    select q.* into candidate from exo_private.task_emails q
      where q.state='pending' and q.next_attempt<=now() and (has_room or exists (
        select 1 from exo_private.task_email_slots s where s.day=utc_day and s.delivery_id=q.id
      ))
      order by q.next_attempt,q.id limit 1 for update;
    if not found then return; end if;
    if exists(select 1 from public.tasks t cross join lateral exo_private.task_email_recipients(t) r
      where t.id=candidate.task_id and r.user_id=candidate.recipient_id and r.email=candidate.email) then exit; end if;
    update exo_private.task_emails q set state='skipped',lease=null where q.id=candidate.id;
  end loop;
  insert into exo_private.task_email_slots(day,delivery_id) values(utc_day,candidate.id) on conflict do nothing;
  -- Keep the email body stable across attempts with the same delivery ID.
  return query update exo_private.task_emails q
    set first_attempt=coalesce(q.first_attempt,now()), next_attempt=now()+interval '2 minutes', lease=gen_random_uuid(),
      task_title=case when q.first_attempt is null and q.task_title is null then t.title else q.task_title end,
      task_due_at=case when q.first_attempt is null and q.task_title is null then t.due_at else q.task_due_at end
    from public.tasks t where q.id=candidate.id and t.id=q.task_id
    returning q.id,q.task_id,q.email,q.lease,q.task_title,q.task_due_at;
end $$;

create or replace function public.finish_task_email(p_id uuid,p_lease uuid,p_result text,p_detail text)
returns void language plpgsql security definer set search_path='' as $$
declare rejected_first_attempt boolean;
begin
  if p_result not in ('sent','retry','failed','rate_limit','daily_quota','monthly_quota') then
    raise exception 'Unknown delivery result';
  end if;
  select q.first_attempt=q.next_attempt-interval '2 minutes' and p_result in ('rate_limit','daily_quota','monthly_quota')
    into rejected_first_attempt from exo_private.task_emails q
    where q.id=p_id and q.lease=p_lease and q.state='pending' for update;
  if not found then return; end if;
  if rejected_first_attempt then
    delete from exo_private.task_email_slots s where s.delivery_id=p_id;
  end if;
  update exo_private.task_emails q set
    state=case when p_result in ('sent','failed') then p_result else 'pending' end,
    sent_at=case when p_result='sent' then now() end,
    provider_id=case when p_result='sent' then p_detail end,
    failure=case when p_result<>'sent' then left(p_detail,120) end,
    first_attempt=case when rejected_first_attempt then null else q.first_attempt end,
    next_attempt=case p_result
      when 'daily_quota' then (date_trunc('day',now() at time zone 'UTC')+interval '1 day') at time zone 'UTC'
      when 'monthly_quota' then (date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC'
      else now()+interval '5 minutes'
    end,
    lease=null
    where q.id=p_id and q.lease=p_lease and q.state='pending';
end $$;
revoke all on function public.claim_task_email(),public.finish_task_email(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_task_email(),public.finish_task_email(uuid,uuid,text,text) to service_role;

notify pgrst,'reload schema';
commit;
