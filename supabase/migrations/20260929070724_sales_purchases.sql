-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 — commercial accounting.
--   Customers and suppliers (with the details LHDN e-Invoice needs), items,
--   SST tax codes, and one document engine for:
--     sales      Quotation, Invoice, Cash Sale, Debit Note, Credit Note,
--                Receipt (OR), Refund (PV)
--     purchases  Purchase Order, Purchase Invoice, Cash Purchase,
--                Supplier Debit Note, Supplier Credit Note,
--                Payment (PV), Supplier Refund (OR)
--   Drafts can be edited; posted documents are fixed (void, or issue a note).
--   Receipts, payments and credit notes knock off invoices and bills, fully
--   or partly; what is left is a deposit to apply later.
--   Customer and supplier balances live on control accounts that only these
--   documents post to, so the aging always ties to the balance sheet — and
--   the proof checks it.
--   Plus a multi-line cash book entry and a cash book per bank/cash account.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Master data ────────────────────────────────────────────────────────────
alter table public.accounts add column is_control boolean not null default false;

create table public.tax_codes (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  code                text not null check (code ~ '^[A-Z0-9-]{1,10}$'),
  name                text not null check (length(btrim(name)) between 1 and 60),
  rate                numeric(5,2) not null check (rate between 0 and 100),
  sales_account_id    uuid references public.accounts(id),   -- output tax (SST payable)
  purchase_account_id uuid references public.accounts(id),   -- claimable input tax; empty = part of the cost
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, code)
);
create index tax_codes_sales_account_idx on public.tax_codes(sales_account_id);
create index tax_codes_purchase_account_idx on public.tax_codes(purchase_account_id);

create table public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  kind                text not null check (kind in ('CUSTOMER', 'SUPPLIER')),
  code                text not null check (code ~ '^[A-Za-z0-9./_-]{1,20}$'),
  name                text not null check (length(btrim(name)) between 1 and 200),
  id_type             text check (id_type in ('BRN', 'NRIC', 'PASSPORT', 'ARMY')),
  reg_no              text check (length(reg_no) <= 40),
  tin                 text check (length(tin) <= 20),
  sst_no              text check (length(sst_no) <= 40),
  email               text check (length(email) <= 200),
  phone               text check (length(phone) <= 40),
  contact_person      text check (length(contact_person) <= 100),
  address             text check (length(address) <= 500),
  postcode            text check (length(postcode) <= 10),
  city                text check (length(city) <= 60),
  state               text check (length(state) <= 60),
  country             text not null default 'MY' check (country ~ '^[A-Z]{2}$'),
  terms_days          int not null default 30 check (terms_days between 0 and 3650),
  credit_limit        numeric(18,2) not null default 0 check (credit_limit >= 0),
  control_account_id  uuid references public.accounts(id),
  default_account_id  uuid references public.accounts(id),
  default_tax_code_id uuid references public.tax_codes(id) on delete set null,
  notes               text check (length(notes) <= 1000),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, kind, code)
);
create index contacts_company_name_idx on public.contacts(company_id, kind, lower(name));
create index contacts_control_account_idx on public.contacts(control_account_id);
create index contacts_default_account_idx on public.contacts(default_account_id);
create index contacts_default_tax_idx on public.contacts(default_tax_code_id);

create table public.items (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  code                 text not null check (code ~ '^[A-Za-z0-9./_-]{1,30}$'),
  description          text not null check (length(btrim(description)) between 1 and 200),
  uom                  text not null default 'UNIT' check (length(uom) between 1 and 20),
  sell_price           numeric(18,4) not null default 0 check (sell_price >= 0),
  buy_price            numeric(18,4) not null default 0 check (buy_price >= 0),
  sales_account_id     uuid references public.accounts(id),
  purchase_account_id  uuid references public.accounts(id),
  sales_tax_code_id    uuid references public.tax_codes(id) on delete set null,
  purchase_tax_code_id uuid references public.tax_codes(id) on delete set null,
  classification       text check (classification ~ '^[0-9]{3}$'),  -- LHDN e-Invoice classification code
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (company_id, code)
);
create index items_sales_account_idx on public.items(sales_account_id);
create index items_purchase_account_idx on public.items(purchase_account_id);
create index items_sales_tax_idx on public.items(sales_tax_code_id);
create index items_purchase_tax_idx on public.items(purchase_tax_code_id);

-- ─── Documents ──────────────────────────────────────────────────────────────
create table public.trade_docs (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  side               text not null check (side in ('AR', 'AP')),
  doc_type           text not null check (doc_type in (
                       'QUOTATION', 'INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'RECEIPT', 'REFUND',
                       'PURCHASE_ORDER', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'SUPPLIER_CN', 'PAYMENT', 'SUPPLIER_REFUND')),
  status             text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'VOID')),
  contact_id         uuid references public.contacts(id),
  bill_name          text check (length(bill_name) <= 200),
  bill_address       text check (length(bill_address) <= 500),
  attention          text check (length(attention) <= 100),
  doc_no             text check (doc_no is null or length(doc_no) between 1 and 40),
  series_id          uuid references public.document_series(id),
  doc_period         int,
  doc_seq            int,
  date               date not null,
  due_date           date,
  terms_days         int check (terms_days between 0 and 3650),
  reference          text check (length(reference) <= 60),
  description        text check (length(description) <= 500),
  notes              text check (length(notes) <= 2000),
  tax_inclusive      boolean not null default false,
  subtotal           numeric(18,2) not null default 0,
  tax_total          numeric(18,2) not null default 0,
  total              numeric(18,2) not null default 0 check (total >= 0),
  allocated          numeric(18,2) not null default 0 check (allocated >= 0),
  money_account_id   uuid references public.accounts(id),
  pay_method         text check (length(pay_method) <= 60),
  bank_charge        numeric(18,2) not null default 0 check (bank_charge >= 0),
  control_account_id uuid references public.accounts(id),
  journal_entry_id   uuid references public.journal_entries(id),
  source_doc_id      uuid references public.trade_docs(id) on delete set null,
  void_date          date,
  void_reason        text check (length(void_reason) <= 300),
  void_entry_id      uuid references public.journal_entries(id),
  einvoice_status    text check (einvoice_status in ('PENDING', 'SUBMITTED', 'VALID', 'INVALID', 'CANCELLED')),
  einvoice_uuid      text check (length(einvoice_uuid) <= 60),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  posted_at          timestamptz,
  posted_by          uuid,
  constraint trade_docs_allocated_le_total check (allocated <= total),
  constraint trade_docs_posted_numbered check (status = 'DRAFT' or doc_no is not null),
  constraint trade_docs_due_after_date check (due_date is null or due_date >= date)
);
create unique index trade_docs_doc_no_uniq on public.trade_docs(company_id, lower(doc_no)) where doc_no is not null;
create index trade_docs_company_type_idx on public.trade_docs(company_id, doc_type, date desc);
create index trade_docs_contact_idx on public.trade_docs(contact_id, status);
create index trade_docs_series_idx on public.trade_docs(series_id, doc_period);
create index trade_docs_journal_idx on public.trade_docs(journal_entry_id);
create index trade_docs_void_entry_idx on public.trade_docs(void_entry_id);
create index trade_docs_source_doc_idx on public.trade_docs(source_doc_id);
create index trade_docs_money_account_idx on public.trade_docs(money_account_id);
create index trade_docs_control_account_idx on public.trade_docs(control_account_id);

create table public.trade_doc_lines (
  id          uuid primary key default gen_random_uuid(),
  doc_id      uuid not null references public.trade_docs(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  line_no     int not null,
  item_id     uuid references public.items(id) on delete set null,
  description text not null check (length(btrim(description)) between 1 and 500),
  qty         numeric(18,4) not null check (qty > 0),
  uom         text check (length(uom) <= 20),
  unit_price  numeric(18,4) not null check (unit_price >= 0),
  discount    numeric(18,2) not null default 0 check (discount >= 0),
  account_id  uuid references public.accounts(id),
  tax_code_id uuid references public.tax_codes(id),
  tax_rate    numeric(5,2) not null default 0,
  amount      numeric(18,2) not null,   -- before tax, after discount
  tax_amount  numeric(18,2) not null default 0,
  total       numeric(18,2) not null,
  unique (doc_id, line_no)
);
create index trade_doc_lines_company_idx on public.trade_doc_lines(company_id);
create index trade_doc_lines_item_idx on public.trade_doc_lines(item_id);
create index trade_doc_lines_account_idx on public.trade_doc_lines(account_id);
create index trade_doc_lines_tax_idx on public.trade_doc_lines(tax_code_id);

-- A receipt, payment or credit note settling (part of) an invoice, bill, debit note or refund.
create table public.trade_allocations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  from_doc_id uuid not null references public.trade_docs(id),
  to_doc_id   uuid not null references public.trade_docs(id),
  amount      numeric(18,2) not null check (amount > 0),
  date        date not null,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index trade_allocations_from_idx on public.trade_allocations(from_doc_id);
create index trade_allocations_to_idx on public.trade_allocations(to_doc_id);
create index trade_allocations_company_idx on public.trade_allocations(company_id);

alter table public.tax_codes enable row level security;
alter table public.contacts enable row level security;
alter table public.items enable row level security;
alter table public.trade_docs enable row level security;
alter table public.trade_doc_lines enable row level security;
alter table public.trade_allocations enable row level security;
create policy "tax codes of my books" on public.tax_codes for select to authenticated
  using (company_id in (select public.my_company_ids()));
create policy "contacts by permission" on public.contacts for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "items by permission" on public.items for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "documents by permission" on public.trade_docs for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "document lines by permission" on public.trade_doc_lines for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));
create policy "allocations by permission" on public.trade_allocations for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));

-- Journals created by documents carry the document's short code.
alter table public.journal_entries drop constraint if exists journal_entries_doc_type_check;
alter table public.journal_entries add constraint journal_entries_doc_type_check
  check (doc_type in ('PV', 'OR', 'IV', 'CS', 'DN', 'CN', 'PI', 'CP', 'SDN', 'SCN'));

