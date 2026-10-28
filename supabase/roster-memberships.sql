-- Install in Supabase SQL Editor as postgres, then run the PRIVATE roster seed.
-- Contains no member emails. Group pre-approvals are not exposed to the browser.
-- Requires schema.sql and Google authentication. Does not grant leadership roles.
begin;

create table if not exists exo_private.roster_memberships (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  team_id uuid not null references public.teams(id) on delete restrict,
  source text not null default 'Approved roster',
  source_row integer,
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (email, team_id)
);
alter table exo_private.roster_memberships enable row level security;
revoke all on exo_private.roster_memberships from public, anon, authenticated;
grant all on exo_private.roster_memberships to service_role;

create or replace function exo_private.apply_roster_memberships(p_user uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare account auth.users; approved record; applied integer := 0;
begin
  select * into account from auth.users where id = p_user;
  -- Match the authenticated account's primary email, never a display name or
  -- client-editable user metadata. Require a verified Google identity as well.
  if account.id is null or account.email_confirmed_at is null then return 0; end if;
  if not exists (
    select 1 from auth.identities i where i.user_id = p_user and i.provider = 'google'
      and lower(btrim(i.identity_data->>'email')) = lower(btrim(account.email))
      and i.identity_data->>'email_verified' = 'true'
  ) then return 0; end if;

  for approved in select id, team_id from exo_private.roster_memberships
    where email = lower(btrim(account.email)) and claimed_at is null and disabled_at is null
    for update loop
    -- Either auth trigger may fire first. Ensure the profile exists without
    -- overwriting an existing display name or avatar.
    insert into public.profiles(id, display_name, avatar_url)
      values (p_user, coalesce(account.raw_user_meta_data->>'full_name', account.raw_user_meta_data->>'name', ''),
        account.raw_user_meta_data->>'avatar_url') on conflict (id) do nothing;
    insert into public.team_members(team_id, user_id)
      values (approved.team_id, p_user) on conflict do nothing;
    update exo_private.roster_memberships set claimed_by = p_user, claimed_at = clock_timestamp()
      where id = approved.id;
    applied := applied + 1;
  end loop;
  return applied;
end;
$$;

create or replace function exo_private.enroll_roster_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'identities' then perform exo_private.apply_roster_memberships(new.user_id);
  else perform exo_private.apply_roster_memberships(new.id); end if;
  return new;
end;
$$;
alter function exo_private.apply_roster_memberships(uuid) owner to postgres;
alter function exo_private.enroll_roster_user() owner to postgres;
revoke all on function exo_private.apply_roster_memberships(uuid), exo_private.enroll_roster_user()
  from public, anon, authenticated;
grant execute on function exo_private.apply_roster_memberships(uuid) to service_role;

-- OAuth creates the account and identity in separate steps. Handle either order,
-- including email confirmation occurring after the identity has been inserted.
drop trigger if exists exo_enroll_roster_user on auth.users;
create trigger exo_enroll_roster_user after insert or update of email, email_confirmed_at on auth.users
  for each row execute function exo_private.enroll_roster_user();
drop trigger if exists exo_enroll_roster_identity on auth.identities;
create trigger exo_enroll_roster_identity after insert or update of identity_data on auth.identities
  for each row execute function exo_private.enroll_roster_user();
commit;

-- An approval is consumed once. Removing a saved membership in Workbench does
-- not reset claimed_at, so a later login cannot silently restore revoked access.
-- To cancel an UNUSED approval, set disabled_at=now() in SQL Editor.
-- To approve a returning member again, explicitly add their membership through
-- Administration; do not reset an old approval without reviewing it.
