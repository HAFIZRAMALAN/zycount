-- Phase 3.2 — Perpetual inventory (weighted-average cost, warehouses).
--
-- Posting rules (docs/spec/04 §7):
--   Purchase invoice / cash purchase of a stock item  Dr Inventory      Cr AP / Bank   (cost = line net + non-claimable SST)
--   Supplier credit note, goods returned               Dr AP             Cr Inventory   (at the credit-note amount)
--   Invoice / cash sale of a stock item                Dr COGS           Cr Inventory   (at weighted-average cost)
--   Customer credit note, goods returned               Dr Inventory      Cr COGS        (at weighted-average cost)
--   Stock adjustment / count / opening stock           Dr/Cr Inventory   Cr/Dr the chosen account (default 5500)
--   Transfer between warehouses                        no journal — quantity moves, value stays
-- Average cost is per item across all warehouses and follows posting order.
-- Selling more than is on hand is refused unless the books allow negative stock.

-- ─── Settings and item fields ───────────────────────────────────────────────
alter table public.companies add column allow_negative_stock boolean not null default false;

alter table public.items
  add column track_stock boolean not null default false,
  add column inventory_account_id uuid references public.accounts(id),
  add column cogs_account_id uuid references public.accounts(id);
create index items_inventory_account_idx on public.items(inventory_account_id);
create index items_cogs_account_idx on public.items(cogs_account_id);

-- ─── Warehouses ─────────────────────────────────────────────────────────────
create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9._-]{1,20}$'),
  name        text not null check (length(btrim(name)) between 1 and 100),
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, code)
);
create unique index warehouses_one_default on public.warehouses(company_id) where is_default;

alter table public.trade_docs
  add column warehouse_id uuid references public.warehouses(id),
  add column stock_return boolean not null default true;   -- credit notes: were goods returned to stock?
create index trade_docs_warehouse_idx on public.trade_docs(warehouse_id);

-- ─── Stock documents (adjustment, count, opening, transfer) ─────────────────
create table public.stock_docs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  kind              text not null check (kind in ('ADJUSTMENT', 'COUNT', 'OPENING', 'TRANSFER')),
  doc_no            text not null,
  date              date not null,
  warehouse_id      uuid not null references public.warehouses(id),
  to_warehouse_id   uuid references public.warehouses(id),
  offset_account_id uuid references public.accounts(id),
  description       text check (length(description) <= 500),
  status            text not null default 'POSTED' check (status in ('POSTED', 'VOID')),
  journal_entry_id  uuid references public.journal_entries(id),
  void_entry_id     uuid references public.journal_entries(id),
  void_date         date,
  void_reason       text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  unique (company_id, doc_no)
);
create index stock_docs_company_idx on public.stock_docs(company_id, date desc);
create index stock_docs_warehouse_idx on public.stock_docs(warehouse_id);
create index stock_docs_to_warehouse_idx on public.stock_docs(to_warehouse_id);
create index stock_docs_offset_idx on public.stock_docs(offset_account_id);
create index stock_docs_journal_idx on public.stock_docs(journal_entry_id);
create index stock_docs_void_entry_idx on public.stock_docs(void_entry_id);

-- ─── The stock ledger: one row per movement, never changed ──────────────────
create table public.stock_moves (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  item_id          uuid not null references public.items(id),
  warehouse_id     uuid not null references public.warehouses(id),
  date             date not null,
  qty              numeric(18,4) not null check (qty <> 0),
  value            numeric(18,2) not null,          -- signed with qty: in > 0, out < 0
  kind             text not null check (kind in ('PURCHASE', 'PURCHASE_RETURN', 'SALE', 'SALE_RETURN',
                                                 'ADJUSTMENT', 'COUNT', 'OPENING', 'TRANSFER', 'VOID')),
  trade_doc_id     uuid references public.trade_docs(id),
  trade_line_id    uuid,
  stock_doc_id     uuid references public.stock_docs(id),
  reverses_id      uuid unique references public.stock_moves(id),
  journal_entry_id uuid references public.journal_entries(id),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  seq              bigint generated always as identity
);
create index stock_moves_item_idx on public.stock_moves(item_id, seq);
create index stock_moves_company_idx on public.stock_moves(company_id, date);
create index stock_moves_warehouse_idx on public.stock_moves(warehouse_id);
create index stock_moves_trade_doc_idx on public.stock_moves(trade_doc_id);
create index stock_moves_stock_doc_idx on public.stock_moves(stock_doc_id);
create index stock_moves_journal_idx on public.stock_moves(journal_entry_id);