-- ─── What each document type does ───────────────────────────────────────────
-- effect: +1 raises what the customer owes us / we owe the supplier, -1 settles it.
-- head_debit: whether the head account (control, or bank for cash documents) is debited.
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
    ('PURCHASE_ORDER',  'AP', 'PURCHASE_ORDER', null,  'Purchase order',       true,  false,  0, null,  false, false, null),
    ('BILL',            'AP', 'BILL',           'PI',  'Purchase invoice',     true,  true,   1, false, false, true,  'BILL'),
    ('CASH_PURCHASE',   'AP', 'CASH_PURCHASE',  'CP',  'Cash purchase',        true,  true,   0, false, true,  false, 'BILL'),
    ('SUPPLIER_DN',     'AP', 'SUPPLIER_DN',    'SDN', 'Supplier debit note',  true,  true,   1, false, false, true,  'BILL'),
    ('SUPPLIER_CN',     'AP', 'SUPPLIER_CN',    'SCN', 'Supplier credit note', true,  true,  -1, true,  false, true,  'BILL'),
    ('PAYMENT',         'AP', 'PAYMENT',        'PV',  'Payment',              false, true,  -1, false, true,  true,  'PAYMENT'),
    ('SUPPLIER_REFUND', 'AP', 'RECEIPT',        'OR',  'Supplier refund',      false, true,   1, true,  true,  true,  'PAYMENT')
  ) as t(doc_type, side, series_kind, jcode, label, has_lines, posts, effect, head_debit, uses_money, uses_control, source)
  where t.doc_type = p_type;
$$;

