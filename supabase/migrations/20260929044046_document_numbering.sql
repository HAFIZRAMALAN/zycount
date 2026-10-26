-- ═══════════════════════════════════════════════════════════════════════════
-- Numbering you control. Every book (business or personal) gets numbering
-- series for payment vouchers, receipts and journals, and can edit them or add
-- more (e.g. a Cash Voucher series linked to petty cash). Each series is:
--   AUTO           Zycount gives the next number (gap-free);
--   AUTO_EDITABLE  Zycount suggests the next number, a person may key another;
--   MANUAL         a person keys every number.
-- Formats use {YYYY} {YY} {MM} and one running number {####}.
-- Hand-keyed numbers must be unique in the books and may not take a number the
-- automatic sequence will use later, so automatic numbering stays gap-free.
-- Account codes become editable too, except the ones the posting rules use.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.document_series (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  kind             text not null check (kind in ('PAYMENT', 'RECEIPT', 'JOURNAL')),
  code             text not null check (code ~ '^[A-Z0-9]{1,10}$'),
  name             text not null check (length(name) between 1 and 60),
  title            text check (title is null or length(title) between 1 and 60),
  format           text not null check (length(format) between 3 and 40),
  reset            text not null default 'YEARLY' check (reset in ('YEARLY', 'MONTHLY', 'NEVER')),
  mode             text not null default 'AUTO' check (mode in ('AUTO', 'AUTO_EDITABLE', 'MANUAL')),
  money_account_id uuid references public.accounts(id) on delete set null,
  is_default       boolean not null default false,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, code),
  constraint document_series_journal_unlinked check (kind <> 'JOURNAL' or money_account_id is null),
  constraint document_series_default_active check (not is_default or is_active)
);
create unique index document_series_one_default on public.document_series(company_id, kind) where is_default;
create unique index document_series_one_per_account on public.document_series(company_id, kind, money_account_id)
  where money_account_id is not null and is_active;
create index document_series_money_account_idx on public.document_series(money_account_id);
alter table public.document_series enable row level security;
create policy "numbering of my books" on public.document_series for select to authenticated
  using (company_id in (select public.my_company_ids()));

-- Deliberate jumps (a new starting number) and steps over hand-keyed numbers,
-- so the gap check can tell them apart from a missing number.
alter table public.number_sequences add column skipped int not null default 0;

alter table public.journal_entries
  add column ref_series_id uuid references public.document_series(id),
  add column ref_period int,
  add column ref_seq int,
  add column doc_series_id uuid references public.document_series(id),
  add column doc_period int,
  add column doc_seq int,
  add constraint journal_entries_doc_no_text check (doc_no is null or length(doc_no) between 1 and 40),
  add constraint journal_entries_reference_text check (reference is null or length(reference) between 1 and 40);
create index journal_entries_ref_series_idx on public.journal_entries(ref_series_id, ref_period);
create index journal_entries_doc_series_idx on public.journal_entries(doc_series_id, doc_period);
create index journal_entries_lower_doc_no_idx on public.journal_entries(company_id, lower(doc_no)) where doc_no is not null;
create index journal_entries_lower_reference_idx on public.journal_entries(company_id, lower(reference)) where reference is not null;

-- ─── Helpers ────────────────────────────────────────────────────────────────
create or replace function public._series_period(p_reset text, p_date date)
returns int language sql immutable set search_path = public as $$
  select case p_reset when 'YEARLY' then extract(year from p_date)::int
                      when 'MONTHLY' then (extract(year from p_date) * 100 + extract(month from p_date))::int
                      else 0 end;
$$;

create or replace function public._format_number(p_format text, p_date date, p_n int)
returns text language plpgsql immutable set search_path = public as $$
declare v text; w int;
begin
  w := length(substring(p_format from '\{(#+)\}'));
  v := replace(replace(replace(p_format, '{YYYY}', to_char(p_date, 'YYYY')), '{YY}', to_char(p_date, 'YY')), '{MM}', to_char(p_date, 'MM'));
  return regexp_replace(v, '\{#+\}', lpad(p_n::text, greatest(w, length(p_n::text)), '0'));
end $$;

