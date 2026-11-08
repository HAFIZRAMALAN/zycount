-- Maker-checker approvals (docs/spec/10 §26), one level.
--
-- When a company turns it on (Settings; needs two or more people who can post), money going out and
-- manual journals above the company's threshold (default RM 5,000) need a second person:
--   • purchase invoices, cash purchases, supplier debit notes and supplier payments;
--   • manual journals (Journal editor) and money-out vouchers (PV) from the Transactions page.
-- "Post" by the maker submits it instead: the draft is locked (status DRAFT, approval PENDING) with the
-- numbering the maker chose — the company's own series (PV/PI/JV…) or a number typed by hand. Someone
-- else with posting rights approves it, which posts it with that number (the checker may change it), or
-- rejects it with a reason, which unlocks the draft. Nobody approves their own submission.
-- Recording or settling from a bank statement is not held: the money has already moved, and the line is matched at once.
-- NB: from here on the trade-document posting body is _post_trade_doc_core; _post_trade_doc is the gate.

alter table public.companies
  add column approval_enabled boolean not null default false,
  add column approval_threshold numeric(18,2) not null default 5000 check (approval_threshold >= 0);

alter table public.trade_docs
  add column approval_status text check (approval_status in ('PENDING', 'REJECTED', 'APPROVED')),
  add column submitted_by uuid references auth.users(id) on delete set null,
  add column submitted_at timestamptz,
  add column approved_by uuid references auth.users(id) on delete set null,
  add column approved_at timestamptz,
  add column approval_note text check (length(approval_note) <= 500),
  add column draft_allocations jsonb;
create index trade_docs_pending_idx on public.trade_docs(company_id) where approval_status = 'PENDING';
create index trade_docs_submitted_by_idx on public.trade_docs(submitted_by);
create index trade_docs_approved_by_idx on public.trade_docs(approved_by);

alter table public.journal_entries
  add column approval_status text check (approval_status in ('PENDING', 'REJECTED', 'APPROVED')),
  add column submitted_by uuid references auth.users(id) on delete set null,
  add column submitted_at timestamptz,
  add column approved_by uuid references auth.users(id) on delete set null,
  add column approved_at timestamptz,
  add column approval_note text check (length(approval_note) <= 500),
  add column draft_series_id uuid references public.document_series(id) on delete set null,
  add column draft_reference text check (length(draft_reference) <= 40);
create index journal_entries_pending_idx on public.journal_entries(company_id) where approval_status = 'PENDING';
create index journal_entries_submitted_by_idx on public.journal_entries(submitted_by);
create index journal_entries_approved_by_idx on public.journal_entries(approved_by);
create index journal_entries_draft_series_idx on public.journal_entries(draft_series_id);

/** Does this amount need a second person in these books? */
create or replace function public._needs_approval(p_company uuid, p_amount numeric)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select c.approval_enabled and p_amount > c.approval_threshold from public.companies c where c.id = p_company), false);
$$;

