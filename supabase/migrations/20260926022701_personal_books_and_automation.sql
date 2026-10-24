-- ═══════════════════════════════════════════════════════════════════════════
-- Personal and business books; transactions that post themselves; proof.
--
--  • companies.kind: 'BUSINESS' (Malaysian SME chart) or 'PERSONAL' (household
--    chart: cash & bank, savings, loans, income and spending categories).
--  • record_transaction(): money in / money out / transfer → a balanced,
--    posted journal. The person never has to choose debit or credit.
--  • post_opening_balances(): one form → one balanced opening journal; the
--    difference goes to equity automatically.
--  • books_proof(): checks, in the database, that the books are whole.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.companies add column kind text not null default 'BUSINESS'
  check (kind in ('BUSINESS', 'PERSONAL'));

-- ─── Personal chart of accounts ─────────────────────────────────────────────
create or replace function public.personal_coa_template()
returns table (code text, name text, type public.account_type, sub_type public.account_sub_type, parent text,
               postable boolean, system boolean, cash boolean, description text)
language sql immutable set search_path = public as $$
  select t.code, t.name, t.type::public.account_type, t.sub_type::public.account_sub_type, t.parent,
         t.postable, t.system, t.cash, t.description
  from (values
  ('1000','WHAT I OWN','ASSET',null,null,false,true,false,null),
  ('1100','Cash and bank','ASSET','CURRENT_ASSET','1000',false,true,false,null),
  ('1110','Cash in hand','ASSET','CURRENT_ASSET','1100',true,true,true,null),
  ('1120','Savings account','ASSET','CURRENT_ASSET','1100',true,false,true,null),
  ('1130','Current account','ASSET','CURRENT_ASSET','1100',true,false,true,null),
  ('1140','E-wallet','ASSET','CURRENT_ASSET','1100',true,false,true,'Touch ''n Go, GrabPay, Boost and similar.'),
  ('1200','Savings and investments','ASSET','NON_CURRENT_ASSET','1000',false,true,false,null),
  ('1210','Fixed deposits','ASSET','CURRENT_ASSET','1200',true,false,false,null),
  ('1220','ASB and unit trusts','ASSET','NON_CURRENT_ASSET','1200',true,false,false,null),
  ('1230','EPF (KWSP)','ASSET','NON_CURRENT_ASSET','1200',true,false,false,null),
  ('1240','Shares and other investments','ASSET','NON_CURRENT_ASSET','1200',true,false,false,null),
  ('1250','Tabung Haji','ASSET','NON_CURRENT_ASSET','1200',true,false,false,null),
  ('1300','Money owed to me','ASSET','CURRENT_ASSET','1000',false,true,false,null),
  ('1310','Loans to family and friends','ASSET','CURRENT_ASSET','1300',true,false,false,null),
  ('1320','Deposits paid','ASSET','CURRENT_ASSET','1300',true,false,false,'Rental and utility deposits.'),
  ('1500','Property and belongings','ASSET','NON_CURRENT_ASSET','1000',false,true,false,null),
  ('1510','Home','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1520','Vehicles','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1530','Other valuables','ASSET','NON_CURRENT_ASSET','1500',true,false,false,'Gold, jewellery, electronics.'),
  ('2000','WHAT I OWE','LIABILITY',null,null,false,true,false,null),
  ('2100','Short-term','LIABILITY','CURRENT_LIABILITY','2000',false,true,false,null),
  ('2110','Credit card','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2120','Buy now, pay later','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2130','Money I owe others','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2500','Long-term loans','LIABILITY','NON_CURRENT_LIABILITY','2000',false,true,false,null),
  ('2510','Home loan','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('2520','Car loan','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('2530','Personal loan','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('2540','PTPTN study loan','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('3000','NET WORTH','EQUITY','EQUITY',null,false,true,false,null),
  ('3100','Opening net worth','EQUITY','EQUITY','3000',true,true,false,'Balancing figure for opening balances.'),
  ('3200','Savings from past years','EQUITY','EQUITY','3000',true,true,false,null),
  ('4000','INCOME','REVENUE',null,null,false,true,false,null),
  ('4100','Earnings','REVENUE','OPERATING_REVENUE','4000',false,true,false,null),
  ('4110','Salary','REVENUE','OPERATING_REVENUE','4100',true,true,false,null),
  ('4120','Bonus and allowances','REVENUE','OPERATING_REVENUE','4100',true,false,false,null),
  ('4130','Side income and freelance','REVENUE','OPERATING_REVENUE','4100',true,false,false,null),
  ('4500','Other income','REVENUE','OTHER_INCOME','4000',false,true,false,null),
  ('4510','Interest and dividends','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4520','Rental income','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4530','Gifts received','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4590','Other income','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('6000','SPENDING','EXPENSE',null,null,false,true,false,null),
  ('6100','Home','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6110','Rent','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6120','Electricity and water','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6130','Internet and phone','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6140','Home repairs','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6200','Food','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6210','Groceries','EXPENSE','OPERATING_EXPENSE','6200',true,false,false,null),
  ('6220','Eating out','EXPENSE','OPERATING_EXPENSE','6200',true,false,false,null),
  ('6300','Transport','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6310','Fuel, tolls and parking','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6320','Public transport and e-hailing','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6330','Car servicing and road tax','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6400','Personal','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6410','Clothing','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6420','Health and medical','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6430','Education','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6440','Entertainment and subscriptions','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6450','Personal care','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6500','Family','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6510','Children','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6520','Support for parents and family','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6600','Financial','EXPENSE','OTHER_EXPENSE','6000',false,true,false,null),
  ('6610','Loan interest','EXPENSE','OTHER_EXPENSE','6600',true,false,false,null),
  ('6620','Bank and card fees','EXPENSE','OTHER_EXPENSE','6600',true,false,false,null),
  ('6630','Insurance and takaful','EXPENSE','OTHER_EXPENSE','6600',true,false,false,null),
  ('6640','Income tax','EXPENSE','OTHER_EXPENSE','6600',true,false,false,'PCB and LHDN payments.'),
  ('6650','Zakat','EXPENSE','OTHER_EXPENSE','6600',true,false,false,null),
  ('6700','Giving and other','EXPENSE','OTHER_EXPENSE','6000',false,true,false,null),
  ('6710','Donations and sedekah','EXPENSE','OTHER_EXPENSE','6700',true,false,false,null),
  ('6790','Other spending','EXPENSE','OTHER_EXPENSE','6700',true,false,false,null)
  ) as t(code, name, type, sub_type, parent, postable, system, cash, description)
$$;

-- ─── Bootstrap: business or personal ────────────────────────────────────────
drop function public.create_company(text, text, text, int);
drop function public.create_company_for_user(uuid, text);
drop function public._bootstrap_company(uuid, text, text, text, int);
drop function public.my_companies();

create function public._bootstrap_company(p_user uuid, p_name text, p_registration_no text,
                                          p_tax_no text, p_year int, p_kind text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_kind text := upper(coalesce(p_kind, 'BUSINESS'));
begin
  if v_kind not in ('BUSINESS', 'PERSONAL') then raise exception 'VALIDATION: Choose personal or business.'; end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'VALIDATION: Enter a name for these books.';
  end if;
  if (select count(*) from public.companies where created_by = p_user) >= 20 then
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

create function public.create_company(p_name text, p_registration_no text default null, p_tax_no text default null,
                                      p_year int default null, p_kind text default 'BUSINESS')
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Sign in to continue.'; end if;
  return public._bootstrap_company(auth.uid(), p_name, p_registration_no, p_tax_no, p_year, p_kind);
end $$;

create function public.create_company_for_user(p_user uuid, p_name text, p_kind text default 'BUSINESS')
returns uuid language plpgsql security definer set search_path = public as $$
begin
  return public._bootstrap_company(p_user, p_name, null, null, null, p_kind);
end $$;

create function public.my_companies()
returns table (company_id uuid, name text, role text, permissions text[], base_currency text, created_at timestamptz, kind text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, m.role, r.permissions, c.base_currency::text, c.created_at, c.kind
  from public.company_members m
  join public.companies c on c.id = m.company_id
  join public.roles r on r.name = m.role
  where m.user_id = auth.uid()
  order by c.created_at;
$$;

-- ─── Money in / money out / transfer ────────────────────────────────────────
-- IN:       Dr money account            Cr income (or other) account [+ Cr SST output]
-- OUT:      Dr spending (or other)       Cr money account
-- TRANSFER: Dr destination               Cr source
create or replace function public.record_transaction(p_company uuid, p_kind text, p_date date, p_amount numeric,
                                                     p_money_account uuid, p_other_account uuid,
                                                     p_description text default null, p_reference text default null,
                                                     p_tax_rate numeric default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_amount numeric; v_net numeric; v_tax numeric := 0; v_tax_acc uuid; v_lines jsonb; v_desc text; v_saved jsonb;
  v_kind text := upper(coalesce(p_kind, ''));
begin
  perform public._require_perm(p_company, 'journal.create');
  perform public._require_perm(p_company, 'journal.post');
  if v_kind not in ('IN', 'OUT', 'TRANSFER') then raise exception 'VALIDATION: Choose money in, money out or transfer.'; end if;
  if p_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then raise exception 'VALIDATION: Enter an amount greater than zero.'; end if;
  if v_amount > 9999999999999999.99 then raise exception 'VALIDATION: That amount is too large.'; end if;
  if p_money_account is null or p_other_account is null then raise exception 'VALIDATION: Choose both accounts.'; end if;
  if p_money_account = p_other_account then raise exception 'VALIDATION: Choose two different accounts.'; end if;
  if (select count(*) from public.accounts where company_id = p_company and id in (p_money_account, p_other_account)) <> 2 then
    raise exception 'VALIDATION: Account not found in these books.';
  end if;

  v_net := v_amount;
  if coalesce(p_tax_rate, 0) <> 0 then
    if v_kind <> 'IN' then raise exception 'VALIDATION: SST is split out only on money received.'; end if;
    if p_tax_rate not in (5, 6, 8, 10) then raise exception 'VALIDATION: Choose an SST rate of 5, 6, 8 or 10%%.'; end if;
    select id into v_tax_acc from public.accounts
     where company_id = p_company and code = '2150' and is_postable and is_active;
    if not found then raise exception 'VALIDATION: These books have no active SST Output Tax account (2150).'; end if;
    v_net := round(v_amount * 100 / (100 + p_tax_rate), 2);
    v_tax := v_amount - v_net;
  end if;

  v_desc := coalesce(nullif(btrim(p_description), ''),
                     case v_kind when 'IN' then 'Money in' when 'OUT' then 'Money out' else 'Transfer' end);
  if v_kind = 'IN' then
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_money_account, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', p_other_account, 'debit', 0, 'credit', v_net));
    if v_tax > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_tax_acc, 'debit', 0, 'credit', v_tax,
                                                                 'description', format('SST %s%%', p_tax_rate::int)));
    end if;
  else
    -- OUT pays from the money account; TRANSFER moves from it to the other.
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_other_account, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', p_money_account, 'debit', 0, 'credit', v_amount));
  end if;

  v_saved := public.save_journal(p_company, null, p_date, left(v_desc, 500), nullif(btrim(p_reference), ''), v_lines, null);
  update public.journal_entries set source = 'BANK' where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid) || jsonb_build_object('kind', v_kind, 'tax', v_tax);
end $$;

-- ─── Opening balances in one step ───────────────────────────────────────────
-- p_lines: [{account_id, amount}] where a positive amount is the account's usual
-- side (assets in debit; liabilities, equity and contra-assets in credit).
create or replace function public.post_opening_balances(p_company uuid, p_date date, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb; v_acc record; v_amt numeric; v_lines jsonb := '[]'::jsonb; v_dr numeric := 0; v_cr numeric := 0;
  v_plug record; v_saved jsonb; v_diff numeric; v_debit_side boolean; v_seen uuid[] := '{}';
begin
  perform public._require_perm(p_company, 'journal.create');
  perform public._require_perm(p_company, 'journal.post');
  if p_date is null then raise exception 'VALIDATION: Choose the date of the opening balances.'; end if;
  if exists (select 1 from public.journal_entries
              where company_id = p_company and source = 'OPENING_BALANCE' and status = 'POSTED') then
    raise exception 'DUPLICATE: Opening balances are already posted. Reverse that journal first to enter them again.';
  end if;
  select a.id, a.code, a.name into v_plug from public.accounts a join public.companies c on c.id = a.company_id
   where a.company_id = p_company and a.code = case c.kind when 'PERSONAL' then '3100' else '3200' end;
  if not found then raise exception 'VALIDATION: The equity account for the balancing figure is missing.'; end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    begin
      v_amt := round(coalesce(nullif(v_line->>'amount', '')::numeric, 0), 2);
    exception when others then
      raise exception 'VALIDATION: An amount is not a number.';
    end;
    if v_amt = 0 then continue; end if;
    select id, code, name, type, is_postable, is_active into v_acc from public.accounts
     where id = (v_line->>'account_id')::uuid and company_id = p_company;
    if not found then raise exception 'VALIDATION: Account not found in these books.'; end if;
    if v_acc.id = any (v_seen) then raise exception 'VALIDATION: % % appears twice.', v_acc.code, v_acc.name; end if;
    v_seen := v_seen || v_acc.id;
    if v_acc.type not in ('ASSET', 'LIABILITY', 'EQUITY') then
      raise exception 'VALIDATION: Opening balances are for what you own, owe and equity — % % is %.', v_acc.code, v_acc.name, lower(v_acc.type::text);
    end if;
    if v_acc.id = v_plug.id then
      raise exception 'VALIDATION: % % takes the balancing figure automatically.', v_acc.code, v_acc.name;
    end if;
    v_debit_side := v_acc.type = 'ASSET' and v_acc.name !~* '^(accumulated|allowance)';
    if v_debit_side = (v_amt > 0) then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'debit', abs(v_amt), 'credit', 0));
      v_dr := v_dr + abs(v_amt);
    else
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'debit', 0, 'credit', abs(v_amt)));
      v_cr := v_cr + abs(v_amt);
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'VALIDATION: Enter at least one balance.'; end if;

  v_diff := v_dr - v_cr;
  if v_diff > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_plug.id, 'debit', 0, 'credit', v_diff,
                                                               'description', 'Balancing figure'));
  elsif v_diff < 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_plug.id, 'debit', -v_diff, 'credit', 0,
                                                               'description', 'Balancing figure'));
  end if;

  v_saved := public.save_journal(p_company, null, p_date, 'Opening balances', null, v_lines, null);
  update public.journal_entries set source = 'OPENING_BALANCE' where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid) || jsonb_build_object('balancing', v_diff);
