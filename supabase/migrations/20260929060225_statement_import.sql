-- ═══════════════════════════════════════════════════════════════════════════
-- Statement import: upload a bank or card statement and every line becomes a
-- transaction. Lines already in the books are matched, lines already imported
-- from an earlier statement are skipped, and the rest are recorded in one go
-- with a category per line. Categories people choose are remembered as rules,
-- so the next statement is categorised automatically.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.category_rules (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  pattern    text not null check (length(pattern) between 2 and 60),
  direction  text not null check (direction in ('IN', 'OUT')),
  account_id uuid not null references public.accounts(id) on delete cascade,
  uses       int not null default 1,
  updated_at timestamptz not null default now(),
  unique (company_id, pattern, direction)
);
create index category_rules_account_idx on public.category_rules(account_id);
alter table public.category_rules enable row level security;
create policy "category rules by permission" on public.category_rules for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')) or company_id in (select public.companies_with_perm('ledger.view')));

-- Import now also skips lines that an earlier statement of the same account
-- already brought in (same date, amount and description), so re-uploading an
-- overlapping statement never records anything twice.
create or replace function public.import_bank_statement(p_company uuid, p_account uuid, p_name text, p_lines jsonb,
                                                        p_opening numeric default null, p_closing numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acc record; v_id uuid; v_line jsonb; v_no int := 0; v_date date; v_amt numeric; v_matched int; v_dups int := 0;
begin
  perform public._require_perm(p_company, 'journal.create');
  select * into v_acc from public.accounts where id = p_account and company_id = p_company;
  if not found then raise exception 'VALIDATION: Account not found in these books.'; end if;
  if not public._statement_account_ok(p_company, p_account) then
    raise exception 'VALIDATION: % % is not a bank, cash or card account.', v_acc.code, v_acc.name;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'VALIDATION: The statement has no lines.';
  end if;
  if jsonb_array_length(p_lines) > 5000 then raise exception 'VALIDATION: Upload at most 5,000 lines at a time.'; end if;

  insert into public.bank_statements (company_id, account_id, name, opening_balance, closing_balance, created_by)
  values (p_company, p_account, left(coalesce(nullif(btrim(p_name), ''), 'Bank statement'), 200), round(p_opening, 2), round(p_closing, 2), auth.uid())
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin
      v_date := (v_line->>'date')::date;
      v_amt := round((v_line->>'amount')::numeric, 2);
    exception when others then
      raise exception 'VALIDATION: Line %: the date or amount could not be read.', v_no + 1;
    end;
    if v_date is null or v_amt is null or v_amt = 0 then continue; end if;
    if abs(v_amt) > 9999999999999999.99 then raise exception 'VALIDATION: Line %: that amount is too large.', v_no + 1; end if;
    v_no := v_no + 1;
    insert into public.bank_lines (statement_id, company_id, line_no, date, description, reference, amount, balance)
    values (v_id, p_company, v_no, v_date, left(nullif(btrim(v_line->>'description'), ''), 500),
            left(nullif(btrim(v_line->>'reference'), ''), 100), v_amt,
            round(nullif(v_line->>'balance', '')::numeric, 2));
  end loop;
  if v_no = 0 then raise exception 'VALIDATION: No line had both a date and an amount.'; end if;

  update public.bank_statements set line_count = v_no,
    date_from = (select min(date) from public.bank_lines where statement_id = v_id),
    date_to = (select max(date) from public.bank_lines where statement_id = v_id)
  where id = v_id;

  -- The n-th copy of a (date, amount, description) line is a duplicate when
  -- earlier statements of this account already hold at least n such lines.
  with mine as (
    select b.id, b.date, b.amount, coalesce(b.description, '') as d,
           row_number() over (partition by b.date, b.amount, coalesce(b.description, '') order by b.line_no) as n
    from public.bank_lines b where b.statement_id = v_id),
  earlier as (
    select b.date, b.amount, coalesce(b.description, '') as d, count(*) as k
    from public.bank_lines b join public.bank_statements s on s.id = b.statement_id
    where s.company_id = p_company and s.account_id = p_account and s.id <> v_id
    group by 1, 2, 3),
  dup as (
    select m.id from mine m join earlier e on e.date = m.date and e.amount = m.amount and e.d = m.d where m.n <= e.k)
  update public.bank_lines b set status = 'IGNORED', note = 'Already imported from an earlier statement', updated_at = now()
  from dup where b.id = dup.id;
  get diagnostics v_dups = row_count;

  v_matched := public._auto_match(v_id);
  perform public._audit(p_company, 'bank.import', 'BankStatement', v_id::text,
    format('Imported %s bank lines for %s %s; %s matched automatically, %s already imported', v_no, v_acc.code, v_acc.name, v_matched, v_dups));
  return jsonb_build_object('id', v_id, 'lines', v_no, 'matched', v_matched, 'duplicates', v_dups);
end $$;

-- Records many statement lines at once. Each item: {line_id, account_id,
-- description?, key?}. A line whose category is an asset or liability (cash,
-- e-wallet, card, loan, savings) is a transfer; otherwise money in or out with
-- the next automatic PV/OR number. Lines that fail (closed period, a series
-- keyed by hand, ...) are reported and left unmatched; the rest are posted.
create or replace function public.record_bank_lines(p_statement uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_st record; v_item jsonb; v_l public.bank_lines; v_acc record; v_kind text; v_saved jsonb; v_r jsonb; v_id uuid;
  v_desc text; v_key text; v_done int := 0; v_errors jsonb := '[]'::jsonb; v_msg text;
begin
  select * into v_st from public.bank_statements where id = p_statement;
  if not found then raise exception 'NOT_FOUND: Statement not found.'; end if;
  perform public._require_perm(v_st.company_id, 'journal.create');
  perform public._require_perm(v_st.company_id, 'journal.post');
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'VALIDATION: Nothing to record.'; end if;
  if jsonb_array_length(p_items) > 2000 then raise exception 'VALIDATION: Record at most 2,000 lines at a time.'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      select * into v_l from public.bank_lines where id = (v_item->>'line_id')::uuid and statement_id = p_statement for update;
      if not found then raise exception 'NOT_FOUND: That line is not on this statement.'; end if;
      if v_l.status <> 'UNMATCHED' then raise exception 'INVALID_STATE: Already matched or ignored.'; end if;
      select * into v_acc from public.accounts
       where id = (v_item->>'account_id')::uuid and company_id = v_st.company_id and is_postable and is_active;
      if not found then raise exception 'VALIDATION: Choose an active category.'; end if;
      if v_acc.id = v_st.account_id then raise exception 'VALIDATION: A line can''t be categorised to its own account.'; end if;
      v_desc := left(coalesce(nullif(btrim(v_item->>'description'), ''), v_l.description, case when v_l.amount > 0 then 'Money in' else 'Money out' end), 500);

      if v_acc.type in ('ASSET', 'LIABILITY') then
        v_saved := public.save_journal(v_st.company_id, null, v_l.date, v_desc, v_l.reference,
          case when v_l.amount > 0
            then jsonb_build_array(jsonb_build_object('account_id', v_st.account_id, 'debit', abs(v_l.amount), 'credit', 0),
                                   jsonb_build_object('account_id', v_acc.id, 'debit', 0, 'credit', abs(v_l.amount)))
            else jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'debit', abs(v_l.amount), 'credit', 0),
                                   jsonb_build_object('account_id', v_st.account_id, 'debit', 0, 'credit', abs(v_l.amount))) end,
          null);
        v_id := (v_saved->>'id')::uuid;
        update public.journal_entries set source = 'BANK', txn_kind = 'TRANSFER' where id = v_id;
        perform public.post_journal(v_id);
      else
        v_kind := case when v_l.amount > 0 then 'IN' else 'OUT' end;
        v_r := public.record_transaction(v_st.company_id, v_kind, v_l.date, abs(v_l.amount), v_st.account_id, v_acc.id,
                                         v_desc, v_l.reference, 0, null, 'Bank transfer');
        v_id := (v_r->>'id')::uuid;
      end if;
      update public.bank_lines set status = 'MATCHED', entry_id = v_id, match_method = 'CREATED', updated_at = now() where id = v_l.id;

      v_key := upper(btrim(coalesce(v_item->>'key', '')));
      if length(v_key) between 2 and 60 then
        insert into public.category_rules (company_id, pattern, direction, account_id)
        values (v_st.company_id, v_key, case when v_l.amount > 0 then 'IN' else 'OUT' end, v_acc.id)
        on conflict (company_id, pattern, direction) do update
          set account_id = excluded.account_id, uses = public.category_rules.uses + 1, updated_at = now();
      end if;
      v_done := v_done + 1;
    exception when others then
      v_msg := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('line_no', v_l.line_no, 'message', v_msg));
    end;
  end loop;

  perform public._audit(v_st.company_id, 'bank.record', 'BankStatement', p_statement::text,
    format('Recorded %s lines from statement %s%s', v_done, v_st.name,
           case when jsonb_array_length(v_errors) > 0 then format(' (%s not recorded)', jsonb_array_length(v_errors)) else '' end));
  return jsonb_build_object('recorded', v_done, 'errors', v_errors);
end $$;

create or replace function public.forget_category_rule(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.category_rules where id = p_id;
  if not found then raise exception 'NOT_FOUND: Rule not found.'; end if;
  perform public._require_perm(v_company, 'journal.create');
  delete from public.category_rules where id = p_id;
end $$;

revoke execute on function public.import_bank_statement(uuid, uuid, text, jsonb, numeric, numeric),
  public.record_bank_lines(uuid, jsonb), public.forget_category_rule(uuid) from public, anon;
grant execute on function public.import_bank_statement(uuid, uuid, text, jsonb, numeric, numeric),
  public.record_bank_lines(uuid, jsonb), public.forget_category_rule(uuid) to authenticated;
