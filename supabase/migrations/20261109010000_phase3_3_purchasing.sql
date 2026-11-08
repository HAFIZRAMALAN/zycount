-- Phase 3.3 — Purchasing: purchase order → goods received (GRN) → purchase invoice, three-way match.
--
-- Posting rules (docs/spec/04 §7):
--   Goods received (GRN)        Dr Inventory (stock items) / the PO line account (services)   Cr GRNI 2140
--                               at the PO price — net, plus SST that can't be claimed back
--   Purchase invoice, matched   Dr GRNI at the received value                                 Cr AP
--                               the price difference goes to Inventory for stock still on hand,
--                               to cost of sales for stock already sold, or to the expense account
-- Matching refuses: billing more than was received; receiving more than was ordered; a unit price
-- that differs from the order by more than the books' tolerance (default 0%) unless the person
-- confirms it. GRNs are stock documents (kind RECEIPT), so voiding and the stock card work as before;
-- a GRN that has been billed can't be voided until the invoice is.

alter table public.companies add column match_price_tolerance numeric(5,2) not null default 0
  check (match_price_tolerance between 0 and 100);

alter table public.stock_docs
  add column po_id uuid references public.trade_docs(id),
  add column contact_id uuid references public.contacts(id),
  add column reference text check (length(reference) <= 60);
create index stock_docs_po_idx on public.stock_docs(po_id);
create index stock_docs_contact_idx on public.stock_docs(contact_id);
alter table public.stock_docs drop constraint stock_docs_kind_check;
alter table public.stock_docs add constraint stock_docs_kind_check check (kind in ('ADJUSTMENT', 'COUNT', 'OPENING', 'TRANSFER', 'RECEIPT'));

alter table public.stock_moves drop constraint stock_moves_kind_check;
alter table public.stock_moves add constraint stock_moves_kind_check check (kind in ('PURCHASE', 'PURCHASE_RETURN', 'SALE', 'SALE_RETURN',
  'ADJUSTMENT', 'COUNT', 'OPENING', 'TRANSFER', 'VOID', 'RECEIPT', 'REVALUE'));
alter table public.stock_moves drop constraint stock_moves_qty_check;
alter table public.stock_moves add constraint stock_moves_qty_check check (qty <> 0 or kind in ('REVALUE', 'VOID'));

