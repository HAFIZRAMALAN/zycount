-- ═══════════════════════════════════════════════════════════════════════════
-- Zycount — Phase 1 core accounting on Supabase (Postgres + Auth + RLS)
--
-- Mirrors the domain model in packages/db/prisma/schema.prisma and the rules in
-- docs/spec/01: balanced journals, immutable posted entries (reverse, never
-- edit), period locking, gap-free posted numbering, append-only audit trail.
--
-- Security model: every table has RLS. Clients may only SELECT (per-company,
-- per-permission). Every write goes through a SECURITY DEFINER function that
-- checks the caller's role in that company and enforces the invariants.
-- Errors are raised as 'CODE: human message' so the client can show both.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Types ──────────────────────────────────────────────────────────────────
create type public.account_type as enum ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','COST_OF_SALES');
create type public.account_sub_type as enum (
  'CURRENT_ASSET','NON_CURRENT_ASSET','CURRENT_LIABILITY','NON_CURRENT_LIABILITY','EQUITY',
  'OPERATING_REVENUE','OTHER_INCOME','COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE');
create type public.period_status as enum ('OPEN','CLOSED');
create type public.journal_status as enum ('DRAFT','POSTED','REVERSED');
create type public.journal_source as enum ('MANUAL','OPENING_BALANCE','INVOICE','BILL','PAYMENT','PAYROLL','ASSET','INVENTORY','BANK','SYSTEM');

-- ─── Tables ─────────────────────────────────────────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  created_at timestamptz not null default now()
);

create table public.roles (
  name        text primary key,
  description text not null,
  permissions text[] not null
);

create table public.companies (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(btrim(name)) between 2 and 200),
  registration_no         text,
  tax_registration_no     text,
  email                   text,
  phone                   text,
  address                 text,
  base_currency           char(3) not null default 'MYR',
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null references public.roles(name),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_members_user_idx on public.company_members(user_id);

create table public.accounts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null check (code ~ '^[0-9A-Za-z.\-]{1,20}$'),
  name        text not null check (length(btrim(name)) between 1 and 200),
  type        public.account_type not null,
  sub_type    public.account_sub_type,
  parent_id   uuid references public.accounts(id),
  description text,
  is_postable boolean not null default true,
  is_active   boolean not null default true,
  is_system   boolean not null default false,
  is_cash     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, code)
);
create index accounts_company_type_idx on public.accounts(company_id, type);
create index accounts_parent_idx on public.accounts(parent_id);

create table public.fiscal_periods (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  name          text not null,
  year          int not null,
  period_no     smallint not null check (period_no between 1 and 12),
  start_date    date not null,
  end_date      date not null check (end_date >= start_date),
  status        public.period_status not null default 'OPEN',
  closed_at     timestamptz,
  closed_by     uuid,
  reopened_at   timestamptz,
  reopened_by   uuid,
  reopen_reason text,
  created_at    timestamptz not null default now(),
  unique (company_id, year, period_no),
  unique (company_id, start_date)
);
create index fiscal_periods_company_dates_idx on public.fiscal_periods(company_id, start_date, end_date);

create table public.number_sequences (
  company_id  uuid not null references public.companies(id) on delete cascade,
  doc_type    text not null,
  year        int not null,
  next_number int not null default 1,
  primary key (company_id, doc_type, year)
);

create table public.journal_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  fiscal_period_id uuid references public.fiscal_periods(id),
  reference        text,                         -- assigned when posted: JV-2026-000001
  date             date not null,
  description      text,
  memo             text,
  status           public.journal_status not null default 'DRAFT',
  source           public.journal_source not null default 'MANUAL',
  source_id        uuid,
  reversal_of_id   uuid unique references public.journal_entries(id),
  total_debit      numeric(18,2) not null default 0,
  total_credit     numeric(18,2) not null default 0,
  version          int not null default 1,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  posted_at        timestamptz,
  posted_by        uuid,
  unique (company_id, reference),
  constraint posted_entries_are_complete check (
    status = 'DRAFT'
    or (reference is not null and fiscal_period_id is not null and posted_at is not null
        and total_debit = total_credit and total_debit > 0))
);
create index journal_entries_company_date_idx on public.journal_entries(company_id, date);
create index journal_entries_company_status_idx on public.journal_entries(company_id, status);

create table public.journal_lines (
  id               uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id       uuid not null references public.accounts(id),
  line_no          int not null,
  description      text,
  debit            numeric(18,2) not null default 0 check (debit >= 0),
  credit           numeric(18,2) not null default 0 check (credit >= 0),
  constraint one_sided_line check ((debit = 0) <> (credit = 0))
);
create index journal_lines_entry_idx on public.journal_lines(journal_entry_id);
create index journal_lines_account_idx on public.journal_lines(account_id);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid references public.companies(id) on delete cascade,
  user_id     uuid,
  user_email  text,
  action      text not null,
  entity_type text,
  entity_id   text,
  summary     text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_company_created_idx on public.audit_log(company_id, created_at desc);

-- ─── Roles & permissions (mirrors packages/shared/src/permissions.ts) ───────
insert into public.roles (name, description, permissions) values
 ('SuperAdmin','Unrestricted access across the whole organisation.', array[
   'company.view','company.create','company.edit','company.delete','user.view','user.create','user.edit','user.delete',
   'role.view','role.edit','account.view','account.create','account.edit','account.delete','period.view','period.create',
   'period.close','period.reopen','journal.view','journal.create','journal.edit','journal.delete','journal.post',
   'journal.reverse','ledger.view','report.view','report.export','audit.view']),
 ('Admin','Administers companies, users, roles and settings.', array[
   'company.view','company.create','company.edit','company.delete','user.view','user.create','user.edit','user.delete',
   'role.view','role.edit','account.view','account.create','account.edit','account.delete','period.view','period.create',
   'period.close','period.reopen','journal.view','journal.create','journal.edit','journal.delete','journal.post',
   'journal.reverse','ledger.view','report.view','report.export','audit.view']),
 ('Accountant','Maintains the chart of accounts and posts to the ledger.', array[
   'company.view','account.view','account.create','account.edit','account.delete','period.view','period.create',
   'journal.view','journal.create','journal.edit','journal.delete','journal.post','journal.reverse',
   'ledger.view','report.view','report.export']),
 ('FinanceManager','Posts and reverses entries, closes and reopens periods.', array[
   'company.view','account.view','period.view','period.create','period.close','period.reopen','journal.view',
   'journal.create','journal.edit','journal.delete','journal.post','journal.reverse','ledger.view','report.view',
   'report.export','audit.view','user.view']),
 ('Auditor','Read-only across financial data, plus the audit log. Never mutates.', array[
   'company.view','account.view','period.view','journal.view','ledger.view','report.view','report.export',
   'audit.view','user.view']),
 ('Sales','Creates sales documents; no ledger access.', array['company.view']),
 ('Purchaser','Creates purchasing documents; no ledger access.', array['company.view']),
 ('HR','Manages people and payroll.', array['company.view']),
 ('Employee','Submits their own expense claims.', array['company.view']),
 ('ReadOnly','Views reports and records; changes nothing.', array[
   'company.view','account.view','period.view','journal.view','ledger.view','report.view','report.export']);

