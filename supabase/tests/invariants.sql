-- Zycount live backend: accounting invariants, tenant isolation and API-role
-- privileges, asserted against the real schema and functions.
--
-- One DO block, so it runs the same way everywhere:
--   CI    psql … -v ON_ERROR_STOP=1 -c 'begin' -f supabase/tests/invariants.sql -c 'rollback'
--   live  paste into a rolled-back session — it creates two throwaway users and
--         their books, and nothing survives the rollback.
-- A failed check raises 'FAIL: …'; success ends with notice 'INVARIANTS PASSED'.
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  ca uuid; cb uuid; cash uuid; rev uuid; ex uuid; sv uuid;
  j jsonb; jid uuid; r jsonb; t text; n numeric; k int; p record;
  cu uuid; su uuid; iv jsonb; bill jsonb; st jsonb; line uuid;
  checks int := 0;
  probe text;
begin
  -- ── Two people, each with their own business books ───────────────────────
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (ua, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inv-a-' || ua || '@test.local', '{"full_name":"Tester A"}', now(), now()),
         (ub, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inv-b-' || ub || '@test.local', '{"full_name":"Tester B"}', now(), now());
  ca := public.create_company_for_user(ua, 'Invariant Co A', 'BUSINESS');
  cb := public.create_company_for_user(ub, 'Invariant Co B', 'BUSINESS');

  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select id into cash from public.accounts where company_id = ca and is_cash and is_postable and type = 'ASSET' order by code limit 1;
  select id into rev from public.accounts where company_id = ca and type = 'REVENUE' and is_postable order by code limit 1;
  select id into ex from public.accounts where company_id = ca and type = 'EXPENSE' and is_postable and not is_control order by code limit 1;
  if cash is null or rev is null or ex is null then raise exception 'FAIL: new books are missing a cash, revenue or expense account'; end if;

  -- ── A. Journals ───────────────────────────────────────────────────────────
  begin
    j := public.save_journal(ca, null, current_date, 'unbalanced', null, jsonb_build_array(
      jsonb_build_object('account_id', cash, 'debit', 100, 'credit', 0), jsonb_build_object('account_id', rev, 'debit', 0, 'credit', 99.99)), null);
    perform public.post_journal((j->>'id')::uuid);
    raise exception 'FAIL: an unbalanced journal was posted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  j := public.save_journal(ca, null, current_date, 'cents', null, jsonb_build_array(
    jsonb_build_object('account_id', cash, 'debit', 0.1, 'credit', 0), jsonb_build_object('account_id', cash, 'debit', 0.2, 'credit', 0),
    jsonb_build_object('account_id', rev, 'debit', 0, 'credit', 0.3)), null);
  jid := (j->>'id')::uuid;
  perform public.post_journal(jid);
  select sum(debit) - sum(credit) into n from public.journal_lines where journal_entry_id = jid;
  if n <> 0 then raise exception 'FAIL: 0.1 + 0.2 did not balance 0.3 exactly'; end if;
  checks := checks + 1;

  begin
    perform public.save_journal(ca, jid, current_date, 'edit', null, jsonb_build_array(
      jsonb_build_object('account_id', cash, 'debit', 5, 'credit', 0), jsonb_build_object('account_id', rev, 'debit', 0, 'credit', 5)), null);
    raise exception 'FAIL: a posted journal was edited';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.delete_journal(jid);
    raise exception 'FAIL: a posted journal was deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 2;

  r := public.reverse_journal(jid, current_date, 'test');
  begin
    perform public.reverse_journal(jid, current_date, 'again');
    raise exception 'FAIL: a journal was reversed twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  begin
    j := public.save_journal(ca, null, '2099-06-15', 'no period', null, jsonb_build_array(
      jsonb_build_object('account_id', cash, 'debit', 1, 'credit', 0), jsonb_build_object('account_id', rev, 'debit', 0, 'credit', 1)), null);
    perform public.post_journal((j->>'id')::uuid);
    raise exception 'FAIL: posted into a date with no fiscal period';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  select * into p from public.fiscal_periods where company_id = ca order by start_date limit 1;
  perform public.close_period(p.id);
  begin
    j := public.save_journal(ca, null, p.start_date, 'closed', null, jsonb_build_array(
      jsonb_build_object('account_id', cash, 'debit', 1, 'credit', 0), jsonb_build_object('account_id', rev, 'debit', 0, 'credit', 1)), null);
    perform public.post_journal((j->>'id')::uuid);
    raise exception 'FAIL: posted into a closed period';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  -- ── B. Documents, knock-off, contra, bank settle ─────────────────────────
  perform public.save_contact(ca, null, '{"kind":"CUSTOMER","name":"Both Sdn Bhd"}'::jsonb);
  perform public.save_contact(ca, null, '{"kind":"SUPPLIER","name":"Both Sdn Bhd"}'::jsonb);
  select id into cu from public.contacts where company_id = ca and kind = 'CUSTOMER';
  select id into su from public.contacts where company_id = ca and kind = 'SUPPLIER';
  select id into sv from public.tax_codes where company_id = ca and code = 'SV8';
  iv := public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'INVOICE', 'contact_id', cu, 'date', current_date),
    jsonb_build_array(jsonb_build_object('description', 'Work', 'qty', 3, 'unit_price', 33.33, 'account_id', rev, 'tax_code_id', sv)), true);
  bill := public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'B-1'),
    jsonb_build_array(jsonb_build_object('description', 'Rent', 'qty', 1, 'unit_price', 50, 'account_id', ex)), true);
  begin
    perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'b-1'),
      jsonb_build_array(jsonb_build_object('description', 'Rent again', 'qty', 1, 'unit_price', 50, 'account_id', ex)), true);
    raise exception 'FAIL: the same supplier invoice was recorded twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  r := public.post_contra(ca, cu, su, current_date, 50);
  st := public.import_bank_statement(ca, cash, 'T', jsonb_build_array(
    jsonb_build_object('date', current_date, 'amount', (iv->>'total')::numeric - 50, 'description', 'IBG ' || (iv->>'doc_no'))));
  select id into line from public.bank_lines where statement_id = (st->>'id')::uuid;
  perform public.settle_from_bank_line(line, cu, jsonb_build_array(jsonb_build_object('doc_id', iv->>'id', 'amount', (iv->>'total')::numeric - 50)));
  select total - allocated into n from public.trade_docs where id = (iv->>'id')::uuid;
  if n <> 0 then raise exception 'FAIL: invoice still open after contra and bank receipt (%)', n; end if;
  checks := checks + 1;

  -- ── C. The books prove themselves ─────────────────────────────────────────
  r := public.books_proof(ca);
  if (r->>'unbalanced')::int <> 0 then raise exception 'FAIL: unbalanced posted entries: %', r->>'unbalanced'; end if;
  if (r->>'total_debit')::numeric <> (r->>'total_credit')::numeric then raise exception 'FAIL: trial balance does not balance'; end if;
  if (r->>'assets')::numeric <> (r->>'liabilities')::numeric + (r->>'equity')::numeric + (r->>'result')::numeric then
    raise exception 'FAIL: assets <> liabilities + equity + result';
  end if;
  if (r->>'numbering_gaps')::int <> 0 then raise exception 'FAIL: numbering gaps: %', r->>'numbering_gaps'; end if;
  if (r->>'subledger_difference')::numeric <> 0 then raise exception 'FAIL: subledger differs from control accounts by %', r->>'subledger_difference'; end if;
  if (r->>'allocation_errors')::int <> 0 then raise exception 'FAIL: allocation errors: %', r->>'allocation_errors'; end if;
  checks := checks + 6;

  -- ── D. Tenant isolation: B cannot read or touch A's books ────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  foreach probe in array array[
    format('select count(*) from public.account_balances(%L, null, null)', ca),
    format('select count(*) from public.general_ledger(%L, null, null, null)', ca),
    format('select public.books_proof(%L)::text', ca),
    format('select public.save_journal(%L, null, current_date, %L, null, %L::jsonb, null)::text', ca, 'x', '[]'),
    format('select public.record_transaction(%L, %L, current_date, 1, %L, %L)::text', ca, 'IN', cash, rev),
    format('select public.create_invite(%L, %L, null)::text', ca, 'Viewer'),
    format('select public.einvoice_settings_get(%L)::text', ca),
    format('select count(*) from public.trade_open_docs(%L)', cu),
    format('select public.void_trade_doc(%L, current_date, %L)::text', iv->>'id', 'x')] loop
    begin
      execute probe into t;
      raise exception 'FAIL: another company''s user ran: %', probe;
    exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
    checks := checks + 1;
  end loop;
  select count(*) into k from public.journal_entries where company_id = ca;
  if k <> 0 then raise exception 'FAIL: row-level security showed % of another company''s journals', k; end if;
  select count(*) into k from public.contacts where company_id = ca;
  if k <> 0 then raise exception 'FAIL: row-level security showed another company''s contacts'; end if;
  checks := checks + 2;

  -- ── E. API roles cannot write to tables directly ─────────────────────────
  foreach probe in array array['journal_entries', 'journal_lines', 'trade_docs', 'accounts', 'company_members', 'audit_log', 'platform_admins'] loop
    if has_table_privilege('authenticated', 'public.' || probe, 'INSERT') or has_table_privilege('authenticated', 'public.' || probe, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || probe, 'DELETE') or has_table_privilege('authenticated', 'public.' || probe, 'TRUNCATE')
       or has_table_privilege('anon', 'public.' || probe, 'TRUNCATE') then
      raise exception 'FAIL: API roles can write to % directly', probe;
    end if;
    checks := checks + 1;
  end loop;
  if has_table_privilege('authenticated', 'public.einvoice_settings', 'SELECT') then raise exception 'FAIL: einvoice_settings is readable'; end if;
  if has_function_privilege('authenticated', 'public._einvoice_credentials(uuid)', 'EXECUTE') then raise exception 'FAIL: credentials function is callable'; end if;
  if has_function_privilege('anon', 'public.my_companies()', 'EXECUTE') then raise exception 'FAIL: anon can call my_companies'; end if;
  checks := checks + 3;

  perform set_config('role', 'postgres', true);
  raise notice 'INVARIANTS PASSED (% checks)', checks;
end $$;