-- A regular expression matching every number the format can produce.
create or replace function public._series_pattern(p_format text)
returns text language sql immutable set search_path = public as $$
  select '^' || regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(p_format, '([./_ -])', '\\\1', 'g'),
           '\{YYYY\}', '[0-9]{4}', 'g'), '\{YY\}', '[0-9]{2}', 'g'), '\{MM\}', '[0-9]{2}', 'g'),
           '\{#+\}', '[0-9]+', 'g') || '$';
$$;

create or replace function public._check_series_format(p_format text, p_reset text)
returns void language plpgsql immutable set search_path = public as $$
declare v_digits int;
begin
  if p_format is null or length(p_format) not between 3 and 40 then
    raise exception 'VALIDATION: The format needs 3 to 40 characters.';
  end if;
  if (select count(*) from regexp_matches(p_format, '\{#+\}', 'g')) <> 1 then
    raise exception 'VALIDATION: Put the running number in the format once, written as {####}.';
  end if;
  v_digits := length(substring(p_format from '\{(#+)\}'));
  if v_digits not between 3 and 10 then
    raise exception 'VALIDATION: The running number needs 3 to 10 digits, from {###} to {##########}.';
  end if;
  if regexp_replace(p_format, '\{(YYYY|YY|MM|#+)\}', '', 'g') !~ '^[A-Za-z0-9/._ -]*$' then
    raise exception 'VALIDATION: Use letters, numbers, / . - _ and the codes {YYYY} {YY} {MM} {####} only.';
  end if;
  if p_reset = 'YEARLY' and p_format !~ '\{YY(YY)?\}' then
    raise exception 'VALIDATION: A series that restarts every year needs the year in it. Add {YYYY} or {YY}.';
  end if;
  if p_reset = 'MONTHLY' and (p_format !~ '\{YY(YY)?\}' or position('{MM}' in p_format) = 0) then
    raise exception 'VALIDATION: A series that restarts every month needs the year and month in it. Add {YYYY} and {MM}.';
  end if;
end $$;

create or replace function public._number_taken(p_company uuid, p_number text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.journal_entries
                 where company_id = p_company and (lower(doc_no) = lower(p_number) or lower(reference) = lower(p_number)));
$$;

create or replace function public._series_preview(p_series public.document_series, p_date date)
returns text language sql stable security definer set search_path = public as $$
  select public._format_number(p_series.format, p_date, coalesce((
    select ns.next_number from public.number_sequences ns
    where ns.company_id = p_series.company_id and ns.doc_type = p_series.code
      and ns.year = public._series_period(p_series.reset, p_date)), 1));
$$;

-- The next automatic number; steps over any number already keyed by hand.
create or replace function public._series_next(p_series public.document_series, p_date date)
returns table (doc_text text, doc_period int, doc_seq int)
language plpgsql security definer set search_path = public as $$
declare v_period int := public._series_period(p_series.reset, p_date); v_n int; v_text text;
begin
  loop
    insert into public.number_sequences (company_id, doc_type, year, next_number)
    values (p_series.company_id, p_series.code, v_period, 2)
    on conflict (company_id, doc_type, year) do update set next_number = public.number_sequences.next_number + 1
    returning public.number_sequences.next_number - 1 into v_n;
    v_text := public._format_number(p_series.format, p_date, v_n);
    exit when not public._number_taken(p_series.company_id, v_text);
    update public.number_sequences set skipped = skipped + 1
     where company_id = p_series.company_id and doc_type = p_series.code and year = v_period;
  end loop;
  return query select v_text, v_period, v_n;
end $$;

-- Automatic, or the number the person keyed — checked against the series rules.
create or replace function public._assign_number(p_series public.document_series, p_date date, p_manual text,
                                                 p_force_auto boolean default false)
returns table (doc_text text, doc_period int, doc_seq int)
language plpgsql security definer set search_path = public as $$
declare
  v_manual text := nullif(btrim(p_manual), '');
  v_label text := case p_series.kind when 'PAYMENT' then 'payment voucher' when 'RECEIPT' then 'receipt' else 'journal' end;
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
  -- Series that also number automatically keep their pattern to themselves.
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

