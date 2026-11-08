-- Phase 3.4 — Fixed assets and depreciation (docs/spec/04 §10).
--
--   Register      from a posted purchase invoice line (already in the books — no journal), or an asset you
--                 already owned (opening, optionally with depreciation already charged), or a purchase
--                 recorded here:  Dr asset cost / Cr the account it was paid from.
--   Depreciation  monthly, from the month the asset was bought:  Dr Depreciation 65x0 / Cr Accumulated 15x5
--                 straight-line (cost − residual) ÷ life, the last month taking what is left; or reducing
--                 balance at an annual rate on the net book value. Never below the residual value.
--                 One journal per run; a run can be voided if it is the latest.
--   Disposal      depreciation up to the disposal month, then Dr Accumulated, Dr Bank (proceeds),
--                 Cr Cost, and the difference to Gain 4530 or Loss 6720.
-- The register's cost and accumulated depreciation are checked against the ledger account by account.

create table public.fixed_assets (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  code                  text not null,
  name                  text not null check (length(btrim(name)) between 1 and 200),
  cost_account_id       uuid not null references public.accounts(id),
  accum_account_id      uuid not null references public.accounts(id),
  expense_account_id    uuid not null references public.accounts(id),
  acquired_on           date not null,
  cost                  numeric(18,2) not null check (cost > 0),
  residual              numeric(18,2) not null default 0 check (residual >= 0),
  method                text not null default 'SL' check (method in ('SL', 'RB')),
  life_months           int check (life_months between 1 and 1200),
  rb_rate               numeric(5,2) check (rb_rate > 0 and rb_rate <= 100),
  opening_accumulated   numeric(18,2) not null default 0 check (opening_accumulated >= 0),
  accumulated           numeric(18,2) not null default 0,
  depreciate_from       date not null,          -- first day of the first month to depreciate
  depreciated_to        date,                   -- last day of the last month depreciated
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISPOSED')),
  source_line_id        uuid unique references public.trade_doc_lines(id),
  acquisition_journal_id uuid references public.journal_entries(id),
  disposed_on           date,
  disposal_proceeds     numeric(18,2),
  disposal_journal_id   uuid references public.journal_entries(id),
  notes                 text check (length(notes) <= 1000),
  created_by            uuid,
  created_at            timestamptz not null default now(),
  unique (company_id, code),
  check (residual < cost),
  check (accumulated between 0 and cost - residual),
  check ((method = 'SL' and life_months is not null) or (method = 'RB' and rb_rate is not null))
);
create index fixed_assets_company_idx on public.fixed_assets(company_id, status);
create index fixed_assets_cost_idx on public.fixed_assets(cost_account_id);
create index fixed_assets_accum_idx on public.fixed_assets(accum_account_id);
create index fixed_assets_expense_idx on public.fixed_assets(expense_account_id);
create index fixed_assets_acq_journal_idx on public.fixed_assets(acquisition_journal_id);
create index fixed_assets_disp_journal_idx on public.fixed_assets(disposal_journal_id);

create table public.depreciation_runs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  period_end       date not null,
  total            numeric(18,2) not null,
  journal_entry_id uuid references public.journal_entries(id),
  status           text not null default 'POSTED' check (status in ('POSTED', 'VOID')),
  void_entry_id    uuid references public.journal_entries(id),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  seq              bigint generated always as identity
);
create index depreciation_runs_company_idx on public.depreciation_runs(company_id, seq desc);
create index depreciation_runs_journal_idx on public.depreciation_runs(journal_entry_id);
create index depreciation_runs_void_idx on public.depreciation_runs(void_entry_id);

