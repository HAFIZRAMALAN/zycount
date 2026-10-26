-- Phase 1 audit hardening (audit/2026-10-phase1-audit.md).
--
-- 1. Table privileges. Every write goes through a SECURITY DEFINER function that
--    checks the caller's role; row-level security only grants SELECT. But anon
--    and authenticated still held Supabase's default INSERT/UPDATE/DELETE/
--    TRUNCATE/TRIGGER/REFERENCES on every table, and TRUNCATE is not subject to
--    row-level security. PostgREST does not expose TRUNCATE today; this removes
--    the privilege anyway so a future exposure path cannot empty the books.
--    profiles keeps its column grant: people may rename themselves.
-- 2. Sign-up throttle. The signup function's limit lived in one function
--    instance's memory; it now lives in the database, per address and overall.

do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;
grant update (full_name) on public.profiles to authenticated;

-- Tables created later start without write privileges for API roles.
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, trigger, references on tables from anon, authenticated;

-- ─── Sign-up throttle ───────────────────────────────────────────────────────
create table public.signup_attempts (
  id      bigint generated always as identity primary key,
  ip_hash text not null check (length(ip_hash) = 64),
  at      timestamptz not null default now()
);
create index signup_attempts_ip_idx on public.signup_attempts(ip_hash, at desc);
create index signup_attempts_at_idx on public.signup_attempts(at desc);
alter table public.signup_attempts enable row level security;
revoke all on public.signup_attempts from anon, authenticated;

-- True when this address may sign up now (5 an hour per address, 60 an hour in
-- all), and records the attempt. Old rows are pruned as it goes.
create or replace function public._signup_allowed(p_ip_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_mine int; v_all int;
begin
  if p_ip_hash is null or length(p_ip_hash) <> 64 then return false; end if;
  delete from public.signup_attempts where at < now() - interval '1 day';
  select count(*) filter (where ip_hash = p_ip_hash), count(*) into v_mine, v_all
    from public.signup_attempts where at > now() - interval '1 hour';
  if v_mine >= 5 or v_all >= 60 then return false; end if;
  insert into public.signup_attempts (ip_hash) values (p_ip_hash);
  return true;
end $$;
revoke execute on function public._signup_allowed(text) from public, anon, authenticated;
grant execute on function public._signup_allowed(text) to service_role;
