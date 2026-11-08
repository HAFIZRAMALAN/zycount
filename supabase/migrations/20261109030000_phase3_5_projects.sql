-- Phase 3.5 — Projects (docs/spec/04 §11).
--
-- A project is a tag on journal lines: a sales or purchase document can name one for all its lines (or a
-- line its own), a manual journal per line. It never changes what is debited or credited — it only lets
-- the profit and loss be read per project. A closed project takes no new postings; reversals keep the
-- original line's project so voiding stays exact. Stock and price-difference lines (COGS, inventory)
-- take the document's project when every line of the document is on the same one.

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null check (length(btrim(code)) between 1 and 30),
  name        text not null check (length(btrim(name)) between 1 and 200),
  contact_id  uuid references public.contacts(id) on delete set null,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'CLOSED')),
  start_date  date,
  end_date    date,
  notes       text check (length(notes) <= 1000),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create unique index projects_code_uniq on public.projects(company_id, lower(code));
create index projects_contact_idx on public.projects(contact_id);
alter table public.projects enable row level security;
create policy "projects by permission" on public.projects for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
revoke all on public.projects from anon;
grant select on public.projects to authenticated;

alter table public.journal_lines add column project_id uuid references public.projects(id);
create index journal_lines_project_idx on public.journal_lines(project_id) where project_id is not null;
alter table public.trade_doc_lines add column project_id uuid references public.projects(id);
create index trade_doc_lines_project_idx on public.trade_doc_lines(project_id) where project_id is not null;