-- Running balances, kept in step with stock_moves by _stock_move().
create table public.item_costs (
  item_id    uuid primary key references public.items(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  qty        numeric(18,4) not null default 0,
  value      numeric(18,2) not null default 0,
  updated_at timestamptz not null default now()
);
create index item_costs_company_idx on public.item_costs(company_id);
create table public.stock_balances (
  item_id      uuid not null references public.items(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  company_id   uuid not null references public.companies(id) on delete cascade,
  qty          numeric(18,4) not null default 0,
  primary key (item_id, warehouse_id)
);
create index stock_balances_company_idx on public.stock_balances(company_id);
create index stock_balances_warehouse_idx on public.stock_balances(warehouse_id);

create or replace function public._guard_stock_move() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.journal_entry_id is distinct from old.journal_entry_id and old.journal_entry_id is null
     and (new.qty, new.value, new.item_id, new.warehouse_id) = (old.qty, old.value, old.item_id, old.warehouse_id) then
    return new;   -- the journal is linked once, right after it is posted
  end if;
  raise exception 'IMMUTABLE: Stock movements cannot be changed or deleted — void the document instead.';
end $$;
create trigger stock_moves_guard before update or delete on public.stock_moves
  for each row execute function public._guard_stock_move();

alter table public.warehouses enable row level security;
alter table public.stock_docs enable row level security;
alter table public.stock_moves enable row level security;
alter table public.item_costs enable row level security;
alter table public.stock_balances enable row level security;
create policy "warehouses by permission" on public.warehouses for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "stock documents by permission" on public.stock_docs for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "stock moves by permission" on public.stock_moves for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "item costs by permission" on public.item_costs for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "stock balances by permission" on public.stock_balances for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
revoke all on public.warehouses, public.stock_docs, public.stock_moves, public.item_costs, public.stock_balances from anon;
grant select on public.warehouses, public.stock_docs, public.stock_moves, public.item_costs, public.stock_balances to authenticated;

alter table public.journal_entries drop constraint journal_entries_doc_type_check;
alter table public.journal_entries add constraint journal_entries_doc_type_check
  check (doc_type in ('PV', 'OR', 'IV', 'CS', 'DN', 'CN', 'PI', 'CP', 'SDN', 'SCN', 'CT', 'SA'));

-- ─── Core ───────────────────────────────────────────────────────────────────
create or replace function public._default_warehouse(p_company uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from public.warehouses where company_id = p_company and is_default;
  if v is null then
    insert into public.warehouses (company_id, code, name, is_default) values (p_company, 'MAIN', 'Main store', true)
    on conflict (company_id, code) do update set is_default = true
    returning id into v;
  end if;
  return v;
end $$;

create or replace function public._warehouse_ok(p_company uuid, p_wh uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v public.warehouses;
begin
  if p_wh is null then return public._default_warehouse(p_company); end if;
  select * into v from public.warehouses where id = p_wh and company_id = p_company;
  if not found then raise exception 'VALIDATION: Warehouse not found in these books.'; end if;
  if not v.is_active then raise exception 'VALIDATION: Warehouse % is inactive.', v.name; end if;
  return v.id;
end $$;

/** One stock movement. p_value null = at weighted-average cost. Returns the signed value used. */
create or replace function public._stock_move(p_company uuid, p_item uuid, p_wh uuid, p_date date, p_qty numeric, p_value numeric,
  p_kind text, p_trade_doc uuid default null, p_line uuid default null, p_stock_doc uuid default null, p_reverses uuid default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_it public.items; v_ic public.item_costs; v_val numeric; v_bal numeric; v_neg boolean; v_wh text;
begin
  select * into v_it from public.items where id = p_item and company_id = p_company;
  if not found then raise exception 'VALIDATION: Item not found in these books.'; end if;
  if not v_it.track_stock then raise exception 'VALIDATION: % does not track stock.', v_it.code; end if;
  if p_qty = 0 then return 0; end if;
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

/** Journal line for a signed amount: > 0 debit, < 0 credit. */
create or replace function public._jl(p_account uuid, p_amount numeric, p_desc text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('account_id', p_account,
    'debit', case when p_amount > 0 then p_amount else 0 end,
    'credit', case when p_amount < 0 then -p_amount else 0 end, 'description', left(p_desc, 200));
$$;

/**
 * Called by _post_trade_doc for documents with lines. Records the stock
 * movements and returns {override: {line_id: inventory account}, extra: [journal lines]}.
 */
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
                  where l.doc_id = p_id and i.track_stock) then return '{}'::jsonb; end if;
  v_wh := public._warehouse_ok(v_d.company_id, v_d.warehouse_id);
  update public.trade_docs set warehouse_id = v_wh where id = p_id;

  for r in
    select l.id, l.line_no, l.qty, l.amount, l.tax_amount, i.id as item_id, i.code, i.inventory_account_id as inv,
           i.cogs_account_id as cogs, t.purchase_account_id as tpa, l.tax_code_id
      from public.trade_doc_lines l join public.items i on i.id = l.item_id and i.track_stock
      left join public.tax_codes t on t.id = l.tax_code_id
     where l.doc_id = p_id order by l.line_no
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

/** Reverses every movement of a document (trade or stock) on void. */
create or replace function public._stock_reverse(p_company uuid, p_trade_doc uuid, p_stock_doc uuid, p_date date, p_journal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.stock_moves;
begin
  for m in select * from public.stock_moves s
            where s.company_id = p_company and s.kind <> 'VOID'
              and ((p_trade_doc is not null and s.trade_doc_id = p_trade_doc) or (p_stock_doc is not null and s.stock_doc_id = p_stock_doc))
              and not exists (select 1 from public.stock_moves x where x.reverses_id = s.id)
            order by s.seq desc
  loop
    perform public._stock_move(p_company, m.item_id, m.warehouse_id, p_date, -m.qty, -m.value, 'VOID',
                               m.trade_doc_id, m.trade_line_id, m.stock_doc_id, m.id);
  end loop;
  if p_journal is not null then
    update public.stock_moves set journal_entry_id = p_journal
     where company_id = p_company and kind = 'VOID' and journal_entry_id is null
       and ((p_trade_doc is not null and trade_doc_id = p_trade_doc) or (p_stock_doc is not null and stock_doc_id = p_stock_doc));
  end if;
end $$;

-- ─── Trade documents: post, void, save (stock hooks added) ──────────────────
create or replace function public._post_trade_doc(p_id uuid, p_series uuid, p_doc_no text, p_allocations jsonb, p_over_limit boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_d public.trade_docs; v_m record; v_c public.contacts; v_series public.document_series; v_num record; v_lines jsonb;
  v_head uuid; v_saved jsonb; v_je uuid; v_posted jsonb; v_bad record; v_bal numeric; v_charge_acc uuid; v_dup text;
  v_party text; v_src public.trade_docs; v_auto numeric; v_stock jsonb := '{}'::jsonb;
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
      v_lines := jsonb_build_array(jsonb_build_object('account_id', v_head,
        'debit', case when v_m.head_debit then v_d.total else 0 end, 'credit', case when v_m.head_debit then 0 else v_d.total end,
        'description', left(coalesce(v_party, v_m.label), 200)));
      select v_lines || coalesce(jsonb_agg(jsonb_build_object('account_id', x.account_id,
               'debit', case when v_m.head_debit then 0 else x.amt end, 'credit', case when v_m.head_debit then x.amt else 0 end,
               'description', x.descr) order by x.ord), '[]'::jsonb)
        into v_lines
      from (
        select l.line_no as ord, coalesce(public._try_uuid(v_stock->'override'->>l.id::text), l.account_id) as account_id,
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
      v_lines := v_lines || coalesce(v_stock->'extra', '[]'::jsonb);
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
  -- Stock comes back (or goes out again) at exactly the value it moved at.
  perform public._stock_reverse(v.company_id, p_id, null, v_date, (v_r->>'id')::uuid);
  update public.trade_docs set status = 'VOID', allocated = 0, void_date = v_date, void_reason = left(btrim(p_reason), 300),
    void_entry_id = (v_r->>'id')::uuid
  where id = p_id;
  perform public._audit(v.company_id, 'trade.void', 'TradeDoc', p_id::text,
    format('Voided %s %s — %s', lower(v_m.label), v.doc_no, btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'status', 'VOID', 'reversal', v_r->>'reference');
end $$;

-- save_trade_doc: unchanged except warehouse_id, stock_return and the inventory account default for stock items.
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
    source_doc_id = coalesce(v_source, v_old.source_doc_id),
    warehouse_id = coalesce(v_wh, v_old.warehouse_id), stock_return = v_ret
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

-- ─── Items: stock tracking ──────────────────────────────────────────────────
create or replace function public.save_item(p_company uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_code text := upper(btrim(coalesce(p_data->>'code', ''))); v_desc text := btrim(coalesce(p_data->>'description', ''));
  v_sa uuid := public._try_uuid(p_data->>'sales_account_id'); v_pa uuid := public._try_uuid(p_data->>'purchase_account_id');
  v_st uuid := public._try_uuid(p_data->>'sales_tax_code_id'); v_pt uuid := public._try_uuid(p_data->>'purchase_tax_code_id');
  v_sell numeric; v_buy numeric; v_class text := nullif(btrim(coalesce(p_data->>'classification', '')), '');
  v_old public.items; v_track boolean; v_inv uuid := public._try_uuid(p_data->>'inventory_account_id');
  v_cogs uuid := public._try_uuid(p_data->>'cogs_account_id');
begin
  perform public._require_perm(p_company, 'journal.create');
  if p_id is not null then
    select * into v_old from public.items where id = p_id and company_id = p_company;
    if not found then raise exception 'NOT_FOUND: Item not found.'; end if;
  end if;
  if v_code !~ '^[A-Z0-9./_-]{1,30}$' then raise exception 'VALIDATION: The item code is up to 30 letters, numbers and . / _ -'; end if;
  if length(v_desc) not between 1 and 200 then raise exception 'VALIDATION: Describe the item.'; end if;
  if exists (select 1 from public.items where company_id = p_company and code = v_code and id is distinct from p_id) then
    raise exception 'DUPLICATE: Item code % is already used.', v_code;
  end if;
  begin
    v_sell := round(coalesce(nullif(p_data->>'sell_price', '')::numeric, 0), 4);
    v_buy := round(coalesce(nullif(p_data->>'buy_price', '')::numeric, 0), 4);
  exception when others then raise exception 'VALIDATION: Prices must be numbers.';
  end;
  if v_sell < 0 or v_buy < 0 then raise exception 'VALIDATION: Prices cannot be negative.'; end if;
  if v_class is not null and v_class !~ '^[0-9]{3}$' then raise exception 'VALIDATION: The e-Invoice classification is a 3-digit code, such as 022.'; end if;

  -- Stock tracking. Once an item has movements it stays tracked, so its history and value stay whole.
  v_track := coalesce((p_data->>'track_stock')::boolean, v_old.track_stock, false);
  if v_old.track_stock and not v_track and exists (select 1 from public.stock_moves where item_id = p_id) then
    raise exception 'VALIDATION: % has stock movements, so it keeps tracking stock. Make it inactive instead.', v_code;
  end if;
  if v_track then
    v_inv := coalesce(v_inv, v_old.inventory_account_id,
      (select id from public.accounts where company_id = p_company and code = '1170' and is_postable and is_active));
    v_cogs := coalesce(v_cogs, v_old.cogs_account_id,
      (select id from public.accounts where company_id = p_company and code = '5100' and is_postable and is_active));
    if v_inv is null then raise exception 'VALIDATION: Choose the inventory account for this stock item.'; end if;
    if v_cogs is null then raise exception 'VALIDATION: Choose the cost-of-sales account for this stock item.'; end if;
    perform public._check_line_account(p_company, v_inv, 'Inventory account');
    perform public._check_line_account(p_company, v_cogs, 'Cost of sales account');
    if v_old.inventory_account_id is not null and v_inv <> v_old.inventory_account_id
       and exists (select 1 from public.item_costs where item_id = p_id and (qty <> 0 or value <> 0)) then
      raise exception 'VALIDATION: % has stock on hand, so its inventory account can''t change. Adjust its stock to zero first.', v_code;
    end if;
    v_pa := coalesce(v_pa, v_inv);   -- purchases of a stock item go to inventory
  else
    v_inv := null; v_cogs := null;
  end if;

  if v_sa is not null then perform public._check_line_account(p_company, v_sa, 'Sales account'); end if;
  if v_pa is not null then perform public._check_line_account(p_company, v_pa, 'Purchase account'); end if;
  if (v_st is not null and not exists (select 1 from public.tax_codes where id = v_st and company_id = p_company))
     or (v_pt is not null and not exists (select 1 from public.tax_codes where id = v_pt and company_id = p_company)) then
    raise exception 'VALIDATION: Tax code not found.';
  end if;
  if p_id is null then
    insert into public.items (company_id, code, description, uom, sell_price, buy_price, sales_account_id, purchase_account_id,
                              sales_tax_code_id, purchase_tax_code_id, classification, is_active,
                              track_stock, inventory_account_id, cogs_account_id)
    values (p_company, v_code, v_desc, coalesce(nullif(upper(btrim(p_data->>'uom')), ''), 'UNIT'), v_sell, v_buy, v_sa, v_pa, v_st, v_pt,
            v_class, coalesce((p_data->>'is_active')::boolean, true), v_track, v_inv, v_cogs)
    returning id into v_id;
  else
    update public.items set code = v_code, description = v_desc, uom = coalesce(nullif(upper(btrim(p_data->>'uom')), ''), 'UNIT'),
      sell_price = v_sell, buy_price = v_buy, sales_account_id = v_sa, purchase_account_id = v_pa, sales_tax_code_id = v_st,
      purchase_tax_code_id = v_pt, classification = v_class, is_active = coalesce((p_data->>'is_active')::boolean, true),
      track_stock = v_track, inventory_account_id = v_inv, cogs_account_id = v_cogs, updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;
  perform public._audit(p_company, 'item.save', 'Item', v_id::text, format('%s item %s (%s)%s', case when p_id is null then 'Added' else 'Updated' end,
    v_desc, v_code, case when v_track then ' — tracks stock' else '' end));
  return v_id;
end $$;

-- ─── Warehouses and settings ────────────────────────────────────────────────
create or replace function public.save_warehouse(p_company uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text := upper(btrim(coalesce(p_data->>'code', ''))); v_name text := btrim(coalesce(p_data->>'name', ''));
  v_active boolean := coalesce((p_data->>'is_active')::boolean, true); v_def boolean := coalesce((p_data->>'is_default')::boolean, false);
begin
  perform public._require_perm(p_company, 'company.edit');
  perform public._default_warehouse(p_company);   -- every set of books has one
  if p_id is not null and not exists (select 1 from public.warehouses where id = p_id and company_id = p_company) then
    raise exception 'NOT_FOUND: Warehouse not found.';
  end if;
  if v_code !~ '^[A-Z0-9._-]{1,20}$' then raise exception 'VALIDATION: The warehouse code is up to 20 letters, numbers and . _ -'; end if;
  if length(v_name) not between 1 and 100 then raise exception 'VALIDATION: Name the warehouse.'; end if;
  if exists (select 1 from public.warehouses where company_id = p_company and code = v_code and id is distinct from p_id) then
    raise exception 'DUPLICATE: Warehouse code % is already used.', v_code;
  end if;
  if not v_active and p_id is not null and exists (select 1 from public.stock_balances where warehouse_id = p_id and qty <> 0) then
    raise exception 'VALIDATION: This warehouse still holds stock. Transfer it out before making the warehouse inactive.';
  end if;
  if not v_active and v_def then raise exception 'VALIDATION: The default warehouse must stay active.'; end if;
  if v_def then update public.warehouses set is_default = false where company_id = p_company and is_default and id is distinct from p_id; end if;
  if p_id is null then
    insert into public.warehouses (company_id, code, name, is_default, is_active) values (p_company, v_code, left(v_name, 100), v_def, v_active)
    returning id into v_id;
  else
    if not v_def and exists (select 1 from public.warehouses where id = p_id and is_default) then
      raise exception 'VALIDATION: Choose another warehouse as the default first.';
    end if;
    update public.warehouses set code = v_code, name = left(v_name, 100), is_default = v_def, is_active = v_active where id = p_id;
    v_id := p_id;
  end if;
  perform public._audit(p_company, 'warehouse.save', 'Warehouse', v_id::text, format('Saved warehouse %s (%s)', v_name, v_code));
  return v_id;
end $$;

/** The books' default warehouse, created the first time stock screens open. Safe to call any number of times. */
create or replace function public.ensure_warehouse(p_company uuid)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'journal.view');
  return public._default_warehouse(p_company);
end $$;

create or replace function public.set_stock_settings(p_company uuid, p_allow_negative boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'company.edit');
  update public.companies set allow_negative_stock = coalesce(p_allow_negative, false) where id = p_company;
  perform public._audit(p_company, 'stock.settings', 'Company', p_company::text,
    case when p_allow_negative then 'Allowed selling below zero stock' else 'Refuse selling below zero stock' end);
end $$;

-- ─── Stock documents ────────────────────────────────────────────────────────
/**
 * Adjustment, opening stock or count. p_data: {kind, date, warehouse_id, offset_account_id, description,
 * lines: [{item_id, qty (+/-) | counted, unit_cost?}]}. Increases without a unit cost come in at average cost.
 */
create or replace function public.post_stock_adjustment(p_company uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind text := upper(coalesce(p_data->>'kind', 'ADJUSTMENT')); v_date date; v_wh uuid; v_off uuid; v_id uuid; v_no text;
  v_line jsonb; v_item public.items; v_qty numeric; v_cost numeric; v_val numeric; v_have numeric; v_n int := 0;
  v_inv jsonb := '{}'::jsonb; v_lines jsonb := '[]'::jsonb; v_total numeric := 0; k text; v_je uuid; v_saved jsonb; v_posted jsonb;
  v_desc text := left(nullif(btrim(p_data->>'description'), ''), 500);
begin
  perform public._require_perm(p_company, 'journal.post');
  if v_kind not in ('ADJUSTMENT', 'COUNT', 'OPENING') then raise exception 'VALIDATION: Unknown stock document.'; end if;
  begin v_date := (p_data->>'date')::date; exception when others then raise exception 'VALIDATION: Choose a valid date.'; end;
  if v_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  v_wh := public._warehouse_ok(p_company, public._try_uuid(p_data->>'warehouse_id'));
  v_off := public._try_uuid(p_data->>'offset_account_id');
  if v_off is null then
    select id into v_off from public.accounts where company_id = p_company and is_postable and is_active
       and code = case when v_kind = 'OPENING' then '3200' else '5500' end;
  end if;
  if v_off is null then raise exception 'VALIDATION: Choose the account for the other side of the entry.'; end if;
  perform public._check_line_account(p_company, v_off, 'Offset account');
  if jsonb_typeof(p_data->'lines') <> 'array' or jsonb_array_length(p_data->'lines') = 0 then
    raise exception 'VALIDATION: Add at least one item.';
  end if;
  if jsonb_array_length(p_data->'lines') > 500 then raise exception 'VALIDATION: At most 500 items at a time.'; end if;

  v_no := public._next_number(p_company, 'SA', extract(year from v_date)::int);
  insert into public.stock_docs (company_id, kind, doc_no, date, warehouse_id, offset_account_id, description, created_by)
  values (p_company, v_kind, v_no, v_date, v_wh, v_off, v_desc, auth.uid()) returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_data->'lines') loop
    select * into v_item from public.items where id = public._try_uuid(v_line->>'item_id') and company_id = p_company;
    if not found then raise exception 'VALIDATION: Item % not found.', v_n + 1; end if;
    if not v_item.track_stock then raise exception 'VALIDATION: % does not track stock.', v_item.code; end if;
    begin
      if v_kind = 'COUNT' then
        select coalesce(qty, 0) into v_have from public.stock_balances where item_id = v_item.id and warehouse_id = v_wh;
        v_qty := round((v_line->>'counted')::numeric, 4) - coalesce(v_have, 0);
        if (v_line->>'counted')::numeric < 0 then raise exception 'VALIDATION: % : a count cannot be below zero.', v_item.code; end if;
      else
        v_qty := round((v_line->>'qty')::numeric, 4);
      end if;
      v_cost := nullif(v_line->>'unit_cost', '')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'VALIDATION: %: quantity and cost must be numbers.', v_item.code;
    end;
    if v_qty is null then raise exception 'VALIDATION: %: enter a quantity.', v_item.code; end if;
    if v_cost is not null and v_cost < 0 then raise exception 'VALIDATION: %: cost cannot be negative.', v_item.code; end if;
    continue when v_qty = 0;
    v_n := v_n + 1;
    v_val := public._stock_move(p_company, v_item.id, v_wh, v_date, v_qty,
      case when v_qty > 0 and v_cost is not null then round(v_qty * v_cost, 2) end, v_kind, null, null, v_id);
    v_inv := jsonb_set(v_inv, array[v_item.inventory_account_id::text],
      to_jsonb(coalesce((v_inv->>v_item.inventory_account_id::text)::numeric, 0) + v_val));
    v_total := v_total + v_val;
  end loop;
  if v_n = 0 then raise exception 'VALIDATION: Nothing changes — every quantity is zero or already matches the count.'; end if;

  for k in select jsonb_object_keys(v_inv) loop
    if (v_inv->>k)::numeric <> 0 then v_lines := v_lines || public._jl(k::uuid, (v_inv->>k)::numeric, 'Inventory'); end if;
  end loop;
  if v_total <> 0 then v_lines := v_lines || public._jl(v_off, -v_total, initcap(lower(v_kind))); end if;
  if jsonb_array_length(v_lines) > 0 then
    v_saved := public.save_journal(p_company, null, v_date,
      left(format('Stock %s %s%s', lower(v_kind), v_no, coalesce(' — ' || v_desc, '')), 500), null, v_lines, null);
    v_je := (v_saved->>'id')::uuid;
    update public.journal_entries set source = 'INVENTORY', source_id = v_id, doc_type = 'SA', doc_no = v_no where id = v_je;
    v_posted := public.post_journal(v_je);
    update public.stock_moves set journal_entry_id = v_je where stock_doc_id = v_id and journal_entry_id is null;
    update public.stock_docs set journal_entry_id = v_je where id = v_id;
  end if;
  perform public._audit(p_company, 'stock.adjust', 'StockDoc', v_id::text,
    format('Posted stock %s %s: %s item(s), value %s', lower(v_kind), v_no, v_n, to_char(v_total, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', v_id, 'doc_no', v_no, 'lines', v_n, 'value', v_total, 'journal_id', v_je, 'reference', v_posted->>'reference');
end $$;

/** Moves quantity between warehouses. Value is unchanged, so there is no journal. */
create or replace function public.post_stock_transfer(p_company uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_date date; v_from uuid; v_to uuid; v_id uuid; v_no text; v_line jsonb; v_item public.items; v_qty numeric; v_val numeric; v_n int := 0;
begin
  perform public._require_perm(p_company, 'journal.post');
  begin v_date := (p_data->>'date')::date; exception when others then raise exception 'VALIDATION: Choose a valid date.'; end;
  if v_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  v_from := public._warehouse_ok(p_company, public._try_uuid(p_data->>'warehouse_id'));
  v_to := public._try_uuid(p_data->>'to_warehouse_id');
  if v_to is null then raise exception 'VALIDATION: Choose where the stock goes.'; end if;
  v_to := public._warehouse_ok(p_company, v_to);
  if v_from = v_to then raise exception 'VALIDATION: Choose two different warehouses.'; end if;
  if jsonb_typeof(p_data->'lines') <> 'array' or jsonb_array_length(p_data->'lines') = 0 then raise exception 'VALIDATION: Add at least one item.'; end if;
  v_no := public._next_number(p_company, 'ST', extract(year from v_date)::int);
  insert into public.stock_docs (company_id, kind, doc_no, date, warehouse_id, to_warehouse_id, description, created_by)
  values (p_company, 'TRANSFER', v_no, v_date, v_from, v_to, left(nullif(btrim(p_data->>'description'), ''), 500), auth.uid())
  returning id into v_id;
  for v_line in select * from jsonb_array_elements(p_data->'lines') loop
    select * into v_item from public.items where id = public._try_uuid(v_line->>'item_id') and company_id = p_company;
    if not found then raise exception 'VALIDATION: Item % not found.', v_n + 1; end if;
    begin v_qty := round((v_line->>'qty')::numeric, 4);
    exception when others then raise exception 'VALIDATION: %: the quantity must be a number.', v_item.code; end;
    if v_qty is null or v_qty <= 0 then raise exception 'VALIDATION: %: transfer a quantity above zero.', v_item.code; end if;
    v_n := v_n + 1;
    v_val := public._stock_move(p_company, v_item.id, v_from, v_date, -v_qty, null, 'TRANSFER', null, null, v_id);
    perform public._stock_move(p_company, v_item.id, v_to, v_date, v_qty, -v_val, 'TRANSFER', null, null, v_id);
  end loop;
  perform public._audit(p_company, 'stock.transfer', 'StockDoc', v_id::text, format('Transferred %s item(s) as %s', v_n, v_no));
  return jsonb_build_object('id', v_id, 'doc_no', v_no, 'lines', v_n);
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
  if v.journal_entry_id is not null then
    v_r := public.reverse_journal(v.journal_entry_id, v_date, format('Void %s: %s', v.doc_no, btrim(p_reason)));
  end if;
  perform public._stock_reverse(v.company_id, null, p_id, v_date, (v_r->>'id')::uuid);
  update public.stock_docs set status = 'VOID', void_date = v_date, void_reason = left(btrim(p_reason), 300),
    void_entry_id = (v_r->>'id')::uuid where id = p_id;
  perform public._audit(v.company_id, 'stock.void', 'StockDoc', p_id::text, format('Voided %s — %s', v.doc_no, btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'status', 'VOID', 'reversal', v_r->>'reference');
end $$;

-- ─── Reports ────────────────────────────────────────────────────────────────
/** Stock on hand, per item (all warehouses, or one). Value and average cost are company-wide. */
create or replace function public.stock_on_hand(p_company uuid, p_warehouse uuid default null)
returns table (item_id uuid, code text, description text, uom text, qty numeric, avg_cost numeric, value numeric,
               total_qty numeric, is_active boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'journal.view');
  return query
  select i.id, i.code, i.description, i.uom,
         coalesce(case when p_warehouse is null then c.qty
                       else (select b.qty from public.stock_balances b where b.item_id = i.id and b.warehouse_id = p_warehouse) end, 0),
         case when coalesce(c.qty, 0) > 0 then round(c.value / c.qty, 4) else i.buy_price end,
         case when p_warehouse is null then coalesce(c.value, 0)
              when coalesce(c.qty, 0) = 0 then 0
              else round(c.value * coalesce((select b.qty from public.stock_balances b where b.item_id = i.id and b.warehouse_id = p_warehouse), 0) / c.qty, 2) end,
         coalesce(c.qty, 0), i.is_active
    from public.items i left join public.item_costs c on c.item_id = i.id
   where i.company_id = p_company and i.track_stock
   order by i.code;
end $$;

/** Stock value from the stock ledger against the inventory accounts' balance in the general ledger. */
create or replace function public.stock_gl_check(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public._require_perm(p_company, 'report.view');
  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name,
           'stock_value', coalesce(s.v, 0), 'gl_balance', coalesce(g.b, 0), 'difference', coalesce(g.b, 0) - coalesce(s.v, 0)) order by a.code), '[]'::jsonb)
    into v
    from public.accounts a
    left join (select i.inventory_account_id acc, sum(c.value) v from public.item_costs c join public.items i on i.id = c.item_id
                where c.company_id = p_company group by 1) s on s.acc = a.id
    left join (select l.account_id acc, sum(l.debit - l.credit) b from public.journal_lines l
                 join public.journal_entries e on e.id = l.journal_entry_id
                where e.company_id = p_company and e.status <> 'DRAFT' group by 1) g on g.acc = a.id   -- a reversed entry and its reversal both count
   where a.company_id = p_company
     and a.id in (select inventory_account_id from public.items where company_id = p_company and track_stock);
  return jsonb_build_object('accounts', v,
    'in_balance', not exists (select 1 from jsonb_array_elements(v) x where (x->>'difference')::numeric <> 0));
end $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function public._default_warehouse(uuid), public._warehouse_ok(uuid, uuid),
  public._stock_move(uuid, uuid, uuid, date, numeric, numeric, text, uuid, uuid, uuid, uuid), public._jl(uuid, numeric, text),
  public._stock_on_post(uuid), public._stock_reverse(uuid, uuid, uuid, date, uuid) from public, anon, authenticated;
revoke execute on function public.ensure_warehouse(uuid), public.save_warehouse(uuid, uuid, jsonb), public.set_stock_settings(uuid, boolean),
  public.post_stock_adjustment(uuid, jsonb), public.post_stock_transfer(uuid, jsonb), public.void_stock_doc(uuid, date, text),
  public.stock_on_hand(uuid, uuid), public.stock_gl_check(uuid) from public, anon;
grant execute on function public.ensure_warehouse(uuid), public.save_warehouse(uuid, uuid, jsonb), public.set_stock_settings(uuid, boolean),
  public.post_stock_adjustment(uuid, jsonb), public.post_stock_transfer(uuid, jsonb), public.void_stock_doc(uuid, date, text),
  public.stock_on_hand(uuid, uuid), public.stock_gl_check(uuid) to authenticated;