-- ─── Chart of accounts template (mirrors packages/db/src/coa.ts) ────────────
create or replace function public.coa_template()
returns table (code text, name text, type public.account_type, sub_type public.account_sub_type, parent text,
               postable boolean, system boolean, cash boolean, description text)
language sql immutable set search_path = public as $$
  select t.code, t.name, t.type::public.account_type, t.sub_type::public.account_sub_type, t.parent,
         t.postable, t.system, t.cash, t.description
  from (values
  ('1000','ASSETS','ASSET',null,null,false,true,false,null),
  ('1100','Current Assets','ASSET','CURRENT_ASSET','1000',false,true,false,null),
  ('1110','Cash in Hand','ASSET','CURRENT_ASSET','1100',true,true,true,null),
  ('1120','Petty Cash','ASSET','CURRENT_ASSET','1100',true,false,true,null),
  ('1130','Bank Accounts','ASSET','CURRENT_ASSET','1100',false,true,false,null),
  ('1131','Maybank Current Account','ASSET','CURRENT_ASSET','1130',true,true,true,null),
  ('1132','CIMB Current Account','ASSET','CURRENT_ASSET','1130',true,false,true,null),
  ('1140','Fixed Deposits','ASSET','CURRENT_ASSET','1100',true,false,false,null),
  ('1150','Accounts Receivable','ASSET','CURRENT_ASSET','1100',true,true,false,'Trade debtors control account.'),
  ('1155','Allowance for Doubtful Debts','ASSET','CURRENT_ASSET','1100',true,false,false,'Contra-asset against receivables.'),
  ('1160','Other Receivables','ASSET','CURRENT_ASSET','1100',true,false,false,null),
  ('1170','Inventory','ASSET','CURRENT_ASSET','1100',true,true,false,null),
  ('1180','Prepaid Expenses','ASSET','CURRENT_ASSET','1100',true,true,false,null),
  ('1190','Deposits Paid','ASSET','CURRENT_ASSET','1100',true,false,false,null),
  ('1195','SST Input Tax','ASSET','CURRENT_ASSET','1100',true,true,false,'Recoverable input tax (tax receivable).'),
  ('1500','Non-Current Assets','ASSET','NON_CURRENT_ASSET','1000',false,true,false,null),
  ('1510','Land and Buildings','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1515','Accumulated Depreciation — Land and Buildings','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1520','Plant and Machinery','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1525','Accumulated Depreciation — Plant and Machinery','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1530','Motor Vehicles','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1535','Accumulated Depreciation — Motor Vehicles','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1540','Office Equipment','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1545','Accumulated Depreciation — Office Equipment','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1550','Furniture and Fittings','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1555','Accumulated Depreciation — Furniture and Fittings','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1560','Computer Equipment','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1565','Accumulated Depreciation — Computer Equipment','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('1580','Intangible Assets','ASSET','NON_CURRENT_ASSET','1500',true,false,false,null),
  ('2000','LIABILITIES','LIABILITY',null,null,false,true,false,null),
  ('2100','Current Liabilities','LIABILITY','CURRENT_LIABILITY','2000',false,true,false,null),
  ('2110','Accounts Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,'Trade creditors control account.'),
  ('2120','Other Payables','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2130','Accrued Expenses','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2140','Goods Received Not Invoiced','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,'GRNI clearing account for three-way match.'),
  ('2150','SST Output Tax','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,'Output tax collected (tax payable).'),
  ('2160','EPF Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2165','SOCSO Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2170','EIS Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2175','PCB Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2180','Salaries Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2185','Employee Claims Payable','LIABILITY','CURRENT_LIABILITY','2100',true,true,false,null),
  ('2190','Bank Overdraft','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2195','Current Portion of Term Loans','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2198','Deposits Received','LIABILITY','CURRENT_LIABILITY','2100',true,false,false,null),
  ('2500','Non-Current Liabilities','LIABILITY','NON_CURRENT_LIABILITY','2000',false,true,false,null),
  ('2510','Term Loans','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('2520','Hire Purchase Creditors','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('2530','Deferred Taxation','LIABILITY','NON_CURRENT_LIABILITY','2500',true,false,false,null),
  ('3000','EQUITY','EQUITY','EQUITY',null,false,true,false,null),
  ('3100','Share Capital','EQUITY','EQUITY','3000',true,true,false,null),
  ('3200','Retained Earnings','EQUITY','EQUITY','3000',true,true,false,'Accumulated result of prior years; year-end close posts here.'),
  ('3300','Shareholders'' Drawings','EQUITY','EQUITY','3000',true,false,false,null),
  ('3400','Reserves','EQUITY','EQUITY','3000',true,false,false,null),
  ('4000','REVENUE','REVENUE',null,null,false,true,false,null),
  ('4100','Operating Revenue','REVENUE','OPERATING_REVENUE','4000',false,true,false,null),
  ('4110','Sales — Goods','REVENUE','OPERATING_REVENUE','4100',true,true,false,null),
  ('4120','Sales — Services','REVENUE','OPERATING_REVENUE','4100',true,true,false,null),
  ('4130','Sales Returns and Allowances','REVENUE','OPERATING_REVENUE','4100',true,false,false,'Contra-revenue.'),
  ('4140','Discounts Allowed','REVENUE','OPERATING_REVENUE','4100',true,false,false,'Contra-revenue.'),
  ('4500','Other Income','REVENUE','OTHER_INCOME','4000',false,true,false,null),
  ('4510','Interest Income','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4520','Rental Income','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4530','Gain on Disposal of Assets','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4540','Foreign Exchange Gain','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('4590','Sundry Income','REVENUE','OTHER_INCOME','4500',true,false,false,null),
  ('5000','COST OF SALES','COST_OF_SALES','COST_OF_SALES',null,false,true,false,null),
  ('5100','Cost of Goods Sold','COST_OF_SALES','COST_OF_SALES','5000',true,true,false,null),
  ('5200','Purchases','COST_OF_SALES','COST_OF_SALES','5000',true,true,false,null),
  ('5300','Direct Labour','COST_OF_SALES','COST_OF_SALES','5000',true,false,false,null),
  ('5400','Freight and Duty Inward','COST_OF_SALES','COST_OF_SALES','5000',true,false,false,null),
  ('5500','Inventory Adjustment','COST_OF_SALES','COST_OF_SALES','5000',true,true,false,null),
  ('5600','Subcontractor Costs','COST_OF_SALES','COST_OF_SALES','5000',true,false,false,null),
  ('6000','EXPENSES','EXPENSE',null,null,false,true,false,null),
  ('6100','Staff Costs','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6110','Salaries and Wages','EXPENSE','OPERATING_EXPENSE','6100',true,true,false,null),
  ('6120','EPF — Employer','EXPENSE','OPERATING_EXPENSE','6100',true,true,false,null),
  ('6130','SOCSO — Employer','EXPENSE','OPERATING_EXPENSE','6100',true,true,false,null),
  ('6140','EIS — Employer','EXPENSE','OPERATING_EXPENSE','6100',true,true,false,null),
  ('6150','Bonus and Allowances','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6160','Staff Welfare','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6170','Staff Training','EXPENSE','OPERATING_EXPENSE','6100',true,false,false,null),
  ('6200','Occupancy Costs','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6210','Rental of Premises','EXPENSE','OPERATING_EXPENSE','6200',true,true,false,null),
  ('6220','Utilities','EXPENSE','OPERATING_EXPENSE','6200',true,true,false,null),
  ('6230','Repairs and Maintenance','EXPENSE','OPERATING_EXPENSE','6200',true,false,false,null),
  ('6240','Insurance','EXPENSE','OPERATING_EXPENSE','6200',true,false,false,null),
  ('6250','Quit Rent and Assessment','EXPENSE','OPERATING_EXPENSE','6200',true,false,false,null),
  ('6300','Administrative Expenses','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6310','Office Supplies','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6320','Printing and Stationery','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6330','Telephone and Internet','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6340','Postage and Courier','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6350','Professional Fees','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6360','Audit Fees','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6370','Secretarial Fees','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6380','Bank Charges','EXPENSE','OPERATING_EXPENSE','6300',true,true,false,null),
  ('6390','Licences and Permits','EXPENSE','OPERATING_EXPENSE','6300',true,false,false,null),
  ('6400','Selling and Distribution','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6410','Advertising and Promotion','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6420','Travelling and Transport','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6430','Entertainment','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6440','Freight Outward','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6450','Commission','EXPENSE','OPERATING_EXPENSE','6400',true,false,false,null),
  ('6500','Depreciation and Amortisation','EXPENSE','OPERATING_EXPENSE','6000',false,true,false,null),
  ('6510','Depreciation — Land and Buildings','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6520','Depreciation — Plant and Machinery','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6530','Depreciation — Motor Vehicles','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6540','Depreciation — Office Equipment','EXPENSE','OPERATING_EXPENSE','6500',true,true,false,null),
  ('6550','Depreciation — Furniture and Fittings','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6560','Depreciation — Computer Equipment','EXPENSE','OPERATING_EXPENSE','6500',true,true,false,null),
  ('6590','Amortisation of Intangibles','EXPENSE','OPERATING_EXPENSE','6500',true,false,false,null),
  ('6600','Finance Costs','EXPENSE','OTHER_EXPENSE','6000',false,true,false,null),
  ('6610','Interest on Term Loans','EXPENSE','OTHER_EXPENSE','6600',true,true,false,null),
  ('6620','Hire Purchase Interest','EXPENSE','OTHER_EXPENSE','6600',true,false,false,null),
  ('6700','Other Expenses','EXPENSE','OTHER_EXPENSE','6000',false,true,false,null),
  ('6710','Bad Debts Written Off','EXPENSE','OTHER_EXPENSE','6700',true,true,false,null),
  ('6720','Loss on Disposal of Assets','EXPENSE','OTHER_EXPENSE','6700',true,false,false,null),
  ('6730','Foreign Exchange Loss','EXPENSE','OTHER_EXPENSE','6700',true,false,false,null),
  ('6740','Donations','EXPENSE','OTHER_EXPENSE','6700',true,false,false,null),
  ('6790','Sundry Expenses','EXPENSE','OTHER_EXPENSE','6700',true,false,false,null)
  ) as t(code, name, type, sub_type, parent, postable, system, cash, description)
$$;

-- ─── Permission helpers ─────────────────────────────────────────────────────
create or replace function public.has_perm(p_company uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m join public.roles r on r.name = m.role
    where m.company_id = p_company and m.user_id = auth.uid() and p_perm = any (r.permissions));
$$;

-- Set of companies where the caller holds a permission; used by RLS so the
-- check runs once per query rather than once per row.
create or replace function public.companies_with_perm(p_perm text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select m.company_id from public.company_members m join public.roles r on r.name = m.role
  where m.user_id = auth.uid() and p_perm = any (r.permissions);
$$;

create or replace function public.my_company_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select company_id from public.company_members where user_id = auth.uid();
$$;

create or replace function public._require_perm(p_company uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED: Sign in to continue.' using errcode = '28000';
  end if;
  if not public.has_perm(p_company, p_perm) then
    raise exception 'PERMISSION_DENIED: Your role cannot perform % in this company.', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function public._audit(p_company uuid, p_action text, p_entity_type text, p_entity_id text,
                                         p_summary text, p_metadata jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, summary, metadata)
  values (p_company, auth.uid(), (select email from public.profiles where id = auth.uid()),
          p_action, p_entity_type, p_entity_id, p_summary, p_metadata);
end $$;

-- ─── Integrity triggers (defence in depth; clients cannot write anyway) ─────
create or replace function public._guard_journal_entry()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'IMMUTABLE: Posted journals are never deleted — reverse them instead.';
    end if;
    return old;
  end if;
  if old.status = 'REVERSED' then
    raise exception 'IMMUTABLE: A reversed journal cannot be changed.';
  end if;
  if old.status = 'POSTED' then
    if new.status <> 'REVERSED'
       or new.date <> old.date or new.reference is distinct from old.reference
       or new.total_debit <> old.total_debit or new.total_credit <> old.total_credit
       or new.company_id <> old.company_id or new.fiscal_period_id is distinct from old.fiscal_period_id
       or new.description is distinct from old.description then
      raise exception 'IMMUTABLE: Posted journals cannot be edited — reverse them instead.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger journal_entries_guard before update or delete on public.journal_entries
  for each row execute function public._guard_journal_entry();

create or replace function public._guard_journal_line()
returns trigger language plpgsql set search_path = public as $$
declare v_status public.journal_status;
begin
  select status into v_status from public.journal_entries
   where id = coalesce(new.journal_entry_id, old.journal_entry_id);
  if v_status is not null and v_status <> 'DRAFT' then
    raise exception 'IMMUTABLE: Lines of a posted journal cannot change.';
  end if;
  return coalesce(new, old);
end $$;
create trigger journal_lines_guard before insert or update or delete on public.journal_lines
  for each row execute function public._guard_journal_line();

create or replace function public._guard_audit()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'IMMUTABLE: The audit trail is append-only.';
end $$;
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function public._guard_audit();

-- ─── Profiles: created automatically for every new auth user ────────────────
create or replace function public._handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public._handle_new_user();

-- ─── Internal building blocks ───────────────────────────────────────────────
create or replace function public._next_number(p_company uuid, p_doc_type text, p_year int)
returns text language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into public.number_sequences (company_id, doc_type, year, next_number)
  values (p_company, p_doc_type, p_year, 2)
  on conflict (company_id, doc_type, year) do update set next_number = public.number_sequences.next_number + 1
  returning next_number - 1 into v_n;
  return format('%s-%s-%s', p_doc_type, p_year, lpad(v_n::text, 6, '0'));
end $$;

create or replace function public._generate_periods(p_company uuid, p_year int)
returns int language plpgsql security definer set search_path = public as $$
declare v_start_month int; v_start date; v_count int := 0; i int;
begin
  select fiscal_year_start_month into v_start_month from public.companies where id = p_company;
  for i in 0..11 loop
    v_start := make_date(p_year, v_start_month, 1) + make_interval(months => i);
    insert into public.fiscal_periods (company_id, name, year, period_no, start_date, end_date)
    values (p_company, to_char(v_start, 'FMMonth YYYY'), p_year, i + 1, v_start,
            (v_start + interval '1 month' - interval '1 day')::date)
    on conflict do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

create or replace function public._bootstrap_company(p_user uuid, p_name text, p_registration_no text,
                                                     p_tax_no text, p_year int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'VALIDATION: Enter a company name.';
  end if;
  if (select count(*) from public.companies where created_by = p_user) >= 20 then
    raise exception 'LIMIT_REACHED: You can create up to 20 companies.';
  end if;

  insert into public.companies (name, registration_no, tax_registration_no, created_by)
  values (btrim(p_name), nullif(btrim(p_registration_no), ''), nullif(btrim(p_tax_no), ''), p_user)
  returning id into v_company;

  insert into public.company_members (company_id, user_id, role) values (v_company, p_user, 'SuperAdmin');

  insert into public.accounts (company_id, code, name, type, sub_type, description, is_postable, is_system, is_cash)
  select v_company, t.code, t.name, t.type, t.sub_type, t.description, t.postable, t.system, t.cash
  from public.coa_template() t;

  update public.accounts a set parent_id = p.id
  from public.coa_template() t
  join public.accounts p on p.company_id = v_company and p.code = t.parent
  where a.company_id = v_company and a.code = t.code and t.parent is not null;

  perform public._generate_periods(v_company, coalesce(p_year, extract(year from current_date)::int));

  insert into public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, summary)
  values (v_company, p_user, (select email from public.profiles where id = p_user), 'company.create', 'Company',
          v_company::text, format('Created %s with the Malaysian chart of accounts and 12 fiscal periods', btrim(p_name)));
  return v_company;
end $$;

-- Validates lines and returns them as a normalised record set.
create or replace function public._write_lines(p_entry uuid, p_company uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb; v_no int := 0; v_debit numeric; v_credit numeric; v_account uuid; v_acc record;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'VALIDATION: Journal lines are required.';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'VALIDATION: A journal can have at most 500 lines.';
  end if;
  delete from public.journal_lines where journal_entry_id = p_entry;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_debit  := round(coalesce(nullif(v_line->>'debit', '')::numeric, 0), 2);
    v_credit := round(coalesce(nullif(v_line->>'credit', '')::numeric, 0), 2);
    if v_debit = 0 and v_credit = 0 then continue; end if;   -- blank rows are ignored
    v_no := v_no + 1;
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
    insert into public.journal_lines (journal_entry_id, account_id, line_no, description, debit, credit)
    values (p_entry, v_account, v_no, nullif(btrim(v_line->>'description'), ''), v_debit, v_credit);
  end loop;
  update public.journal_entries e set
    total_debit  = coalesce((select sum(debit)  from public.journal_lines where journal_entry_id = p_entry), 0),
    total_credit = coalesce((select sum(credit) from public.journal_lines where journal_entry_id = p_entry), 0)
  where e.id = p_entry;
end $$;

-- Posts a DRAFT entry. Caller must already hold the right permission.
create or replace function public._post(p_entry uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_e record; v_lines int; v_dr numeric; v_cr numeric; v_period record; v_ref text; v_bad record;
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
  select * into v_period from public.fiscal_periods
   where company_id = v_e.company_id and v_e.date between start_date and end_date;
  if not found then
    raise exception 'PERIOD_NOT_FOUND: No fiscal period covers %. Generate that fiscal year first.', to_char(v_e.date, 'DD Mon YYYY');
  end if;
  if v_period.status = 'CLOSED' then
    raise exception 'PERIOD_CLOSED: % is closed. Reopen it before posting to it.', v_period.name;
  end if;
  v_ref := public._next_number(v_e.company_id, 'JV', extract(year from v_e.date)::int);
  update public.journal_entries set
    status = 'POSTED', reference = v_ref, fiscal_period_id = v_period.id,
    total_debit = v_dr, total_credit = v_cr, posted_at = now(), posted_by = auth.uid(), version = version + 1
  where id = p_entry;
  return jsonb_build_object('id', p_entry, 'reference', v_ref, 'total', v_dr);
end $$;

-- ═══ Public API (RPC) ═══════════════════════════════════════════════════════

-- Companies ------------------------------------------------------------------
create or replace function public.create_company(p_name text, p_registration_no text default null,
                                                 p_tax_no text default null, p_year int default null)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Sign in to continue.'; end if;
  return public._bootstrap_company(auth.uid(), p_name, p_registration_no, p_tax_no, p_year);
end $$;

-- Service-role only: used by the signup Edge Function right after it creates the user.
create or replace function public.create_company_for_user(p_user uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  return public._bootstrap_company(p_user, p_name, null, null, null);
end $$;

create or replace function public.update_company(p_company uuid, p_name text, p_registration_no text,
                                                 p_tax_no text, p_email text, p_phone text, p_address text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'company.edit');
  if p_name is null or length(btrim(p_name)) < 2 then raise exception 'VALIDATION: Enter a company name.'; end if;
  update public.companies set name = btrim(p_name), registration_no = nullif(btrim(p_registration_no), ''),
    tax_registration_no = nullif(btrim(p_tax_no), ''), email = nullif(btrim(p_email), ''),
    phone = nullif(btrim(p_phone), ''), address = nullif(btrim(p_address), ''), updated_at = now()
  where id = p_company;
  perform public._audit(p_company, 'company.edit', 'Company', p_company::text, 'Updated company profile');
end $$;

create or replace function public.my_companies()
returns table (company_id uuid, name text, role text, permissions text[], base_currency text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, m.role, r.permissions, c.base_currency::text, c.created_at
  from public.company_members m
  join public.companies c on c.id = m.company_id
  join public.roles r on r.name = m.role
  where m.user_id = auth.uid()
  order by c.created_at;
$$;

create or replace function public.log_event(p_company uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_action not in ('auth.login', 'auth.logout') then raise exception 'VALIDATION: Unknown event.'; end if;
  if not exists (select 1 from public.company_members where company_id = p_company and user_id = auth.uid()) then
    raise exception 'PERMISSION_DENIED: Not a member of this company.';
  end if;
  perform public._audit(p_company, p_action, 'User', auth.uid()::text,
    case p_action when 'auth.login' then 'Signed in' else 'Signed out' end);
end $$;

-- Chart of accounts ------------------------------------------------------------
create or replace function public.create_account(p_company uuid, p_code text, p_name text, p_type public.account_type,
                                                 p_sub_type public.account_sub_type default null, p_parent_id uuid default null,
                                                 p_description text default null, p_is_postable boolean default true,
                                                 p_is_cash boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_parent record; v_parent_sub public.account_sub_type;
begin
  perform public._require_perm(p_company, 'account.create');
  if p_code is null or btrim(p_code) !~ '^[0-9A-Za-z.\-]{1,20}$' then
    raise exception 'VALIDATION: Account code must be 1–20 letters, digits, dots or dashes.';
  end if;
  if p_name is null or length(btrim(p_name)) < 1 then raise exception 'VALIDATION: Enter an account name.'; end if;
  if exists (select 1 from public.accounts where company_id = p_company and code = btrim(p_code)) then
    raise exception 'DUPLICATE: Account code % is already in use.', btrim(p_code);
  end if;
  if p_parent_id is not null then
    select * into v_parent from public.accounts where id = p_parent_id and company_id = p_company;
    if not found then raise exception 'VALIDATION: Parent account not found.'; end if;
    if v_parent.type <> p_type then
      raise exception 'VALIDATION: A sub-account must have the same type as its parent (%).', v_parent.type;
    end if;
    if v_parent.is_postable then
      raise exception 'VALIDATION: % % is a postable account; choose a heading as the parent.', v_parent.code, v_parent.name;
    end if;
    v_parent_sub := v_parent.sub_type;
  end if;
  insert into public.accounts (company_id, code, name, type, sub_type, parent_id, description, is_postable, is_cash)
  values (p_company, btrim(p_code), btrim(p_name), p_type, coalesce(p_sub_type, v_parent_sub), p_parent_id,
          nullif(btrim(p_description), ''), coalesce(p_is_postable, true), coalesce(p_is_cash, false))
  returning id into v_id;
  perform public._audit(p_company, 'account.create', 'Account', v_id::text, format('Created account %s %s', btrim(p_code), btrim(p_name)));
  return v_id;
end $$;

create or replace function public.update_account(p_id uuid, p_name text, p_description text, p_is_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_a record; v_balance numeric;
begin
  select * into v_a from public.accounts where id = p_id;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  perform public._require_perm(v_a.company_id, 'account.edit');
  if p_name is null or length(btrim(p_name)) < 1 then raise exception 'VALIDATION: Enter an account name.'; end if;
  if v_a.is_active and not coalesce(p_is_active, true) then
    if v_a.is_system then
      raise exception 'SYSTEM_ACCOUNT: % % is used by the posting rules and cannot be archived.', v_a.code, v_a.name;
    end if;
    select coalesce(sum(l.debit - l.credit), 0) into v_balance from public.journal_lines l
      join public.journal_entries e on e.id = l.journal_entry_id
     where l.account_id = p_id and e.status in ('POSTED','REVERSED');
    if v_balance <> 0 then
      raise exception 'ACCOUNT_HAS_BALANCE: % % has a balance of %; move it before archiving.',
        v_a.code, v_a.name, to_char(v_balance, 'FM999,999,999,990.00');
    end if;
  end if;
  update public.accounts set name = btrim(p_name), description = nullif(btrim(p_description), ''),
    is_active = coalesce(p_is_active, is_active), updated_at = now()
  where id = p_id;
  perform public._audit(v_a.company_id,
    case when v_a.is_active and not coalesce(p_is_active, true) then 'account.archive' else 'account.edit' end,
    'Account', p_id::text, format('Updated account %s %s', v_a.code, btrim(p_name)));
end $$;

create or replace function public.delete_account(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_a record;
begin
  select * into v_a from public.accounts where id = p_id;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  perform public._require_perm(v_a.company_id, 'account.delete');
  if v_a.is_system then raise exception 'SYSTEM_ACCOUNT: System accounts cannot be deleted.'; end if;
  if exists (select 1 from public.journal_lines where account_id = p_id) then
    raise exception 'ACCOUNT_IN_USE: % % has journal lines; archive it instead.', v_a.code, v_a.name;
  end if;
  if exists (select 1 from public.accounts where parent_id = p_id) then
    raise exception 'ACCOUNT_IN_USE: % % has sub-accounts.', v_a.code, v_a.name;
  end if;
  delete from public.accounts where id = p_id;
  perform public._audit(v_a.company_id, 'account.delete', 'Account', p_id::text, format('Deleted account %s %s', v_a.code, v_a.name));
end $$;

-- Fiscal periods ----------------------------------------------------------------
create or replace function public.generate_fiscal_year(p_company uuid, p_year int)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public._require_perm(p_company, 'period.create');
  if p_year < 2000 or p_year > 2100 then raise exception 'VALIDATION: Choose a year between 2000 and 2100.'; end if;
  v_n := public._generate_periods(p_company, p_year);
  perform public._audit(p_company, 'period.generate', 'FiscalPeriod', null, format('Generated fiscal year %s (%s new periods)', p_year, v_n));
  return v_n;
end $$;

create or replace function public.close_period(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_p record; v_drafts int;
begin
  select * into v_p from public.fiscal_periods where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Period not found.'; end if;
  perform public._require_perm(v_p.company_id, 'period.close');
  if v_p.status = 'CLOSED' then raise exception 'INVALID_STATE: % is already closed.', v_p.name; end if;
  select count(*) into v_drafts from public.journal_entries
   where company_id = v_p.company_id and status = 'DRAFT' and date between v_p.start_date and v_p.end_date;
  if v_drafts > 0 then
    raise exception 'PERIOD_HAS_DRAFTS: % draft journal(s) are dated in %. Post or delete them first.', v_drafts, v_p.name;
  end if;
  update public.fiscal_periods set status = 'CLOSED', closed_at = now(), closed_by = auth.uid() where id = p_id;
  perform public._audit(v_p.company_id, 'period.close', 'FiscalPeriod', p_id::text, format('Closed %s', v_p.name));
end $$;

create or replace function public.reopen_period(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_p record;
begin
  select * into v_p from public.fiscal_periods where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Period not found.'; end if;
  perform public._require_perm(v_p.company_id, 'period.reopen');
  if v_p.status = 'OPEN' then raise exception 'INVALID_STATE: % is already open.', v_p.name; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION: Give a reason for reopening (at least 5 characters) — it goes in the audit trail.';
  end if;
  update public.fiscal_periods set status = 'OPEN', reopened_at = now(), reopened_by = auth.uid(),
    reopen_reason = btrim(p_reason) where id = p_id;
  perform public._audit(v_p.company_id, 'period.reopen', 'FiscalPeriod', p_id::text,
    format('Reopened %s — %s', v_p.name, btrim(p_reason)), jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- Journals -------------------------------------------------------------------------
create or replace function public.save_journal(p_company uuid, p_id uuid, p_date date, p_description text,
                                               p_memo text, p_lines jsonb, p_version int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_e record;
begin
  if p_date is null then raise exception 'VALIDATION: Choose a journal date.'; end if;
  if p_id is null then
    perform public._require_perm(p_company, 'journal.create');
    insert into public.journal_entries (company_id, date, description, memo, created_by)
    values (p_company, p_date, nullif(btrim(p_description), ''), nullif(btrim(p_memo), ''), auth.uid())
    returning id into v_id;
    perform public._write_lines(v_id, p_company, p_lines);
    perform public._audit(p_company, 'journal.create', 'JournalEntry', v_id::text,
      format('Created draft journal dated %s', to_char(p_date, 'DD Mon YYYY')));
  else
    select * into v_e from public.journal_entries where id = p_id and company_id = p_company for update;
    if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
    perform public._require_perm(p_company, 'journal.edit');
    if v_e.status <> 'DRAFT' then
      raise exception 'IMMUTABLE: Only drafts can be edited — reverse a posted journal instead.';
    end if;
    if p_version is not null and p_version <> v_e.version then
      raise exception 'CONFLICT: Someone else changed this journal. Reload it and try again.';
    end if;
    v_id := p_id;
    update public.journal_entries set date = p_date, description = nullif(btrim(p_description), ''),
      memo = nullif(btrim(p_memo), ''), version = version + 1 where id = v_id;
    perform public._write_lines(v_id, p_company, p_lines);
    perform public._audit(p_company, 'journal.edit', 'JournalEntry', v_id::text, 'Edited draft journal');
  end if;
  return (select jsonb_build_object('id', id, 'version', version, 'total_debit', total_debit, 'total_credit', total_credit)
          from public.journal_entries where id = v_id);
end $$;

create or replace function public.post_journal(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_result jsonb;
begin
  select company_id into v_company from public.journal_entries where id = p_id;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  perform public._require_perm(v_company, 'journal.post');
  v_result := public._post(p_id);
  perform public._audit(v_company, 'journal.post', 'JournalEntry', p_id::text,
    format('Posted %s for %s', v_result->>'reference', to_char((v_result->>'total')::numeric, 'FM999,999,999,990.00')));
  return v_result;
end $$;

-- Save and post in one step (both permissions required).
create or replace function public.create_and_post_journal(p_company uuid, p_date date, p_description text,
                                                          p_memo text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_saved jsonb;
begin
  perform public._require_perm(p_company, 'journal.post');
  v_saved := public.save_journal(p_company, null, p_date, p_description, p_memo, p_lines, null);
  return public.post_journal((v_saved->>'id')::uuid);
end $$;

create or replace function public.delete_journal(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_e record;
begin
  select * into v_e from public.journal_entries where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  perform public._require_perm(v_e.company_id, 'journal.delete');
  if v_e.status <> 'DRAFT' then
    raise exception 'IMMUTABLE: Posted journals are never deleted — reverse them instead.';
  end if;
  delete from public.journal_entries where id = p_id;
  perform public._audit(v_e.company_id, 'journal.delete', 'JournalEntry', p_id::text, 'Deleted draft journal');
end $$;

create or replace function public.reverse_journal(p_id uuid, p_date date default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_e record; v_new uuid; v_date date; v_result jsonb;
begin
  select * into v_e from public.journal_entries where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  perform public._require_perm(v_e.company_id, 'journal.reverse');
  if v_e.status = 'REVERSED' then raise exception 'INVALID_STATE: % has already been reversed.', v_e.reference; end if;
  if v_e.status <> 'POSTED' then raise exception 'INVALID_STATE: Only posted journals can be reversed.'; end if;
  if v_e.reversal_of_id is not null then
    raise exception 'INVALID_STATE: % is itself a reversal and cannot be reversed.', v_e.reference;
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

-- Members ------------------------------------------------------------------------
create or replace function public._admins_left(p_company uuid, p_excluding uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.company_members
  where company_id = p_company and role in ('SuperAdmin', 'Admin') and user_id <> p_excluding;
$$;

create or replace function public.add_member(p_company uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform public._require_perm(p_company, 'user.create');
  if not exists (select 1 from public.roles where name = p_role) then raise exception 'VALIDATION: Unknown role %.', p_role; end if;
  if p_role = 'SuperAdmin' and not public.has_perm(p_company, 'role.edit') then
    raise exception 'PERMISSION_DENIED: Only administrators can grant SuperAdmin.';
  end if;
  select id into v_user from public.profiles where email = lower(btrim(p_email));
  if not found then
    raise exception 'USER_NOT_FOUND: % has no Zycount account yet. Ask them to register first, then add them.', btrim(p_email);
  end if;
  if exists (select 1 from public.company_members where company_id = p_company and user_id = v_user) then
    raise exception 'DUPLICATE: % is already a member of this company.', btrim(p_email);
  end if;
  insert into public.company_members (company_id, user_id, role) values (p_company, v_user, p_role);
  perform public._audit(p_company, 'user.create', 'User', v_user::text, format('Added %s as %s', lower(btrim(p_email)), p_role));
end $$;

create or replace function public.update_member_role(p_company uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  perform public._require_perm(p_company, 'user.edit');
  if not exists (select 1 from public.roles where name = p_role) then raise exception 'VALIDATION: Unknown role %.', p_role; end if;
  select role into v_old from public.company_members where company_id = p_company and user_id = p_user for update;
  if not found then raise exception 'NOT_FOUND: That user is not a member of this company.'; end if;
  if v_old in ('SuperAdmin','Admin') and p_role not in ('SuperAdmin','Admin') and public._admins_left(p_company, p_user) = 0 then
    raise exception 'LAST_ADMIN: The company needs at least one administrator.';
  end if;
  update public.company_members set role = p_role where company_id = p_company and user_id = p_user;
  perform public._audit(p_company, 'user.edit', 'User', p_user::text,
    format('Changed %s from %s to %s', (select email from public.profiles where id = p_user), v_old, p_role));
end $$;

create or replace function public.remove_member(p_company uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  perform public._require_perm(p_company, 'user.delete');
  select role into v_old from public.company_members where company_id = p_company and user_id = p_user for update;
  if not found then raise exception 'NOT_FOUND: That user is not a member of this company.'; end if;
  if v_old in ('SuperAdmin','Admin') and public._admins_left(p_company, p_user) = 0 then
    raise exception 'LAST_ADMIN: The company needs at least one administrator.';
  end if;
  delete from public.company_members where company_id = p_company and user_id = p_user;
  perform public._audit(p_company, 'user.delete', 'User', p_user::text,
    format('Removed %s', (select email from public.profiles where id = p_user)));
end $$;

-- Reports ---------------------------------------------------------------------------
-- Balance convention: balance = Σdebit − Σcredit (credit-normal accounts are negative).
create or replace function public.account_balances(p_company uuid, p_from date, p_to date)
returns table (account_id uuid, code text, name text, type public.account_type, sub_type public.account_sub_type,
               parent_id uuid, is_postable boolean, is_active boolean, is_cash boolean,
               opening numeric, period_debit numeric, period_credit numeric, closing numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_company, 'report.view') or public.has_perm(p_company, 'ledger.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view reports in this company.';
  end if;
  return query
  with mv as (
    select l.account_id,
      sum(case when p_from is not null and e.date < p_from then l.debit - l.credit else 0 end) as opening,
      sum(case when (p_from is null or e.date >= p_from) and e.date <= p_to then l.debit else 0 end) as dr,
      sum(case when (p_from is null or e.date >= p_from) and e.date <= p_to then l.credit else 0 end) as cr
    from public.journal_lines l
    join public.journal_entries e on e.id = l.journal_entry_id
    where e.company_id = p_company and e.status in ('POSTED','REVERSED') and e.date <= p_to
    group by l.account_id)
  select a.id, a.code, a.name, a.type, a.sub_type, a.parent_id, a.is_postable, a.is_active, a.is_cash,
         coalesce(mv.opening, 0)::numeric(18,2), coalesce(mv.dr, 0)::numeric(18,2), coalesce(mv.cr, 0)::numeric(18,2),
         (coalesce(mv.opening, 0) + coalesce(mv.dr, 0) - coalesce(mv.cr, 0))::numeric(18,2)
  from public.accounts a left join mv on mv.account_id = a.id
  where a.company_id = p_company
  order by a.code;
end $$;

create or replace function public.general_ledger(p_company uuid, p_account uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_open numeric; v_rows jsonb; v_acc record;
begin
  if not public.has_perm(p_company, 'ledger.view') then
    raise exception 'PERMISSION_DENIED: Your role cannot view the ledger in this company.';
  end if;
  select id, code, name, type into v_acc from public.accounts where id = p_account and company_id = p_company;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  select coalesce(sum(l.debit - l.credit), 0) into v_open
    from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
   where l.account_id = p_account and e.status in ('POSTED','REVERSED') and p_from is not null and e.date < p_from;
  select coalesce(jsonb_agg(r order by r.date, r.reference, r.line_no), '[]'::jsonb) into v_rows from (
    select e.id as entry_id, e.reference, e.date, coalesce(l.description, e.description) as description,
           e.source, e.status, l.line_no, l.debit, l.credit,
           v_open + sum(l.debit - l.credit) over (order by e.date, e.reference, l.line_no
                                                  rows between unbounded preceding and current row) as balance
    from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
    where l.account_id = p_account and e.status in ('POSTED','REVERSED')
      and (p_from is null or e.date >= p_from) and e.date <= p_to) r;
  return jsonb_build_object('account', jsonb_build_object('id', v_acc.id, 'code', v_acc.code, 'name', v_acc.name, 'type', v_acc.type),
                            'opening', v_open, 'lines', v_rows);
end $$;

create or replace function public.monthly_summary(p_company uuid, p_year int)
returns table (month int, revenue numeric, cost_of_sales numeric, expenses numeric, profit numeric, cash numeric, entries int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm(p_company, 'report.view') then
    raise exception 'PERMISSION_DENIED: Your role cannot view reports in this company.';
  end if;
  return query
  with m as (select generate_series(1, 12) as mo),
  lines as (
    select extract(month from e.date)::int as mo, a.type, a.is_cash, l.debit, l.credit, e.date, e.id as entry_id
    from public.journal_lines l
    join public.journal_entries e on e.id = l.journal_entry_id
    join public.accounts a on a.id = l.account_id
    where e.company_id = p_company and e.status in ('POSTED','REVERSED'))
  select m.mo,
    coalesce((select sum(credit - debit) from lines where lines.mo = m.mo and extract(year from lines.date) = p_year and type = 'REVENUE'), 0)::numeric(18,2),
    coalesce((select sum(debit - credit) from lines where lines.mo = m.mo and extract(year from lines.date) = p_year and type = 'COST_OF_SALES'), 0)::numeric(18,2),
    coalesce((select sum(debit - credit) from lines where lines.mo = m.mo and extract(year from lines.date) = p_year and type = 'EXPENSE'), 0)::numeric(18,2),
    coalesce((select sum(case when type = 'REVENUE' then credit - debit when type in ('COST_OF_SALES','EXPENSE') then credit - debit else 0 end)
              from lines where lines.mo = m.mo and extract(year from lines.date) = p_year), 0)::numeric(18,2),
    coalesce((select sum(debit - credit) from lines where is_cash and lines.date <= (make_date(p_year, m.mo, 1) + interval '1 month' - interval '1 day')::date), 0)::numeric(18,2),
    (select count(distinct entry_id)::int from lines where lines.mo = m.mo and extract(year from lines.date) = p_year)
  from m order by m.mo;
end $$;

-- ─── Row-level security ─────────────────────────────────────────────────────
alter table public.profiles         enable row level security;
alter table public.roles            enable row level security;
alter table public.companies        enable row level security;
alter table public.company_members  enable row level security;
alter table public.accounts         enable row level security;
alter table public.fiscal_periods   enable row level security;
alter table public.number_sequences enable row level security;
alter table public.journal_entries  enable row level security;
alter table public.journal_lines    enable row level security;
alter table public.audit_log        enable row level security;

create policy "own profile or co-member" on public.profiles for select to authenticated
  using (id = (select auth.uid())
         or id in (select m.user_id from public.company_members m where m.company_id in (select public.my_company_ids())));
create policy "update own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "roles readable" on public.roles for select to authenticated using (true);
create policy "member companies" on public.companies for select to authenticated
  using (id in (select public.my_company_ids()));
create policy "members of my companies" on public.company_members for select to authenticated
  using (company_id in (select public.my_company_ids()));
create policy "accounts by permission" on public.accounts for select to authenticated
  using (company_id in (select public.companies_with_perm('account.view')));
create policy "periods by permission" on public.fiscal_periods for select to authenticated
  using (company_id in (select public.companies_with_perm('period.view')));
create policy "journals by permission" on public.journal_entries for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view'))
         or company_id in (select public.companies_with_perm('ledger.view')));
create policy "journal lines by permission" on public.journal_lines for select to authenticated
  using (journal_entry_id in (
    select e.id from public.journal_entries e
    where e.company_id in (select public.companies_with_perm('journal.view'))
       or e.company_id in (select public.companies_with_perm('ledger.view'))));
create policy "audit by permission" on public.audit_log for select to authenticated
  using (company_id in (select public.companies_with_perm('audit.view')));
-- number_sequences: no client policy (internal only).

-- ─── Function privileges ────────────────────────────────────────────────────
-- Nothing is callable by default; grant only the public API to signed-in users.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.has_perm(uuid, text), public.companies_with_perm(text), public.my_company_ids(),
  public.create_company(text, text, text, int), public.update_company(uuid, text, text, text, text, text, text),
  public.my_companies(), public.log_event(uuid, text),
  public.create_account(uuid, text, text, public.account_type, public.account_sub_type, uuid, text, boolean, boolean),
  public.update_account(uuid, text, text, boolean), public.delete_account(uuid),
  public.generate_fiscal_year(uuid, int), public.close_period(uuid), public.reopen_period(uuid, text),
  public.save_journal(uuid, uuid, date, text, text, jsonb, int), public.post_journal(uuid),
  public.create_and_post_journal(uuid, date, text, text, jsonb), public.delete_journal(uuid),
  public.reverse_journal(uuid, date, text),
  public.add_member(uuid, text, text), public.update_member_role(uuid, uuid, text), public.remove_member(uuid, uuid),
  public.account_balances(uuid, date, date), public.general_ledger(uuid, uuid, date, date),
  public.monthly_summary(uuid, int), public.coa_template()
to authenticated;

grant execute on function public.create_company_for_user(uuid, text) to service_role;
-- The auth service inserts into auth.users; its trigger must be able to run.
grant execute on function public._handle_new_user() to supabase_auth_admin;

-- Future functions are private unless granted explicitly.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
