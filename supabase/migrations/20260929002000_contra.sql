-- AR/AP contra: when a customer is also a supplier, what they owe us is set off against
-- what we owe them. One journal (Dr trade payables, Cr trade receivables) and a pair of
-- documents — one on the customer's ledger, one on the supplier's — sharing one CT number.
-- Each knocks off that party's open invoices or bills, so both statements and both
-- control accounts stay tied to the ledger.

-- ─── Document types ─────────────────────────────────────────────────────────
alter table public.trade_docs drop constraint trade_docs_doc_type_check;
alter table public.trade_docs add constraint trade_docs_doc_type_check check (doc_type in (
  'QUOTATION', 'INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'RECEIPT', 'REFUND',
  'PURCHASE_ORDER', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'SUPPLIER_CN', 'PAYMENT', 'SUPPLIER_REFUND',
  'AR_CONTRA', 'AP_CONTRA'));

alter table public.journal_entries drop constraint if exists journal_entries_doc_type_check;
alter table public.journal_entries add constraint journal_entries_doc_type_check
  check (doc_type in ('PV', 'OR', 'IV', 'CS', 'DN', 'CN', 'PI', 'CP', 'SDN', 'SCN', 'CT'));

-- The supplier-side half carries the same number as the customer-side half.
drop index if exists public.trade_docs_doc_no_uniq;
create unique index trade_docs_doc_no_uniq on public.trade_docs(company_id, lower(doc_no))
  where doc_no is not null and doc_type <> 'AP_CONTRA';

create or replace function public._trade_meta(p_type text)
returns table (side text, series_kind text, jcode text, label text, has_lines boolean, posts boolean,
               effect int, head_debit boolean, uses_money boolean, uses_control boolean, source text)
language sql immutable set search_path = public as $$
  select t.side, t.series_kind, t.jcode, t.label, t.has_lines, t.posts, t.effect, t.head_debit, t.uses_money, t.uses_control, t.source
  from (values
    ('QUOTATION',       'AR', 'QUOTATION',      null,  'Quotation',            true,  false,  0, null::boolean, false, false, null),
    ('INVOICE',         'AR', 'INVOICE',        'IV',  'Invoice',              true,  true,   1, true,  false, true,  'INVOICE'),
    ('CASH_SALE',       'AR', 'CASH_SALE',      'CS',  'Cash sale',            true,  true,   0, true,  true,  false, 'INVOICE'),
    ('DEBIT_NOTE',      'AR', 'DEBIT_NOTE',     'DN',  'Debit note',           true,  true,   1, true,  false, true,  'INVOICE'),
    ('CREDIT_NOTE',     'AR', 'CREDIT_NOTE',    'CN',  'Credit note',          true,  true,  -1, false, false, true,  'INVOICE'),
    ('RECEIPT',         'AR', 'RECEIPT',        'OR',  'Receipt',              false, true,  -1, true,  true,  true,  'PAYMENT'),
    ('REFUND',          'AR', 'PAYMENT',        'PV',  'Refund',               false, true,   1, false, true,  true,  'PAYMENT'),
    ('AR_CONTRA',       'AR', 'CONTRA',         'CT',  'Contra',               false, true,  -1, false, false, true,  'SYSTEM'),
    ('PURCHASE_ORDER',  'AP', 'PURCHASE_ORDER', null,  'Purchase order',       true,  false,  0, null,  false, false, null),
    ('BILL',            'AP', 'BILL',           'PI',  'Purchase invoice',     true,  true,   1, false, false, true,  'BILL'),
    ('CASH_PURCHASE',   'AP', 'CASH_PURCHASE',  'CP',  'Cash purchase',        true,  true,   0, false, true,  false, 'BILL'),
    ('SUPPLIER_DN',     'AP', 'SUPPLIER_DN',    'SDN', 'Supplier debit note',  true,  true,   1, false, false, true,  'BILL'),
    ('SUPPLIER_CN',     'AP', 'SUPPLIER_CN',    'SCN', 'Supplier credit note', true,  true,  -1, true,  false, true,  'BILL'),
    ('PAYMENT',         'AP', 'PAYMENT',        'PV',  'Payment',              false, true,  -1, false, true,  true,  'PAYMENT'),
    ('SUPPLIER_REFUND', 'AP', 'RECEIPT',        'OR',  'Supplier refund',      false, true,   1, true,  true,  true,  'PAYMENT'),
    ('AP_CONTRA',       'AP', 'CONTRA',         'CT',  'Contra',               false, true,  -1, true,  false, true,  'SYSTEM')
  ) as t(doc_type, side, series_kind, jcode, label, has_lines, posts, effect, head_debit, uses_money, uses_control, source)
  where t.doc_type = p_type;