create table public.goods_receipt_lines (
  id           uuid primary key default gen_random_uuid(),
  stock_doc_id uuid not null references public.stock_docs(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  line_no      int not null,
  po_line_id   uuid not null references public.trade_doc_lines(id),
  item_id      uuid references public.items(id),
  description  text not null,
  qty          numeric(18,4) not null check (qty > 0),
  unit_cost    numeric(18,4) not null check (unit_cost >= 0),
  value        numeric(18,2) not null check (value >= 0),
  account_id   uuid not null references public.accounts(id),
  unique (stock_doc_id, line_no)
);
create index goods_receipt_lines_po_line_idx on public.goods_receipt_lines(po_line_id);
create index goods_receipt_lines_company_idx on public.goods_receipt_lines(company_id);
create index goods_receipt_lines_item_idx on public.goods_receipt_lines(item_id);
create index goods_receipt_lines_account_idx on public.goods_receipt_lines(account_id);
alter table public.goods_receipt_lines enable row level security;
create policy "goods receipt lines by permission" on public.goods_receipt_lines for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
revoke all on public.goods_receipt_lines from anon;
grant select on public.goods_receipt_lines to authenticated;

alter table public.trade_doc_lines
  add column grn_line_id uuid references public.goods_receipt_lines(id),
  add column grn_value numeric(18,2);   -- the GRNI this line cleared, set when its invoice posts
create index trade_doc_lines_grn_line_idx on public.trade_doc_lines(grn_line_id);
alter table public.trade_docs add column allow_price_variance boolean not null default false;

alter table public.journal_entries drop constraint journal_entries_doc_type_check;
alter table public.journal_entries add constraint journal_entries_doc_type_check
  check (doc_type in ('PV', 'OR', 'IV', 'CS', 'DN', 'CN', 'PI', 'CP', 'SDN', 'SCN', 'CT', 'SA', 'GRN'));

-- ─── Helpers ────────────────────────────────────────────────────────────────
create or replace function public._grni_account(p_company uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from public.accounts where company_id = p_company and code = '2140' and is_postable and is_active;
  if v is null then raise exception 'VALIDATION: These books need an active Goods Received Not Invoiced account (2140).'; end if;
  return v;
end $$;

/** A purchase-invoice line's link to goods received: same books, same supplier, receipt still posted. */
create or replace function public._grn_line_ok(p_company uuid, p_type text, p_contact uuid, p_text text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := public._try_uuid(p_text); v record;
begin
  if v_id is null then return null; end if;
  if p_type not in ('BILL', 'CASH_PURCHASE') then
    raise exception 'VALIDATION: Only purchase invoices and cash purchases can be matched to goods received.';
  end if;
  select g.id, s.status, s.contact_id, s.doc_no into v from public.goods_receipt_lines g join public.stock_docs s on s.id = g.stock_doc_id
   where g.id = v_id and g.company_id = p_company;
  if not found then raise exception 'VALIDATION: Goods-received line not found in these books.'; end if;
  if v.status <> 'POSTED' then raise exception 'VALIDATION: Goods received % is void.', v.doc_no; end if;
  if v.contact_id is distinct from p_contact then raise exception 'VALIDATION: Goods received % is from another supplier.', v.doc_no; end if;
  return v_id;
end $$;

/** Value of a GRN line already cleared by posted invoices (other than p_except). */
create or replace function public._grn_billed(p_grn_line uuid, p_except uuid default null)
returns table (qty numeric, value numeric) language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.qty), 0), coalesce(sum(l.grn_value), 0)
    from public.trade_doc_lines l join public.trade_docs d on d.id = l.doc_id
   where l.grn_line_id = p_grn_line and d.status = 'POSTED' and d.id is distinct from p_except;
$$;

/**
 * Called by _post_trade_doc for purchase invoices. Checks the three-way match and returns
 * {override: {line_id: GRNI}, extra: [price-difference journal lines]}.
 */
create or replace function public._match_on_post(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_d public.trade_docs; r record; v_tol numeric; v_grni uuid; v_b record; v_amt numeric; v_gval numeric; v_var numeric;
  v_unit numeric; v_on numeric; v_part numeric; v_over jsonb := '{}'::jsonb; v_extra jsonb := '[]'::jsonb;
begin
  select * into v_d from public.trade_docs where id = p_id;
  if v_d.doc_type not in ('BILL', 'CASH_PURCHASE') then return '{}'::jsonb; end if;
  if not exists (select 1 from public.trade_doc_lines where doc_id = p_id and grn_line_id is not null) then return '{}'::jsonb; end if;
  select match_price_tolerance into v_tol from public.companies where id = v_d.company_id;
  v_grni := public._grni_account(v_d.company_id);

  for r in
    select l.id, l.line_no, l.qty, l.amount, l.tax_amount, l.tax_code_id, t.purchase_account_id as tpa,
           g.id as gid, g.qty as g_qty, g.unit_cost, g.value as g_value, g.item_id, g.account_id as g_account,
           s.doc_no as grn_no, s.status as grn_status, s.warehouse_id, i.track_stock, i.inventory_account_id as inv, i.cogs_account_id as cogs
      from public.trade_doc_lines l
      join public.goods_receipt_lines g on g.id = l.grn_line_id
      join public.stock_docs s on s.id = g.stock_doc_id
      left join public.items i on i.id = g.item_id
      left join public.tax_codes t on t.id = l.tax_code_id
     where l.doc_id = p_id order by l.line_no
  loop
    perform 1 from public.goods_receipt_lines where id = r.gid for update;   -- one invoice at a time per received line
    if r.grn_status <> 'POSTED' then raise exception 'VALIDATION: Line %: goods received % is void.', r.line_no, r.grn_no; end if;
    select * into v_b from public._grn_billed(r.gid, p_id);
    if v_b.qty + r.qty > r.g_qty then
      raise exception 'MATCH: Line %: % received on %, % already invoiced — this invoices %. Invoice no more than was received.',
        r.line_no, trim_scale(r.g_qty), r.grn_no, trim_scale(v_b.qty), trim_scale(r.qty);
    end if;
    v_amt := r.amount + case when r.tax_code_id is not null and r.tpa is null then r.tax_amount else 0 end;
    v_unit := round(v_amt / r.qty, 4);
    if not v_d.allow_price_variance and r.unit_cost > 0 and abs(v_unit - r.unit_cost) * 100 > v_tol * r.unit_cost then
      raise exception 'PRICE_VARIANCE: Line %: invoiced at % a unit, received at % on % (% %%). Check the price, or confirm the difference.',
        r.line_no, to_char(v_unit, 'FM999,999,990.00'), to_char(r.unit_cost, 'FM999,999,990.00'), r.grn_no,
        case when v_unit > r.unit_cost then '+' else '' end || to_char((v_unit - r.unit_cost) * 100 / r.unit_cost, 'FM9990.0');
    end if;
    -- The received value this line clears; the last invoice takes what is left, so GRNI ends at exactly zero.
    v_gval := case when v_b.qty + r.qty = r.g_qty then r.g_value - v_b.value else round(r.unit_cost * r.qty, 2) end;
    update public.trade_doc_lines set grn_value = v_gval where id = r.id;
    v_over := v_over || jsonb_build_object(r.id::text, v_grni);
    v_var := v_amt - v_gval;
    if v_var <> 0 then
      v_extra := v_extra || public._jl(v_grni, -v_var, 'Price difference');
      if coalesce(r.track_stock, false) then
        select coalesce(qty, 0) into v_on from public.item_costs where item_id = r.item_id;
        v_part := case when coalesce(v_on, 0) >= r.qty then v_var when coalesce(v_on, 0) <= 0 then 0 else round(v_var * v_on / r.qty, 2) end;
        if v_part <> 0 then
          perform public._stock_move(v_d.company_id, r.item_id, r.warehouse_id, v_d.date, 0, v_part, 'REVALUE', p_id, r.id);
          v_extra := v_extra || public._jl(r.inv, v_part, 'Price difference — stock on hand');
        end if;
        if v_var - v_part <> 0 then v_extra := v_extra || public._jl(r.cogs, v_var - v_part, 'Price difference — stock already sold'); end if;
      else
        v_extra := v_extra || public._jl(r.g_account, v_var, 'Price difference');
      end if;
    end if;
  end loop;
  return jsonb_build_object('override', v_over, 'extra', v_extra);
end $$;

-- ─── Goods received ─────────────────────────────────────────────────────────
/** p_data: {po_id, date, warehouse_id, reference (delivery order no.), description, lines: [{po_line_id, qty}]} */
create or replace function public.post_goods_receipt(p_company uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_po public.trade_docs; v_date date; v_wh uuid; v_grni uuid; v_id uuid; v_no text; v_line jsonb; v_pl record; v_qty numeric;
  v_rec record; v_full numeric; v_unit numeric; v_val numeric; v_acc uuid; v_gl uuid; v_n int := 0; v_total numeric := 0;
  v_dr jsonb := '{}'::jsonb; v_lines jsonb := '[]'::jsonb; k text; v_je uuid; v_saved jsonb; v_posted jsonb; v_party text;
begin
  perform public._require_perm(p_company, 'journal.post');
  select * into v_po from public.trade_docs where id = public._try_uuid(p_data->>'po_id') and company_id = p_company for update;
  if not found or v_po.doc_type <> 'PURCHASE_ORDER' then raise exception 'VALIDATION: Choose the purchase order the goods came on.'; end if;
  if v_po.status <> 'POSTED' then raise exception 'VALIDATION: Issue purchase order % before receiving goods on it.', coalesce(v_po.doc_no, '(draft)'); end if;
  begin v_date := (p_data->>'date')::date; exception when others then raise exception 'VALIDATION: Choose a valid date.'; end;
  if v_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  if v_date < v_po.date then raise exception 'VALIDATION: Goods can''t arrive before the purchase order date.'; end if;
  v_wh := public._warehouse_ok(p_company, coalesce(public._try_uuid(p_data->>'warehouse_id'), v_po.warehouse_id));
  v_grni := public._grni_account(p_company);
  if jsonb_typeof(p_data->'lines') <> 'array' or jsonb_array_length(p_data->'lines') = 0 then raise exception 'VALIDATION: Enter what arrived.'; end if;
  select name into v_party from public.contacts where id = v_po.contact_id;

  v_no := public._next_number(p_company, 'GRN', extract(year from v_date)::int);
  insert into public.stock_docs (company_id, kind, doc_no, date, warehouse_id, description, created_by, po_id, contact_id, reference)
  values (p_company, 'RECEIPT', v_no, v_date, v_wh, left(nullif(btrim(p_data->>'description'), ''), 500), auth.uid(),
          v_po.id, v_po.contact_id, left(nullif(btrim(p_data->>'reference'), ''), 60))
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_data->'lines') loop
    begin v_qty := round((v_line->>'qty')::numeric, 4); exception when others then raise exception 'VALIDATION: Quantities must be numbers.'; end;
    continue when coalesce(v_qty, 0) = 0;
    select l.*, i.track_stock, i.inventory_account_id, t.purchase_account_id as tpa into v_pl
      from public.trade_doc_lines l left join public.items i on i.id = l.item_id left join public.tax_codes t on t.id = l.tax_code_id
     where l.id = public._try_uuid(v_line->>'po_line_id') and l.doc_id = v_po.id;
    if not found then raise exception 'VALIDATION: That line is not on purchase order %.', v_po.doc_no; end if;
    if v_qty < 0 then raise exception 'VALIDATION: Line %: the quantity received must be above zero.', v_pl.line_no; end if;
    select coalesce(sum(g.qty), 0) as qty, coalesce(sum(g.value), 0) as value into v_rec
      from public.goods_receipt_lines g join public.stock_docs s on s.id = g.stock_doc_id
     where g.po_line_id = v_pl.id and s.status = 'POSTED';
    if v_rec.qty + v_qty > v_pl.qty then
      raise exception 'MATCH: Line % (%): % ordered, % already received — % more is over the order.',
        v_pl.line_no, left(v_pl.description, 60), trim_scale(v_pl.qty), trim_scale(v_rec.qty), trim_scale(v_qty);
    end if;
    -- Cost at the order price: net of discount, plus SST that can't be claimed back.
    v_full := v_pl.amount + case when v_pl.tax_code_id is not null and v_pl.tpa is null then v_pl.tax_amount else 0 end;
    v_unit := round(v_full / v_pl.qty, 4);
    v_val := case when v_rec.qty + v_qty = v_pl.qty then v_full - v_rec.value else round(v_unit * v_qty, 2) end;
    v_acc := case when coalesce(v_pl.track_stock, false) then v_pl.inventory_account_id else v_pl.account_id end;
    if v_acc is null then raise exception 'VALIDATION: Line % of the purchase order has no account. Edit the order first.', v_pl.line_no; end if;
    v_n := v_n + 1;
    insert into public.goods_receipt_lines (stock_doc_id, company_id, line_no, po_line_id, item_id, description, qty, unit_cost, value, account_id)
    values (v_id, p_company, v_n, v_pl.id, v_pl.item_id, v_pl.description, v_qty, v_unit, v_val, v_acc) returning id into v_gl;
    if coalesce(v_pl.track_stock, false) then
      perform public._stock_move(p_company, v_pl.item_id, v_wh, v_date, v_qty, v_val, 'RECEIPT', null, v_gl, v_id);
    end if;
    v_dr := jsonb_set(v_dr, array[v_acc::text], to_jsonb(coalesce((v_dr->>v_acc::text)::numeric, 0) + v_val));
    v_total := v_total + v_val;
  end loop;
  if v_n = 0 then raise exception 'VALIDATION: Enter a quantity for at least one line.'; end if;

  if v_total > 0 then
    for k in select jsonb_object_keys(v_dr) loop
      if (v_dr->>k)::numeric <> 0 then v_lines := v_lines || public._jl(k::uuid, (v_dr->>k)::numeric, 'Goods received'); end if;
    end loop;
    v_lines := v_lines || public._jl(v_grni, -v_total, left(coalesce(v_party, 'Supplier'), 200));
    v_saved := public.save_journal(p_company, null, v_date,
      left(format('Goods received %s — %s — PO %s%s', v_no, coalesce(v_party, ''), v_po.doc_no,
                  coalesce(' — DO ' || nullif(btrim(p_data->>'reference'), ''), '')), 500), null, v_lines, null);
    v_je := (v_saved->>'id')::uuid;
    update public.journal_entries set source = 'INVENTORY', source_id = v_id, doc_type = 'GRN', doc_no = v_no, party = left(v_party, 200)
     where id = v_je;
    v_posted := public.post_journal(v_je);
    update public.stock_moves set journal_entry_id = v_je where stock_doc_id = v_id and journal_entry_id is null;
    update public.stock_docs set journal_entry_id = v_je where id = v_id;
  end if;
  perform public._audit(p_company, 'stock.receive', 'StockDoc', v_id::text,
    format('Received goods %s on PO %s from %s: %s line(s), value %s', v_no, v_po.doc_no, coalesce(v_party, '—'), v_n, to_char(v_total, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', v_id, 'doc_no', v_no, 'lines', v_n, 'value', v_total, 'journal_id', v_je, 'reference', v_posted->>'reference');
end $$;

/** What each purchase-order line has had received and invoiced. */
create or replace function public.po_progress(p_po uuid)
returns table (po_line_id uuid, line_no int, item_id uuid, description text, ordered numeric, received numeric, invoiced numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_c uuid;
begin
  select company_id into v_c from public.trade_docs where id = p_po;
  if v_c is null then raise exception 'NOT_FOUND: Purchase order not found.'; end if;
  perform public._require_perm(v_c, 'journal.view');
  return query
  select l.id, l.line_no, l.item_id, l.description, l.qty,
         coalesce((select sum(g.qty) from public.goods_receipt_lines g join public.stock_docs s on s.id = g.stock_doc_id
                    where g.po_line_id = l.id and s.status = 'POSTED'), 0),
         coalesce((select sum(b.qty) from public.goods_receipt_lines g join public.stock_docs s on s.id = g.stock_doc_id
                     join public.trade_doc_lines b on b.grn_line_id = g.id join public.trade_docs d on d.id = b.doc_id
                    where g.po_line_id = l.id and s.status = 'POSTED' and d.status = 'POSTED'), 0)
    from public.trade_doc_lines l where l.doc_id = p_po order by l.line_no;
end $$;

/** Goods received but not yet invoiced — the make-up of the GRNI balance. */
create or replace function public.grn_open_lines(p_company uuid, p_contact uuid default null, p_grn uuid default null)
returns table (grn_line_id uuid, grn_id uuid, grn_no text, grn_date date, po_id uuid, po_no text, contact_id uuid, contact_name text,
               item_id uuid, description text, account_id uuid, received numeric, invoiced numeric, open_qty numeric,
               unit_cost numeric, open_value numeric, tax_code_id uuid, uom text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'journal.view');
  return query
  select g.id, s.id, s.doc_no, s.date, s.po_id, po.doc_no, s.contact_id, c.name, g.item_id, g.description, g.account_id,
         g.qty, b.qty, g.qty - b.qty, g.unit_cost, g.value - b.value, pl.tax_code_id, pl.uom
    from public.goods_receipt_lines g
    join public.stock_docs s on s.id = g.stock_doc_id
    join public.trade_doc_lines pl on pl.id = g.po_line_id
    left join public.trade_docs po on po.id = s.po_id
    left join public.contacts c on c.id = s.contact_id
    cross join lateral public._grn_billed(g.id, null) b
   where g.company_id = p_company and s.status = 'POSTED' and g.qty - b.qty > 0
     and (p_contact is null or s.contact_id = p_contact) and (p_grn is null or s.id = p_grn)
   order by s.date, s.doc_no, g.line_no;
end $$;

/** GRNI in the ledger against goods received but not invoiced. */
create or replace function public.grni_check(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_acc uuid; v_gl numeric; v_open numeric;
begin
  perform public._require_perm(p_company, 'report.view');
  select id into v_acc from public.accounts where company_id = p_company and code = '2140';
  select coalesce(sum(l.credit - l.debit), 0) into v_gl from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
   where l.account_id = v_acc and e.status <> 'DRAFT';
  select coalesce(sum(g.value - b.value), 0) into v_open
    from public.goods_receipt_lines g join public.stock_docs s on s.id = g.stock_doc_id cross join lateral public._grn_billed(g.id, null) b
   where g.company_id = p_company and s.status = 'POSTED';
  return jsonb_build_object('gl_balance', v_gl, 'open_value', v_open, 'in_balance', v_gl = v_open);
end $$;

create or replace function public.set_match_tolerance(p_company uuid, p_percent numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'company.edit');
  if p_percent is null or p_percent < 0 or p_percent > 100 then raise exception 'VALIDATION: The tolerance is between 0 and 100%%.'; end if;
  update public.companies set match_price_tolerance = round(p_percent, 2) where id = p_company;
  perform public._audit(p_company, 'purchase.settings', 'Company', p_company::text, format('Price tolerance for invoice matching set to %s%%', round(p_percent, 2)));
end $$;

-- ─── Posting functions with the matching hooks (otherwise unchanged from phase3_2_inventory) ───
create or replace function public._stock_move(p_company uuid, p_item uuid, p_wh uuid, p_date date, p_qty numeric, p_value numeric,
  p_kind text, p_trade_doc uuid default null, p_line uuid default null, p_stock_doc uuid default null, p_reverses uuid default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_it public.items; v_ic public.item_costs; v_val numeric; v_bal numeric; v_neg boolean; v_wh text;
begin
  select * into v_it from public.items where id = p_item and company_id = p_company;
  if not found then raise exception 'VALIDATION: Item not found in these books.'; end if;
  if not v_it.track_stock then raise exception 'VALIDATION: % does not track stock.', v_it.code; end if;
  if p_qty = 0 and p_value is null then return 0; end if;   -- qty 0 with a value = revaluation
  insert into public.item_costs (item_id, company_id) values (p_item, p_company) on conflict (item_id) do nothing;
  select * into v_ic from public.item_costs where item_id = p_item for update;   -- one cost update at a time per item

  if p_value is not null then
    v_val := round(p_value, 2);
  elsif p_qty < 0 then
    if v_ic.qty + p_qty = 0 then v_val := -v_ic.value;                        -- the last unit takes what is left
    elsif v_ic.qty > 0 then v_val := -round(v_ic.value * (-p_qty) / v_ic.qty, 2);
    else v_val := -round(v_it.buy_price * (-p_qty), 2);                      -- nothing on hand: last buy price
    end if;
  else
    v_val := round(case when v_ic.qty > 0 then v_ic.value / v_ic.qty else v_it.buy_price end * p_qty, 2);
  end if;

  insert into public.stock_balances (item_id, warehouse_id, company_id) values (p_item, p_wh, p_company)
  on conflict (item_id, warehouse_id) do nothing;
  update public.stock_balances set qty = qty + p_qty where item_id = p_item and warehouse_id = p_wh returning qty into v_bal;
  if v_bal < 0 then
    select allow_negative_stock into v_neg from public.companies where id = p_company;
    if not v_neg then
      select name into v_wh from public.warehouses where id = p_wh;
      raise exception 'STOCK_SHORT: Not enough % (%) in %: % short. Receive or adjust stock first.',
        v_it.code, v_it.description, v_wh, trim_scale(-v_bal);
    end if;
  end if;
  update public.item_costs set qty = qty + p_qty, value = value + v_val, updated_at = now() where item_id = p_item;
  insert into public.stock_moves (company_id, item_id, warehouse_id, date, qty, value, kind, trade_doc_id, trade_line_id,
                                  stock_doc_id, reverses_id, created_by)
  values (p_company, p_item, p_wh, p_date, p_qty, v_val, p_kind, p_trade_doc, p_line, p_stock_doc, p_reverses, auth.uid());
  return v_val;
end $$;

create or replace function public._stock_on_post(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_d public.trade_docs; v_wh uuid; r record; v_val numeric; v_amt numeric;
  v_over jsonb := '{}'::jsonb; v_extra jsonb := '[]'::jsonb; v_inv jsonb := '{}'::jsonb; v_cogs jsonb := '{}'::jsonb; k text;
begin
  select * into v_d from public.trade_docs where id = p_id;
  if v_d.doc_type not in ('INVOICE', 'CASH_SALE', 'CREDIT_NOTE', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_CN') then return '{}'::jsonb; end if;
  if v_d.doc_type in ('CREDIT_NOTE', 'SUPPLIER_CN') and not v_d.stock_return then return '{}'::jsonb; end if;
  if not exists (select 1 from public.trade_doc_lines l join public.items i on i.id = l.item_id
                  where l.doc_id = p_id and i.track_stock and l.grn_line_id is null) then return '{}'::jsonb; end if;
  v_wh := public._warehouse_ok(v_d.company_id, v_d.warehouse_id);
  update public.trade_docs set warehouse_id = v_wh where id = p_id;

  for r in
    select l.id, l.line_no, l.qty, l.amount, l.tax_amount, i.id as item_id, i.code, i.inventory_account_id as inv,
           i.cogs_account_id as cogs, t.purchase_account_id as tpa, l.tax_code_id
      from public.trade_doc_lines l join public.items i on i.id = l.item_id and i.track_stock
      left join public.tax_codes t on t.id = l.tax_code_id
     where l.doc_id = p_id and l.grn_line_id is null order by l.line_no
  loop
    if r.inv is null or r.cogs is null then
      raise exception 'VALIDATION: Line %: item % needs an inventory and a cost-of-sales account.', r.line_no, r.code;
    end if;
    if v_d.doc_type in ('INVOICE', 'CASH_SALE') then
      v_val := public._stock_move(v_d.company_id, r.item_id, v_wh, v_d.date, -r.qty, null, 'SALE', p_id, r.id);
      v_cogs := jsonb_set(v_cogs, array[r.cogs::text], to_jsonb(coalesce((v_cogs->>r.cogs::text)::numeric, 0) - v_val));
      v_inv := jsonb_set(v_inv, array[r.inv::text], to_jsonb(coalesce((v_inv->>r.inv::text)::numeric, 0) + v_val));
    elsif v_d.doc_type = 'CREDIT_NOTE' then
      v_val := public._stock_move(v_d.company_id, r.item_id, v_wh, v_d.date, r.qty, null, 'SALE_RETURN', p_id, r.id);
      v_cogs := jsonb_set(v_cogs, array[r.cogs::text], to_jsonb(coalesce((v_cogs->>r.cogs::text)::numeric, 0) - v_val));
      v_inv := jsonb_set(v_inv, array[r.inv::text], to_jsonb(coalesce((v_inv->>r.inv::text)::numeric, 0) + v_val));
    else
      -- Purchases carry their own cost: the line net plus SST that can't be claimed back.
      v_amt := r.amount + case when r.tax_code_id is not null and r.tpa is null then r.tax_amount else 0 end;
      perform public._stock_move(v_d.company_id, r.item_id, v_wh, v_d.date,
        case when v_d.doc_type = 'SUPPLIER_CN' then -r.qty else r.qty end,
        case when v_d.doc_type = 'SUPPLIER_CN' then -v_amt else v_amt end,
        case when v_d.doc_type = 'SUPPLIER_CN' then 'PURCHASE_RETURN' else 'PURCHASE' end, p_id, r.id);
      v_over := v_over || jsonb_build_object(r.id::text, r.inv);
    end if;
  end loop;

  for k in select jsonb_object_keys(v_cogs) loop
    if (v_cogs->>k)::numeric <> 0 then v_extra := v_extra || public._jl(k::uuid, (v_cogs->>k)::numeric, 'Cost of goods sold'); end if;
  end loop;
  for k in select jsonb_object_keys(v_inv) loop
    if (v_inv->>k)::numeric <> 0 then v_extra := v_extra || public._jl(k::uuid, (v_inv->>k)::numeric, 'Inventory'); end if;
  end loop;
  return jsonb_build_object('override', v_over, 'extra', v_extra);
end $$;

create or replace function public._post_trade_doc(p_id uuid, p_series uuid, p_doc_no text, p_allocations jsonb, p_over_limit boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_d public.trade_docs; v_m record; v_c public.contacts; v_series public.document_series; v_num record; v_lines jsonb;
  v_head uuid; v_saved jsonb; v_je uuid; v_posted jsonb; v_bad record; v_bal numeric; v_charge_acc uuid; v_dup text;
  v_party text; v_src public.trade_docs; v_auto numeric; v_stock jsonb := '{}'::jsonb; v_match jsonb := '{}'::jsonb;
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
               'description', x.descr) order by x.ord), '[]'::jsonb)
        into v_lines
      from (
        select l.line_no as ord, coalesce(public._try_uuid(v_match->'override'->>l.id::text), public._try_uuid(v_stock->'override'->>l.id::text), l.account_id) as account_id,
               left(l.description, 200) as descr,
               l.amount + case when v_m.side = 'AP' and t.purchase_account_id is null then l.tax_amount else 0 end as amt
        from public.trade_doc_lines l left join public.tax_codes t on t.id = l.tax_code_id
        where l.doc_id = p_id
        union all
        select 100000 + row_number() over (order by g.acc), g.acc, g.descr, g.amt from (
          select case when v_m.side = 'AR' then t.sales_account_id else t.purchase_account_id end as acc,
                 'SST ' || string_agg(distinct t.code, ', ') as descr, sum(l.tax_amount) as amt
          from public.trade_doc_lines l join public.tax_codes t on t.id = l.tax_code_id
          where l.doc_id = p_id and l.tax_amount <> 0
            and (case when v_m.side = 'AR' then t.sales_account_id else t.purchase_account_id end) is not null
          group by 1) g) x;
      v_lines := v_lines || coalesce(v_stock->'extra', '[]'::jsonb) || coalesce(v_match->'extra', '[]'::jsonb);
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

create or replace function public.save_trade_doc(p_company uuid, p_id uuid, p_doc jsonb, p_lines jsonb default '[]'::jsonb,
                                                 p_post boolean default false, p_series uuid default null, p_doc_no text default null,
                                                 p_allocations jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.trade_docs; v_type text; v_m record; v_id uuid; v_contact public.contacts; v_date date; v_due date; v_terms int;
  v_line jsonb; v_no int := 0; v_qty numeric; v_price numeric; v_disc numeric; v_gross numeric; v_amt numeric; v_tax numeric;
  v_net numeric; v_tc public.tax_codes; v_item public.items; v_acc uuid; v_desc text; v_sub numeric := 0; v_taxt numeric := 0;
  v_tot numeric := 0; v_money uuid; v_control uuid; v_charge numeric := 0; v_incl boolean; v_rows jsonb := '[]'::jsonb;
  v_contact_id uuid; v_source uuid; v_what text; v_wh uuid; v_ret boolean;
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
        'total', v_net + v_tax, 'grn_line_id', public._grn_line_ok(p_company, v_type, v_contact_id, v_line->>'grn_line_id')));
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
                                      account_id, tax_code_id, tax_rate, amount, tax_amount, total, grn_line_id)
  select v_id, p_company, (r->>'line_no')::int, (r->>'item_id')::uuid, r->>'description', (r->>'qty')::numeric, r->>'uom',
         (r->>'unit_price')::numeric, (r->>'discount')::numeric, (r->>'account_id')::uuid, (r->>'tax_code_id')::uuid,
         (r->>'tax_rate')::numeric, (r->>'amount')::numeric, (r->>'tax_amount')::numeric, (r->>'total')::numeric, (r->>'grn_line_id')::uuid
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

create or replace function public.void_stock_doc(p_id uuid, p_date date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.stock_docs; v_date date; v_r jsonb;
begin
  select * into v from public.stock_docs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Stock document not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.reverse');
  if v.status <> 'POSTED' then raise exception 'INVALID_STATE: Only posted stock documents can be voided.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'VALIDATION: Give a reason for voiding.'; end if;
  v_date := coalesce(p_date, current_date);
  if v_date < v.date then raise exception 'VALIDATION: The void date cannot be before the document date.'; end if;
  if v.kind = 'RECEIPT' and exists (select 1 from public.goods_receipt_lines g join public.trade_doc_lines l on l.grn_line_id = g.id
                                     join public.trade_docs d on d.id = l.doc_id
                                    where g.stock_doc_id = p_id and d.status = 'POSTED') then
    raise exception 'VALIDATION: % has been billed. Void the purchase invoice first.', v.doc_no;
  end if;
  if v.journal_entry_id is not null then
    v_r := public.reverse_journal(v.journal_entry_id, v_date, format('Void %s: %s', v.doc_no, btrim(p_reason)));
  end if;
  perform public._stock_reverse(v.company_id, null, p_id, v_date, (v_r->>'id')::uuid);
  update public.stock_docs set status = 'VOID', void_date = v_date, void_reason = left(btrim(p_reason), 300),
    void_entry_id = (v_r->>'id')::uuid where id = p_id;
  perform public._audit(v.company_id, 'stock.void', 'StockDoc', p_id::text, format('Voided %s — %s', v.doc_no, btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'status', 'VOID', 'reversal', v_r->>'reference');
end $$;
-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function public._grni_account(uuid), public._grn_line_ok(uuid, text, uuid, text), public._grn_billed(uuid, uuid),
  public._match_on_post(uuid) from public, anon, authenticated;
revoke execute on function public.post_goods_receipt(uuid, jsonb), public.po_progress(uuid), public.grn_open_lines(uuid, uuid, uuid),
  public.grni_check(uuid), public.set_match_tolerance(uuid, numeric) from public, anon;
grant execute on function public.post_goods_receipt(uuid, jsonb), public.po_progress(uuid), public.grn_open_lines(uuid, uuid, uuid),
  public.grni_check(uuid), public.set_match_tolerance(uuid, numeric) to authenticated;