-- ─── A submitted draft is locked until it is approved, rejected or withdrawn ─
create or replace function public._guard_pending()
returns trigger language plpgsql set search_path = public as $$
declare v_free text[] := array['approval_status', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'approval_note',
                               'draft_series_id', 'draft_doc_no', 'draft_reference', 'draft_allocations', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.approval_status = 'PENDING' then raise exception 'PENDING_APPROVAL: This is waiting for approval. Withdraw it first.'; end if;
    return old;
  end if;
  if old.approval_status = 'PENDING' and (to_jsonb(new) - v_free) <> (to_jsonb(old) - v_free) then
    raise exception 'PENDING_APPROVAL: This is waiting for approval and can''t be changed. Withdraw it to edit.';
  end if;
  return new;
end $$;
create trigger trade_docs_pending_guard before update or delete on public.trade_docs
  for each row execute function public._guard_pending();
create trigger journal_entries_pending_guard before update or delete on public.journal_entries
  for each row execute function public._guard_pending();

create or replace function public._guard_pending_line()
returns trigger language plpgsql set search_path = public as $$
declare v text;
begin
  if tg_table_name = 'trade_doc_lines' then
    select approval_status into v from public.trade_docs where id = coalesce(new.doc_id, old.doc_id);
  else
    select approval_status into v from public.journal_entries where id = coalesce(new.journal_entry_id, old.journal_entry_id);
  end if;
  if v = 'PENDING' then raise exception 'PENDING_APPROVAL: This is waiting for approval and can''t be changed. Withdraw it to edit.'; end if;
  return coalesce(new, old);
end $$;
create trigger trade_doc_lines_pending_guard before insert or update or delete on public.trade_doc_lines
  for each row execute function public._guard_pending_line();
create trigger journal_lines_pending_guard before insert or update or delete on public.journal_lines
  for each row execute function public._guard_pending_line();

-- ─── The gates ──────────────────────────────────────────────────────────────
alter function public._post_trade_doc(uuid, uuid, text, jsonb, boolean) rename to _post_trade_doc_core;
revoke execute on function public._post_trade_doc_core(uuid, uuid, text, jsonb, boolean) from public, anon, authenticated;

create function public._post_trade_doc(p_id uuid, p_series uuid, p_doc_no text, p_allocations jsonb, p_over_limit boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.trade_docs;
begin
  select * into v from public.trade_docs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  if v.status = 'DRAFT' and v.doc_type in ('BILL', 'CASH_PURCHASE', 'SUPPLIER_DN', 'PAYMENT')
     and public._needs_approval(v.company_id, v.total)
     and coalesce(current_setting('zycount.approving', true), '') <> p_id::text
     and coalesce(current_setting('zycount.no_approval', true), '') <> 'on' then
    perform public._require_perm(v.company_id, 'journal.create');
    if v.total <= 0 then raise exception 'VALIDATION: The total must be more than zero.'; end if;
    update public.trade_docs set approval_status = 'PENDING', submitted_by = auth.uid(), submitted_at = now(),
      approved_by = null, approved_at = null, approval_note = null,
      draft_series_id = coalesce(p_series, draft_series_id), draft_doc_no = coalesce(nullif(btrim(p_doc_no), ''), draft_doc_no),
      draft_allocations = p_allocations
    where id = p_id;
    perform public._audit(v.company_id, 'approval.submit', 'TradeDoc', p_id::text,
      format('Submitted %s for approval, %s', lower(replace(v.doc_type, '_', ' ')), to_char(v.total, 'FM999,999,999,990.00')));
    return jsonb_build_object('id', p_id, 'status', 'PENDING', 'total', v.total);
  end if;
  return public._post_trade_doc_core(p_id, p_series, p_doc_no, p_allocations, p_over_limit);
end $$;
revoke execute on function public._post_trade_doc(uuid, uuid, text, jsonb, boolean) from public, anon, authenticated;

create or replace function public.post_journal(p_id uuid, p_series uuid default null, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.journal_entries; v_result jsonb;
begin
  select * into v from public.journal_entries where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Journal not found.'; end if;
  if v.status = 'DRAFT' and v.reversal_of_id is null
     and ((v.source = 'MANUAL' and v.source_id is null) or (v.source = 'BANK' and v.txn_kind = 'OUT'))
     and public._needs_approval(v.company_id, v.total_debit)
     and coalesce(current_setting('zycount.approving', true), '') <> p_id::text
     and coalesce(current_setting('zycount.no_approval', true), '') <> 'on' then
    perform public._require_perm(v.company_id, 'journal.create');
    if v.total_debit <> v.total_credit then
      raise exception 'JOURNAL_UNBALANCED: Debits % and credits % must be equal before it can be submitted.',
        to_char(v.total_debit, 'FM999,999,999,990.00'), to_char(v.total_credit, 'FM999,999,999,990.00');
    end if;
    update public.journal_entries set approval_status = 'PENDING', submitted_by = auth.uid(), submitted_at = now(),
      approved_by = null, approved_at = null, approval_note = null,
      draft_series_id = coalesce(p_series, draft_series_id), draft_reference = coalesce(nullif(btrim(p_reference), ''), draft_reference)
    where id = p_id;
    perform public._audit(v.company_id, 'approval.submit', 'JournalEntry', p_id::text,
      format('Submitted %s for approval, %s', coalesce(v.doc_no, 'a journal'), to_char(v.total_debit, 'FM999,999,999,990.00')));
    return jsonb_build_object('id', p_id, 'status', 'PENDING', 'total', v.total_debit, 'doc_no', v.doc_no);
  end if;
  perform public._require_perm(v.company_id, 'journal.post');
  v_result := public._post(p_id, p_series, p_reference);
  perform public._audit(v.company_id, 'journal.post', 'JournalEntry', p_id::text,
    format('Posted %s for %s', v_result->>'reference', to_char((v_result->>'total')::numeric, 'FM999,999,999,990.00')));
  return v_result;
end $$;

create or replace function public.record_from_bank_line(p_line uuid, p_other_account uuid, p_description text default null,
                                             p_party text default null, p_tax_rate numeric default 0,
                                             p_series uuid default null, p_doc_no text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines; v_st record; v_r jsonb;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  if v_l.status <> 'UNMATCHED' then raise exception 'INVALID_STATE: Only unmatched bank lines can be recorded.'; end if;
  select * into v_st from public.bank_statements where id = v_l.statement_id;
  perform set_config('zycount.no_approval', 'on', true);   -- from the bank statement: the money has already moved
  v_r := public.record_transaction(v_l.company_id, case when v_l.amount > 0 then 'IN' else 'OUT' end, v_l.date, abs(v_l.amount),
                                   v_st.account_id, p_other_account, coalesce(nullif(btrim(p_description), ''), v_l.description),
                                   v_l.reference, p_tax_rate, p_party, 'Bank transfer', p_series, p_doc_no);
  perform set_config('zycount.no_approval', '', true);
  update public.bank_lines set status = 'MATCHED', entry_id = (v_r->>'id')::uuid, match_method = 'CREATED', updated_at = now() where id = p_line;
  return v_r;
end $$;

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
        perform set_config('zycount.no_approval', 'on', true);   -- from the bank statement: the money has already moved
        perform public.post_journal(v_id);
        perform set_config('zycount.no_approval', '', true);
      else
        v_kind := case when v_l.amount > 0 then 'IN' else 'OUT' end;
        perform set_config('zycount.no_approval', 'on', true);   -- from the bank statement: the money has already moved
        v_r := public.record_transaction(v_st.company_id, v_kind, v_l.date, abs(v_l.amount), v_st.account_id, v_acc.id,
                                         v_desc, v_l.reference, 0, null, 'Bank transfer');
        perform set_config('zycount.no_approval', '', true);
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

create or replace function public.settle_from_bank_line(p_line uuid, p_contact uuid, p_allocations jsonb default '[]'::jsonb,
                                                        p_bank_charge numeric default 0, p_series uuid default null,
                                                        p_doc_no text default null, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_l public.bank_lines; v_st record; v_c public.contacts; v_in boolean; v_charge numeric := round(coalesce(p_bank_charge, 0), 2);
        v_total numeric; v_r jsonb; v_je uuid; v_applied numeric := 0; v_item jsonb;
begin
  v_l := public._bank_line_for_update(p_line, 'journal.post');
  if v_l.status <> 'UNMATCHED' then raise exception 'INVALID_STATE: This bank line is already %.', lower(v_l.status); end if;
  v_in := v_l.amount > 0;
  select * into v_st from public.bank_statements where id = v_l.statement_id;
  select * into v_c from public.contacts where id = p_contact and company_id = v_l.company_id;
  if not found or v_c.kind <> (case when v_in then 'CUSTOMER' else 'SUPPLIER' end) then
    raise exception 'VALIDATION: %', case when v_in then 'Choose the customer who paid this.' else 'Choose the supplier this was paid to.' end;
  end if;
  if v_charge < 0 then raise exception 'VALIDATION: Bank charges cannot be negative.'; end if;
  -- The bank shows what actually moved: a customer's payment arrives net of charges,
  -- a supplier payment leaves with the charges on top.
  v_total := case when v_in then abs(v_l.amount) + v_charge else abs(v_l.amount) - v_charge end;
  if v_total <= 0 then raise exception 'VALIDATION: Bank charges must be less than the amount.'; end if;

  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' then
    for v_item in select * from jsonb_array_elements(p_allocations) loop
      begin v_applied := v_applied + coalesce(round((v_item->>'amount')::numeric, 2), 0);
      exception when others then raise exception 'VALIDATION: Check the knock-off amounts.'; end;
    end loop;
  end if;
  if v_applied > v_total then
    raise exception 'VALIDATION: You are knocking off % but only % was %.', to_char(v_applied, 'FM999,999,999,990.00'),
      to_char(v_total, 'FM999,999,999,990.00'), case when v_in then 'received' else 'paid' end;
  end if;

  perform set_config('zycount.no_approval', 'on', true);   -- from the bank statement: the money has already moved
  v_r := public.save_trade_doc(v_l.company_id, null,
    jsonb_build_object('doc_type', case when v_in then 'RECEIPT' else 'PAYMENT' end, 'contact_id', p_contact, 'date', v_l.date,
      'amount', v_total, 'bank_charge', v_charge, 'money_account_id', v_st.account_id, 'pay_method', 'Bank transfer',
      'reference', left(v_l.reference, 60),
      'description', left(coalesce(nullif(btrim(p_description), ''), v_l.description), 500)),
    '[]'::jsonb, true, p_series, p_doc_no, coalesce(p_allocations, '[]'::jsonb));
  perform set_config('zycount.no_approval', '', true);
  select journal_entry_id into v_je from public.trade_docs where id = (v_r->>'id')::uuid;
  update public.bank_lines set status = 'MATCHED', entry_id = v_je, match_method = 'CREATED', note = null, updated_at = now()
  where id = p_line;
  return v_r || jsonb_build_object('applied', v_applied, 'advance', v_total - v_applied, 'contact', v_c.name);
end $$;

-- ─── Approve, reject, withdraw ──────────────────────────────────────────────
create or replace function public._approval_target(p_kind text, p_id uuid)
returns table (company_id uuid, status text, approval_status text, submitted_by uuid, label text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_kind = 'DOC' then
    return query select d.company_id, d.status::text, d.approval_status, d.submitted_by,
      lower(replace(d.doc_type, '_', ' ')) || coalesce(' ' || d.draft_doc_no, '') from public.trade_docs d where d.id = p_id;
  elsif p_kind = 'JOURNAL' then
    return query select e.company_id, e.status::text, e.approval_status, e.submitted_by,
      coalesce(e.doc_no, 'journal') from public.journal_entries e where e.id = p_id;
  else
    raise exception 'VALIDATION: Unknown kind.';
  end if;
end $$;

/** Approves and posts. p_series / p_number replace the maker's numbering when given. */
create or replace function public.approve_submission(p_kind text, p_id uuid, p_series uuid default null, p_number text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t record; v_r jsonb; d public.trade_docs; e public.journal_entries;
begin
  select * into t from public._approval_target(p_kind, p_id);
  if t.company_id is null then raise exception 'NOT_FOUND: Not found.'; end if;
  perform public._require_perm(t.company_id, 'journal.post');
  if t.status <> 'DRAFT' or t.approval_status is distinct from 'PENDING' then raise exception 'INVALID_STATE: This isn''t waiting for approval.'; end if;
  if t.submitted_by = auth.uid() then raise exception 'SAME_PERSON: You submitted this — someone else has to approve it.'; end if;
  perform set_config('zycount.approving', p_id::text, true);
  if p_kind = 'DOC' then
    update public.trade_docs set approval_status = 'APPROVED', approved_by = auth.uid(), approved_at = now() where id = p_id returning * into d;
    v_r := public._post_trade_doc(p_id, coalesce(p_series, d.draft_series_id), coalesce(nullif(btrim(p_number), ''), d.draft_doc_no), d.draft_allocations, false);
  else
    update public.journal_entries set approval_status = 'APPROVED', approved_by = auth.uid(), approved_at = now() where id = p_id returning * into e;
    v_r := public.post_journal(p_id, coalesce(p_series, e.draft_series_id), coalesce(nullif(btrim(p_number), ''), e.draft_reference));
  end if;
  perform set_config('zycount.approving', '', true);
  perform public._audit(t.company_id, 'approval.approve', case p_kind when 'DOC' then 'TradeDoc' else 'JournalEntry' end, p_id::text,
    format('Approved and posted %s', coalesce(v_r->>'doc_no', v_r->>'reference', t.label)));
  return v_r;
end $$;

create or replace function public.reject_submission(p_kind text, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from public._approval_target(p_kind, p_id);
  if t.company_id is null then raise exception 'NOT_FOUND: Not found.'; end if;
  perform public._require_perm(t.company_id, 'journal.post');
  if t.status <> 'DRAFT' or t.approval_status is distinct from 'PENDING' then raise exception 'INVALID_STATE: This isn''t waiting for approval.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'VALIDATION: Say why, so the maker can fix it.'; end if;
  if p_kind = 'DOC' then
    update public.trade_docs set approval_status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_note = left(btrim(p_reason), 500) where id = p_id;
  else
    update public.journal_entries set approval_status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_note = left(btrim(p_reason), 500) where id = p_id;
  end if;
  perform public._audit(t.company_id, 'approval.reject', case p_kind when 'DOC' then 'TradeDoc' else 'JournalEntry' end, p_id::text,
    format('Rejected %s — %s', t.label, btrim(p_reason)));
  return jsonb_build_object('id', p_id, 'approval_status', 'REJECTED');
end $$;

/** The maker (or anyone who can create) takes it back to edit. */
create or replace function public.withdraw_submission(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from public._approval_target(p_kind, p_id);
  if t.company_id is null then raise exception 'NOT_FOUND: Not found.'; end if;
  perform public._require_perm(t.company_id, 'journal.create');
  if t.status <> 'DRAFT' or t.approval_status is distinct from 'PENDING' then raise exception 'INVALID_STATE: This isn''t waiting for approval.'; end if;
  if p_kind = 'DOC' then
    update public.trade_docs set approval_status = null where id = p_id;
  else
    update public.journal_entries set approval_status = null where id = p_id;
  end if;
  perform public._audit(t.company_id, 'approval.withdraw', case p_kind when 'DOC' then 'TradeDoc' else 'JournalEntry' end, p_id::text,
    format('Withdrew %s from approval', t.label));
  return jsonb_build_object('id', p_id, 'approval_status', null);
end $$;

-- ─── Settings and the queue ─────────────────────────────────────────────────
create or replace function public.set_approval_settings(p_company uuid, p_enabled boolean, p_threshold numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t numeric := coalesce(p_threshold, 5000); v_posters int;
begin
  perform public._require_perm(p_company, 'company.edit');
  if v_t < 0 or v_t <> round(v_t, 2) then raise exception 'VALIDATION: The threshold is an amount like 5,000.00.'; end if;
  if (select kind from public.companies where id = p_company) <> 'BUSINESS' then
    raise exception 'VALIDATION: Approvals are for business books.';
  end if;
  if coalesce(p_enabled, false) then
    select count(*) into v_posters from public.company_members m join public.roles r on r.name = m.role
     where m.company_id = p_company and 'journal.post' = any(r.permissions);
    if v_posters < 2 then
      raise exception 'VALIDATION: Approvals need at least two people who can post — nobody may approve their own work. Invite someone under Users & roles first.';
    end if;
  end if;
  update public.companies set approval_enabled = coalesce(p_enabled, false), approval_threshold = v_t where id = p_company;
  perform public._audit(p_company, 'approval.settings', 'Company', p_company::text,
    format('Approvals %s, above %s', case when p_enabled then 'on' else 'off' end, to_char(v_t, 'FM999,999,999,990.00')));
  return jsonb_build_object('enabled', coalesce(p_enabled, false), 'threshold', v_t);
end $$;

/** Everything waiting for approval, and what was rejected (so the maker sees why). */
create or replace function public.approval_queue(p_company uuid)
returns table (kind text, id uuid, doc_type text, number text, party text, date date, amount numeric, approval_status text,
               submitted_by uuid, submitted_name text, submitted_at timestamptz, note text, mine boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'journal.view');
  return query
  select 'DOC'::text, d.id, d.doc_type, d.draft_doc_no, coalesce(d.bill_name, c.name), d.date, d.total, d.approval_status,
         d.submitted_by, coalesce(nullif(p.full_name, ''), p.email), d.submitted_at, d.approval_note, d.submitted_by = auth.uid()
    from public.trade_docs d left join public.contacts c on c.id = d.contact_id left join public.profiles p on p.id = d.submitted_by
   where d.company_id = p_company and d.status = 'DRAFT' and d.approval_status in ('PENDING', 'REJECTED')
  union all
  select 'JOURNAL', e.id, coalesce(e.doc_type, 'JV'), coalesce(e.doc_no, e.draft_reference), coalesce(e.party, e.description), e.date, e.total_debit,
         e.approval_status, e.submitted_by, coalesce(nullif(p.full_name, ''), p.email), e.submitted_at, e.approval_note, e.submitted_by = auth.uid()
    from public.journal_entries e left join public.profiles p on p.id = e.submitted_by
   where e.company_id = p_company and e.status = 'DRAFT' and e.approval_status in ('PENDING', 'REJECTED')
   order by 11;
end $$;

revoke execute on function public._needs_approval(uuid, numeric), public._approval_target(text, uuid) from public, anon, authenticated;
revoke execute on function public.approve_submission(text, uuid, uuid, text), public.reject_submission(text, uuid, text),
  public.withdraw_submission(text, uuid), public.set_approval_settings(uuid, boolean, numeric), public.approval_queue(uuid) from public, anon;
grant execute on function public.approve_submission(text, uuid, uuid, text), public.reject_submission(text, uuid, text),
  public.withdraw_submission(text, uuid), public.set_approval_settings(uuid, boolean, numeric), public.approval_queue(uuid) to authenticated;
