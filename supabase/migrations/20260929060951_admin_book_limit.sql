-- Platform administrators set up books for their clients, so the 20-books cap
-- that protects ordinary accounts doesn't apply to them.
create or replace function public._bootstrap_company(p_user uuid, p_name text, p_registration_no text,
                                          p_tax_no text, p_year int, p_kind text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_kind text := upper(coalesce(p_kind, 'BUSINESS'));
begin
  if v_kind not in ('BUSINESS', 'PERSONAL') then raise exception 'VALIDATION: Choose personal or business.'; end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'VALIDATION: Enter a name for these books.';
  end if;
  if (select count(*) from public.companies where created_by = p_user) >= 20
     and not exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'LIMIT_REACHED: You can create up to 20 sets of books.';
  end if;

  insert into public.companies (name, registration_no, tax_registration_no, created_by, kind)
  values (btrim(p_name), nullif(btrim(p_registration_no), ''), nullif(btrim(p_tax_no), ''), p_user, v_kind)
  returning id into v_company;

  insert into public.company_members (company_id, user_id, role) values (v_company, p_user, 'SuperAdmin');

  if v_kind = 'PERSONAL' then
    insert into public.accounts (company_id, code, name, type, sub_type, description, is_postable, is_system, is_cash)
    select v_company, t.code, t.name, t.type, t.sub_type, t.description, t.postable, t.system, t.cash
    from public.personal_coa_template() t;
    update public.accounts a set parent_id = p.id
    from public.personal_coa_template() t
    join public.accounts p on p.company_id = v_company and p.code = t.parent
    where a.company_id = v_company and a.code = t.code and t.parent is not null;
  else
    insert into public.accounts (company_id, code, name, type, sub_type, description, is_postable, is_system, is_cash)
    select v_company, t.code, t.name, t.type, t.sub_type, t.description, t.postable, t.system, t.cash
    from public.coa_template() t;
    update public.accounts a set parent_id = p.id
    from public.coa_template() t
    join public.accounts p on p.company_id = v_company and p.code = t.parent
    where a.company_id = v_company and a.code = t.code and t.parent is not null;
  end if;

  perform public._generate_periods(v_company, coalesce(p_year, extract(year from current_date)::int));

  insert into public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, summary)
  values (v_company, p_user, (select email from public.profiles where id = p_user), 'company.create', 'Company',
          v_company::text, format('Created %s (%s) with %s accounts and 12 fiscal periods', btrim(p_name), lower(v_kind),
          (select count(*) from public.accounts where company_id = v_company)));
  return v_company;
end $$;