end $$;

-- ─── Proof that the books are whole ─────────────────────────────────────────
create or replace function public.books_proof(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_entries int; v_unbalanced int; v_dr numeric; v_cr numeric; v_gaps int; v_headings int;
  v_assets numeric; v_liab numeric; v_equity numeric; v_result numeric; v_audit int; v_last timestamptz; v_closed int;
begin
  if not (public.has_perm(p_company, 'report.view') or public.has_perm(p_company, 'ledger.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view reports in these books.';
  end if;

  with e as (
    select id, total_debit, total_credit from public.journal_entries
    where company_id = p_company and status in ('POSTED', 'REVERSED')),
  l as (
    select jl.journal_entry_id, sum(jl.debit) as d, sum(jl.credit) as c
    from public.journal_lines jl join e on e.id = jl.journal_entry_id group by jl.journal_entry_id)
  select count(e.id),
         count(e.id) filter (where l.d is null or l.d <> l.c or l.d <> e.total_debit or l.c <> e.total_credit),
         coalesce(sum(l.d), 0), coalesce(sum(l.c), 0)
    into v_entries, v_unbalanced, v_dr, v_cr
  from e left join l on l.journal_entry_id = e.id;

  select coalesce(sum(case when a.type = 'ASSET' then jl.debit - jl.credit end), 0),
         coalesce(sum(case when a.type = 'LIABILITY' then jl.credit - jl.debit end), 0),
         coalesce(sum(case when a.type = 'EQUITY' then jl.credit - jl.debit end), 0),
         coalesce(sum(case when a.type in ('REVENUE', 'EXPENSE', 'COST_OF_SALES') then jl.credit - jl.debit end), 0),
         count(*) filter (where not a.is_postable)
    into v_assets, v_liab, v_equity, v_result, v_headings
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id
  join public.accounts a on a.id = jl.account_id
  where je.company_id = p_company and je.status in ('POSTED', 'REVERSED');

  -- Gap-free numbering: in each year the highest JV number equals the count.
  select coalesce(sum(mx - n), 0)::int into v_gaps from (
    select split_part(reference, '-', 2) as yr, count(*) as n, max(split_part(reference, '-', 3)::int) as mx
    from public.journal_entries
    where company_id = p_company and reference like 'JV-%' and status in ('POSTED', 'REVERSED')
    group by 1) s;

  select count(*), max(created_at) into v_audit, v_last from public.audit_log where company_id = p_company;
  select count(*) into v_closed from public.fiscal_periods where company_id = p_company and status = 'CLOSED';

  return jsonb_build_object(
    'checked_at', now(), 'entries', v_entries, 'unbalanced', v_unbalanced,
    'total_debit', v_dr, 'total_credit', v_cr,
    'assets', v_assets, 'liabilities', v_liab, 'equity', v_equity, 'result', v_result,
    'numbering_gaps', v_gaps, 'lines_on_headings', v_headings,
    'audit_events', v_audit, 'last_audit_at', v_last, 'closed_periods', v_closed);
end $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function public._bootstrap_company(uuid, text, text, text, int, text) from public, anon, authenticated;
revoke execute on function public.create_company_for_user(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.personal_coa_template() from public, anon;
grant execute on function
  public.create_company(text, text, text, int, text), public.my_companies(),
  public.record_transaction(uuid, text, date, numeric, uuid, uuid, text, text, numeric),
  public.post_opening_balances(uuid, date, jsonb), public.books_proof(uuid), public.personal_coa_template()
to authenticated;
grant execute on function public.create_company_for_user(uuid, text, text) to service_role;