$$;

-- ─── Numbering ──────────────────────────────────────────────────────────────
alter table public.document_series drop constraint document_series_kind_check;
alter table public.document_series add constraint document_series_kind_check check (kind in (
  'PAYMENT', 'RECEIPT', 'JOURNAL', 'QUOTATION', 'INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE',
  'PURCHASE_ORDER', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'SUPPLIER_CN', 'CONTRA'));

create or replace function public._series_label(p_kind text)
returns text language sql immutable set search_path = public as $$
  select case p_kind
    when 'PAYMENT' then 'payment voucher' when 'RECEIPT' then 'receipt' when 'JOURNAL' then 'journal'
    when 'QUOTATION' then 'quotation' when 'INVOICE' then 'invoice' when 'CASH_SALE' then 'cash sale'
    when 'DEBIT_NOTE' then 'debit note' when 'CREDIT_NOTE' then 'credit note' when 'PURCHASE_ORDER' then 'purchase order'
    when 'BILL' then 'purchase invoice' when 'CASH_PURCHASE' then 'cash purchase'
    when 'SUPPLIER_DN' then 'supplier debit note' when 'SUPPLIER_CN' then 'supplier credit note'
    when 'CONTRA' then 'contra'
    else lower(p_kind) end;
$$;

create or replace function public._seed_trade_setup(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_kind text; v_sst uuid;
begin
  select kind into v_kind from public.companies where id = p_company;
  if v_kind is distinct from 'BUSINESS' then return; end if;
  insert into public.document_series (company_id, kind, code, name, format, is_default)
  select p_company, s.kind, s.code, s.name, s.code || '-{YYYY}-{######}', true
  from (values ('QUOTATION', 'QT', 'Quotation'), ('INVOICE', 'IV', 'Sales invoice'), ('CASH_SALE', 'CS', 'Cash sale'),
               ('DEBIT_NOTE', 'DN', 'Debit note'), ('CREDIT_NOTE', 'CN', 'Credit note'),
               ('PURCHASE_ORDER', 'PO', 'Purchase order'), ('BILL', 'PI', 'Purchase invoice'), ('CASH_PURCHASE', 'CP', 'Cash purchase'),
               ('SUPPLIER_DN', 'SDN', 'Supplier debit note'), ('SUPPLIER_CN', 'SCN', 'Supplier credit note'),
               ('CONTRA', 'CT', 'Contra')) as s(kind, code, name)
  where not exists (select 1 from public.document_series x where x.company_id = p_company and x.kind = s.kind)
  on conflict (company_id, code) do nothing;

  update public.accounts set is_control = true where company_id = p_company and code in ('1150', '2110') and is_postable;

  select id into v_sst from public.accounts where company_id = p_company and code = '2150';
  insert into public.tax_codes (company_id, code, name, rate, sales_account_id)
  values (p_company, 'SV8', 'Service tax 8%', 8, v_sst), (p_company, 'SV6', 'Service tax 6%', 6, v_sst),
         (p_company, 'ST10', 'Sales tax 10%', 10, v_sst), (p_company, 'ST5', 'Sales tax 5%', 5, v_sst)
  on conflict (company_id, code) do nothing;
end $$;

insert into public.document_series (company_id, kind, code, name, format, is_default, mode)
select c.id, 'CONTRA', 'CT', 'Contra', 'CT-{YYYY}-{######}', true, 'AUTO_EDITABLE'
from public.companies c
where c.kind = 'BUSINESS' and not exists (select 1 from public.document_series x where x.company_id = c.id and x.kind = 'CONTRA')
on conflict (company_id, code) do nothing;

-- ─── Contras are only made and cancelled together ───────────────────────────
create or replace function public._guard_contra()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.doc_type in ('AR_CONTRA', 'AP_CONTRA') and coalesce(current_setting('zycount.contra', true), '') <> 'on'
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    raise exception 'VALIDATION: A contra is made and cancelled as a pair — use Contra on the customer or supplier.';
  end if;
  return new;
end $$;
create trigger trade_docs_contra_guard before insert or update on public.trade_docs
  for each row execute function public._guard_contra();

-- Knocks a settling document off the contact's oldest open items, up to p_amount.
create or replace function public._allocate_oldest(p_doc uuid, p_amount numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_d public.trade_docs; v_o record; v_left numeric := round(p_amount, 2); v_take numeric;
begin
  select * into v_d from public.trade_docs where id = p_doc;
  for v_o in
    select d.id, d.total - d.allocated as open_amt from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.contact_id = v_d.contact_id and d.side = v_d.side and d.control_account_id = v_d.control_account_id
      and d.status = 'POSTED' and m.effect = 1 and d.total > d.allocated
    order by coalesce(d.due_date, d.date), d.date, d.doc_no
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_o.open_amt);
    perform public._allocate(p_doc, v_o.id, v_take);
    v_left := v_left - v_take;
  end loop;
  return round(p_amount, 2) - v_left;
end $$;

-- ─── Post / void ────────────────────────────────────────────────────────────
create or replace function public.post_contra(p_company uuid, p_customer uuid, p_supplier uuid, p_date date, p_amount numeric,
                                              p_ar_allocations jsonb default null, p_ap_allocations jsonb default null,
                                              p_description text default null, p_series uuid default null, p_doc_no text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_cu public.contacts; v_su public.contacts; v_amt numeric := round(p_amount, 2); v_ar_ctl uuid; v_ap_ctl uuid;
  v_ar_open numeric; v_ap_open numeric; v_series public.document_series; v_num record; v_ar uuid; v_ap uuid;
  v_desc text; v_saved jsonb; v_je uuid; v_posted jsonb;
begin
  perform public._require_perm(p_company, 'journal.create');
  perform public._require_perm(p_company, 'journal.post');
  select * into v_cu from public.contacts where id = p_customer and company_id = p_company for update;
  if not found or v_cu.kind <> 'CUSTOMER' then raise exception 'VALIDATION: Choose the customer.'; end if;
  select * into v_su from public.contacts where id = p_supplier and company_id = p_company for update;
  if not found or v_su.kind <> 'SUPPLIER' then raise exception 'VALIDATION: Choose the supplier.'; end if;
  if not v_cu.is_active then raise exception 'VALIDATION: % is inactive.', v_cu.name; end if;
  if not v_su.is_active then raise exception 'VALIDATION: % is inactive.', v_su.name; end if;
  if p_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'VALIDATION: Enter the amount to set off.'; end if;

  v_ar_ctl := coalesce(v_cu.control_account_id, public._default_control(p_company, 'AR'));
  v_ap_ctl := coalesce(v_su.control_account_id, public._default_control(p_company, 'AP'));
  if v_ar_ctl is null or v_ap_ctl is null then
    raise exception 'VALIDATION: These books need both a trade receivables and a trade payables control account.';
  end if;

  -- Only what is actually open on each side can be set off.
  select coalesce(sum(d.total - d.allocated), 0) into v_ar_open from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
   where d.contact_id = p_customer and d.status = 'POSTED' and m.effect = 1 and d.control_account_id = v_ar_ctl and d.date <= p_date;
  select coalesce(sum(d.total - d.allocated), 0) into v_ap_open from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
   where d.contact_id = p_supplier and d.status = 'POSTED' and m.effect = 1 and d.control_account_id = v_ap_ctl and d.date <= p_date;
  if v_amt > v_ar_open then
    raise exception 'VALIDATION: % has only % open to set off on %.', v_cu.name, to_char(v_ar_open, 'FM999,999,999,990.00'), to_char(p_date, 'DD Mon YYYY');
  end if;
  if v_amt > v_ap_open then
    raise exception 'VALIDATION: You owe % only % on %.', v_su.name, to_char(v_ap_open, 'FM999,999,999,990.00'), to_char(p_date, 'DD Mon YYYY');
  end if;

  v_series := public._resolve_series(p_company, 'CONTRA', p_series, null);
  if v_series.id is null then raise exception 'VALIDATION: These books have no contra numbering series. Add one under Numbering.'; end if;
  select * into v_num from public._assign_number(v_series, p_date, p_doc_no, false);
  v_desc := left(coalesce(nullif(btrim(p_description), ''), format('Contra — %s / %s', v_cu.name, v_su.name)), 500);

  perform set_config('zycount.contra', 'on', true);
  insert into public.trade_docs (company_id, side, doc_type, contact_id, date, bill_name, description, subtotal, total,
                                 control_account_id, pay_method, created_by)
  values (p_company, 'AR', 'AR_CONTRA', p_customer, p_date, v_cu.name, v_desc, v_amt, v_amt, v_ar_ctl, 'Contra', auth.uid())
  returning id into v_ar;
  insert into public.trade_docs (company_id, side, doc_type, contact_id, date, bill_name, description, subtotal, total,
                                 control_account_id, pay_method, source_doc_id, created_by)
  values (p_company, 'AP', 'AP_CONTRA', p_supplier, p_date, v_su.name, v_desc, v_amt, v_amt, v_ap_ctl, 'Contra', v_ar, auth.uid())
  returning id into v_ap;
  update public.trade_docs set source_doc_id = v_ap where id = v_ar;

  v_saved := public.save_journal(p_company, null, p_date, left(format('Contra %s — %s', v_num.doc_text, v_desc), 500), null,
    jsonb_build_array(
      jsonb_build_object('account_id', v_ap_ctl, 'debit', v_amt, 'credit', 0, 'description', left(v_su.name, 200)),
      jsonb_build_object('account_id', v_ar_ctl, 'debit', 0, 'credit', v_amt, 'description', left(v_cu.name, 200))), null);
  v_je := (v_saved->>'id')::uuid;
  update public.journal_entries set source = 'SYSTEM', source_id = v_ar, doc_type = 'CT', doc_no = v_num.doc_text,
    party = left(v_cu.name || ' / ' || v_su.name, 200), pay_method = 'Contra'
  where id = v_je;
  v_posted := public.post_journal(v_je);

  update public.trade_docs set status = 'POSTED', doc_no = v_num.doc_text,
    series_id = case when v_num.doc_seq is null then null else v_series.id end, doc_period = v_num.doc_period, doc_seq = v_num.doc_seq,
    journal_entry_id = v_je, posted_at = now(), posted_by = auth.uid()
  where id = v_ar;
  update public.trade_docs set status = 'POSTED', doc_no = v_num.doc_text, journal_entry_id = v_je, posted_at = now(), posted_by = auth.uid()
  where id = v_ap;
  perform set_config('zycount.contra', '', true);

  -- Knock-off: as chosen, otherwise oldest first. Either way the whole contra is applied.
  if p_ar_allocations is not null and jsonb_array_length(p_ar_allocations) > 0 then perform public._apply_allocations(v_ar, p_ar_allocations); end if;
  if p_ap_allocations is not null and jsonb_array_length(p_ap_allocations) > 0 then perform public._apply_allocations(v_ap, p_ap_allocations); end if;
  perform public._allocate_oldest(v_ar, v_amt - (select allocated from public.trade_docs where id = v_ar));
  perform public._allocate_oldest(v_ap, v_amt - (select allocated from public.trade_docs where id = v_ap));

  perform public._audit(p_company, 'trade.post', 'TradeDoc', v_ar::text,
    format('Posted contra %s — %s set off between %s and %s', v_num.doc_text, to_char(v_amt, 'FM999,999,999,990.00'), v_cu.name, v_su.name));
  return jsonb_build_object('id', v_ar, 'ap_id', v_ap, 'doc_no', v_num.doc_text, 'total', v_amt, 'journal_id', v_je,
                            'reference', v_posted->>'reference');
end $$;

create or replace function public.void_contra(p_id uuid, p_date date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.trade_docs; v_pair uuid[]; v_a record; v_r jsonb; v_date date;
begin
  select * into v from public.trade_docs where id = p_id;
  if not found or v.doc_type not in ('AR_CONTRA', 'AP_CONTRA') then raise exception 'NOT_FOUND: Contra not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.reverse');
  v_pair := array[v.id, v.source_doc_id];
  perform 1 from public.trade_docs where id = any(v_pair) order by id for update;
  if v.status <> 'POSTED' then raise exception 'INVALID_STATE: Only posted contras can be voided.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'VALIDATION: Give a reason for voiding.'; end if;
  v_date := coalesce(p_date, current_date);
  if v_date < v.date then raise exception 'VALIDATION: The void date cannot be before the contra date.'; end if;

  for v_a in select * from public.trade_allocations where from_doc_id = any(v_pair) or to_doc_id = any(v_pair) loop
    update public.trade_docs set allocated = allocated - v_a.amount
     where id in (v_a.from_doc_id, v_a.to_doc_id) and not (id = any(v_pair));
    delete from public.trade_allocations where id = v_a.id;
  end loop;

  perform set_config('zycount.trade_void', 'on', true);
  v_r := public.reverse_journal(v.journal_entry_id, v_date, format('Void %s: %s', v.doc_no, btrim(p_reason)));
  perform set_config('zycount.trade_void', '', true);
  perform set_config('zycount.contra', 'on', true);
  update public.trade_docs set status = 'VOID', allocated = 0, void_date = v_date, void_reason = left(btrim(p_reason), 300),
    void_entry_id = (v_r->>'id')::uuid
  where id = any(v_pair);
  perform set_config('zycount.contra', '', true);
  perform public._audit(v.company_id, 'trade.void', 'TradeDoc', v.id::text, format('Voided contra %s — %s', v.doc_no, btrim(p_reason)));
  return jsonb_build_object('id', v.id, 'status', 'VOID', 'reversal', v_r->>'reference');
end $$;

-- void_trade_doc on one half would leave the other half posted; send it to void_contra.
create or replace function public.void_trade_doc(p_id uuid, p_date date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.trade_docs; v_m record; v_r jsonb; v_date date; v_a record;
begin
  select * into v from public.trade_docs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  if v.doc_type in ('AR_CONTRA', 'AP_CONTRA') then return public.void_contra(p_id, p_date, p_reason); end if;
  select * into v_m from public._trade_meta(v.doc_type);
  perform public._require_perm(v.company_id, case when v_m.posts then 'journal.reverse' else 'journal.create' end);
  if v.status <> 'POSTED' then raise exception 'INVALID_STATE: Only posted documents can be voided.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'VALIDATION: Give a reason for voiding.'; end if;
  v_date := coalesce(p_date, current_date);
  if v_date < v.date then raise exception 'VALIDATION: The void date cannot be before the document date.'; end if;

  for v_a in select * from public.trade_allocations where from_doc_id = p_id or to_doc_id = p_id loop
    update public.trade_docs set allocated = allocated - v_a.amount
     where id = case when v_a.from_doc_id = p_id then v_a.to_doc_id else v_a.from_doc_id end;
    delete from public.trade_allocations where id = v_a.id;
  end loop;

  if v.journal_entry_id is not null then
    perform set_config('zycount.trade_void', 'on', true);
    v_r := public.reverse_journal(v.journal_entry_id, v_date, format('Void %s: %s', v.doc_no, btrim(p_reason)));
    perform set_config('zycount.trade_void', '', true);
  end if;
  update public.trade_docs set status = 'VOID', allocated = 0, void_date = v_date, void_reason = left(btrim(p_reason), 300),
    void_entry_id = (v_r->>'id')::uuid
  where id = p_id;
  perform public._audit(v.company_id, 'trade.void', 'TradeDoc', p_id::text,
    format('Voided %s %s — %s', lower(v_m.label), v.doc_no, btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'status', 'VOID', 'reversal', v_r->>'reference');
end $$;

revoke execute on function public._guard_contra(), public._allocate_oldest(uuid, numeric) from public, anon, authenticated;
revoke execute on function public.post_contra(uuid, uuid, uuid, date, numeric, jsonb, jsonb, text, uuid, text),
  public.void_contra(uuid, date, text) from public, anon;
grant execute on function public.post_contra(uuid, uuid, uuid, date, numeric, jsonb, jsonb, text, uuid, text),
  public.void_contra(uuid, date, text) to authenticated;
