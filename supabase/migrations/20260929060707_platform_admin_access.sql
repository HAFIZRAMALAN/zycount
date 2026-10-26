-- ═══════════════════════════════════════════════════════════════════════════
-- Zycount platform administrators (public.platform_admins) have owner rights
-- in every set of books — business and personal — without being added as a
-- member, so they can set up and correct any client's books. They see all
-- books in the company switcher; opening a client's books is written to that
-- company's audit trail, and everything they change is audited as usual.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.has_perm(p_company uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m join public.roles r on r.name = m.role
    where m.company_id = p_company and m.user_id = auth.uid() and p_perm = any (r.permissions))
  or (public.is_platform_admin()
      and exists (select 1 from public.companies where id = p_company)
      and exists (select 1 from public.roles where name = 'SuperAdmin' and p_perm = any (permissions)));
$$;

create or replace function public.companies_with_perm(p_perm text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select m.company_id from public.company_members m join public.roles r on r.name = m.role
  where m.user_id = auth.uid() and p_perm = any (r.permissions)
  union
  select c.id from public.companies c
  where public.is_platform_admin() and exists (select 1 from public.roles where name = 'SuperAdmin' and p_perm = any (permissions));
$$;

create or replace function public.my_company_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select company_id from public.company_members where user_id = auth.uid()
  union
  select id from public.companies where public.is_platform_admin();
$$;

drop function public.my_companies();
create function public.my_companies()
returns table (company_id uuid, name text, role text, permissions text[], base_currency text, created_at timestamptz, kind text, admin_access boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, m.role, r.permissions, c.base_currency::text, c.created_at, c.kind, false
  from public.company_members m
  join public.companies c on c.id = m.company_id
  join public.roles r on r.name = m.role
  where m.user_id = auth.uid()
  union all
  select c.id, c.name, 'SuperAdmin', (select permissions from public.roles where name = 'SuperAdmin'), c.base_currency::text, c.created_at, c.kind, true
  from public.companies c
  where public.is_platform_admin()
    and not exists (select 1 from public.company_members m where m.company_id = c.id and m.user_id = auth.uid())
  order by 8, 6;
$$;

-- Sign-in events, plus a record in a client's books when an administrator opens them.
create or replace function public.log_event(p_company uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare v_member boolean;
begin
  if p_action not in ('auth.login', 'auth.logout', 'admin.open') then raise exception 'VALIDATION: Unknown event.'; end if;
  v_member := exists (select 1 from public.company_members where company_id = p_company and user_id = auth.uid());
  if p_action = 'admin.open' then
    if v_member or not public.is_platform_admin() or not exists (select 1 from public.companies where id = p_company) then return; end if;
    perform public._audit(p_company, 'admin.open', 'User', auth.uid()::text, 'A Zycount administrator opened these books');
    return;
  end if;
  if not v_member and not public.is_platform_admin() then
    raise exception 'PERMISSION_DENIED: Not a member of this company.';
  end if;
  perform public._audit(p_company, p_action, 'User', auth.uid()::text,
    case p_action when 'auth.login' then 'Signed in' else 'Signed out' end);
end $$;

revoke execute on function public.my_companies() from public, anon;
grant execute on function public.my_companies() to authenticated;
