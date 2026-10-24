-- ═══════════════════════════════════════════════════════════════════════════
-- Platform admin console · payment vouchers & official receipts · document
-- templates · bank reconciliation from uploaded statements.
-- Platform admins are granted by user id (never by email, which sign-up does not
-- verify):  insert into public.platform_admins (user_id) values ('<uuid>');
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Platform admin ─────────────────────────────────────────────────────────
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security; -- no client policies

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public._require_platform_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'PERMISSION_DENIED: Platform administrators only.'; end if;
end $$;

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_platform_admin();
  return jsonb_build_object(
    'users', (select count(*) from auth.users),
    'business', (select count(*) from public.companies where kind = 'BUSINESS'),
    'personal', (select count(*) from public.companies where kind = 'PERSONAL'),
    'posted', (select count(*) from public.journal_entries where status in ('POSTED','REVERSED')),
    'posted_30d', (select count(*) from public.journal_entries where status in ('POSTED','REVERSED') and posted_at > now() - interval '30 days'),
    'signups_30d', (select count(*) from auth.users where created_at > now() - interval '30 days'));
end $$;

create or replace function public.admin_users()
returns table (id uuid, email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz, books int, is_admin boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public._require_platform_admin();
  return query
  select u.id, u.email::text, coalesce(p.full_name, ''), u.created_at, u.last_sign_in_at,
         (select count(*)::int from public.company_members m where m.user_id = u.id),
         exists (select 1 from public.platform_admins a where a.user_id = u.id)
  from auth.users u left join public.profiles p on p.id = u.id
  order by u.created_at desc;
end $$;

create or replace function public.admin_companies()
returns table (id uuid, name text, kind text, created_at timestamptz, owner_email text, members int, posted int,
               last_entry date, i_am_member boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_platform_admin();
  return query
  select c.id, c.name, c.kind, c.created_at, (select pr.email from public.profiles pr where pr.id = c.created_by),
         (select count(*)::int from public.company_members m where m.company_id = c.id),
         (select count(*)::int from public.journal_entries e where e.company_id = c.id and e.status in ('POSTED','REVERSED')),
         (select max(e.date) from public.journal_entries e where e.company_id = c.id and e.status in ('POSTED','REVERSED')),
         exists (select 1 from public.company_members m where m.company_id = c.id and m.user_id = auth.uid())
  from public.companies c
  order by c.created_at desc;
end $$;

-- Opens a set of books for support: the admin becomes an owner, and the books'
-- own audit trail records it.
create or replace function public.admin_join_company(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  perform public._require_platform_admin();
  select name into v_name from public.companies where id = p_company;
  if not found then raise exception 'NOT_FOUND: Books not found.'; end if;
  insert into public.company_members (company_id, user_id, role) values (p_company, auth.uid(), 'SuperAdmin')
  on conflict (company_id, user_id) do update set role = 'SuperAdmin';
  perform public._audit(p_company, 'admin.join', 'User', auth.uid()::text, 'A Zycount platform administrator opened these books for support');
end $$;

-- ─── Vouchers: PV for money out, OR for money in ────────────────────────────
alter table public.journal_entries
  add column doc_type text check (doc_type in ('PV', 'OR')),
  add column doc_no text,
  add column party text check (party is null or length(party) <= 200),
  add column pay_method text check (pay_method is null or length(pay_method) <= 60);
create unique index journal_entries_doc_no_uniq on public.journal_entries(company_id, doc_no) where doc_no is not null;

drop function public.record_transaction(uuid, text, date, numeric, uuid, uuid, text, text, numeric);
create function public.record_transaction(p_company uuid, p_kind text, p_date date, p_amount numeric,
                                          p_money_account uuid, p_other_account uuid,
                                          p_description text default null, p_reference text default null,
                                          p_tax_rate numeric default 0, p_party text default null, p_method text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_amount numeric; v_net numeric; v_tax numeric := 0; v_tax_acc uuid; v_lines jsonb; v_desc text; v_saved jsonb;
  v_kind text := upper(coalesce(p_kind, '')); v_doc_type text; v_doc_no text;
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
  if v_kind in ('IN', 'OUT') then
    v_doc_type := case v_kind when 'IN' then 'OR' else 'PV' end;
    v_doc_no := public._next_number(p_company, v_doc_type, extract(year from p_date)::int);
  end if;
  update public.journal_entries set source = 'BANK', txn_kind = v_kind, doc_type = v_doc_type, doc_no = v_doc_no,
    party = nullif(btrim(p_party), ''), pay_method = nullif(btrim(p_method), '')
  where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid)
    || jsonb_build_object('kind', v_kind, 'tax', v_tax, 'doc_no', v_doc_no, 'doc_type', v_doc_type);
end $$;

-- ─── Document template (logo, colours, titles, signatures) ──────────────────
create table public.document_settings (
  company_id  uuid primary key references public.companies(id) on delete cascade,
  logo        text check (logo is null or (length(logo) <= 400000 and logo ~ '^data:image/(png|jpeg|webp);base64,')),
  accent      text not null default '#3A3FD0' check (accent ~ '^#[0-9A-Fa-f]{6}$'),
  pv_title    text not null default 'Payment Voucher' check (length(pv_title) between 1 and 60),
  or_title    text not null default 'Official Receipt' check (length(or_title) between 1 and 60),
  footer      text check (footer is null or length(footer) <= 500),
  sign_labels jsonb not null default '["Prepared by","Approved by","Received by"]',
  show_lines  boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.document_settings enable row level security;
create policy "document settings of my books" on public.document_settings for select to authenticated
  using (company_id in (select public.my_company_ids()));

create or replace function public.save_document_settings(p_company uuid, p_logo text, p_accent text, p_pv_title text,
                                                         p_or_title text, p_footer text, p_sign_labels jsonb, p_show_lines boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'company.edit');
  if p_sign_labels is null or jsonb_typeof(p_sign_labels) <> 'array' or jsonb_array_length(p_sign_labels) > 4 then
    raise exception 'VALIDATION: Use up to four signature boxes.';
  end if;
  insert into public.document_settings (company_id, logo, accent, pv_title, or_title, footer, sign_labels, show_lines, updated_at)
  values (p_company, nullif(p_logo, ''), coalesce(nullif(p_accent, ''), '#3A3FD0'), coalesce(nullif(btrim(p_pv_title), ''), 'Payment Voucher'),
          coalesce(nullif(btrim(p_or_title), ''), 'Official Receipt'), nullif(btrim(p_footer), ''), p_sign_labels, coalesce(p_show_lines, true), now())
  on conflict (company_id) do update set logo = excluded.logo, accent = excluded.accent, pv_title = excluded.pv_title,
    or_title = excluded.or_title, footer = excluded.footer, sign_labels = excluded.sign_labels,
    show_lines = excluded.show_lines, updated_at = now();
  perform public._audit(p_company, 'company.edit', 'Company', p_company::text, 'Updated the voucher and receipt template');
end $$;

-- ─── Bank reconciliation ────────────────────────────────────────────────────
create table public.bank_statements (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  account_id      uuid not null references public.accounts(id),
  name            text not null check (length(name) between 1 and 200),
  date_from       date,
  date_to         date,
  opening_balance numeric(18,2),
  closing_balance numeric(18,2),
  line_count      int not null default 0,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index bank_statements_company_idx on public.bank_statements(company_id, account_id, date_to desc);

create table public.bank_lines (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.bank_statements(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  line_no      int not null,
  date         date not null,
  description  text check (description is null or length(description) <= 500),
  reference    text check (reference is null or length(reference) <= 100),
  amount       numeric(18,2) not null check (amount <> 0),   -- + money in, − money out
  balance      numeric(18,2),
  status       text not null default 'UNMATCHED' check (status in ('UNMATCHED', 'MATCHED', 'IGNORED')),
  entry_id     uuid references public.journal_entries(id),
  match_method text check (match_method in ('AUTO', 'MANUAL', 'CREATED')),
  note         text check (note is null or length(note) <= 300),
  updated_at   timestamptz not null default now()
);
create index bank_lines_statement_idx on public.bank_lines(statement_id, line_no);
create unique index bank_lines_entry_uniq on public.bank_lines(entry_id) where entry_id is not null; -- one bank line per journal

alter table public.bank_statements enable row level security;
alter table public.bank_lines enable row level security;
create policy "statements by permission" on public.bank_statements for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')) or company_id in (select public.companies_with_perm('ledger.view')));
create policy "bank lines by permission" on public.bank_lines for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')) or company_id in (select public.companies_with_perm('ledger.view')));

-- Pairs each unmatched bank line with one posted journal on the same account for the
-- same amount and side, within 7 days; a PV/OR/JV number in the bank text wins ties.
create or replace function public._auto_match(p_statement uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_st record; v_l record; v_e uuid; v_n int := 0; v_text text;
begin
  select * into v_st from public.bank_statements where id = p_statement;
  for v_l in select * from public.bank_lines where statement_id = p_statement and status = 'UNMATCHED' order by date, line_no loop
    v_text := lower(coalesce(v_l.description, '') || ' ' || coalesce(v_l.reference, ''));
    select e.id into v_e
    from public.journal_entries e
    join public.journal_lines jl on jl.journal_entry_id = e.id and jl.account_id = v_st.account_id
    where e.company_id = v_st.company_id and e.status = 'POSTED' and e.reversal_of_id is null
      and ((v_l.amount > 0 and jl.debit = v_l.amount) or (v_l.amount < 0 and jl.credit = -v_l.amount))
      and e.date between v_l.date - 7 and v_l.date + 7
      and not exists (select 1 from public.bank_lines b where b.entry_id = e.id)
    order by
      case when strpos(v_text, lower(coalesce(e.doc_no, '§'))) > 0
             or strpos(v_text, lower(e.reference)) > 0
             or (length(e.memo) >= 4 and strpos(v_text, lower(e.memo)) > 0) then 0 else 1 end,
      abs(e.date - v_l.date), e.posted_at
    limit 1;
    if found then
      update public.bank_lines set status = 'MATCHED', entry_id = v_e, match_method = 'AUTO', updated_at = now() where id = v_l.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function public.import_bank_statement(p_company uuid, p_account uuid, p_name text, p_lines jsonb,
                                                        p_opening numeric default null, p_closing numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acc record; v_id uuid; v_line jsonb; v_no int := 0; v_date date; v_amt numeric; v_matched int;
begin
  perform public._require_perm(p_company, 'journal.create');
  select * into v_acc from public.accounts where id = p_account and company_id = p_company;
  if not found then raise exception 'VALIDATION: Account not found in these books.'; end if;
  if not v_acc.is_cash or not v_acc.is_postable then
    raise exception 'VALIDATION: % % is not a bank or cash account.', v_acc.code, v_acc.name;
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
  v_matched := public._auto_match(v_id);
  perform public._audit(p_company, 'bank.import', 'BankStatement', v_id::text,
    format('Imported %s bank lines for %s %s; %s matched automatically', v_no, v_acc.code, v_acc.name, v_matched));
  return jsonb_build_object('id', v_id, 'lines', v_no, 'matched', v_matched);
end $$;

create or replace function public.auto_match_statement(p_statement uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_n int;
begin
  select company_id into v_company from public.bank_statements where id = p_statement;
  if not found then raise exception 'NOT_FOUND: Statement not found.'; end if;
  perform public._require_perm(v_company, 'journal.post');
  v_n := public._auto_match(p_statement);
  return v_n;
end $$;

create or replace function public._bank_line_for_update(p_line uuid, p_perm text)
returns public.bank_lines language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines;
begin
  select * into v_l from public.bank_lines where id = p_line for update;
  if not found then raise exception 'NOT_FOUND: Bank line not found.'; end if;
  perform public._require_perm(v_l.company_id, p_perm);
  return v_l;
end $$;

create or replace function public.match_bank_line(p_line uuid, p_entry uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines; v_account uuid; v_ok boolean;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  if v_l.status = 'MATCHED' then raise exception 'INVALID_STATE: This bank line is already matched.'; end if;
  select account_id into v_account from public.bank_statements where id = v_l.statement_id;
  select exists (
    select 1 from public.journal_entries e join public.journal_lines jl on jl.journal_entry_id = e.id and jl.account_id = v_account
    where e.id = p_entry and e.company_id = v_l.company_id and e.status = 'POSTED' and e.reversal_of_id is null
      and ((v_l.amount > 0 and jl.debit = v_l.amount) or (v_l.amount < 0 and jl.credit = -v_l.amount))) into v_ok;
  if not v_ok then
    raise exception 'AMOUNT_MISMATCH: That journal does not move % on this bank account.', to_char(abs(v_l.amount), 'FM999,999,999,990.00');
  end if;
  if exists (select 1 from public.bank_lines where entry_id = p_entry) then
    raise exception 'DUPLICATE: That journal is already matched to another bank line.';
  end if;
  update public.bank_lines set status = 'MATCHED', entry_id = p_entry, match_method = 'MANUAL', note = null, updated_at = now() where id = p_line;
end $$;

create or replace function public.unmatch_bank_line(p_line uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  update public.bank_lines set status = 'UNMATCHED', entry_id = null, match_method = null, note = null, updated_at = now() where id = p_line;
end $$;

create or replace function public.ignore_bank_line(p_line uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  if v_l.status = 'MATCHED' then raise exception 'INVALID_STATE: Unmatch the line first.'; end if;
  update public.bank_lines set status = 'IGNORED', note = nullif(btrim(p_note), ''), updated_at = now() where id = p_line;
end $$;

-- Posts the missing PV/OR for a bank line and matches it in one step.
create or replace function public.record_from_bank_line(p_line uuid, p_other_account uuid, p_description text default null,
                                                        p_party text default null, p_tax_rate numeric default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines; v_st record; v_r jsonb;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  if v_l.status <> 'UNMATCHED' then raise exception 'INVALID_STATE: Only unmatched bank lines can be recorded.'; end if;
  select * into v_st from public.bank_statements where id = v_l.statement_id;
  v_r := public.record_transaction(v_l.company_id, case when v_l.amount > 0 then 'IN' else 'OUT' end, v_l.date, abs(v_l.amount),
                                   v_st.account_id, p_other_account, coalesce(nullif(btrim(p_description), ''), v_l.description),
                                   v_l.reference, p_tax_rate, p_party, 'Bank transfer');
  update public.bank_lines set status = 'MATCHED', entry_id = (v_r->>'id')::uuid, match_method = 'CREATED', updated_at = now() where id = p_line;
  return v_r;
end $$;

create or replace function public.delete_bank_statement(p_statement uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_s record;
begin
  select * into v_s from public.bank_statements where id = p_statement;
  if not found then raise exception 'NOT_FOUND: Statement not found.'; end if;
  perform public._require_perm(v_s.company_id, 'journal.create');
  delete from public.bank_statements where id = p_statement;
  perform public._audit(v_s.company_id, 'bank.delete', 'BankStatement', p_statement::text,
    format('Deleted bank statement %s (%s lines). Journals are unchanged.', v_s.name, v_s.line_count));
end $$;

-- Journals that could be this bank line: same account, same amount and side, not yet matched.
create or replace function public.bank_match_candidates(p_line uuid)
returns table (entry_id uuid, date date, reference text, doc_no text, description text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_l public.bank_lines; v_account uuid;
begin
  select * into v_l from public.bank_lines where id = p_line;
  if not found then raise exception 'NOT_FOUND: Bank line not found.'; end if;
  if not (public.has_perm(v_l.company_id, 'journal.view') or public.has_perm(v_l.company_id, 'ledger.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view journals in these books.';
  end if;
  select account_id into v_account from public.bank_statements where id = v_l.statement_id;
  return query
  select distinct on (e.id) e.id, e.date, e.reference, e.doc_no, e.description, (jl.debit - jl.credit)::numeric
  from public.journal_entries e join public.journal_lines jl on jl.journal_entry_id = e.id and jl.account_id = v_account
  where e.company_id = v_l.company_id and e.status = 'POSTED' and e.reversal_of_id is null
    and ((v_l.amount > 0 and jl.debit = v_l.amount) or (v_l.amount < 0 and jl.credit = -v_l.amount))
    and e.date between v_l.date - 45 and v_l.date + 45
    and not exists (select 1 from public.bank_lines b where b.entry_id = e.id)
  order by e.id, e.date
  limit 50;
end $$;

-- Book movements on the statement's account, in its date range, with no bank line.
create or replace function public.bank_unmatched_book(p_statement uuid)
returns table (entry_id uuid, date date, reference text, doc_no text, description text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_s record;
begin
  select * into v_s from public.bank_statements where id = p_statement;
  if not found then raise exception 'NOT_FOUND: Statement not found.'; end if;
  if not (public.has_perm(v_s.company_id, 'journal.view') or public.has_perm(v_s.company_id, 'ledger.view')) then
    raise exception 'PERMISSION_DENIED: Your role cannot view journals in these books.';
  end if;
  return query
  select e.id, e.date, e.reference, e.doc_no, e.description, sum(jl.debit - jl.credit)::numeric
  from public.journal_entries e join public.journal_lines jl on jl.journal_entry_id = e.id and jl.account_id = v_s.account_id
  where e.company_id = v_s.company_id and e.status = 'POSTED' and e.reversal_of_id is null
    and e.date between v_s.date_from and v_s.date_to
    and not exists (select 1 from public.bank_lines b where b.entry_id = e.id)
  group by e.id, e.date, e.reference, e.doc_no, e.description
  order by e.date;
end $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function public._require_platform_admin(), public._auto_match(uuid), public._bank_line_for_update(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.is_platform_admin(), public.admin_overview(), public.admin_users(), public.admin_companies(), public.admin_join_company(uuid),
  public.record_transaction(uuid, text, date, numeric, uuid, uuid, text, text, numeric, text, text),
  public.save_document_settings(uuid, text, text, text, text, text, jsonb, boolean),
  public.import_bank_statement(uuid, uuid, text, jsonb, numeric, numeric), public.auto_match_statement(uuid),
  public.match_bank_line(uuid, uuid), public.unmatch_bank_line(uuid), public.ignore_bank_line(uuid, text),
  public.record_from_bank_line(uuid, uuid, text, text, numeric), public.delete_bank_statement(uuid),
  public.bank_match_candidates(uuid), public.bank_unmatched_book(uuid)
to authenticated;