/** A project id from user input: blank is none; it must be these books' and still open. */
create or replace function public._project_ok(p_company uuid, p_value text, p_what text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_id uuid; v public.projects;
begin
  if nullif(btrim(coalesce(p_value, '')), '') is null then return null; end if;
  v_id := public._try_uuid(p_value);
  select * into v from public.projects where id = v_id and company_id = p_company;
  if not found then raise exception 'VALIDATION: %: project not found in these books.', p_what; end if;
  if v.status <> 'ACTIVE' then raise exception 'VALIDATION: %: project % is closed. Reopen it to post to it.', p_what, v.code; end if;
  return v.id;
end $$;
revoke execute on function public._project_ok(uuid, text, text) from public, anon, authenticated;

create or replace function public._write_lines(p_entry uuid, p_company uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb; v_no int := 0; v_debit numeric; v_credit numeric; v_account uuid; v_acc record; v_proj uuid;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'VALIDATION: Journal lines are required.';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'VALIDATION: A journal can have at most 500 lines.';
  end if;
  delete from public.journal_lines where journal_entry_id = p_entry;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin
      v_debit  := coalesce(nullif(btrim(v_line->>'debit'), '')::numeric, 0);
      v_credit := coalesce(nullif(btrim(v_line->>'credit'), '')::numeric, 0);
    exception when others then
      raise exception 'VALIDATION: Line %: amounts must be numbers.', v_no + 1;
    end;
    if v_debit = 0 and v_credit = 0 then continue; end if;   -- blank rows are ignored
    v_no := v_no + 1;
    if v_debit <> round(v_debit, 2) or v_credit <> round(v_credit, 2) then
      raise exception 'VALIDATION: Line %: amounts can have at most 2 decimal places (sen).', v_no;
    end if;
    if v_debit < 0 or v_credit < 0 then
      raise exception 'VALIDATION: Line %: amounts cannot be negative.', v_no;
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'VALIDATION: Line %: enter a debit or a credit, not both.', v_no;
    end if;
    if v_debit > 9999999999999999.99 or v_credit > 9999999999999999.99 then
      raise exception 'VALIDATION: Line %: amount is too large.', v_no;
    end if;
    begin
      v_account := (v_line->>'account_id')::uuid;
    exception when others then
      raise exception 'VALIDATION: Line %: choose an account.', v_no;
    end;
    select id, code, name, is_postable, is_active into v_acc from public.accounts
     where id = v_account and company_id = p_company;
    if not found then
      raise exception 'VALIDATION: Line %: account not found in this company.', v_no;
    end if;
    if not v_acc.is_postable then
      raise exception 'ACCOUNT_NOT_POSTABLE: % % is a heading — post to one of its sub-accounts.', v_acc.code, v_acc.name;
    end if;
    if not v_acc.is_active then
      raise exception 'ACCOUNT_NOT_POSTABLE: % % is archived.', v_acc.code, v_acc.name;
    end if;
    v_proj := public._project_ok(p_company, v_line->>'project_id', format('Line %s', v_no));
    insert into public.journal_lines (journal_entry_id, account_id, line_no, description, debit, credit, project_id)
    values (p_entry, v_account, v_no, nullif(btrim(v_line->>'description'), ''), v_debit, v_credit, v_proj);
  end loop;
  update public.journal_entries e set
    total_debit  = coalesce((select sum(debit)  from public.journal_lines where journal_entry_id = p_entry), 0),
    total_credit = coalesce((select sum(credit) from public.journal_lines where journal_entry_id = p_entry), 0)
  where e.id = p_entry;
end $$;

create or replace function public.reverse_journal(p_id uuid, p_date date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_e record; v_new uuid; v_date date; v_result jsonb; v_doc record;
begin
  select * into v_e from public.journal_entries where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  perform public._require_perm(v_e.company_id, 'journal.reverse');
  if v_e.status = 'REVERSED' then raise exception 'INVALID_STATE: % has already been reversed.', v_e.reference; end if;
  if v_e.status <> 'POSTED' then raise exception 'INVALID_STATE: Only posted journals can be reversed.'; end if;
  if v_e.reversal_of_id is not null then
    raise exception 'INVALID_STATE: % is itself a reversal and cannot be reversed.', v_e.reference;
  end if;
  if coalesce(current_setting('zycount.trade_void', true), '') <> 'on' then
    select doc_no, doc_type into v_doc from public.trade_docs where journal_entry_id = p_id;
    if found then
      raise exception 'LINKED_DOCUMENT: % was posted by %. Void that document instead, so its balance and knock-offs stay right.', v_e.reference, v_doc.doc_no;
    end if;
  end if;
  v_date := coalesce(p_date, current_date);
  if v_date < v_e.date then
    raise exception 'VALIDATION: The reversal date cannot be before the original date (%).', to_char(v_e.date, 'DD Mon YYYY');
  end if;

  insert into public.journal_entries (company_id, date, description, memo, source, source_id, reversal_of_id, created_by)
  values (v_e.company_id, v_date,
          left(format('Reversal of %s%s', v_e.reference, coalesce(' — ' || v_e.description, '')), 500),
          nullif(btrim(p_reason), ''), v_e.source, v_e.source_id, v_e.id, auth.uid())
  returning id into v_new;

  insert into public.journal_lines (journal_entry_id, account_id, line_no, description, debit, credit, project_id)
  select v_new, account_id, line_no, description, credit, debit, project_id
  from public.journal_lines where journal_entry_id = v_e.id;

  v_result := public._post(v_new);
  update public.journal_entries set status = 'REVERSED', version = version + 1 where id = v_e.id;
  perform public._audit(v_e.company_id, 'journal.reverse', 'JournalEntry', v_e.id::text,
    format('Reversed %s with %s%s', v_e.reference, v_result->>'reference', coalesce(' — ' || nullif(btrim(p_reason), ''), '')));
  return v_result || jsonb_build_object('reversed', v_e.reference);
end $$;

create or replace function public.save_trade_doc(p_company uuid, p_id uuid, p_doc jsonb, p_lines jsonb default '[]'::jsonb,
                                                 p_post boolean default false, p_series uuid default null, p_doc_no text default null,
                                                 p_allocations jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.trade_docs; v_type text; v_m record; v_id uuid; v_contact public.contacts; v_date date; v_due date; v_terms int;
  v_line jsonb; v_no int := 0; v_qty numeric; v_price numeric; v_disc numeric; v_gross numeric; v_amt numeric; v_tax numeric;
  v_net numeric; v_tc public.tax_codes; v_item public.items; v_acc uuid; v_desc text; v_sub numeric := 0; v_taxt numeric := 0;
  v_tot numeric := 0; v_money uuid; v_control uuid; v_charge numeric := 0; v_incl boolean; v_rows jsonb := '[]'::jsonb;
  v_contact_id uuid; v_source uuid; v_what text; v_wh uuid; v_ret boolean; v_doc_proj uuid;
begin
  perform public._require_perm(p_company, 'journal.create');
  if p_id is not null then
    select * into v_old from public.trade_docs where id = p_id and company_id = p_company for update;
    if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
    if v_old.status <> 'DRAFT' then raise exception 'IMMUTABLE: Only drafts can be edited. Void it, or issue a credit or debit note.'; end if;
    v_type := v_old.doc_type;
  else
    v_type := upper(btrim(coalesce(p_doc->>'doc_type', '')));
  end if;
  select * into v_m from public._trade_meta(v_type);
  if v_m.side is null then raise exception 'VALIDATION: Unknown document type.'; end if;
  v_what := case v_m.side when 'AR' then 'customer' else 'supplier' end;

  begin v_date := (p_doc->>'date')::date; exception when others then raise exception 'VALIDATION: Choose a valid date.'; end;
  if v_date is null then raise exception 'VALIDATION: Choose a date.'; end if;

  v_contact_id := public._try_uuid(p_doc->>'contact_id');
  if v_contact_id is not null then
    select * into v_contact from public.contacts where id = v_contact_id and company_id = p_company;
    if not found or v_contact.kind <> (case v_m.side when 'AR' then 'CUSTOMER' else 'SUPPLIER' end) then
      raise exception 'VALIDATION: Choose a %.', v_what;
    end if;
    if not v_contact.is_active then raise exception 'VALIDATION: % is inactive.', v_contact.name; end if;
  elsif v_m.uses_control or v_type in ('QUOTATION', 'PURCHASE_ORDER') then
    raise exception 'VALIDATION: Choose a %.', v_what;
  end if;

  begin
    v_terms := coalesce(nullif(p_doc->>'terms_days', '')::int, v_contact.terms_days, 30);
    v_due := nullif(p_doc->>'due_date', '')::date;
  exception when others then raise exception 'VALIDATION: Check the terms and due date.';
  end;
  if v_m.effect = 1 and v_m.has_lines then
    v_due := coalesce(v_due, v_date + v_terms);
  elsif v_type in ('QUOTATION', 'PURCHASE_ORDER') then
    v_due := coalesce(v_due, v_date + 30);
  else
    v_due := null; v_terms := null;
  end if;
  if v_due is not null and v_due < v_date then raise exception 'VALIDATION: The due date cannot be before the document date.'; end if;

  if v_m.uses_money then
    v_money := public._try_uuid(p_doc->>'money_account_id');
    if v_money is null or not public._statement_account_ok(p_company, v_money) then
      raise exception 'VALIDATION: Choose the bank or cash account.';
    end if;
  end if;
  if v_m.uses_control then
    v_control := coalesce(v_contact.control_account_id, public._default_control(p_company, v_m.side));
    if v_control is null then
      raise exception 'VALIDATION: These books have no % control account. Mark one in the chart of accounts.',
        case v_m.side when 'AR' then 'trade receivables' else 'trade payables' end;
    end if;
  end if;

  v_source := public._try_uuid(p_doc->>'source_doc_id');
  if v_source is not null and not exists (select 1 from public.trade_docs where id = v_source and company_id = p_company) then
    v_source := null;
  end if;
  v_incl := coalesce((p_doc->>'tax_inclusive')::boolean, false);
  -- Phase 3.2: where the goods leave from / arrive at, and whether a credit note returns them to stock.
  v_wh := public._try_uuid(p_doc->>'warehouse_id');
  if v_wh is not null then v_wh := public._warehouse_ok(p_company, v_wh); end if;
  v_ret := coalesce((p_doc->>'stock_return')::boolean, v_old.stock_return, true);
  -- Phase 3.5: a project for the whole document; a line can name its own.
  v_doc_proj := public._project_ok(p_company, p_doc->>'project_id', 'Project');

  if v_m.has_lines then
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'VALIDATION: Add at least one line.'; end if;
    if jsonb_array_length(p_lines) > 200 then raise exception 'VALIDATION: A document can have at most 200 lines.'; end if;
    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_item := null; v_tc := null;
      if public._try_uuid(v_line->>'item_id') is not null then
        select * into v_item from public.items where id = public._try_uuid(v_line->>'item_id') and company_id = p_company;
        if not found then raise exception 'VALIDATION: Line %: item not found.', v_no + 1; end if;
      end if;
      v_desc := btrim(coalesce(nullif(btrim(v_line->>'description'), ''), v_item.description, ''));
      begin
        v_qty := round(coalesce(nullif(v_line->>'qty', '')::numeric, 1), 4);
        v_price := round(coalesce(nullif(v_line->>'unit_price', '')::numeric, 0), 4);
        v_disc := round(coalesce(nullif(v_line->>'discount', '')::numeric, 0), 2);
      exception when others then raise exception 'VALIDATION: Line %: quantity, price and discount must be numbers.', v_no + 1;
      end;
      if v_desc = '' and v_price = 0 and v_item.id is null then continue; end if;  -- blank rows are ignored
      v_no := v_no + 1;
      if v_desc = '' then raise exception 'VALIDATION: Line %: describe it.', v_no; end if;
      if v_qty <= 0 then raise exception 'VALIDATION: Line %: quantity must be more than zero.', v_no; end if;
      if v_price < 0 then raise exception 'VALIDATION: Line %: the price cannot be negative.', v_no; end if;
      v_gross := round(v_qty * v_price, 2);
      if v_gross > 9999999999999.99 then raise exception 'VALIDATION: Line %: amount is too large.', v_no; end if;
      if v_disc < 0 or v_disc > v_gross then raise exception 'VALIDATION: Line %: the discount is between zero and the line amount.', v_no; end if;
      v_amt := v_gross - v_disc;

      v_acc := coalesce(public._try_uuid(v_line->>'account_id'),
                        case v_m.side when 'AR' then v_item.sales_account_id
                                      else coalesce(v_item.purchase_account_id, case when v_item.track_stock then v_item.inventory_account_id end) end,
                        v_contact.default_account_id);
      if v_acc is not null then
        perform public._check_line_account(p_company, v_acc, format('Line %s', v_no));
        if v_acc = v_money then raise exception 'VALIDATION: Line %: choose an income or expense account, not the bank account.', v_no; end if;
      elsif v_m.posts then
        raise exception 'VALIDATION: Line %: choose an account.', v_no;
      end if;

      if public._try_uuid(v_line->>'tax_code_id') is not null then
        select * into v_tc from public.tax_codes where id = public._try_uuid(v_line->>'tax_code_id') and company_id = p_company;
        if not found then raise exception 'VALIDATION: Line %: tax code not found.', v_no; end if;
        if not v_tc.is_active then raise exception 'VALIDATION: Line %: tax code % is inactive.', v_no, v_tc.code; end if;
        if v_m.side = 'AR' and v_tc.sales_account_id is null and v_tc.rate > 0 then
          raise exception 'VALIDATION: Line %: tax code % has no output tax account.', v_no, v_tc.code;
        end if;
      end if;
      if coalesce(v_tc.rate, 0) = 0 then
        v_net := v_amt; v_tax := 0;
      elsif v_incl then
        v_tax := round(v_amt * v_tc.rate / (100 + v_tc.rate), 2); v_net := v_amt - v_tax;
      else
        v_net := v_amt; v_tax := round(v_amt * v_tc.rate / 100, 2);
      end if;
      v_sub := v_sub + v_net; v_taxt := v_taxt + v_tax; v_tot := v_tot + v_net + v_tax;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'line_no', v_no, 'item_id', v_item.id, 'description', left(v_desc, 500), 'qty', v_qty,
        'uom', coalesce(nullif(upper(btrim(v_line->>'uom')), ''), v_item.uom), 'unit_price', v_price, 'discount', v_disc,
        'account_id', v_acc, 'tax_code_id', v_tc.id, 'tax_rate', coalesce(v_tc.rate, 0), 'amount', v_net, 'tax_amount', v_tax,
        'total', v_net + v_tax,
        'project_id', coalesce(public._project_ok(p_company, v_line->>'project_id', format('Line %s', v_no)), v_doc_proj), 'grn_line_id', public._grn_line_ok(p_company, v_type, v_contact_id, v_line->>'grn_line_id')));
    end loop;
    if v_no = 0 then raise exception 'VALIDATION: Add at least one line.'; end if;
  else
    begin
      v_tot := round((p_doc->>'amount')::numeric, 2);
      v_charge := round(coalesce(nullif(p_doc->>'bank_charge', '')::numeric, 0), 2);
    exception when others then raise exception 'VALIDATION: Enter the amount.';
    end;
    if v_tot is null or v_tot <= 0 then raise exception 'VALIDATION: Enter an amount greater than zero.'; end if;
    if v_tot > 9999999999999.99 then raise exception 'VALIDATION: That amount is too large.'; end if;
    if v_charge < 0 then raise exception 'VALIDATION: Bank charges cannot be negative.'; end if;
    if v_m.head_debit and v_charge >= v_tot then raise exception 'VALIDATION: Bank charges must be less than the amount.'; end if;
    v_sub := v_tot;
  end if;

  if p_id is null then
    insert into public.trade_docs (company_id, side, doc_type, contact_id, date, created_by)
    values (p_company, v_m.side, v_type, v_contact_id, v_date, auth.uid()) returning id into v_id;
  else
    v_id := p_id;
  end if;
  update public.trade_docs set contact_id = v_contact_id, date = v_date, due_date = v_due, terms_days = v_terms,
    bill_name = left(coalesce(nullif(btrim(p_doc->>'bill_name'), ''), v_contact.name), 200),
    bill_address = left(nullif(btrim(p_doc->>'bill_address'), ''), 500),
    attention = left(nullif(btrim(p_doc->>'attention'), ''), 100),
    reference = left(nullif(btrim(p_doc->>'reference'), ''), 60), description = left(nullif(btrim(p_doc->>'description'), ''), 500),
    notes = left(nullif(btrim(p_doc->>'notes'), ''), 2000), tax_inclusive = v_incl,
    subtotal = v_sub, tax_total = v_taxt, total = v_tot, money_account_id = v_money,
    pay_method = left(nullif(btrim(p_doc->>'pay_method'), ''), 60), bank_charge = v_charge, control_account_id = v_control,
    source_doc_id = coalesce(v_source, v_old.source_doc_id),
    warehouse_id = coalesce(v_wh, v_old.warehouse_id), stock_return = v_ret,
    allow_price_variance = coalesce((p_doc->>'allow_price_variance')::boolean, false)
  where id = v_id;
  delete from public.trade_doc_lines where doc_id = v_id;
  insert into public.trade_doc_lines (doc_id, company_id, line_no, item_id, description, qty, uom, unit_price, discount,
                                      account_id, tax_code_id, tax_rate, amount, tax_amount, total, grn_line_id, project_id)
  select v_id, p_company, (r->>'line_no')::int, (r->>'item_id')::uuid, r->>'description', (r->>'qty')::numeric, r->>'uom',
         (r->>'unit_price')::numeric, (r->>'discount')::numeric, (r->>'account_id')::uuid, (r->>'tax_code_id')::uuid,
         (r->>'tax_rate')::numeric, (r->>'amount')::numeric, (r->>'tax_amount')::numeric, (r->>'total')::numeric, (r->>'grn_line_id')::uuid,
         (r->>'project_id')::uuid
  from jsonb_array_elements(v_rows) r;

  -- A number (or series) chosen on a draft is kept until the draft is posted.
  update public.trade_docs set
    draft_series_id = (select s.id from public.document_series s where s.id = p_series and s.company_id = p_company),
    draft_doc_no = left(nullif(btrim(p_doc_no), ''), 40)
  where id = v_id;

  if p_post then
    return public._post_trade_doc(v_id, p_series, p_doc_no, p_allocations, coalesce((p_doc->>'allow_over_limit')::boolean, false));
  end if;
  perform public._audit(p_company, 'trade.save', 'TradeDoc', v_id::text,
    format('%s draft %s%s for %s', case when p_id is null then 'Created' else 'Edited' end, lower(v_m.label),
           coalesce(' ' || nullif(btrim(p_doc->>'reference'), ''), ''), to_char(v_tot, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', v_id, 'status', 'DRAFT', 'total', v_tot);
end $$;

create or replace function public._post_trade_doc(p_id uuid, p_series uuid, p_doc_no text, p_allocations jsonb, p_over_limit boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_d public.trade_docs; v_m record; v_c public.contacts; v_series public.document_series; v_num record; v_lines jsonb;
  v_head uuid; v_saved jsonb; v_je uuid; v_posted jsonb; v_bad record; v_bal numeric; v_charge_acc uuid; v_dup text;
  v_party text; v_src public.trade_docs; v_auto numeric; v_stock jsonb := '{}'::jsonb; v_match jsonb := '{}'::jsonb; v_one uuid;
begin
  select * into v_d from public.trade_docs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v_d.company_id, 'journal.post');
  if v_d.status <> 'DRAFT' then raise exception 'INVALID_STATE: This document is already %.', lower(v_d.status); end if;
  select * into v_m from public._trade_meta(v_d.doc_type);
  if v_d.total <= 0 then raise exception 'VALIDATION: The total must be more than zero.'; end if;
  if v_d.contact_id is not null then
    select * into v_c from public.contacts where id = v_d.contact_id;
    if not v_c.is_active then raise exception 'VALIDATION: % is inactive.', v_c.name; end if;
  end if;
  v_party := coalesce(v_d.bill_name, v_c.name);

  if v_m.posts then
    select l.line_no into v_bad from public.trade_doc_lines l where l.doc_id = p_id and l.account_id is null order by l.line_no limit 1;
    if found then raise exception 'VALIDATION: Line %: choose an account.', v_bad.line_no; end if;
    select l.line_no, t.code into v_bad from public.trade_doc_lines l join public.tax_codes t on t.id = l.tax_code_id
     where l.doc_id = p_id and l.tax_amount <> 0 and v_m.side = 'AR' and t.sales_account_id is null limit 1;
    if found then raise exception 'VALIDATION: Line %: tax code % has no output tax account.', v_bad.line_no, v_bad.code; end if;
  end if;

  -- Credit limit (the person can confirm going over it).
  if v_m.side = 'AR' and v_m.effect = 1 and v_c.credit_limit > 0 and not coalesce(p_over_limit, false) then
    v_bal := public._contact_balance(v_c.id);
    if v_bal + v_d.total > v_c.credit_limit then
      raise exception 'CREDIT_LIMIT: % would owe %, over the credit limit of %.', v_c.name,
        to_char(v_bal + v_d.total, 'FM999,999,999,990.00'), to_char(v_c.credit_limit, 'FM999,999,999,990.00');
    end if;
  end if;
  -- The same supplier invoice is never recorded twice.
  if v_d.doc_type in ('BILL', 'CASH_PURCHASE') and v_d.reference is not null and v_d.contact_id is not null then
    select doc_no into v_dup from public.trade_docs
     where company_id = v_d.company_id and contact_id = v_d.contact_id and doc_type in ('BILL', 'CASH_PURCHASE')
       and status = 'POSTED' and lower(reference) = lower(v_d.reference) limit 1;
    if found then raise exception 'DUPLICATE: Supplier invoice % from % is already recorded as %.', v_d.reference, v_party, v_dup; end if;
  end if;

  v_series := public._resolve_series(v_d.company_id, v_m.series_kind, p_series, v_d.money_account_id);
  if v_series.id is null then
    raise exception 'VALIDATION: These books have no % numbering series. Add one under Numbering.', public._series_label(v_m.series_kind);
  end if;
  select * into v_num from public._assign_number(v_series, v_d.date, p_doc_no, false);

  if v_m.posts then
    v_head := coalesce(v_d.control_account_id, v_d.money_account_id);
    if v_m.has_lines then
      -- Phase 3.2: stock items move stock; purchases post to Inventory, sales add cost of goods sold.
      v_stock := public._stock_on_post(p_id);
      -- Phase 3.3: lines matched to goods received clear GRNI; price differences go to stock, COGS or the expense.
      v_match := public._match_on_post(p_id);
      v_lines := jsonb_build_array(jsonb_build_object('account_id', v_head,
        'debit', case when v_m.head_debit then v_d.total else 0 end, 'credit', case when v_m.head_debit then 0 else v_d.total end,
        'description', left(coalesce(v_party, v_m.label), 200)));
      select v_lines || coalesce(jsonb_agg(jsonb_build_object('account_id', x.account_id,
               'debit', case when v_m.head_debit then 0 else x.amt end, 'credit', case when v_m.head_debit then x.amt else 0 end,
               'description', x.descr, 'project_id', x.proj) order by x.ord), '[]'::jsonb)
        into v_lines
      from (
        select l.line_no as ord, coalesce(public._try_uuid(v_match->'override'->>l.id::text), public._try_uuid(v_stock->'override'->>l.id::text), l.account_id) as account_id,
               left(l.description, 200) as descr,
               l.amount + case when v_m.side = 'AP' and t.purchase_account_id is null then l.tax_amount else 0 end as amt,
               l.project_id as proj
        from public.trade_doc_lines l left join public.tax_codes t on t.id = l.tax_code_id
        where l.doc_id = p_id
        union all
        select 100000 + row_number() over (order by g.acc), g.acc, g.descr, g.amt, null::uuid from (
          select case when v_m.side = 'AR' then t.sales_account_id else t.purchase_account_id end as acc,
                 'SST ' || string_agg(distinct t.code, ', ') as descr, sum(l.tax_amount) as amt
          from public.trade_doc_lines l join public.tax_codes t on t.id = l.tax_code_id
          where l.doc_id = p_id and l.tax_amount <> 0
            and (case when v_m.side = 'AR' then t.sales_account_id else t.purchase_account_id end) is not null
          group by 1) g) x;
      select case when count(*) = count(project_id) and count(distinct project_id) = 1 then min(project_id::text)::uuid end
        into v_one from public.trade_doc_lines where doc_id = p_id;
      select v_lines || coalesce(jsonb_agg(case when v_one is null then e else e || jsonb_build_object('project_id', v_one) end), '[]'::jsonb)
        into v_lines
        from jsonb_array_elements(coalesce(v_stock->'extra', '[]'::jsonb) || coalesce(v_match->'extra', '[]'::jsonb)) e;
    else
      if v_d.bank_charge > 0 then
        select id into v_charge_acc from public.accounts where company_id = v_d.company_id and code = '6380' and is_postable and is_active;
        if not found then raise exception 'VALIDATION: These books have no active Bank Charges account (6380).'; end if;
      end if;
      if v_m.head_debit then
        v_lines := jsonb_build_array(
          jsonb_build_object('account_id', v_d.money_account_id, 'debit', v_d.total - v_d.bank_charge, 'credit', 0),
          jsonb_build_object('account_id', v_charge_acc, 'debit', v_d.bank_charge, 'credit', 0, 'description', 'Bank charges'),
          jsonb_build_object('account_id', v_d.control_account_id, 'debit', 0, 'credit', v_d.total, 'description', left(v_party, 200)));
      else
        v_lines := jsonb_build_array(
          jsonb_build_object('account_id', v_d.control_account_id, 'debit', v_d.total, 'credit', 0, 'description', left(v_party, 200)),
          jsonb_build_object('account_id', v_charge_acc, 'debit', v_d.bank_charge, 'credit', 0, 'description', 'Bank charges'),
          jsonb_build_object('account_id', v_d.money_account_id, 'debit', 0, 'credit', v_d.total + v_d.bank_charge));
      end if;
    end if;

    v_saved := public.save_journal(v_d.company_id, null, v_d.date,
      left(format('%s %s%s%s', v_m.label, v_num.doc_text, coalesce(' — ' || v_party, ''), coalesce(' — ' || v_d.description, '')), 500),
      null, v_lines, null);
    v_je := (v_saved->>'id')::uuid;
    update public.journal_entries set source = v_m.source::public.journal_source, source_id = p_id, doc_type = v_m.jcode,
      doc_no = v_num.doc_text, party = left(v_party, 200), pay_method = v_d.pay_method,
      txn_kind = case when v_m.uses_money then case when v_m.head_debit then 'IN' else 'OUT' end end
    where id = v_je;
    v_posted := public.post_journal(v_je);
    update public.stock_moves set journal_entry_id = v_je where trade_doc_id = p_id and journal_entry_id is null;
  end if;

  update public.trade_docs set status = 'POSTED', doc_no = v_num.doc_text, series_id = case when v_num.doc_seq is null then null else v_series.id end,
    doc_period = v_num.doc_period, doc_seq = v_num.doc_seq, journal_entry_id = v_je, bill_name = coalesce(bill_name, v_party),
    bill_address = coalesce(bill_address, nullif(concat_ws(E'\n', v_c.address, nullif(concat_ws(' ', v_c.postcode, v_c.city), ''), v_c.state), '')),
    posted_at = now(), posted_by = auth.uid()
  where id = p_id;

  if p_allocations is not null then
    perform public._apply_allocations(p_id, p_allocations);
  elsif v_m.effect = -1 and v_d.source_doc_id is not null then
    -- A credit note raised from an invoice settles that invoice.
    select * into v_src from public.trade_docs where id = v_d.source_doc_id;
    if v_src.status = 'POSTED' and v_src.contact_id = v_d.contact_id and v_src.control_account_id = v_d.control_account_id
       and (select effect from public._trade_meta(v_src.doc_type)) = 1 then
      v_auto := least(v_d.total, v_src.total - v_src.allocated);
      if v_auto > 0 then perform public._allocate(p_id, v_src.id, v_auto); end if;
    end if;
  end if;

  perform public._audit(v_d.company_id, 'trade.post', 'TradeDoc', p_id::text,
    format('Posted %s %s%s for %s', lower(v_m.label), v_num.doc_text, coalesce(' — ' || v_party, ''), to_char(v_d.total, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', p_id, 'status', 'POSTED', 'doc_no', v_num.doc_text, 'total', v_d.total,
                            'journal_id', v_je, 'reference', v_posted->>'reference');
end $$;

-- ─── Project RPCs ───────────────────────────────────────────────────────────
/** p_data: {code, name, contact_id?, start_date?, end_date?, status ACTIVE|CLOSED, notes?} */
create or replace function public.save_project(p_company uuid, p_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old public.projects; v_id uuid; v_code text := upper(btrim(coalesce(p_data->>'code', ''))); v_name text := btrim(coalesce(p_data->>'name', ''));
  v_contact uuid := public._try_uuid(p_data->>'contact_id'); v_start date; v_end date;
  v_status text := upper(coalesce(nullif(btrim(p_data->>'status'), ''), 'ACTIVE'));
begin
  perform public._require_perm(p_company, 'journal.create');
  if p_id is not null then
    select * into v_old from public.projects where id = p_id and company_id = p_company for update;
    if not found then raise exception 'NOT_FOUND: Project not found.'; end if;
  end if;
  if length(v_code) not between 1 and 30 then raise exception 'VALIDATION: Give the project a short code (up to 30 characters).'; end if;
  if length(v_name) not between 1 and 200 then raise exception 'VALIDATION: Name the project.'; end if;
  if v_status not in ('ACTIVE', 'CLOSED') then raise exception 'VALIDATION: A project is active or closed.'; end if;
  begin
    v_start := nullif(p_data->>'start_date', '')::date;
    v_end := nullif(p_data->>'end_date', '')::date;
  exception when others then raise exception 'VALIDATION: Check the start and end dates.';
  end;
  if v_start is not null and v_end is not null and v_end < v_start then raise exception 'VALIDATION: The end date can''t be before the start date.'; end if;
  if v_contact is not null and not exists (select 1 from public.contacts where id = v_contact and company_id = p_company) then
    raise exception 'VALIDATION: Customer not found in these books.';
  end if;
  if exists (select 1 from public.projects where company_id = p_company and lower(code) = lower(v_code) and id is distinct from p_id) then
    raise exception 'DUPLICATE: Project code % is already used.', v_code;
  end if;
  if p_id is null then
    insert into public.projects (company_id, code, name, contact_id, status, start_date, end_date, notes, created_by)
    values (p_company, v_code, left(v_name, 200), v_contact, v_status, v_start, v_end, left(nullif(btrim(p_data->>'notes'), ''), 1000), auth.uid())
    returning id into v_id;
  else
    update public.projects set code = v_code, name = left(v_name, 200), contact_id = v_contact, status = v_status,
      start_date = v_start, end_date = v_end, notes = left(nullif(btrim(p_data->>'notes'), ''), 1000)
    where id = p_id returning id into v_id;
  end if;
  perform public._audit(p_company, case when p_id is null then 'project.create' when v_old.status <> v_status then 'project.' || lower(case v_status when 'CLOSED' then 'close' else 'reopen' end) else 'project.update' end,
    'Project', v_id::text, format('%s project %s %s', case when p_id is null then 'Created' else 'Saved' end, v_code, v_name));
  return jsonb_build_object('id', v_id, 'code', v_code, 'status', v_status);
end $$;

/** Deletes a project nothing has been tagged with yet. */
create or replace function public.delete_project(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.projects;
begin
  select * into v from public.projects where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Project not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.delete');
  if exists (select 1 from public.journal_lines where project_id = p_id) or exists (select 1 from public.trade_doc_lines where project_id = p_id) then
    raise exception 'VALIDATION: % has documents or journals tagged to it. Close it instead.', v.code;
  end if;
  delete from public.projects where id = p_id;
  perform public._audit(v.company_id, 'project.delete', 'Project', p_id::text, format('Deleted project %s %s', v.code, v.name));
end $$;

/**
 * Profit and loss by project: every posted revenue and expense line in the dates (either may be null),
 * summed per project and account. Revenue is credit − debit; expenses debit − credit. Lines with no
 * project come back with project_id null ("Not in a project"), so the columns add up to the whole P&L.
 */
create or replace function public.project_pl(p_company uuid, p_from date default null, p_to date default null, p_project uuid default null)
returns table (project_id uuid, account_id uuid, code text, name text, type text, sub_type text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'report.view');
  return query
  select l.project_id, a.id, a.code, a.name, a.type::text, a.sub_type::text,
         sum(case when a.type = 'REVENUE' then l.credit - l.debit else l.debit - l.credit end)
    from public.journal_lines l
    join public.journal_entries e on e.id = l.journal_entry_id
    join public.accounts a on a.id = l.account_id
   where e.company_id = p_company and e.status <> 'DRAFT' and a.type in ('REVENUE', 'EXPENSE')
     and (p_from is null or e.date >= p_from) and (p_to is null or e.date <= p_to)
     and (p_project is null or l.project_id = p_project)
   group by l.project_id, a.id, a.code, a.name, a.type, a.sub_type
  having sum(l.debit - l.credit) <> 0
   order by a.code;
end $$;

revoke execute on function public.save_project(uuid, uuid, jsonb), public.delete_project(uuid),
  public.project_pl(uuid, date, date, uuid) from public, anon;
grant execute on function public.save_project(uuid, uuid, jsonb), public.delete_project(uuid),
  public.project_pl(uuid, date, date, uuid) to authenticated;
