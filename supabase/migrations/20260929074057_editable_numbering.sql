-- ═══════════════════════════════════════════════════════════════════════════
-- Every number can be keyed by hand. Series that numbered automatically now
-- suggest the next number and also accept one keyed by hand (AUTO_EDITABLE):
-- a keyed number must be unused and may not take a number the automatic
-- sequence will hand out later, so automatic numbering stays gap-free.
-- New series start this way too. A number keyed on a draft document is kept
-- with the draft until it is posted.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.document_series alter column mode set default 'AUTO_EDITABLE';
update public.document_series set mode = 'AUTO_EDITABLE', updated_at = now() where mode = 'AUTO';

alter table public.trade_docs
  add column draft_series_id uuid references public.document_series(id) on delete set null,
  add column draft_doc_no text check (draft_doc_no is null or length(draft_doc_no) between 1 and 40);
create index trade_docs_draft_series_idx on public.trade_docs(draft_series_id);

create or replace function public.save_trade_doc(p_company uuid, p_id uuid, p_doc jsonb, p_lines jsonb default '[]'::jsonb,
                                                 p_post boolean default false, p_series uuid default null, p_doc_no text default null,
                                                 p_allocations jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.trade_docs; v_type text; v_m record; v_id uuid; v_contact public.contacts; v_date date; v_due date; v_terms int;
  v_line jsonb; v_no int := 0; v_qty numeric; v_price numeric; v_disc numeric; v_gross numeric; v_amt numeric; v_tax numeric;
  v_net numeric; v_tc public.tax_codes; v_item public.items; v_acc uuid; v_desc text; v_sub numeric := 0; v_taxt numeric := 0;
  v_tot numeric := 0; v_money uuid; v_control uuid; v_charge numeric := 0; v_incl boolean; v_rows jsonb := '[]'::jsonb;
  v_contact_id uuid; v_source uuid; v_what text;
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
                        case v_m.side when 'AR' then v_item.sales_account_id else v_item.purchase_account_id end,
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
        'total', v_net + v_tax));
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
    source_doc_id = coalesce(v_source, v_old.source_doc_id)
  where id = v_id;
  delete from public.trade_doc_lines where doc_id = v_id;
  insert into public.trade_doc_lines (doc_id, company_id, line_no, item_id, description, qty, uom, unit_price, discount,
                                      account_id, tax_code_id, tax_rate, amount, tax_amount, total)
  select v_id, p_company, (r->>'line_no')::int, (r->>'item_id')::uuid, r->>'description', (r->>'qty')::numeric, r->>'uom',
         (r->>'unit_price')::numeric, (r->>'discount')::numeric, (r->>'account_id')::uuid, (r->>'tax_code_id')::uuid,
         (r->>'tax_rate')::numeric, (r->>'amount')::numeric, (r->>'tax_amount')::numeric, (r->>'total')::numeric
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

-- The draft-only fields may still be cleared on a posted or void document
-- (e.g. when an unused series is removed); everything else stays fixed.
create or replace function public._guard_trade_doc()
returns trigger language plpgsql set search_path = public as $$
declare
  v_free text[] := array['status', 'void_date', 'void_reason', 'void_entry_id', 'allocated', 'einvoice_status', 'einvoice_uuid', 'updated_at',
                         'draft_series_id', 'draft_doc_no'];
  v_void_free text[] := array['einvoice_status', 'einvoice_uuid', 'updated_at', 'draft_series_id', 'draft_doc_no'];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then raise exception 'IMMUTABLE: Posted documents are never deleted — void them instead.'; end if;
    return old;
  end if;
  if old.status = 'VOID' and (to_jsonb(new) - v_void_free) <> (to_jsonb(old) - v_void_free) then
    raise exception 'IMMUTABLE: A void document cannot be changed.';
  end if;
  if old.status = 'POSTED' then
    if new.status not in ('POSTED', 'VOID') or (to_jsonb(new) - v_free) <> (to_jsonb(old) - v_free) then
      raise exception 'IMMUTABLE: Posted documents cannot be edited — void it, or issue a credit or debit note.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public._guard_trade_doc() from public, anon, authenticated;

-- Posting a draft on its own uses the number and series kept with it.
create or replace function public.post_trade_doc(p_id uuid, p_series uuid default null, p_doc_no text default null,
                                                 p_allocations jsonb default null, p_allow_over_limit boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.trade_docs;
begin
  select * into v from public.trade_docs where id = p_id;
  return public._post_trade_doc(p_id, coalesce(p_series, v.draft_series_id), coalesce(nullif(btrim(p_doc_no), ''), v.draft_doc_no),
                                p_allocations, p_allow_over_limit);
end $$;