create or replace function public._try_uuid(p text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return nullif(btrim(p), '')::uuid;
exception when others then
  return null;
end $$;

create or replace function public._series_label(p_kind text)
returns text language sql immutable set search_path = public as $$
  select case p_kind
    when 'PAYMENT' then 'payment voucher' when 'RECEIPT' then 'receipt' when 'JOURNAL' then 'journal'
    when 'QUOTATION' then 'quotation' when 'INVOICE' then 'invoice' when 'CASH_SALE' then 'cash sale'
    when 'DEBIT_NOTE' then 'debit note' when 'CREDIT_NOTE' then 'credit note' when 'PURCHASE_ORDER' then 'purchase order'
    when 'BILL' then 'purchase invoice' when 'CASH_PURCHASE' then 'cash purchase'
    when 'SUPPLIER_DN' then 'supplier debit note' when 'SUPPLIER_CN' then 'supplier credit note'
    else lower(p_kind) end;
$$;

-- ─── Numbering covers the new documents ─────────────────────────────────────
alter table public.document_series drop constraint document_series_kind_check;
alter table public.document_series add constraint document_series_kind_check check (kind in (
  'PAYMENT', 'RECEIPT', 'JOURNAL', 'QUOTATION', 'INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE',
  'PURCHASE_ORDER', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'SUPPLIER_CN'));

create or replace function public._number_taken(p_company uuid, p_number text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.journal_entries
                 where company_id = p_company and (lower(doc_no) = lower(p_number) or lower(reference) = lower(p_number)))
      or exists (select 1 from public.trade_docs where company_id = p_company and lower(doc_no) = lower(p_number));
$$;

create or replace function public._assign_number(p_series public.document_series, p_date date, p_manual text,
                                                 p_force_auto boolean default false)
returns table (doc_text text, doc_period int, doc_seq int)
language plpgsql security definer set search_path = public as $$
declare
  v_manual text := nullif(btrim(p_manual), '');
  v_label text := public._series_label(p_series.kind);
begin
  if p_force_auto then
    v_manual := null;
  elsif p_series.mode = 'AUTO' and v_manual is not null then
    raise exception 'VALIDATION: Numbers in the "%" series are given automatically.', p_series.name;
  elsif p_series.mode = 'MANUAL' and v_manual is null then
    raise exception 'VALIDATION: Enter the % number.', v_label;
  end if;
  if v_manual is null then
    return query select * from public._series_next(p_series, p_date);
    return;
  end if;
  if v_manual !~ '^[A-Za-z0-9/._ -]{1,40}$' then
    raise exception 'VALIDATION: A % number has up to 40 letters, numbers and / . - _', v_label;
  end if;
  if p_series.mode = 'AUTO_EDITABLE' or p_series.kind = 'JOURNAL' then
    if lower(v_manual) = lower(public._series_preview(p_series, p_date)) then
      return query select * from public._series_next(p_series, p_date);
      return;
    end if;
    if v_manual ~* public._series_pattern(p_series.format) then
      raise exception 'VALIDATION: % follows the automatic pattern of the "%" series, so it is kept for automatic numbering. Key a different number, or leave it blank for the next one.', v_manual, p_series.name;
    end if;
  end if;
  if public._number_taken(p_series.company_id, v_manual) then
    raise exception 'DUPLICATE: % is already used in these books.', v_manual;
  end if;
  return query select v_manual, null::int, null::int;
end $$;

-- How many numbers a series has handed out, across journals and documents.
create or replace function public._series_used(p_series uuid)
returns int language sql stable security definer set search_path = public as $$
  select ((select count(*) from public.journal_entries e where e.ref_series_id = p_series or e.doc_series_id = p_series)
        + (select count(*) from public.trade_docs d where d.series_id = p_series))::int;
$$;

create or replace function public.document_series_overview(p_company uuid, p_date date default null)
returns table (id uuid, kind text, code text, name text, title text, format text, reset text, mode text,
               money_account_id uuid, is_default boolean, is_active boolean, next_number int, next_preview text, used int)
language plpgsql stable security definer set search_path = public as $$
declare v_date date := coalesce(p_date, current_date);
begin
  perform public._require_perm(p_company, 'company.view');
  return query
  select s.id, s.kind, s.code, s.name, s.title, s.format, s.reset, s.mode, s.money_account_id, s.is_default, s.is_active,
         coalesce(ns.next_number, 1), public._format_number(s.format, v_date, coalesce(ns.next_number, 1)),
         public._series_used(s.id)
  from public.document_series s
  left join public.number_sequences ns
    on ns.company_id = s.company_id and ns.doc_type = s.code and ns.year = public._series_period(s.reset, v_date)
  where s.company_id = p_company
  order by array_position(array['QUOTATION', 'INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'RECEIPT',
                                'PURCHASE_ORDER', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'SUPPLIER_CN', 'PAYMENT', 'JOURNAL'], s.kind),
           s.is_default desc, s.name;
end $$;

create or replace function public.save_document_series(p_company uuid, p_id uuid, p_kind text, p_code text, p_name text,
                                                       p_title text, p_format text, p_reset text, p_mode text,
                                                       p_money_account uuid, p_is_default boolean, p_is_active boolean,
                                                       p_next_number int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_old public.document_series; v_id uuid; v_kind text := upper(btrim(coalesce(p_kind, ''))); v_code text := upper(btrim(coalesce(p_code, '')));
  v_format text := btrim(coalesce(p_format, '')); v_reset text := upper(coalesce(p_reset, 'YEARLY')); v_mode text := upper(coalesce(p_mode, 'AUTO'));
  v_default boolean := coalesce(p_is_default, false); v_active boolean := coalesce(p_is_active, true);
  v_used int; v_period int; v_cur int; v_max int; v_acc record;
begin
  perform public._require_perm(p_company, 'company.edit');
  if p_id is not null then
    select * into v_old from public.document_series where id = p_id and company_id = p_company for update;
    if not found then raise exception 'NOT_FOUND: Numbering series not found.'; end if;
    v_kind := v_old.kind; v_code := v_old.code;
    v_used := public._series_used(p_id);
    if v_used > 0 and v_reset <> v_old.reset then
      raise exception 'VALIDATION: This series already numbers % entries, so when it restarts can''t change. Add a new series instead.', v_used;
    end if;
  else
    if v_kind not in ('PAYMENT', 'RECEIPT', 'JOURNAL', 'QUOTATION', 'INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE',
                      'PURCHASE_ORDER', 'BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'SUPPLIER_CN') then
      raise exception 'VALIDATION: Choose what the series numbers.';
    end if;
    if v_code !~ '^[A-Z0-9]{1,10}$' then raise exception 'VALIDATION: The code is 1 to 10 letters or numbers, such as PV or CV.'; end if;
    if exists (select 1 from public.document_series where company_id = p_company and code = v_code) then
      raise exception 'DUPLICATE: The code % is already used by another series.', v_code;
    end if;
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 60 then raise exception 'VALIDATION: Give the series a name (up to 60 characters).'; end if;
  if p_title is not null and length(btrim(p_title)) > 60 then raise exception 'VALIDATION: The printed title is up to 60 characters.'; end if;
  if v_reset not in ('YEARLY', 'MONTHLY', 'NEVER') then raise exception 'VALIDATION: Choose when the numbers restart.'; end if;
  if v_mode not in ('AUTO', 'AUTO_EDITABLE', 'MANUAL') then raise exception 'VALIDATION: Choose automatic or manual numbering.'; end if;
  perform public._check_series_format(v_format, v_reset);
  if exists (select 1 from public.document_series where company_id = p_company and is_active and lower(format) = lower(v_format)
               and id is distinct from p_id) and v_active then
    raise exception 'DUPLICATE: Another series already uses the format %. Give this one a different prefix.', v_format;
  end if;

  if p_money_account is not null then
    if v_kind not in ('PAYMENT', 'RECEIPT') then raise exception 'VALIDATION: Only payment and receipt series are linked to a bank account.'; end if;
    select a.*, c.kind as company_kind into v_acc from public.accounts a join public.companies c on c.id = a.company_id
     where a.id = p_money_account and a.company_id = p_company;
    if not found or not (v_acc.is_cash or (v_acc.company_kind = 'PERSONAL' and v_acc.type = 'LIABILITY' and v_acc.sub_type = 'CURRENT_LIABILITY')) then
      raise exception 'VALIDATION: Link the series to a bank, cash or card account.';
    end if;
    if v_active and exists (select 1 from public.document_series where company_id = p_company and kind = v_kind and is_active
                              and money_account_id = p_money_account and id is distinct from p_id) then
      raise exception 'DUPLICATE: Another % series is already linked to % %.', public._series_label(v_kind), v_acc.code, v_acc.name;
    end if;
  end if;

  if not exists (select 1 from public.document_series where company_id = p_company and kind = v_kind and is_default and id is distinct from p_id) then
    v_default := true;
  end if;
  if v_default and not v_active then raise exception 'VALIDATION: The default series has to stay active. Make another series the default first.'; end if;
  if v_old.id is not null and v_old.is_default and not v_default then
    raise exception 'VALIDATION: Make another series the default first.';
  end if;
  if v_default then
    update public.document_series set is_default = false, updated_at = now()
     where company_id = p_company and kind = v_kind and is_default and id is distinct from p_id;
  end if;

  if p_id is null then
    insert into public.document_series (company_id, kind, code, name, title, format, reset, mode, money_account_id, is_default, is_active)
    values (p_company, v_kind, v_code, btrim(p_name), nullif(btrim(p_title), ''), v_format, v_reset, v_mode, p_money_account, v_default, v_active)
    returning id into v_id;
    delete from public.number_sequences where company_id = p_company and doc_type = v_code;
  else
    update public.document_series set name = btrim(p_name), title = nullif(btrim(p_title), ''), format = v_format, reset = v_reset,
      mode = v_mode, money_account_id = p_money_account, is_default = v_default, is_active = v_active, updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;

  if p_next_number is not null then
    if p_next_number not between 1 and 99999999 then raise exception 'VALIDATION: The next number is between 1 and 99,999,999.'; end if;
    v_period := public._series_period(v_reset, current_date);
    select next_number into v_cur from public.number_sequences where company_id = p_company and doc_type = v_code and year = v_period;
    v_cur := coalesce(v_cur, 1);
    select greatest(
             coalesce((select max(ref_seq) from public.journal_entries where ref_series_id = v_id and ref_period = v_period), 0),
             coalesce((select max(doc_seq) from public.journal_entries where doc_series_id = v_id and doc_period = v_period), 0),
             coalesce((select max(doc_seq) from public.trade_docs where series_id = v_id and doc_period = v_period), 0))
      into v_max;
    if p_next_number <= v_max then
      raise exception 'VALIDATION: Numbers up to % are already used this period, so the next number must be at least %.', v_max, v_max + 1;
    end if;
    if p_next_number <> v_cur then
      insert into public.number_sequences (company_id, doc_type, year, next_number, skipped)
      values (p_company, v_code, v_period, p_next_number, p_next_number - 1)
      on conflict (company_id, doc_type, year) do update
        set skipped = greatest(0, public.number_sequences.skipped + (excluded.next_number - public.number_sequences.next_number)),
            next_number = excluded.next_number;
    end if;
  end if;

  perform public._audit(p_company, case when p_id is null then 'numbering.create' else 'numbering.edit' end, 'DocumentSeries', v_id::text,
    format('%s numbering series %s (%s): %s, %s%s', case when p_id is null then 'Added' else 'Updated' end, btrim(p_name), v_code,
           v_format, lower(replace(v_mode, '_', ' ')), case when p_next_number is not null then format(', next number %s', p_next_number) else '' end));
  return v_id;
end $$;

create or replace function public.delete_document_series(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.document_series; v_used int;
begin
  select * into v from public.document_series where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Numbering series not found.'; end if;
  perform public._require_perm(v.company_id, 'company.edit');
  if v.is_default then raise exception 'VALIDATION: Make another series the default before removing this one.'; end if;
  v_used := public._series_used(p_id);
  if v_used > 0 then
    raise exception 'IN_USE: % entries carry numbers from this series. Make it inactive instead.', v_used;
  end if;
  delete from public.number_sequences where company_id = v.company_id and doc_type = v.code;
  delete from public.document_series where id = p_id;
  perform public._audit(v.company_id, 'numbering.delete', 'DocumentSeries', p_id::text, format('Removed numbering series %s (%s)', v.name, v.code));
end $$;

-- ─── Default set-up for business books ──────────────────────────────────────
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
               ('SUPPLIER_DN', 'SDN', 'Supplier debit note'), ('SUPPLIER_CN', 'SCN', 'Supplier credit note')) as s(kind, code, name)
  where not exists (select 1 from public.document_series x where x.company_id = p_company and x.kind = s.kind)
  on conflict (company_id, code) do nothing;

  update public.accounts set is_control = true where company_id = p_company and code in ('1150', '2110') and is_postable;

  select id into v_sst from public.accounts where company_id = p_company and code = '2150';
  insert into public.tax_codes (company_id, code, name, rate, sales_account_id)
  values (p_company, 'SV8', 'Service tax 8%', 8, v_sst), (p_company, 'SV6', 'Service tax 6%', 6, v_sst),
         (p_company, 'ST10', 'Sales tax 10%', 10, v_sst), (p_company, 'ST5', 'Sales tax 5%', 5, v_sst)
  on conflict (company_id, code) do nothing;
end $$;

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
  perform public._seed_trade_setup(v_company);

  insert into public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, summary)
  values (v_company, p_user, (select email from public.profiles where id = p_user), 'company.create', 'Company',
          v_company::text, format('Created %s (%s) with %s accounts and 12 fiscal periods', btrim(p_name), lower(v_kind),
          (select count(*) from public.accounts where company_id = v_company)));
  return v_company;
end $$;

select public._seed_trade_setup(id) from public.companies where kind = 'BUSINESS';

-- ─── Posting: control accounts only take document postings ──────────────────
create or replace function public._post(p_entry uuid, p_series uuid default null, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_e record; v_lines int; v_dr numeric; v_cr numeric; v_period record; v_bad record;
  v_series public.document_series; v_num record; v_system boolean;
begin
  select * into v_e from public.journal_entries where id = p_entry for update;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  if v_e.status <> 'DRAFT' then
    raise exception 'INVALID_STATE: Only draft journals can be posted (this one is %).', v_e.status;
  end if;
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_lines, v_dr, v_cr
    from public.journal_lines where journal_entry_id = p_entry;
  if v_lines < 2 then
    raise exception 'JOURNAL_TOO_FEW_LINES: A journal needs at least two lines.';
  end if;
  if v_dr <> v_cr then
    raise exception 'JOURNAL_UNBALANCED: Debits (%) do not equal credits (%). Difference %.',
      to_char(v_dr, 'FM999,999,999,990.00'), to_char(v_cr, 'FM999,999,999,990.00'), to_char(abs(v_dr - v_cr), 'FM999,999,999,990.00');
  end if;
  select a.code, a.name into v_bad from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.journal_entry_id = p_entry and (not a.is_postable or not a.is_active) limit 1;
  if found then
    raise exception 'ACCOUNT_NOT_POSTABLE: % % cannot receive postings.', v_bad.code, v_bad.name;
  end if;
  if v_e.source in ('MANUAL', 'BANK') and v_e.reversal_of_id is null then
    select a.code, a.name into v_bad from public.journal_lines l join public.accounts a on a.id = l.account_id
     where l.journal_entry_id = p_entry and a.is_control limit 1;
    if found then
      raise exception 'CONTROL_ACCOUNT: % % holds customer or supplier balances, so it only takes invoices, bills, notes, receipts and payments.', v_bad.code, v_bad.name;
    end if;
  end if;
  select * into v_period from public.fiscal_periods
   where company_id = v_e.company_id and v_e.date between start_date and end_date;
  if not found then
    raise exception 'PERIOD_NOT_FOUND: No fiscal period covers %. Generate that fiscal year first.', to_char(v_e.date, 'DD Mon YYYY');
  end if;
  if v_period.status = 'CLOSED' then
    raise exception 'PERIOD_CLOSED: % is closed. Reopen it before posting to it.', v_period.name;
  end if;
  v_system := v_e.source <> 'MANUAL' or v_e.reversal_of_id is not null;
  v_series := public._resolve_series(v_e.company_id, 'JOURNAL', case when v_system then null else p_series end, null);
  if v_series.id is null then
    raise exception 'VALIDATION: These books have no journal numbering series. Add one under Numbering.';
  end if;
  select * into v_num from public._assign_number(v_series, v_e.date, p_reference, v_system);
  update public.journal_entries set
    status = 'POSTED', reference = v_num.doc_text, fiscal_period_id = v_period.id,
    ref_series_id = v_series.id, ref_period = v_num.doc_period, ref_seq = v_num.doc_seq,
    total_debit = v_dr, total_credit = v_cr, posted_at = now(), posted_by = auth.uid(), version = version + 1
  where id = p_entry;
  return jsonb_build_object('id', p_entry, 'reference', v_num.doc_text, 'total', v_dr);
end $$;

-- A document's journal is reversed only by voiding the document.
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

  insert into public.journal_lines (journal_entry_id, account_id, line_no, description, debit, credit)
  select v_new, account_id, line_no, description, credit, debit
  from public.journal_lines where journal_entry_id = v_e.id;

  v_result := public._post(v_new);
  update public.journal_entries set status = 'REVERSED', version = version + 1 where id = v_e.id;
  perform public._audit(v_e.company_id, 'journal.reverse', 'JournalEntry', v_e.id::text,
    format('Reversed %s with %s%s', v_e.reference, v_result->>'reference', coalesce(' — ' || nullif(btrim(p_reason), ''), '')));
  return v_result || jsonb_build_object('reversed', v_e.reference);
end $$;

-- ─── Posted documents are fixed ─────────────────────────────────────────────
create or replace function public._guard_trade_doc()
returns trigger language plpgsql set search_path = public as $$
declare v_free text[] := array['status', 'void_date', 'void_reason', 'void_entry_id', 'allocated', 'einvoice_status', 'einvoice_uuid', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then raise exception 'IMMUTABLE: Posted documents are never deleted — void them instead.'; end if;
    return old;
  end if;
  if old.status = 'VOID' and (to_jsonb(new) - array['einvoice_status', 'einvoice_uuid', 'updated_at'])
                           <> (to_jsonb(old) - array['einvoice_status', 'einvoice_uuid', 'updated_at']) then
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
create trigger trade_docs_guard before update or delete on public.trade_docs
  for each row execute function public._guard_trade_doc();

create or replace function public._guard_trade_line()
returns trigger language plpgsql set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.trade_docs where id = coalesce(new.doc_id, old.doc_id);
  if v_status is not null and v_status <> 'DRAFT' then
    raise exception 'IMMUTABLE: Lines of a posted document cannot change.';
  end if;
  return coalesce(new, old);
end $$;
create trigger trade_doc_lines_guard before insert or update or delete on public.trade_doc_lines
  for each row execute function public._guard_trade_line();

-- ─── Master data RPCs ───────────────────────────────────────────────────────
create or replace function public._default_control(p_company uuid, p_side text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.accounts
  where company_id = p_company and is_control and is_active and is_postable
    and type = (case p_side when 'AR' then 'ASSET' else 'LIABILITY' end)::public.account_type
  order by code limit 1;
$$;

-- A line/default account: postable, active, and not a control or heading.
create or replace function public._check_line_account(p_company uuid, p_account uuid, p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
declare v record;
begin
  select code, name, is_postable, is_active, is_control into v from public.accounts where id = p_account and company_id = p_company;
  if not found then raise exception 'VALIDATION: %: account not found in these books.', p_what; end if;
  if not v.is_postable then raise exception 'ACCOUNT_NOT_POSTABLE: %: % % is a heading.', p_what, v.code, v.name; end if;
  if not v.is_active then raise exception 'ACCOUNT_NOT_POSTABLE: %: % % is archived.', p_what, v.code, v.name; end if;
  if v.is_control then raise exception 'CONTROL_ACCOUNT: %: % % is a control account.', p_what, v.code, v.name; end if;
end $$;

create or replace function public.save_contact(p_company uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_old public.contacts; v_id uuid; v_kind text; v_code text; v_name text := btrim(coalesce(p_data->>'name', ''));
  v_ctrl uuid := public._try_uuid(p_data->>'control_account_id'); v_def uuid := public._try_uuid(p_data->>'default_account_id');
  v_tax uuid := public._try_uuid(p_data->>'default_tax_code_id'); v_n int; v_prefix text; v_ctrl_acc record;
  v_terms int; v_limit numeric; v_idtype text := nullif(upper(btrim(coalesce(p_data->>'id_type', ''))), '');
  v_tin text := nullif(upper(regexp_replace(coalesce(p_data->>'tin', ''), '\s', '', 'g')), '');
begin
  perform public._require_perm(p_company, 'journal.create');
  if p_id is not null then
    select * into v_old from public.contacts where id = p_id and company_id = p_company for update;
    if not found then raise exception 'NOT_FOUND: Contact not found.'; end if;
    v_kind := v_old.kind;
  else
    v_kind := upper(btrim(coalesce(p_data->>'kind', '')));
    if v_kind not in ('CUSTOMER', 'SUPPLIER') then raise exception 'VALIDATION: Choose customer or supplier.'; end if;
  end if;
  if length(v_name) not between 1 and 200 then raise exception 'VALIDATION: Enter the % name.', lower(v_kind); end if;

  v_code := upper(btrim(coalesce(p_data->>'code', '')));
  if v_code = '' then
    if v_old.id is not null then v_code := v_old.code;
    else
      v_prefix := case v_kind when 'CUSTOMER' then 'C' else 'S' end;
      select coalesce(max(substring(code from '^' || v_prefix || '([0-9]+)$')::int), 0) + 1 into v_n
        from public.contacts where company_id = p_company and kind = v_kind and code ~ ('^' || v_prefix || '[0-9]+$');
      v_code := v_prefix || lpad(v_n::text, 4, '0');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9./_-]{1,20}$' then raise exception 'VALIDATION: The code is up to 20 letters, numbers and . / _ -'; end if;
  if exists (select 1 from public.contacts where company_id = p_company and kind = v_kind and code = v_code and id is distinct from p_id) then
    raise exception 'DUPLICATE: Code % is already used by another %.', v_code, lower(v_kind);
  end if;

  begin
    v_terms := coalesce(nullif(p_data->>'terms_days', '')::int, 30);
    v_limit := round(coalesce(nullif(p_data->>'credit_limit', '')::numeric, 0), 2);
  exception when others then
    raise exception 'VALIDATION: Credit terms and credit limit must be numbers.';
  end;
  if v_terms not between 0 and 3650 then raise exception 'VALIDATION: Credit terms are 0 to 3,650 days.'; end if;
  if v_limit < 0 then raise exception 'VALIDATION: The credit limit cannot be negative.'; end if;
  if v_idtype is not null and v_idtype not in ('BRN', 'NRIC', 'PASSPORT', 'ARMY') then raise exception 'VALIDATION: Choose the ID type.'; end if;
  if v_tin is not null and v_tin !~ '^[A-Z0-9]{3,20}$' then raise exception 'VALIDATION: A TIN is letters and numbers, such as C1234567890 or IG12345678901.'; end if;
  if nullif(btrim(p_data->>'email'), '') is not null and btrim(p_data->>'email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: Check the email address.';
  end if;

  if v_ctrl is not null then
    select * into v_ctrl_acc from public.accounts where id = v_ctrl and company_id = p_company;
    if not found or not v_ctrl_acc.is_control or not v_ctrl_acc.is_active
       or v_ctrl_acc.type <> (case v_kind when 'CUSTOMER' then 'ASSET' else 'LIABILITY' end)::public.account_type then
      raise exception 'VALIDATION: Choose an active % control account.', case v_kind when 'CUSTOMER' then 'receivables' else 'payables' end;
    end if;
    if v_old.id is not null and v_old.control_account_id is distinct from v_ctrl
       and exists (select 1 from public.trade_docs where contact_id = p_id and status = 'POSTED' and total > allocated and control_account_id is not null) then
      raise exception 'VALIDATION: % still has open documents on the current control account. Settle them before moving it.', v_name;
    end if;
  end if;
  if v_def is not null then perform public._check_line_account(p_company, v_def, 'Default account'); end if;
  if v_tax is not null and not exists (select 1 from public.tax_codes where id = v_tax and company_id = p_company) then
    raise exception 'VALIDATION: Tax code not found.';
  end if;

  if p_id is null then
    insert into public.contacts (company_id, kind, code, name, id_type, reg_no, tin, sst_no, email, phone, contact_person,
      address, postcode, city, state, country, terms_days, credit_limit, control_account_id, default_account_id, default_tax_code_id, notes, is_active)
    values (p_company, v_kind, v_code, v_name, v_idtype, nullif(btrim(p_data->>'reg_no'), ''), v_tin,
      nullif(btrim(p_data->>'sst_no'), ''), nullif(lower(btrim(p_data->>'email')), ''), nullif(btrim(p_data->>'phone'), ''),
      nullif(btrim(p_data->>'contact_person'), ''), nullif(btrim(p_data->>'address'), ''), nullif(btrim(p_data->>'postcode'), ''),
      nullif(btrim(p_data->>'city'), ''), nullif(btrim(p_data->>'state'), ''), coalesce(nullif(upper(btrim(p_data->>'country')), ''), 'MY'),
      v_terms, v_limit, v_ctrl, v_def, v_tax, nullif(btrim(p_data->>'notes'), ''), coalesce((p_data->>'is_active')::boolean, true))
    returning id into v_id;
  else
    update public.contacts set code = v_code, name = v_name, id_type = v_idtype, reg_no = nullif(btrim(p_data->>'reg_no'), ''), tin = v_tin,
      sst_no = nullif(btrim(p_data->>'sst_no'), ''), email = nullif(lower(btrim(p_data->>'email')), ''), phone = nullif(btrim(p_data->>'phone'), ''),
      contact_person = nullif(btrim(p_data->>'contact_person'), ''), address = nullif(btrim(p_data->>'address'), ''),
      postcode = nullif(btrim(p_data->>'postcode'), ''), city = nullif(btrim(p_data->>'city'), ''), state = nullif(btrim(p_data->>'state'), ''),
      country = coalesce(nullif(upper(btrim(p_data->>'country')), ''), 'MY'), terms_days = v_terms, credit_limit = v_limit,
      control_account_id = v_ctrl, default_account_id = v_def, default_tax_code_id = v_tax, notes = nullif(btrim(p_data->>'notes'), ''),
      is_active = coalesce((p_data->>'is_active')::boolean, true), updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;
  perform public._audit(p_company, 'contact.save', 'Contact', v_id::text,
    format('%s %s %s (%s)', case when p_id is null then 'Added' else 'Updated' end, lower(v_kind), v_name, v_code));
  return v_id;
end $$;

create or replace function public.delete_contact(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.contacts;
begin
  select * into v from public.contacts where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Contact not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.create');
  if exists (select 1 from public.trade_docs where contact_id = p_id) then
    raise exception 'IN_USE: % has documents, so it stays. Make it inactive instead.', v.name;
  end if;
  delete from public.contacts where id = p_id;
  perform public._audit(v.company_id, 'contact.delete', 'Contact', p_id::text, format('Removed %s %s (%s)', lower(v.kind), v.name, v.code));
end $$;

create or replace function public.save_item(p_company uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_code text := upper(btrim(coalesce(p_data->>'code', ''))); v_desc text := btrim(coalesce(p_data->>'description', ''));
  v_sa uuid := public._try_uuid(p_data->>'sales_account_id'); v_pa uuid := public._try_uuid(p_data->>'purchase_account_id');
  v_st uuid := public._try_uuid(p_data->>'sales_tax_code_id'); v_pt uuid := public._try_uuid(p_data->>'purchase_tax_code_id');
  v_sell numeric; v_buy numeric; v_class text := nullif(btrim(coalesce(p_data->>'classification', '')), '');
begin
  perform public._require_perm(p_company, 'journal.create');
  if p_id is not null and not exists (select 1 from public.items where id = p_id and company_id = p_company) then
    raise exception 'NOT_FOUND: Item not found.';
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
  if v_sa is not null then perform public._check_line_account(p_company, v_sa, 'Sales account'); end if;
  if v_pa is not null then perform public._check_line_account(p_company, v_pa, 'Purchase account'); end if;
  if (v_st is not null and not exists (select 1 from public.tax_codes where id = v_st and company_id = p_company))
     or (v_pt is not null and not exists (select 1 from public.tax_codes where id = v_pt and company_id = p_company)) then
    raise exception 'VALIDATION: Tax code not found.';
  end if;
  if p_id is null then
    insert into public.items (company_id, code, description, uom, sell_price, buy_price, sales_account_id, purchase_account_id,
                              sales_tax_code_id, purchase_tax_code_id, classification, is_active)
    values (p_company, v_code, v_desc, coalesce(nullif(upper(btrim(p_data->>'uom')), ''), 'UNIT'), v_sell, v_buy, v_sa, v_pa, v_st, v_pt,
            v_class, coalesce((p_data->>'is_active')::boolean, true))
    returning id into v_id;
  else
    update public.items set code = v_code, description = v_desc, uom = coalesce(nullif(upper(btrim(p_data->>'uom')), ''), 'UNIT'),
      sell_price = v_sell, buy_price = v_buy, sales_account_id = v_sa, purchase_account_id = v_pa, sales_tax_code_id = v_st,
      purchase_tax_code_id = v_pt, classification = v_class, is_active = coalesce((p_data->>'is_active')::boolean, true), updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;
  perform public._audit(p_company, 'item.save', 'Item', v_id::text, format('%s item %s (%s)', case when p_id is null then 'Added' else 'Updated' end, v_desc, v_code));
  return v_id;
end $$;

create or replace function public.delete_item(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.items;
begin
  select * into v from public.items where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Item not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.create');
  if exists (select 1 from public.trade_doc_lines where item_id = p_id) then
    raise exception 'IN_USE: % is on documents, so it stays. Make it inactive instead.', v.code;
  end if;
  delete from public.items where id = p_id;
  perform public._audit(v.company_id, 'item.delete', 'Item', p_id::text, format('Removed item %s (%s)', v.description, v.code));
end $$;

create or replace function public.save_tax_code(p_company uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_code text := upper(btrim(coalesce(p_data->>'code', ''))); v_name text := btrim(coalesce(p_data->>'name', ''));
  v_rate numeric; v_sa uuid := public._try_uuid(p_data->>'sales_account_id'); v_pa uuid := public._try_uuid(p_data->>'purchase_account_id');
  v_old public.tax_codes;
begin
  perform public._require_perm(p_company, 'company.edit');
  if p_id is not null then
    select * into v_old from public.tax_codes where id = p_id and company_id = p_company for update;
    if not found then raise exception 'NOT_FOUND: Tax code not found.'; end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,10}$' then raise exception 'VALIDATION: The tax code is up to 10 letters, numbers and -'; end if;
  if length(v_name) not between 1 and 60 then raise exception 'VALIDATION: Name the tax code.'; end if;
  begin v_rate := round((p_data->>'rate')::numeric, 2); exception when others then raise exception 'VALIDATION: Enter the rate.'; end;
  if v_rate is null or v_rate not between 0 and 100 then raise exception 'VALIDATION: The rate is 0 to 100%%.'; end if;
  if v_old.id is not null and v_old.rate <> v_rate and exists (select 1 from public.trade_doc_lines where tax_code_id = p_id) then
    raise exception 'VALIDATION: % is already on documents, so its rate stays. Add a new tax code for the new rate.', v_old.code;
  end if;
  if exists (select 1 from public.tax_codes where company_id = p_company and code = v_code and id is distinct from p_id) then
    raise exception 'DUPLICATE: Tax code % already exists.', v_code;
  end if;
  if v_sa is not null and not exists (select 1 from public.accounts where id = v_sa and company_id = p_company and is_postable and type = 'LIABILITY') then
    raise exception 'VALIDATION: The output tax account is a liability account, such as 2150 SST Output Tax.';
  end if;
  if v_pa is not null and not exists (select 1 from public.accounts where id = v_pa and company_id = p_company and is_postable and type = 'ASSET') then
    raise exception 'VALIDATION: The claimable input tax account is an asset account, such as 1195 SST Input Tax.';
  end if;
  if p_id is null then
    insert into public.tax_codes (company_id, code, name, rate, sales_account_id, purchase_account_id, is_active)
    values (p_company, v_code, v_name, v_rate, v_sa, v_pa, coalesce((p_data->>'is_active')::boolean, true)) returning id into v_id;
  else
    update public.tax_codes set code = v_code, name = v_name, rate = v_rate, sales_account_id = v_sa, purchase_account_id = v_pa,
      is_active = coalesce((p_data->>'is_active')::boolean, true), updated_at = now() where id = p_id;
    v_id := p_id;
  end if;
  perform public._audit(p_company, 'tax.save', 'TaxCode', v_id::text, format('%s tax code %s (%s%%)', case when p_id is null then 'Added' else 'Updated' end, v_code, v_rate));
  return v_id;
end $$;

-- Which accounts hold customer / supplier balances.
create or replace function public.set_account_control(p_id uuid, p_control boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.accounts where id = p_id;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  perform public._require_perm(v.company_id, 'account.edit');
  if v.is_control = coalesce(p_control, false) then return; end if;
  if p_control then
    if not v.is_postable or v.is_cash or v.sub_type not in ('CURRENT_ASSET', 'CURRENT_LIABILITY') then
      raise exception 'VALIDATION: Only current asset (receivables) or current liability (payables) accounts can be control accounts.';
    end if;
  else
    if exists (select 1 from public.trade_docs where control_account_id = p_id) or exists (select 1 from public.contacts where control_account_id = p_id) then
      raise exception 'IN_USE: % % already carries customer or supplier documents.', v.code, v.name;
    end if;
  end if;
  update public.accounts set is_control = p_control, updated_at = now() where id = p_id;
  perform public._audit(v.company_id, 'account.edit', 'Account', p_id::text,
    format(case when p_control then 'Made %s %s a control account' else 'Stopped %s %s being a control account' end, v.code, v.name));
end $$;

-- ─── Documents ──────────────────────────────────────────────────────────────
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

  if p_post then
    return public._post_trade_doc(v_id, p_series, p_doc_no, p_allocations, coalesce((p_doc->>'allow_over_limit')::boolean, false));
  end if;
  perform public._audit(p_company, 'trade.save', 'TradeDoc', v_id::text,
    format('%s draft %s%s for %s', case when p_id is null then 'Created' else 'Edited' end, lower(v_m.label),
           coalesce(' ' || nullif(btrim(p_doc->>'reference'), ''), ''), to_char(v_tot, 'FM999,999,999,990.00')));
  return jsonb_build_object('id', v_id, 'status', 'DRAFT', 'total', v_tot);
end $$;

-- Knock-off: a settling document (receipt, payment, credit note) against a
-- charge (invoice, bill, debit note, refund) of the same customer or supplier.
create or replace function public._allocate(p_from uuid, p_to uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_f public.trade_docs; v_t public.trade_docs; v_fm record; v_tm record; v_amt numeric := round(p_amount, 2);
begin
  perform 1 from public.trade_docs where id in (p_from, p_to) order by id for update;
  select * into v_f from public.trade_docs where id = p_from;
  select * into v_t from public.trade_docs where id = p_to;
  if v_f.id is null or v_t.id is null or v_f.company_id <> v_t.company_id then raise exception 'NOT_FOUND: Document not found.'; end if;
  select * into v_fm from public._trade_meta(v_f.doc_type);
  select * into v_tm from public._trade_meta(v_t.doc_type);
  if v_fm.effect <> -1 or v_tm.effect <> 1 then
    raise exception 'VALIDATION: Receipts, payments and credit notes knock off invoices, bills, debit notes and refunds.';
  end if;
  if v_f.status <> 'POSTED' or v_t.status <> 'POSTED' then raise exception 'INVALID_STATE: Only posted documents can be knocked off.'; end if;
  if v_f.contact_id is distinct from v_t.contact_id or v_f.side <> v_t.side then
    raise exception 'VALIDATION: % and % belong to different %s.', v_f.doc_no, v_t.doc_no, case v_f.side when 'AR' then 'customer' else 'supplier' end;
  end if;
  if v_f.control_account_id is distinct from v_t.control_account_id then
    raise exception 'VALIDATION: % and % sit on different control accounts.', v_f.doc_no, v_t.doc_no;
  end if;
  if v_amt is null or v_amt <= 0 then raise exception 'VALIDATION: Knock off an amount greater than zero.'; end if;
  if v_amt > v_t.total - v_t.allocated then
    raise exception 'VALIDATION: Only % is still open on %.', to_char(v_t.total - v_t.allocated, 'FM999,999,999,990.00'), v_t.doc_no;
  end if;
  if v_amt > v_f.total - v_f.allocated then
    raise exception 'VALIDATION: Only % of % is left to apply.', to_char(v_f.total - v_f.allocated, 'FM999,999,999,990.00'), v_f.doc_no;
  end if;
  insert into public.trade_allocations (company_id, from_doc_id, to_doc_id, amount, date, created_by)
  values (v_f.company_id, p_from, p_to, v_amt, greatest(v_f.date, v_t.date), auth.uid());
  update public.trade_docs set allocated = allocated + v_amt where id in (p_from, p_to);
end $$;

-- Items: [{doc_id, amount}], applied from (or to) p_doc depending on its kind.
create or replace function public._apply_allocations(p_doc uuid, p_items jsonb)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_other uuid; v_amt numeric; v_effect int; v_sum numeric := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return 0; end if;
  select m.effect into v_effect from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m where d.id = p_doc;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_other := public._try_uuid(v_item->>'doc_id');
    begin v_amt := round((v_item->>'amount')::numeric, 2); exception when others then v_amt := null; end;
    if v_other is null or coalesce(v_amt, 0) = 0 then continue; end if;
    if v_effect = -1 then perform public._allocate(p_doc, v_other, v_amt);
    else perform public._allocate(v_other, p_doc, v_amt); end if;
    v_sum := v_sum + v_amt;
  end loop;
  return v_sum;
end $$;

create or replace function public._contact_balance(p_contact uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(m.effect * d.total), 0) from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
  where d.contact_id = p_contact and d.status = 'POSTED' and m.effect <> 0;
$$;

create or replace function public._post_trade_doc(p_id uuid, p_series uuid, p_doc_no text, p_allocations jsonb, p_over_limit boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_d public.trade_docs; v_m record; v_c public.contacts; v_series public.document_series; v_num record; v_lines jsonb;
  v_head uuid; v_saved jsonb; v_je uuid; v_posted jsonb; v_bad record; v_bal numeric; v_charge_acc uuid; v_dup text;
  v_party text; v_src public.trade_docs; v_auto numeric;
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
      v_lines := jsonb_build_array(jsonb_build_object('account_id', v_head,
        'debit', case when v_m.head_debit then v_d.total else 0 end, 'credit', case when v_m.head_debit then 0 else v_d.total end,
        'description', left(coalesce(v_party, v_m.label), 200)));
      select v_lines || coalesce(jsonb_agg(jsonb_build_object('account_id', x.account_id,
               'debit', case when v_m.head_debit then 0 else x.amt end, 'credit', case when v_m.head_debit then x.amt else 0 end,
               'description', x.descr) order by x.ord), '[]'::jsonb)
        into v_lines
      from (
        select l.line_no as ord, l.account_id, left(l.description, 200) as descr,
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

create or replace function public.post_trade_doc(p_id uuid, p_series uuid default null, p_doc_no text default null,
                                                 p_allocations jsonb default null, p_allow_over_limit boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public._post_trade_doc(p_id, p_series, p_doc_no, p_allocations, p_allow_over_limit);
end $$;

create or replace function public.allocate_trade_doc(p_doc uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.trade_docs; v_sum numeric;
begin
  select * into v from public.trade_docs where id = p_doc;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.post');
  v_sum := public._apply_allocations(p_doc, p_items);
  perform public._audit(v.company_id, 'trade.allocate', 'TradeDoc', p_doc::text,
    format('Knocked off %s against %s', to_char(v_sum, 'FM999,999,999,990.00'), v.doc_no));
  return jsonb_build_object('applied', v_sum);
end $$;

create or replace function public.unallocate_trade(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.trade_allocations; v_f text; v_t text;
begin
  select * into v from public.trade_allocations where id = p_id;
  if not found then raise exception 'NOT_FOUND: Knock-off not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.post');
  perform 1 from public.trade_docs where id in (v.from_doc_id, v.to_doc_id) order by id for update;
  delete from public.trade_allocations where id = p_id;
  update public.trade_docs set allocated = allocated - v.amount where id in (v.from_doc_id, v.to_doc_id);
  select doc_no into v_f from public.trade_docs where id = v.from_doc_id;
  select doc_no into v_t from public.trade_docs where id = v.to_doc_id;
  perform public._audit(v.company_id, 'trade.unallocate', 'TradeDoc', v.to_doc_id::text,
    format('Removed knock-off of %s from %s against %s', to_char(v.amount, 'FM999,999,999,990.00'), v_f, v_t));
end $$;

create or replace function public.void_trade_doc(p_id uuid, p_date date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.trade_docs; v_m record; v_r jsonb; v_date date; v_a record;
begin
  select * into v from public.trade_docs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
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

create or replace function public.delete_trade_doc(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.trade_docs;
begin
  select * into v from public.trade_docs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.delete');
  if v.status <> 'DRAFT' then raise exception 'IMMUTABLE: Posted documents are never deleted — void them instead.'; end if;
  delete from public.trade_docs where id = p_id;
  perform public._audit(v.company_id, 'trade.delete', 'TradeDoc', p_id::text,
    format('Deleted draft %s', lower((select label from public._trade_meta(v.doc_type)))));
end $$;

-- Quotation → invoice, purchase order → bill, invoice → credit/debit note, or a copy.
create or replace function public.copy_trade_doc(p_id uuid, p_to_type text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v public.trade_docs; v_to text := upper(btrim(coalesce(p_to_type, ''))); v_m record; v_new uuid; v_convert boolean;
begin
  select * into v from public.trade_docs where id = p_id;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v.company_id, 'journal.create');
  select * into v_m from public._trade_meta(v_to);
  v_convert := v_to <> v.doc_type;
  if v_m.side is null or not v_m.has_lines or v_m.side <> v.side
     or (v_convert and not (v.doc_type, v_to) in (('QUOTATION', 'INVOICE'), ('QUOTATION', 'CASH_SALE'),
                                                  ('PURCHASE_ORDER', 'BILL'), ('PURCHASE_ORDER', 'CASH_PURCHASE'),
                                                  ('INVOICE', 'CREDIT_NOTE'), ('INVOICE', 'DEBIT_NOTE'),
                                                  ('BILL', 'SUPPLIER_CN'), ('BILL', 'SUPPLIER_DN'))) then
    raise exception 'VALIDATION: That document can''t be turned into a %.', lower(coalesce(v_m.label, 'document'));
  end if;
  if not (select has_lines from public._trade_meta(v.doc_type)) then raise exception 'VALIDATION: Only documents with lines can be copied.'; end if;
  if v_convert and v.status <> 'POSTED' then raise exception 'INVALID_STATE: Post the % first.', lower((select label from public._trade_meta(v.doc_type))); end if;

  insert into public.trade_docs (company_id, side, doc_type, contact_id, bill_name, bill_address, attention, date, terms_days,
    reference, description, notes, tax_inclusive, subtotal, tax_total, total, control_account_id, source_doc_id, created_by)
  values (v.company_id, v.side, v_to, v.contact_id, v.bill_name, v.bill_address, v.attention, current_date,
    case when v_m.effect = 1 then v.terms_days end,
    case when v_convert and v_to in ('CREDIT_NOTE', 'DEBIT_NOTE', 'SUPPLIER_CN', 'SUPPLIER_DN') then v.doc_no else v.reference end,
    v.description, v.notes, v.tax_inclusive, v.subtotal, v.tax_total, v.total,
    case when v_m.uses_control then v.control_account_id end, case when v_convert then p_id end, auth.uid())
  returning id into v_new;
  if v_m.uses_control and v.control_account_id is null then
    update public.trade_docs set control_account_id = coalesce((select control_account_id from public.contacts where id = v.contact_id),
                                                               public._default_control(v.company_id, v.side))
    where id = v_new;
  end if;
  if v_m.effect = 1 then
    update public.trade_docs set due_date = current_date + coalesce(v.terms_days, 30) where id = v_new;
  elsif v_to in ('QUOTATION', 'PURCHASE_ORDER') then
    update public.trade_docs set due_date = current_date + 30 where id = v_new;
  end if;
  insert into public.trade_doc_lines (doc_id, company_id, line_no, item_id, description, qty, uom, unit_price, discount,
                                      account_id, tax_code_id, tax_rate, amount, tax_amount, total)
  select v_new, l.company_id, l.line_no, l.item_id, l.description, l.qty, l.uom, l.unit_price, l.discount,
         coalesce(l.account_id, case v.side when 'AR' then i.sales_account_id else i.purchase_account_id end),
         l.tax_code_id, l.tax_rate, l.amount, l.tax_amount, l.total
  from public.trade_doc_lines l left join public.items i on i.id = l.item_id
  where l.doc_id = p_id;
  perform public._audit(v.company_id, 'trade.save', 'TradeDoc', v_new::text,
    format('Created draft %s from %s', lower(v_m.label), coalesce(v.doc_no, 'a draft')));
  return v_new;
end $$;

-- ─── Reports ────────────────────────────────────────────────────────────────
-- Open documents of one customer or supplier, for knocking off.
create or replace function public.trade_open_docs(p_contact uuid)
returns table (id uuid, doc_type text, doc_no text, date date, due_date date, reference text, total numeric,
               allocated numeric, outstanding numeric, effect int)
language plpgsql stable security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.contacts where contacts.id = p_contact;
  if not found then raise exception 'NOT_FOUND: Contact not found.'; end if;
  perform public._require_perm(v_company, 'journal.view');
  return query
  select d.id, d.doc_type, d.doc_no, d.date, d.due_date, d.reference, d.total, d.allocated, d.total - d.allocated, m.effect
  from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
  where d.contact_id = p_contact and d.status = 'POSTED' and m.effect <> 0 and d.total > d.allocated
  order by coalesce(d.due_date, d.date), d.date, d.doc_no;
end $$;

-- Aged receivables / payables by due date, as at a date.
create or replace function public.trade_aging(p_company uuid, p_side text, p_as_at date default null)
returns table (contact_id uuid, code text, name text, terms_days int, credit_limit numeric,
               not_due numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d91_120 numeric, d120_plus numeric,
               unapplied numeric, balance numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_at date := coalesce(p_as_at, current_date);
begin
  if not (public.has_perm(p_company, 'report.view') or public.has_perm(p_company, 'journal.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view reports in these books.';
  end if;
  return query
  with docs as (
    select d.contact_id, m.effect, coalesce(d.due_date, d.date) as due,
           d.total - coalesce((select sum(a.amount) from public.trade_allocations a
                               where (a.to_doc_id = d.id or a.from_doc_id = d.id) and a.date <= v_at), 0) as open_amt
    from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.company_id = p_company and d.side = upper(p_side) and m.effect <> 0 and d.date <= v_at
      and (d.status = 'POSTED' or (d.status = 'VOID' and d.void_date > v_at))),
  agg as (
    select x.contact_id,
      coalesce(sum(x.open_amt) filter (where x.effect = 1 and v_at - x.due <= 0), 0) as nd,
      coalesce(sum(x.open_amt) filter (where x.effect = 1 and v_at - x.due between 1 and 30), 0) as a1,
      coalesce(sum(x.open_amt) filter (where x.effect = 1 and v_at - x.due between 31 and 60), 0) as a2,
      coalesce(sum(x.open_amt) filter (where x.effect = 1 and v_at - x.due between 61 and 90), 0) as a3,
      coalesce(sum(x.open_amt) filter (where x.effect = 1 and v_at - x.due between 91 and 120), 0) as a4,
      coalesce(sum(x.open_amt) filter (where x.effect = 1 and v_at - x.due > 120), 0) as a5,
      coalesce(sum(x.open_amt) filter (where x.effect = -1), 0) as un
    from docs x where x.open_amt <> 0 group by x.contact_id)
  select c.id, c.code, c.name, c.terms_days, c.credit_limit, agg.nd, agg.a1, agg.a2, agg.a3, agg.a4, agg.a5, agg.un,
         agg.nd + agg.a1 + agg.a2 + agg.a3 + agg.a4 + agg.a5 - agg.un
  from agg join public.contacts c on c.id = agg.contact_id
  order by c.name;
end $$;

-- Statement of account: balance brought forward, every document and void in
-- the period with a running balance, and the aging at the end date.
create or replace function public.contact_statement(p_contact uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_c public.contacts; v_open numeric; v_rows jsonb; v_aging jsonb; v_to date := coalesce(p_to, current_date);
        v_from date := coalesce(p_from, date_trunc('month', coalesce(p_to, current_date))::date);
begin
  select * into v_c from public.contacts where id = p_contact;
  if not found then raise exception 'NOT_FOUND: Contact not found.'; end if;
  perform public._require_perm(v_c.company_id, 'journal.view');
  if v_from > v_to then raise exception 'VALIDATION: The start date is after the end date.'; end if;

  select coalesce(sum(m.effect * d.total), 0) into v_open
  from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
  where d.contact_id = p_contact and m.effect <> 0 and d.date < v_from
    and (d.status = 'POSTED' or (d.status = 'VOID' and d.void_date >= v_from));

  with ev as (
    select d.date, 0 as ord, d.doc_type, d.doc_no, d.due_date, d.reference,
           coalesce(d.description, m.label) as description, m.effect * d.total as amt, d.id
    from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.contact_id = p_contact and m.effect <> 0 and d.status in ('POSTED', 'VOID') and d.date between v_from and v_to
    union all
    select d.void_date, 1, d.doc_type, d.doc_no, null, d.reference, 'Cancelled: ' || coalesce(d.void_reason, ''), -m.effect * d.total, d.id
    from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.contact_id = p_contact and m.effect <> 0 and d.status = 'VOID' and d.void_date between v_from and v_to)
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'date', r.date, 'doc_type', r.doc_type, 'doc_no', r.doc_no,
           'due_date', r.due_date, 'reference', r.reference, 'description', r.description,
           'increase', case when r.amt > 0 then r.amt else 0 end, 'decrease', case when r.amt < 0 then -r.amt else 0 end,
           'balance', r.bal) order by r.date, r.ord, r.doc_no), '[]'::jsonb) into v_rows
  from (select ev.*, v_open + sum(ev.amt) over (order by ev.date, ev.ord, ev.doc_no rows between unbounded preceding and current row) as bal from ev) r;

  select to_jsonb(a) into v_aging from public.trade_aging(v_c.company_id, case v_c.kind when 'CUSTOMER' then 'AR' else 'AP' end, v_to) a
   where a.contact_id = p_contact;
  return jsonb_build_object('contact', to_jsonb(v_c), 'from', v_from, 'to', v_to, 'opening', v_open, 'lines', v_rows,
    'closing', v_open + coalesce((select sum((x->>'increase')::numeric - (x->>'decrease')::numeric) from jsonb_array_elements(v_rows) x), 0),
    'aging', coalesce(v_aging, '{}'::jsonb));
end $$;

-- Cash book: every receipt and payment through one bank/cash account.
create or replace function public.cash_book(p_company uuid, p_account uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_acc record; v_open numeric; v_rows jsonb; v_to date := coalesce(p_to, current_date);
begin
  if not (public.has_perm(p_company, 'ledger.view') or public.has_perm(p_company, 'report.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view the ledger in these books.';
  end if;
  select id, code, name, type, is_cash into v_acc from public.accounts where id = p_account and company_id = p_company;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  if not public._statement_account_ok(p_company, p_account) then
    raise exception 'VALIDATION: % % is not a bank, cash or card account.', v_acc.code, v_acc.name;
  end if;
  select coalesce(sum(l.debit - l.credit), 0) into v_open
    from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
   where l.account_id = p_account and e.status in ('POSTED', 'REVERSED') and p_from is not null and e.date < p_from;
  select coalesce(jsonb_agg(r order by r.date, r.reference, r.line_no), '[]'::jsonb) into v_rows from (
    select e.id as entry_id, e.date, e.reference, e.doc_no, e.doc_type, e.party, e.source, e.source_id, e.status,
           coalesce(l.description, e.description) as description, l.line_no,
           (select string_agg(a.code || ' ' || a.name, ', ' order by l2.line_no)
              from public.journal_lines l2 join public.accounts a on a.id = l2.account_id
             where l2.journal_entry_id = e.id and l2.account_id <> p_account) as contra,
           l.debit as receipt, l.credit as payment,
           v_open + sum(l.debit - l.credit) over (order by e.date, e.reference, l.line_no rows between unbounded preceding and current row) as balance
    from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
    where l.account_id = p_account and e.status in ('POSTED', 'REVERSED')
      and (p_from is null or e.date >= p_from) and e.date <= v_to) r;
  return jsonb_build_object('account', jsonb_build_object('id', v_acc.id, 'code', v_acc.code, 'name', v_acc.name, 'type', v_acc.type),
    'from', p_from, 'to', v_to, 'opening', v_open, 'lines', v_rows,
    'receipts', coalesce((select sum((x->>'receipt')::numeric) from jsonb_array_elements(v_rows) x), 0),
    'payments', coalesce((select sum((x->>'payment')::numeric) from jsonb_array_elements(v_rows) x), 0),
    'closing', v_open + coalesce((select sum((x->>'receipt')::numeric - (x->>'payment')::numeric) from jsonb_array_elements(v_rows) x), 0));
end $$;

-- Cash book entry: one PV or OR with several lines (and SST).
create or replace function public.record_cash_entry(p_company uuid, p_kind text, p_date date, p_money_account uuid, p_lines jsonb,
                                                    p_description text default null, p_party text default null, p_method text default null,
                                                    p_reference text default null, p_series uuid default null, p_doc_no text default null,
                                                    p_tax_inclusive boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind text := upper(coalesce(p_kind, '')); v_line jsonb; v_no int := 0; v_amt numeric; v_net numeric; v_tax numeric;
  v_acc uuid; v_tc public.tax_codes; v_total numeric := 0; v_gl jsonb := '[]'::jsonb; v_taxes jsonb := '{}'::jsonb;
  v_desc text; v_saved jsonb; v_series public.document_series; v_num record; v_k text; v_first text;
begin
  perform public._require_perm(p_company, 'journal.create');
  perform public._require_perm(p_company, 'journal.post');
  if v_kind not in ('IN', 'OUT') then raise exception 'VALIDATION: Choose money in or money out.'; end if;
  if p_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  if p_money_account is null or not public._statement_account_ok(p_company, p_money_account) then
    raise exception 'VALIDATION: Choose the bank or cash account.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'VALIDATION: Add at least one line.'; end if;
  if jsonb_array_length(p_lines) > 100 then raise exception 'VALIDATION: An entry can have at most 100 lines.'; end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin v_amt := round(coalesce(nullif(v_line->>'amount', '')::numeric, 0), 2);
    exception when others then raise exception 'VALIDATION: Line %: the amount must be a number.', v_no + 1; end;
    if v_amt = 0 then continue; end if;
    v_no := v_no + 1;
    if v_amt < 0 then raise exception 'VALIDATION: Line %: amounts are positive.', v_no; end if;
    v_acc := public._try_uuid(v_line->>'account_id');
    if v_acc is null then raise exception 'VALIDATION: Line %: choose an account.', v_no; end if;
    perform public._check_line_account(p_company, v_acc, format('Line %s', v_no));
    if v_acc = p_money_account then raise exception 'VALIDATION: Line %: choose an account other than the bank account.', v_no; end if;
    v_tc := null; v_tax := 0; v_net := v_amt;
    if public._try_uuid(v_line->>'tax_code_id') is not null then
      select * into v_tc from public.tax_codes where id = public._try_uuid(v_line->>'tax_code_id') and company_id = p_company and is_active;
      if not found then raise exception 'VALIDATION: Line %: choose an active tax code.', v_no; end if;
      if v_tc.rate > 0 then
        if coalesce(p_tax_inclusive, true) then v_tax := round(v_amt * v_tc.rate / (100 + v_tc.rate), 2); v_net := v_amt - v_tax;
        else v_tax := round(v_amt * v_tc.rate / 100, 2); end if;
      end if;
      if v_kind = 'IN' and v_tax > 0 and v_tc.sales_account_id is null then
        raise exception 'VALIDATION: Line %: tax code % has no output tax account.', v_no, v_tc.code;
      end if;
    end if;
    v_desc := left(nullif(btrim(v_line->>'description'), ''), 200);
    v_first := coalesce(v_first, v_desc);
    if v_kind = 'OUT' and v_tax > 0 and v_tc.purchase_account_id is null then
      v_net := v_net + v_tax; v_tax := 0;  -- SST that can't be claimed is part of the cost
    end if;
    v_gl := v_gl || jsonb_build_array(jsonb_build_object('account_id', v_acc, 'description', v_desc,
      'debit', case when v_kind = 'OUT' then v_net else 0 end, 'credit', case when v_kind = 'IN' then v_net else 0 end));
    if v_tax > 0 then
      v_k := (case when v_kind = 'IN' then v_tc.sales_account_id else v_tc.purchase_account_id end)::text;
      v_taxes := jsonb_set(v_taxes, array[v_k], to_jsonb(coalesce((v_taxes->>v_k)::numeric, 0) + v_tax));
    end if;
    v_total := v_total + v_net + v_tax;
  end loop;
  if v_no = 0 or v_total <= 0 then raise exception 'VALIDATION: Enter at least one amount.'; end if;

  select v_gl || coalesce(jsonb_agg(jsonb_build_object('account_id', t.key, 'description', 'SST',
           'debit', case when v_kind = 'OUT' then t.value::numeric else 0 end,
           'credit', case when v_kind = 'IN' then t.value::numeric else 0 end)), '[]'::jsonb)
    into v_gl from jsonb_each_text(v_taxes) t;
  v_gl := jsonb_build_array(jsonb_build_object('account_id', p_money_account,
            'debit', case when v_kind = 'IN' then v_total else 0 end, 'credit', case when v_kind = 'OUT' then v_total else 0 end,
            'description', left(nullif(btrim(p_party), ''), 200))) || v_gl;

  v_saved := public.save_journal(p_company, null, p_date,
    left(coalesce(nullif(btrim(p_description), ''), v_first, case v_kind when 'IN' then 'Money in' else 'Money out' end), 500),
    nullif(btrim(p_reference), ''), v_gl, null);
  v_series := public._resolve_series(p_company, case v_kind when 'IN' then 'RECEIPT' else 'PAYMENT' end, p_series, p_money_account);
  if v_series.id is null then
    raise exception 'VALIDATION: These books have no % numbering series. Add one under Numbering.', case v_kind when 'IN' then 'receipt' else 'payment' end;
  end if;
  select * into v_num from public._assign_number(v_series, p_date, p_doc_no, false);
  update public.journal_entries set source = 'BANK', txn_kind = v_kind, doc_type = case v_kind when 'IN' then 'OR' else 'PV' end,
    doc_no = v_num.doc_text, doc_series_id = case when v_num.doc_seq is null then null else v_series.id end,
    doc_period = v_num.doc_period, doc_seq = v_num.doc_seq,
    party = left(nullif(btrim(p_party), ''), 200), pay_method = left(nullif(btrim(p_method), ''), 60)
  where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid)
    || jsonb_build_object('kind', v_kind, 'doc_no', v_num.doc_text, 'doc_type', case v_kind when 'IN' then 'OR' else 'PV' end, 'lines', v_no);
end $$;

-- Customer and supplier balances agree with their control accounts.
create or replace function public.trade_proof(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb; v_alloc int;
begin
  if not (public.has_perm(p_company, 'report.view') or public.has_perm(p_company, 'ledger.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view reports in these books.';
  end if;
  with gl as (
    select l.account_id, sum(l.debit - l.credit) as bal
    from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
    where e.company_id = p_company and e.status in ('POSTED', 'REVERSED') group by l.account_id),
  sub as (
    select d.control_account_id as account_id, sum(m.effect * d.total * case d.side when 'AR' then 1 else -1 end) as bal
    from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.company_id = p_company and d.status = 'POSTED' and d.control_account_id is not null group by d.control_account_id)
  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name,
           'side', case when a.type = 'ASSET' then 'AR' else 'AP' end,
           'ledger', case when a.type = 'ASSET' then coalesce(gl.bal, 0) else -coalesce(gl.bal, 0) end,
           'documents', case when a.type = 'ASSET' then coalesce(sub.bal, 0) else -coalesce(sub.bal, 0) end,
           'difference', coalesce(gl.bal, 0) - coalesce(sub.bal, 0)) order by a.code), '[]'::jsonb)
    into v_rows
  from public.accounts a left join gl on gl.account_id = a.id left join sub on sub.account_id = a.id
  where a.company_id = p_company and a.is_control;

  select count(*) into v_alloc from public.trade_docs d
  where d.company_id = p_company and d.allocated <> coalesce((select sum(amount) from public.trade_allocations a
                                                               where a.from_doc_id = d.id or a.to_doc_id = d.id), 0);
  return jsonb_build_object('accounts', v_rows, 'allocation_errors', v_alloc,
    'difference', coalesce((select sum(abs((x->>'difference')::numeric)) from jsonb_array_elements(v_rows) x), 0));
end $$;

-- ─── Proof: numbering gaps across journals and documents; sub-ledgers tie ───
create or replace function public.books_proof(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_entries int; v_unbalanced int; v_dr numeric; v_cr numeric; v_gaps int; v_headings int;
  v_assets numeric; v_liab numeric; v_equity numeric; v_result numeric; v_audit int; v_last timestamptz; v_closed int;
  v_trade jsonb; v_docs int;
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

  -- Per series and period, the highest automatic number equals how many were
  -- handed out, apart from deliberate jumps and numbers keyed by hand.
  select coalesce(sum(greatest(0, x.mx - x.n - coalesce(ns.skipped, 0))), 0)::int into v_gaps
  from (
    select y.code, y.period, max(y.seq) as mx, count(*) as n from (
      select s.code, e.ref_period as period, e.ref_seq as seq
      from public.journal_entries e join public.document_series s on s.id = e.ref_series_id
      where e.company_id = p_company and e.status in ('POSTED', 'REVERSED') and e.ref_seq is not null
      union all
      select s.code, e.doc_period, e.doc_seq
      from public.journal_entries e join public.document_series s on s.id = e.doc_series_id
      where e.company_id = p_company and e.status in ('POSTED', 'REVERSED') and e.doc_seq is not null
      union all
      select s.code, d.doc_period, d.doc_seq
      from public.trade_docs d join public.document_series s on s.id = d.series_id
      where d.company_id = p_company and d.status in ('POSTED', 'VOID') and d.doc_seq is not null) y
    group by y.code, y.period) x
  left join public.number_sequences ns on ns.company_id = p_company and ns.doc_type = x.code and ns.year = x.period;

  select count(*), max(created_at) into v_audit, v_last from public.audit_log where company_id = p_company;
  select count(*) into v_closed from public.fiscal_periods where company_id = p_company and status = 'CLOSED';
  select count(*) into v_docs from public.trade_docs where company_id = p_company and status <> 'DRAFT';
  v_trade := public.trade_proof(p_company);

  return jsonb_build_object(
    'entries', v_entries, 'unbalanced', v_unbalanced,
    'total_debit', v_dr, 'total_credit', v_cr,
    'assets', v_assets, 'liabilities', v_liab, 'equity', v_equity, 'result', v_result,
    'numbering_gaps', v_gaps, 'lines_on_headings', v_headings,
    'audit_events', v_audit, 'last_audit_at', v_last, 'closed_periods', v_closed,
    'documents', v_docs, 'subledger_difference', v_trade->'difference', 'allocation_errors', v_trade->'allocation_errors',
    'control_accounts', v_trade->'accounts');
end $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function
  public._trade_meta(text), public._try_uuid(text), public._series_label(text), public._series_used(uuid),
  public._seed_trade_setup(uuid), public._guard_trade_doc(), public._guard_trade_line(), public._default_control(uuid, text),
  public._check_line_account(uuid, uuid, text), public._allocate(uuid, uuid, numeric), public._apply_allocations(uuid, jsonb),
  public._contact_balance(uuid), public._post_trade_doc(uuid, uuid, text, jsonb, boolean),
  public._number_taken(uuid, text), public._assign_number(public.document_series, date, text, boolean),
  public._post(uuid, uuid, text), public._bootstrap_company(uuid, text, text, text, int, text)
from public, anon, authenticated;
revoke execute on function
  public.save_contact(uuid, uuid, jsonb), public.delete_contact(uuid), public.save_item(uuid, uuid, jsonb), public.delete_item(uuid),
  public.save_tax_code(uuid, uuid, jsonb), public.set_account_control(uuid, boolean),
  public.save_trade_doc(uuid, uuid, jsonb, jsonb, boolean, uuid, text, jsonb), public.post_trade_doc(uuid, uuid, text, jsonb, boolean),
  public.allocate_trade_doc(uuid, jsonb), public.unallocate_trade(uuid), public.void_trade_doc(uuid, date, text),
  public.delete_trade_doc(uuid), public.copy_trade_doc(uuid, text), public.trade_open_docs(uuid),
  public.trade_aging(uuid, text, date), public.contact_statement(uuid, date, date), public.cash_book(uuid, uuid, date, date),
  public.record_cash_entry(uuid, text, date, uuid, jsonb, text, text, text, text, uuid, text, boolean), public.trade_proof(uuid),
  public.reverse_journal(uuid, date, text), public.document_series_overview(uuid, date),
  public.save_document_series(uuid, uuid, text, text, text, text, text, text, text, uuid, boolean, boolean, int),
  public.delete_document_series(uuid), public.books_proof(uuid)
from public, anon;
grant execute on function
  public.save_contact(uuid, uuid, jsonb), public.delete_contact(uuid), public.save_item(uuid, uuid, jsonb), public.delete_item(uuid),
  public.save_tax_code(uuid, uuid, jsonb), public.set_account_control(uuid, boolean),
  public.save_trade_doc(uuid, uuid, jsonb, jsonb, boolean, uuid, text, jsonb), public.post_trade_doc(uuid, uuid, text, jsonb, boolean),
  public.allocate_trade_doc(uuid, jsonb), public.unallocate_trade(uuid), public.void_trade_doc(uuid, date, text),
  public.delete_trade_doc(uuid), public.copy_trade_doc(uuid, text), public.trade_open_docs(uuid),
  public.trade_aging(uuid, text, date), public.contact_statement(uuid, date, date), public.cash_book(uuid, uuid, date, date),
  public.record_cash_entry(uuid, text, date, uuid, jsonb, text, text, text, text, uuid, text, boolean), public.trade_proof(uuid),
  public.reverse_journal(uuid, date, text), public.document_series_overview(uuid, date),
  public.save_document_series(uuid, uuid, text, text, text, text, text, text, text, uuid, boolean, boolean, int),
  public.delete_document_series(uuid), public.books_proof(uuid)
to authenticated;