create table public.depreciation_lines (
  id        uuid primary key default gen_random_uuid(),
  run_id    uuid references public.depreciation_runs(id) on delete cascade,
  asset_id  uuid not null references public.fixed_assets(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  month     date not null,                    -- first day of the month depreciated
  amount    numeric(18,2) not null check (amount > 0),
  kind      text not null default 'RUN' check (kind in ('RUN', 'DISPOSAL'))
);
create index depreciation_lines_asset_idx on public.depreciation_lines(asset_id, month);
create index depreciation_lines_run_idx on public.depreciation_lines(run_id);
create index depreciation_lines_company_idx on public.depreciation_lines(company_id);

alter table public.fixed_assets enable row level security;
alter table public.depreciation_runs enable row level security;
alter table public.depreciation_lines enable row level security;
create policy "fixed assets by permission" on public.fixed_assets for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "depreciation runs by permission" on public.depreciation_runs for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "depreciation lines by permission" on public.depreciation_lines for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
revoke all on public.fixed_assets, public.depreciation_runs, public.depreciation_lines from anon;
grant select on public.fixed_assets, public.depreciation_runs, public.depreciation_lines to authenticated;

alter table public.journal_entries drop constraint journal_entries_doc_type_check;
alter table public.journal_entries add constraint journal_entries_doc_type_check
  check (doc_type in ('PV', 'OR', 'IV', 'CS', 'DN', 'CN', 'PI', 'CP', 'SDN', 'SCN', 'CT', 'SA', 'GRN', 'FA', 'DEP'));

-- ─── Helpers ────────────────────────────────────────────────────────────────
/** Default accumulated-depreciation and expense accounts for a cost account (15x0 → 15x5, 65x0). */
create or replace function public._asset_defaults(p_company uuid, p_cost uuid)
returns table (accum_id uuid, expense_id uuid) language sql stable security definer set search_path = public as $$
  select (select a2.id from public.accounts a2 where a2.company_id = p_company and a2.is_postable and a2.is_active
           and a2.code = left(a.code, 3) || '5'),
         (select a3.id from public.accounts a3 where a3.company_id = p_company and a3.is_postable and a3.is_active
           and a3.code = case when a.code = '1580' then '6590' else '65' || substr(a.code, 3, 1) || '0' end)
    from public.accounts a where a.id = p_cost and a.company_id = p_company;
$$;

/** The depreciation for one month, given what has been charged before it. Straight-line takes the rounded
    monthly amount, and the last month takes what is left (so 100 over 3 months is 33.33, 33.33, 33.34). */
create or replace function public._asset_month(p_a public.fixed_assets, p_acc numeric)
returns numeric language sql immutable set search_path = public as $$
  select greatest(0, case p_a.method
    when 'SL' then case
      when p_a.cost - p_a.residual - p_acc - round((p_a.cost - p_a.residual) / p_a.life_months, 2) < 0.01 * p_a.life_months
        then p_a.cost - p_a.residual - p_acc
      else round((p_a.cost - p_a.residual) / p_a.life_months, 2) end
    else least(p_a.cost - p_a.residual - p_acc, round((p_a.cost - p_acc) * p_a.rb_rate / 1200, 2)) end);
$$;

/** Months due up to p_until (inclusive) for every active asset, with their amounts. */
create or replace function public._depreciation_due(p_company uuid, p_until date, p_asset uuid default null)
returns table (asset_id uuid, month date, amount numeric) language plpgsql stable security definer set search_path = public as $$
declare a public.fixed_assets; m date; acc numeric; amt numeric;
begin
  for a in select * from public.fixed_assets f
            where f.company_id = p_company and f.status = 'ACTIVE' and (p_asset is null or f.id = p_asset)
              and f.depreciate_from <= p_until order by f.code
  loop
    acc := a.accumulated;
    m := coalesce((a.depreciated_to + 1), a.depreciate_from);
    while m <= date_trunc('month', p_until)::date loop
      amt := public._asset_month(a, acc);
      exit when amt <= 0;
      asset_id := a.id; month := m; amount := amt;
      return next;
      acc := acc + amt;
      m := (m + interval '1 month')::date;
    end loop;
  end loop;
end $$;

create or replace function public._asset_check_accounts(p_company uuid, p_cost uuid, p_accum uuid, p_exp uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  perform public._check_line_account(p_company, p_cost, 'Asset account');
  perform public._check_line_account(p_company, p_accum, 'Accumulated depreciation account');
  perform public._check_line_account(p_company, p_exp, 'Depreciation expense account');
  if (select type from public.accounts where id = p_cost) <> 'ASSET' or (select type from public.accounts where id = p_accum) <> 'ASSET' then
    raise exception 'VALIDATION: The asset and accumulated depreciation accounts must be asset accounts.';
  end if;
  if (select type from public.accounts where id = p_exp) <> 'EXPENSE' then
    raise exception 'VALIDATION: The depreciation account must be an expense account.';
  end if;
  if p_cost = p_accum then raise exception 'VALIDATION: Use separate accounts for cost and accumulated depreciation.'; end if;
end $$;

-- ─── Register ───────────────────────────────────────────────────────────────
/**
 * p_data: {name, cost_account_id, accum_account_id?, expense_account_id?, acquired_on, cost, residual, method SL|RB,
 *          life_months | rb_rate, opening_accumulated, source_line_id?, post_acquisition?, paid_from_account_id?, notes}
 */
create or replace function public.register_asset(p_company uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_cost_acc uuid := public._try_uuid(p_data->>'cost_account_id'); v_accum uuid := public._try_uuid(p_data->>'accum_account_id');
  v_exp uuid := public._try_uuid(p_data->>'expense_account_id'); v_src uuid := public._try_uuid(p_data->>'source_line_id');
  v_def record; v_line record; v_on date; v_cost numeric; v_res numeric; v_life int; v_rate numeric; v_open numeric;
  v_method text := upper(coalesce(nullif(p_data->>'method', ''), 'SL')); v_id uuid; v_code text; v_je uuid; v_saved jsonb; v_paid uuid;
  v_name text := btrim(coalesce(p_data->>'name', ''));
begin
  perform public._require_perm(p_company, 'journal.post');
  if length(v_name) not between 1 and 200 then raise exception 'VALIDATION: Name the asset.'; end if;
  begin
    v_on := (p_data->>'acquired_on')::date;
    v_cost := round((p_data->>'cost')::numeric, 2);
    v_res := round(coalesce(nullif(p_data->>'residual', '')::numeric, 0), 2);
    v_life := nullif(p_data->>'life_months', '')::int;
    v_rate := nullif(p_data->>'rb_rate', '')::numeric;
    v_open := round(coalesce(nullif(p_data->>'opening_accumulated', '')::numeric, 0), 2);
  exception when others then raise exception 'VALIDATION: Check the date, cost, life and rate — they must be valid numbers and dates.';
  end;
  if v_src is not null then
    select l.id, l.amount, l.tax_amount, l.account_id, l.description, d.date, d.status, d.doc_type, d.company_id, t.purchase_account_id as tpa, l.tax_code_id
      into v_line from public.trade_doc_lines l join public.trade_docs d on d.id = l.doc_id left join public.tax_codes t on t.id = l.tax_code_id
     where l.id = v_src;
    if not found or v_line.company_id <> p_company then raise exception 'VALIDATION: Purchase line not found in these books.'; end if;
    if v_line.status <> 'POSTED' or v_line.doc_type not in ('BILL', 'CASH_PURCHASE') then
      raise exception 'VALIDATION: Register assets from a posted purchase invoice or cash purchase.';
    end if;
    if exists (select 1 from public.fixed_assets where source_line_id = v_src) then raise exception 'DUPLICATE: That purchase line is already registered as an asset.'; end if;
    v_cost_acc := v_line.account_id;
    -- The cost is what the invoice put on the asset account, so the register always agrees with the ledger.
    v_cost := v_line.amount + case when v_line.tax_code_id is not null and v_line.tpa is null then v_line.tax_amount else 0 end;
    v_on := coalesce(v_on, v_line.date);
    if v_name = '' then v_name := left(v_line.description, 200); end if;
  end if;
  if v_cost_acc is null then raise exception 'VALIDATION: Choose the asset account (for example 1540 Office Equipment).'; end if;
  select * into v_def from public._asset_defaults(p_company, v_cost_acc);
  v_accum := coalesce(v_accum, v_def.accum_id); v_exp := coalesce(v_exp, v_def.expense_id);
  if v_accum is null or v_exp is null then raise exception 'VALIDATION: Choose the accumulated depreciation and depreciation expense accounts for this asset.'; end if;
  perform public._asset_check_accounts(p_company, v_cost_acc, v_accum, v_exp);
  if v_on is null then raise exception 'VALIDATION: Enter the date the asset was bought.'; end if;
  if v_cost is null or v_cost <= 0 then raise exception 'VALIDATION: The cost must be more than zero.'; end if;
  if v_res < 0 or v_res >= v_cost then raise exception 'VALIDATION: The residual value is from zero up to below the cost.'; end if;
  if v_method not in ('SL', 'RB') then raise exception 'VALIDATION: Choose straight-line or reducing balance.'; end if;
  if v_method = 'SL' and (v_life is null or v_life not between 1 and 1200) then raise exception 'VALIDATION: Enter the useful life in months (1 to 1200).'; end if;
  if v_method = 'RB' and (v_rate is null or v_rate <= 0 or v_rate > 100) then raise exception 'VALIDATION: Enter the yearly reducing-balance rate (above 0, up to 100%%).'; end if;
  if v_open < 0 or v_open > v_cost - v_res then raise exception 'VALIDATION: Depreciation already charged can''t be more than cost less residual value.'; end if;

  v_code := public._next_number(p_company, 'FA', extract(year from v_on)::int);
  insert into public.fixed_assets (company_id, code, name, cost_account_id, accum_account_id, expense_account_id, acquired_on, cost, residual,
    method, life_months, rb_rate, opening_accumulated, accumulated, depreciate_from, depreciated_to, source_line_id, notes, created_by)
  values (p_company, v_code, left(v_name, 200), v_cost_acc, v_accum, v_exp, v_on, v_cost, v_res, v_method,
    case when v_method = 'SL' then v_life end, case when v_method = 'RB' then round(v_rate, 2) end, v_open, v_open,
    -- An asset brought in with depreciation already charged starts from next month; a new one from the month it was bought.
    case when v_open > 0 then (date_trunc('month', greatest(v_on, current_date)) + interval '1 month')::date else date_trunc('month', v_on)::date end,
    null, v_src, left(nullif(btrim(p_data->>'notes'), ''), 1000), auth.uid())
  returning id into v_id;

  if coalesce((p_data->>'post_acquisition')::boolean, false) and v_src is null then
    v_paid := public._try_uuid(p_data->>'paid_from_account_id');
    if v_paid is null then raise exception 'VALIDATION: Choose the account the asset was paid from.'; end if;
    perform public._check_line_account(p_company, v_paid, 'Paid from');
    v_saved := public.save_journal(p_company, null, v_on, left(format('Asset %s — %s', v_code, v_name), 500), null,
      jsonb_build_array(public._jl(v_cost_acc, v_cost, v_name), public._jl(v_paid, -v_cost, v_name)), null);
    v_je := (v_saved->>'id')::uuid;
    update public.journal_entries set source = 'ASSET', source_id = v_id, doc_type = 'FA', doc_no = v_code where id = v_je;
    perform public.post_journal(v_je);
    update public.fixed_assets set acquisition_journal_id = v_je where id = v_id;
  end if;
  perform public._audit(p_company, 'asset.register', 'FixedAsset', v_id::text, format('Registered asset %s %s, cost %s', v_code, v_name, to_char(v_cost, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', v_id, 'code', v_code, 'journal_id', v_je);
end $$;

/** Removes an asset registered by mistake — only before any depreciation was posted for it. */
create or replace function public.delete_asset(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.fixed_assets;
begin
  select * into a from public.fixed_assets where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Asset not found.'; end if;
  perform public._require_perm(a.company_id, 'journal.reverse');
  if a.status <> 'ACTIVE' or a.accumulated <> a.opening_accumulated or exists (select 1 from public.depreciation_lines where asset_id = p_id) then
    raise exception 'VALIDATION: % has depreciation or a disposal posted. Void those first.', a.code;
  end if;
  if a.acquisition_journal_id is not null then
    perform public.reverse_journal(a.acquisition_journal_id, current_date, format('Asset %s removed', a.code));
  end if;
  delete from public.fixed_assets where id = p_id;
  perform public._audit(a.company_id, 'asset.delete', 'FixedAsset', p_id::text, format('Removed asset %s %s', a.code, a.name));
end $$;

-- ─── Depreciation ───────────────────────────────────────────────────────────
create or replace function public.depreciation_preview(p_company uuid, p_period_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'journal.view');
  return coalesce((select jsonb_agg(jsonb_build_object('asset_id', a.id, 'code', a.code, 'name', a.name, 'months', d.months,
            'amount', d.amount, 'from', d.m1, 'to', d.m2) order by a.code)
    from (select asset_id, count(*) months, sum(amount) amount, min(month) m1, max(month) m2
            from public._depreciation_due(p_company, p_period_end) group by asset_id) d
    join public.fixed_assets a on a.id = d.asset_id), '[]'::jsonb);
end $$;

create or replace function public.run_depreciation(p_company uuid, p_period_end date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_end date; v_id uuid; r record; v_lines jsonb := '[]'::jsonb; v_total numeric := 0; v_je uuid; v_saved jsonb; v_posted jsonb; k record;
begin
  perform public._require_perm(p_company, 'journal.post');
  if p_period_end is null then raise exception 'VALIDATION: Choose the month to depreciate up to.'; end if;
  v_end := (date_trunc('month', p_period_end) + interval '1 month - 1 day')::date;   -- always a month end
  perform 1 from public.fixed_assets where company_id = p_company and status = 'ACTIVE' for update;
  insert into public.depreciation_runs (company_id, period_end, total, created_by) values (p_company, v_end, 0, auth.uid()) returning id into v_id;
  insert into public.depreciation_lines (run_id, asset_id, company_id, month, amount)
  select v_id, d.asset_id, p_company, d.month, d.amount from public._depreciation_due(p_company, v_end) d;
  select coalesce(sum(amount), 0) into v_total from public.depreciation_lines where run_id = v_id;
  if v_total = 0 then raise exception 'VALIDATION: Nothing to depreciate up to % — every asset is up to date or fully depreciated.', to_char(v_end, 'DD Mon YYYY'); end if;

  for k in select a.expense_account_id e, a.accum_account_id c, sum(l.amount) amt
             from public.depreciation_lines l join public.fixed_assets a on a.id = l.asset_id where l.run_id = v_id group by 1, 2 loop
    v_lines := v_lines || public._jl(k.e, k.amt, 'Depreciation') || public._jl(k.c, -k.amt, 'Accumulated depreciation');
  end loop;
  v_saved := public.save_journal(p_company, null, v_end, format('Depreciation to %s', to_char(v_end, 'FMMonth YYYY')), null, v_lines, null);
  v_je := (v_saved->>'id')::uuid;
  update public.journal_entries set source = 'ASSET', source_id = v_id, doc_type = 'DEP', doc_no = public._next_number(p_company, 'DEP', extract(year from v_end)::int) where id = v_je;
  v_posted := public.post_journal(v_je);
  update public.depreciation_runs set total = v_total, journal_entry_id = v_je where id = v_id;
  for r in select asset_id, sum(amount) amt, max(month) last_m from public.depreciation_lines where run_id = v_id group by asset_id loop
    update public.fixed_assets set accumulated = accumulated + r.amt, depreciated_to = (r.last_m + interval '1 month - 1 day')::date where id = r.asset_id;
  end loop;
  perform public._audit(p_company, 'asset.depreciate', 'DepreciationRun', v_id::text,
    format('Depreciation to %s: %s', to_char(v_end, 'Mon YYYY'), to_char(v_total, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', v_id, 'total', v_total, 'period_end', v_end, 'journal_id', v_je, 'reference', v_posted->>'reference');
end $$;

/** Undoes the latest depreciation run: the journal is reversed and each asset steps back. */
create or replace function public.void_depreciation_run(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.depreciation_runs; v_r jsonb; r record;
begin
  select * into v from public.depreciation_runs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Depreciation run not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.reverse');
  if v.status <> 'POSTED' then raise exception 'INVALID_STATE: This run is already void.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'VALIDATION: Give a reason for voiding.'; end if;
  if exists (select 1 from public.depreciation_runs where company_id = v.company_id and status = 'POSTED' and seq > v.seq) then
    raise exception 'VALIDATION: Void the later depreciation runs first — only the latest can be undone.';
  end if;
  if exists (select 1 from public.depreciation_lines l join public.fixed_assets a on a.id = l.asset_id where l.run_id = p_id and a.status <> 'ACTIVE') then
    raise exception 'VALIDATION: An asset in this run has since been disposed of. Undo the disposal first.';
  end if;
  v_r := public.reverse_journal(v.journal_entry_id, greatest(v.period_end, current_date), format('Void depreciation to %s: %s', to_char(v.period_end, 'Mon YYYY'), btrim(p_reason)));
  for r in select asset_id, sum(amount) amt, min(month) first_m from public.depreciation_lines where run_id = p_id group by asset_id loop
    update public.fixed_assets set accumulated = accumulated - r.amt,
      depreciated_to = case when r.first_m <= depreciate_from then null else (r.first_m - 1) end where id = r.asset_id;
  end loop;
  delete from public.depreciation_lines where run_id = p_id;
  update public.depreciation_runs set status = 'VOID', void_entry_id = (v_r->>'id')::uuid where id = p_id;
  perform public._audit(v.company_id, 'asset.depreciate.void', 'DepreciationRun', p_id::text, format('Voided depreciation to %s — %s', to_char(v.period_end, 'Mon YYYY'), btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'status', 'VOID', 'reversal', v_r->>'reference');
end $$;

-- ─── Disposal ───────────────────────────────────────────────────────────────
/** p_data: {date, proceeds, money_account_id (when proceeds > 0), reason} */
create or replace function public.dispose_asset(p_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.fixed_assets; v_date date; v_proc numeric; v_money uuid; v_catch numeric; v_acc numeric; v_nbv numeric; v_gain numeric;
  v_lines jsonb := '[]'::jsonb; v_gain_acc uuid; v_loss_acc uuid; v_saved jsonb; v_je uuid; v_posted jsonb;
begin
  select * into a from public.fixed_assets where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Asset not found.'; end if;
  perform public._require_perm(a.company_id, 'journal.post');
  if a.status <> 'ACTIVE' then raise exception 'INVALID_STATE: % is already disposed of.', a.code; end if;
  begin
    v_date := (p_data->>'date')::date;
    v_proc := round(coalesce(nullif(p_data->>'proceeds', '')::numeric, 0), 2);
  exception when others then raise exception 'VALIDATION: Check the date and the amount received.';
  end;
  if v_date is null then raise exception 'VALIDATION: Enter the disposal date.'; end if;
  if v_date < a.acquired_on then raise exception 'VALIDATION: An asset can''t be disposed of before it was bought.'; end if;
  if v_proc < 0 then raise exception 'VALIDATION: The amount received can''t be negative.'; end if;
  if v_proc > 0 then
    v_money := public._try_uuid(p_data->>'money_account_id');
    if v_money is null then raise exception 'VALIDATION: Choose the account the money went into.'; end if;
    perform public._check_line_account(p_company => a.company_id, p_account => v_money, p_what => 'Received into');
  end if;
  -- Depreciation for the months not yet charged, up to and including the disposal month.
  insert into public.depreciation_lines (run_id, asset_id, company_id, month, amount, kind)
  select null, d.asset_id, a.company_id, d.month, d.amount, 'DISPOSAL' from public._depreciation_due(a.company_id, v_date, p_id) d;
  select coalesce(sum(amount), 0) into v_catch from public.depreciation_lines where asset_id = p_id and kind = 'DISPOSAL';
  v_acc := a.accumulated + v_catch;
  v_nbv := a.cost - v_acc;
  v_gain := v_proc - v_nbv;
  select id into v_gain_acc from public.accounts where company_id = a.company_id and code = '4530' and type = 'REVENUE' and name ilike '%disposal%' and is_postable and is_active;
  select id into v_loss_acc from public.accounts where company_id = a.company_id and code = '6720' and type = 'EXPENSE' and name ilike '%disposal%' and is_postable and is_active;
  if (v_gain > 0 and v_gain_acc is null) or (v_gain < 0 and v_loss_acc is null) then
    raise exception 'VALIDATION: These books need active Gain on Disposal (4530) and Loss on Disposal (6720) accounts.';
  end if;
  if v_catch > 0 then v_lines := v_lines || public._jl(a.expense_account_id, v_catch, 'Depreciation to disposal'); end if;
  if a.accumulated > 0 then v_lines := v_lines || public._jl(a.accum_account_id, a.accumulated, 'Accumulated depreciation'); end if;
  if v_proc > 0 then v_lines := v_lines || public._jl(v_money, v_proc, 'Proceeds'); end if;
  v_lines := v_lines || public._jl(a.cost_account_id, -a.cost, 'Cost');
  if v_gain > 0 then v_lines := v_lines || public._jl(v_gain_acc, -v_gain, 'Gain on disposal');
  elsif v_gain < 0 then v_lines := v_lines || public._jl(v_loss_acc, -v_gain, 'Loss on disposal'); end if;
  v_saved := public.save_journal(a.company_id, null, v_date,
    left(format('Disposal of %s %s%s', a.code, a.name, coalesce(' — ' || nullif(btrim(p_data->>'reason'), ''), '')), 500), null, v_lines, null);
  v_je := (v_saved->>'id')::uuid;
  update public.journal_entries set source = 'ASSET', source_id = p_id, doc_type = 'FA',
    doc_no = public._next_number(a.company_id, 'FAD', extract(year from v_date)::int) where id = v_je;
  v_posted := public.post_journal(v_je);
  update public.fixed_assets set status = 'DISPOSED', accumulated = v_acc, disposed_on = v_date, disposal_proceeds = v_proc,
    disposal_journal_id = v_je, depreciated_to = (date_trunc('month', v_date) + interval '1 month - 1 day')::date where id = p_id;
  perform public._audit(a.company_id, 'asset.dispose', 'FixedAsset', p_id::text,
    format('Disposed of %s %s for %s — %s %s', a.code, a.name, to_char(v_proc, 'FM999,999,999,990.00'),
           case when v_gain >= 0 then 'gain' else 'loss' end, to_char(abs(v_gain), 'FM999,999,999,990.00')));
  return jsonb_build_object('id', p_id, 'gain', v_gain, 'depreciation', v_catch, 'journal_id', v_je, 'reference', v_posted->>'reference');
end $$;

/** Undoes a disposal: the journal is reversed and the asset is active again. */
create or replace function public.undo_asset_disposal(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.fixed_assets; v_catch numeric; v_last date; v_r jsonb;
begin
  select * into a from public.fixed_assets where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Asset not found.'; end if;
  perform public._require_perm(a.company_id, 'journal.reverse');
  if a.status <> 'DISPOSED' then raise exception 'INVALID_STATE: % has not been disposed of.', a.code; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'VALIDATION: Give a reason.'; end if;
  v_r := public.reverse_journal(a.disposal_journal_id, greatest(a.disposed_on, current_date), format('Undo disposal of %s: %s', a.code, btrim(p_reason)));
  select coalesce(sum(amount), 0) into v_catch from public.depreciation_lines where asset_id = p_id and kind = 'DISPOSAL';
  delete from public.depreciation_lines where asset_id = p_id and kind = 'DISPOSAL';
  select max(month) into v_last from public.depreciation_lines where asset_id = p_id;
  update public.fixed_assets set status = 'ACTIVE', accumulated = accumulated - v_catch, disposed_on = null, disposal_proceeds = null,
    disposal_journal_id = null, depreciated_to = case when v_last is null then null else (v_last + interval '1 month - 1 day')::date end
  where id = p_id;
  perform public._audit(a.company_id, 'asset.dispose.undo', 'FixedAsset', p_id::text, format('Undid disposal of %s — %s', a.code, btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'status', 'ACTIVE', 'reversal', v_r->>'reference');
end $$;

-- ─── Reports ────────────────────────────────────────────────────────────────
/** Posted purchase lines on fixed-asset accounts that aren't in the register yet. */
create or replace function public.asset_candidates(p_company uuid)
returns table (line_id uuid, doc_id uuid, doc_no text, date date, supplier text, description text, account_id uuid, account text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'journal.view');
  return query
  select l.id, d.id, d.doc_no, d.date, coalesce(d.bill_name, c.name), l.description, a.id, a.code || ' · ' || a.name,
         l.amount + case when l.tax_code_id is not null and t.purchase_account_id is null then l.tax_amount else 0 end
    from public.trade_doc_lines l join public.trade_docs d on d.id = l.doc_id join public.accounts a on a.id = l.account_id
    left join public.contacts c on c.id = d.contact_id left join public.tax_codes t on t.id = l.tax_code_id
   where l.company_id = p_company and d.status = 'POSTED' and d.doc_type in ('BILL', 'CASH_PURCHASE')
     and a.sub_type = 'NON_CURRENT_ASSET' and a.name not ilike 'accumulated%'
     and not exists (select 1 from public.fixed_assets f where f.source_line_id = l.id)
   order by d.date desc, d.doc_no;
end $$;

/** Register against the ledger, account by account: cost, and accumulated depreciation. */
create or replace function public.fixed_asset_gl_check(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public._require_perm(p_company, 'report.view');
  with reg as (
    select cost_account_id acc, sum(cost) amt from public.fixed_assets where company_id = p_company and status = 'ACTIVE' group by 1
    union all
    select accum_account_id, -sum(accumulated) from public.fixed_assets where company_id = p_company and status = 'ACTIVE' group by 1),
  accs as (select acc, sum(amt) reg from reg group by acc),
  gl as (select l.account_id acc, sum(l.debit - l.credit) bal from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
          where e.company_id = p_company and e.status <> 'DRAFT' and l.account_id in (select acc from accs) group by 1)
  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name, 'register', x.reg,
           'gl_balance', coalesce(g.bal, 0), 'difference', coalesce(g.bal, 0) - x.reg) order by a.code), '[]'::jsonb)
    into v from accs x join public.accounts a on a.id = x.acc left join gl g on g.acc = x.acc;
  return jsonb_build_object('accounts', v, 'in_balance', not exists (select 1 from jsonb_array_elements(v) e where (e->>'difference')::numeric <> 0));
end $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
alter function public._asset_month(public.fixed_assets, numeric) set search_path = public;
revoke execute on function public._asset_defaults(uuid, uuid), public._asset_month(public.fixed_assets, numeric),
  public._depreciation_due(uuid, date, uuid), public._asset_check_accounts(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.register_asset(uuid, jsonb), public.delete_asset(uuid), public.depreciation_preview(uuid, date),
  public.run_depreciation(uuid, date), public.void_depreciation_run(uuid, text), public.dispose_asset(uuid, jsonb),
  public.undo_asset_disposal(uuid, text), public.asset_candidates(uuid), public.fixed_asset_gl_check(uuid) from public, anon;
grant execute on function public.register_asset(uuid, jsonb), public.delete_asset(uuid), public.depreciation_preview(uuid, date),
  public.run_depreciation(uuid, date), public.void_depreciation_run(uuid, text), public.dispose_asset(uuid, jsonb),
  public.undo_asset_disposal(uuid, text), public.asset_candidates(uuid), public.fixed_asset_gl_check(uuid) to authenticated;