-- A chosen series, else the one linked to the bank/cash account, else the default.
create or replace function public._resolve_series(p_company uuid, p_kind text, p_series uuid, p_money_account uuid)
returns public.document_series language plpgsql stable security definer set search_path = public as $$
declare v public.document_series;
begin
  if p_series is not null then
    select * into v from public.document_series where id = p_series and company_id = p_company;
    if not found or v.kind <> p_kind or not v.is_active then
      raise exception 'VALIDATION: Choose an active numbering series for this entry.';
    end if;
    return v;
  end if;
  if p_money_account is not null then
    select * into v from public.document_series
     where company_id = p_company and kind = p_kind and is_active and money_account_id = p_money_account;
    if found then return v; end if;
  end if;
  select * into v from public.document_series where company_id = p_company and kind = p_kind and is_default;
  return v; -- all fields null when the books have no series of this kind
end $$;

-- ─── Default series for every set of books ──────────────────────────────────
create or replace function public._seed_document_series()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.document_series (company_id, kind, code, name, format, is_default) values
    (new.id, 'JOURNAL', 'JV', 'Journal', 'JV-{YYYY}-{######}', true),
    (new.id, 'PAYMENT', 'PV', case when new.kind = 'PERSONAL' then 'Money out' else 'Payment voucher' end, 'PV-{YYYY}-{######}', true),
    (new.id, 'RECEIPT', 'OR', case when new.kind = 'PERSONAL' then 'Money in' else 'Official receipt' end, 'OR-{YYYY}-{######}', true)
  on conflict (company_id, code) do nothing;
  return new;
end $$;
create trigger companies_seed_numbering after insert on public.companies
  for each row execute function public._seed_document_series();

insert into public.document_series (company_id, kind, code, name, format, is_default)
select c.id, s.kind, s.code, case when c.kind = 'PERSONAL' then s.personal else s.business end, s.format, true
from public.companies c
cross join (values ('JOURNAL', 'JV', 'Journal', 'Journal', 'JV-{YYYY}-{######}'),
                   ('PAYMENT', 'PV', 'Payment voucher', 'Money out', 'PV-{YYYY}-{######}'),
                   ('RECEIPT', 'OR', 'Official receipt', 'Money in', 'OR-{YYYY}-{######}')) as s(kind, code, business, personal, format)
on conflict (company_id, code) do nothing;

-- Existing numbers join their series (posted rows are otherwise immutable).
alter table public.journal_entries disable trigger journal_entries_guard;
update public.journal_entries e
   set ref_series_id = s.id, ref_period = split_part(e.reference, '-', 2)::int, ref_seq = split_part(e.reference, '-', 3)::int
  from public.document_series s
 where s.company_id = e.company_id and s.code = 'JV' and e.reference ~ '^JV-[0-9]{4}-[0-9]+$';
update public.journal_entries e
   set doc_series_id = s.id, doc_period = split_part(e.doc_no, '-', 2)::int, doc_seq = split_part(e.doc_no, '-', 3)::int
  from public.document_series s
 where s.company_id = e.company_id and s.code = e.doc_type and e.doc_no ~ '^(PV|OR)-[0-9]{4}-[0-9]+$';
alter table public.journal_entries enable trigger journal_entries_guard;

-- Posted entries keep their numbers and voucher details for good.
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
       or new.description is distinct from old.description
       or new.doc_no is distinct from old.doc_no or new.doc_type is distinct from old.doc_type
       or new.doc_series_id is distinct from old.doc_series_id or new.doc_seq is distinct from old.doc_seq
       or new.ref_series_id is distinct from old.ref_series_id or new.ref_seq is distinct from old.ref_seq
       or new.party is distinct from old.party or new.pay_method is distinct from old.pay_method then
      raise exception 'IMMUTABLE: Posted journals cannot be edited — reverse them instead.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ─── Posting takes its journal number from the series ───────────────────────
drop function public.post_journal(uuid);
drop function public._post(uuid);

create function public._post(p_entry uuid, p_series uuid default null, p_reference text default null)
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
  select * into v_period from public.fiscal_periods
   where company_id = v_e.company_id and v_e.date between start_date and end_date;
  if not found then
    raise exception 'PERIOD_NOT_FOUND: No fiscal period covers %. Generate that fiscal year first.', to_char(v_e.date, 'DD Mon YYYY');
  end if;
  if v_period.status = 'CLOSED' then
    raise exception 'PERIOD_CLOSED: % is closed. Reopen it before posting to it.', v_period.name;
  end if;
  -- Money in/out, opening balances and reversals are always numbered automatically.
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

create function public.post_journal(p_id uuid, p_series uuid default null, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_result jsonb;
begin
  select company_id into v_company from public.journal_entries where id = p_id;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  perform public._require_perm(v_company, 'journal.post');
  v_result := public._post(p_id, p_series, p_reference);
  perform public._audit(v_company, 'journal.post', 'JournalEntry', p_id::text,
    format('Posted %s for %s', v_result->>'reference', to_char((v_result->>'total')::numeric, 'FM999,999,999,990.00')));
  return v_result;
end $$;

-- ─── Money in / out take their PV or OR number from the series ──────────────
drop function public.record_from_bank_line(uuid, uuid, text, text, numeric);
drop function public.record_transaction(uuid, text, date, numeric, uuid, uuid, text, text, numeric, text, text);

create function public.record_transaction(p_company uuid, p_kind text, p_date date, p_amount numeric,
                                          p_money_account uuid, p_other_account uuid,
                                          p_description text default null, p_reference text default null,
                                          p_tax_rate numeric default 0, p_party text default null, p_method text default null,
                                          p_series uuid default null, p_doc_no text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_amount numeric; v_net numeric; v_tax numeric := 0; v_tax_acc uuid; v_lines jsonb; v_desc text; v_saved jsonb;
  v_kind text := upper(coalesce(p_kind, '')); v_doc_type text; v_series public.document_series; v_num record;
  v_doc_no text; v_doc_period int; v_doc_seq int;
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
  if v_kind = 'TRANSFER' and (p_series is not null or nullif(btrim(p_doc_no), '') is not null) then
    raise exception 'VALIDATION: Transfers are numbered as journals only.';
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
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_other_account, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', p_money_account, 'debit', 0, 'credit', v_amount));
  end if;

  v_saved := public.save_journal(p_company, null, p_date, left(v_desc, 500), nullif(btrim(p_reference), ''), v_lines, null);
  -- The voucher number is fixed while the entry is still a draft; a failed post rolls it back.
  if v_kind in ('IN', 'OUT') then
    v_series := public._resolve_series(p_company, case v_kind when 'IN' then 'RECEIPT' else 'PAYMENT' end, p_series, p_money_account);
    if v_series.id is not null then
      select * into v_num from public._assign_number(v_series, p_date, p_doc_no, false);
      v_doc_no := v_num.doc_text; v_doc_period := v_num.doc_period; v_doc_seq := v_num.doc_seq;
      v_doc_type := case v_kind when 'IN' then 'OR' else 'PV' end;
    elsif nullif(btrim(p_doc_no), '') is not null then
      raise exception 'VALIDATION: These books have no active % numbering series. Add one under Numbering.',
        case v_kind when 'IN' then 'receipt' else 'payment' end;
    end if;
  end if;
  update public.journal_entries set source = 'BANK', txn_kind = v_kind, doc_type = v_doc_type,
    doc_no = v_doc_no, doc_series_id = case when v_doc_no is null then null else v_series.id end, doc_period = v_doc_period, doc_seq = v_doc_seq,
    party = nullif(btrim(p_party), ''), pay_method = nullif(btrim(p_method), '')
  where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid)
    || jsonb_build_object('kind', v_kind, 'tax', v_tax, 'doc_no', v_doc_no, 'doc_type', v_doc_type);
end $$;

create function public.record_from_bank_line(p_line uuid, p_other_account uuid, p_description text default null,
                                             p_party text default null, p_tax_rate numeric default 0,
                                             p_series uuid default null, p_doc_no text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines; v_st record; v_r jsonb;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  if v_l.status <> 'UNMATCHED' then raise exception 'INVALID_STATE: Only unmatched bank lines can be recorded.'; end if;
  select * into v_st from public.bank_statements where id = v_l.statement_id;
  v_r := public.record_transaction(v_l.company_id, case when v_l.amount > 0 then 'IN' else 'OUT' end, v_l.date, abs(v_l.amount),
                                   v_st.account_id, p_other_account, coalesce(nullif(btrim(p_description), ''), v_l.description),
                                   v_l.reference, p_tax_rate, p_party, 'Bank transfer', p_series, p_doc_no);
  update public.bank_lines set status = 'MATCHED', entry_id = (v_r->>'id')::uuid, match_method = 'CREATED', updated_at = now() where id = p_line;
  return v_r;
end $$;

-- ─── Managing series ────────────────────────────────────────────────────────
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
         (select count(*)::int from public.journal_entries e where e.ref_series_id = s.id or e.doc_series_id = s.id)
  from public.document_series s
  left join public.number_sequences ns
    on ns.company_id = s.company_id and ns.doc_type = s.code and ns.year = public._series_period(s.reset, v_date)
  where s.company_id = p_company
  order by case s.kind when 'PAYMENT' then 1 when 'RECEIPT' then 2 else 3 end, s.is_default desc, s.name;
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
    select count(*) into v_used from public.journal_entries where ref_series_id = p_id or doc_series_id = p_id;
    if v_used > 0 and v_reset <> v_old.reset then
      raise exception 'VALIDATION: This series already numbers % entries, so when it restarts can''t change. Add a new series instead.', v_used;
    end if;
  else
    if v_kind not in ('PAYMENT', 'RECEIPT', 'JOURNAL') then raise exception 'VALIDATION: Choose what the series numbers.'; end if;
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
    if v_kind = 'JOURNAL' then raise exception 'VALIDATION: Journal series aren''t linked to a bank account.'; end if;
    select a.*, c.kind as company_kind into v_acc from public.accounts a join public.companies c on c.id = a.company_id
     where a.id = p_money_account and a.company_id = p_company;
    if not found or not (v_acc.is_cash or (v_acc.company_kind = 'PERSONAL' and v_acc.type = 'LIABILITY' and v_acc.sub_type = 'CURRENT_LIABILITY')) then
      raise exception 'VALIDATION: Link the series to a bank, cash or card account.';
    end if;
    if v_active and exists (select 1 from public.document_series where company_id = p_company and kind = v_kind and is_active
                              and money_account_id = p_money_account and id is distinct from p_id) then
      raise exception 'DUPLICATE: Another % series is already linked to % %.', lower(v_kind), v_acc.code, v_acc.name;
    end if;
  end if;

  -- One default per kind, always active; the first series of a kind becomes it.
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
    delete from public.number_sequences where company_id = p_company and doc_type = v_code; -- no stale counter
  else
    update public.document_series set name = btrim(p_name), title = nullif(btrim(p_title), ''), format = v_format, reset = v_reset,
      mode = v_mode, money_account_id = p_money_account, is_default = v_default, is_active = v_active, updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;

  -- A new next number applies to the current period; numbers already used can't be reused.
  if p_next_number is not null then
    if p_next_number not between 1 and 99999999 then raise exception 'VALIDATION: The next number is between 1 and 99,999,999.'; end if;
    v_period := public._series_period(v_reset, current_date);
    select next_number into v_cur from public.number_sequences where company_id = p_company and doc_type = v_code and year = v_period;
    v_cur := coalesce(v_cur, 1);
    select greatest(coalesce(max(ref_seq) filter (where ref_series_id = v_id and ref_period = v_period), 0),
                    coalesce(max(doc_seq) filter (where doc_series_id = v_id and doc_period = v_period), 0))
      into v_max from public.journal_entries where company_id = p_company;
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
  select count(*) into v_used from public.journal_entries where ref_series_id = p_id or doc_series_id = p_id;
  if v_used > 0 then
    raise exception 'IN_USE: % entries carry numbers from this series. Make it inactive instead.', v_used;
  end if;
  delete from public.number_sequences where company_id = v.company_id and doc_type = v.code;
  delete from public.document_series where id = p_id;
  perform public._audit(v.company_id, 'numbering.delete', 'DocumentSeries', p_id::text, format('Removed numbering series %s (%s)', v.name, v.code));
end $$;

-- ─── Account codes can change, except the ones the posting rules look up ────
create or replace function public.change_account_code(p_id uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare v_a record; v_code text := btrim(coalesce(p_code, ''));
begin
  select a.*, c.kind as company_kind into v_a from public.accounts a join public.companies c on c.id = a.company_id where a.id = p_id;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  perform public._require_perm(v_a.company_id, 'account.edit');
  if v_code = v_a.code then return; end if;
  if v_code !~ '^[0-9A-Za-z.\-]{1,20}$' then raise exception 'VALIDATION: Account code must be 1–20 letters, digits, dots or dashes.'; end if;
  if v_a.is_system or v_a.code in ('2150', '3300') or v_a.code = (case v_a.company_kind when 'PERSONAL' then '3100' else '3200' end) then
    raise exception 'SYSTEM_ACCOUNT: % % is used by the posting rules, so its code stays.', v_a.code, v_a.name;
  end if;
  if v_code in ('2150', '3300', case v_a.company_kind when 'PERSONAL' then '3100' else '3200' end) then
    raise exception 'VALIDATION: % is reserved for the posting rules.', v_code;
  end if;
  if exists (select 1 from public.accounts where company_id = v_a.company_id and code = v_code) then
    raise exception 'DUPLICATE: Account code % is already in use.', v_code;
  end if;
  update public.accounts set code = v_code, updated_at = now() where id = p_id;
  perform public._audit(v_a.company_id, 'account.edit', 'Account', p_id::text, format('Changed account code %s to %s (%s)', v_a.code, v_code, v_a.name));
end $$;

-- ─── Proof: automatic numbers have no gaps ──────────────────────────────────
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

  -- Per series and period, the highest automatic number equals the count, apart
  -- from deliberate jumps and numbers stepped over because someone keyed them.
  select coalesce(sum(greatest(0, x.mx - x.n - coalesce(ns.skipped, 0))), 0)::int into v_gaps
  from (
    select s.code, e.ref_period as period, max(e.ref_seq) as mx, count(*) as n
    from public.journal_entries e join public.document_series s on s.id = e.ref_series_id
    where e.company_id = p_company and e.status in ('POSTED', 'REVERSED') and e.ref_seq is not null
    group by s.code, e.ref_period
    union all
    select s.code, e.doc_period, max(e.doc_seq), count(*)
    from public.journal_entries e join public.document_series s on s.id = e.doc_series_id
    where e.company_id = p_company and e.status in ('POSTED', 'REVERSED') and e.doc_seq is not null
    group by s.code, e.doc_period) x
  left join public.number_sequences ns on ns.company_id = p_company and ns.doc_type = x.code and ns.year = x.period;

  select count(*), max(created_at) into v_audit, v_last from public.audit_log where company_id = p_company;
  select count(*) into v_closed from public.fiscal_periods where company_id = p_company and status = 'CLOSED';

  return jsonb_build_object(
    'entries', v_entries, 'unbalanced', v_unbalanced,
    'total_debit', v_dr, 'total_credit', v_cr,
    'assets', v_assets, 'liabilities', v_liab, 'equity', v_equity, 'result', v_result,
    'numbering_gaps', v_gaps, 'lines_on_headings', v_headings,
    'audit_events', v_audit, 'last_audit_at', v_last, 'closed_periods', v_closed);
end $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function
  public._series_period(text, date), public._format_number(text, date, int), public._series_pattern(text),
  public._check_series_format(text, text), public._number_taken(uuid, text),
  public._series_preview(public.document_series, date), public._series_next(public.document_series, date),
  public._assign_number(public.document_series, date, text, boolean), public._resolve_series(uuid, text, uuid, uuid),
  public._seed_document_series(), public._post(uuid, uuid, text)
from public, anon, authenticated;
revoke execute on function
  public.post_journal(uuid, uuid, text),
  public.record_transaction(uuid, text, date, numeric, uuid, uuid, text, text, numeric, text, text, uuid, text),
  public.record_from_bank_line(uuid, uuid, text, text, numeric, uuid, text),
  public.document_series_overview(uuid, date),
  public.save_document_series(uuid, uuid, text, text, text, text, text, text, text, uuid, boolean, boolean, int),
  public.delete_document_series(uuid), public.change_account_code(uuid, text), public.books_proof(uuid)
from public, anon;
grant execute on function
  public.post_journal(uuid, uuid, text),
  public.record_transaction(uuid, text, date, numeric, uuid, uuid, text, text, numeric, text, text, uuid, text),
  public.record_from_bank_line(uuid, uuid, text, text, numeric, uuid, text),
  public.document_series_overview(uuid, date),
  public.save_document_series(uuid, uuid, text, text, text, text, text, text, text, uuid, boolean, boolean, int),
  public.delete_document_series(uuid), public.change_account_code(uuid, text), public.books_proof(uuid)
to authenticated;
