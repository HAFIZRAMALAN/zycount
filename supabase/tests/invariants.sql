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
  it uuid; wh2 uuid; ia uuid; ca2 uuid; q numeric; v numeric;
  it2 uuid; po jsonb; grn jsonb; grn2 jsonb; pl uuid; g1 uuid; g2 uuid; bx jsonb;
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

  -- L1: an amount with a fraction of a sen is refused, not rounded.
  begin
    perform public.save_journal(ca, null, current_date, 'sub-cent', null, jsonb_build_array(
      jsonb_build_object('account_id', cash, 'debit', 0.005, 'credit', 0), jsonb_build_object('account_id', rev, 'debit', 0, 'credit', 0.005)), null);
    raise exception 'FAIL: a journal with 0.005 was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%2 decimal places%' then raise exception 'FAIL: sub-cent refused for the wrong reason: %', sqlerrm; end if;
  end;
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
    format('select public.void_trade_doc(%L, current_date, %L)::text', iv->>'id', 'x'),
    format('select public.sst_summary(%L, current_date, current_date)::text', ca),
    format('select public.bank_accept_suggestions(%L)::text', st->>'id'),
    format('select public.attention_summary(%L)::text', ca)] loop
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

  -- ── F. Keys, plans and idempotent money calls ─────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  foreach probe in array array['platform_secrets', 'platform_settings', 'platform_audit', 'idempotency_keys'] loop
    if has_table_privilege('authenticated', 'public.' || probe, 'SELECT') or has_table_privilege('anon', 'public.' || probe, 'SELECT') then
      raise exception 'FAIL: API roles can read %', probe;
    end if;
    checks := checks + 1;
  end loop;
  foreach probe in array array['public._platform_secret(text)', 'public._billing_mark_paid(uuid,numeric,jsonb)', 'public._billing_attach(uuid,text,text)'] loop
    if has_function_privilege('authenticated', probe, 'EXECUTE') or has_function_privilege('anon', probe, 'EXECUTE') then
      raise exception 'FAIL: API roles can call %', probe;
    end if;
    checks := checks + 1;
  end loop;
  begin
    perform public.platform_secret_set('INVARIANT_KEY', 'not-an-admin');
    raise exception 'FAIL: a non-admin stored a platform key';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  select count(*) into k from public.subscriptions where company_id in (ca, cb) and status = 'TRIAL';
  if k <> 1 then raise exception 'FAIL: new business books did not start on a trial, or row-level security showed another company''s plan'; end if;
  checks := checks + 1;

  -- The same request id posts once; a new id posts again.
  select id into ex from public.accounts where company_id = ca and type = 'EXPENSE' and is_postable and not is_control order by code limit 1;
  r := jsonb_build_object('p_company', ca, 'p_kind', 'OUT', 'p_date', current_date, 'p_amount', 7.25, 'p_money_account', cash,
         'p_other_account', ex, 'p_description', 'idempotency probe', 'p_tax_rate', 0);
  sv := gen_random_uuid();
  perform public.idem_call(sv, 'record_transaction', r);
  perform public.idem_call(sv, 'record_transaction', r);
  select count(*) into k from public.journal_entries where company_id = ca and description = 'idempotency probe';
  if k <> 1 then raise exception 'FAIL: a repeated request id posted % times', k; end if;
  perform public.idem_call(gen_random_uuid(), 'record_transaction', r);
  select count(*) into k from public.journal_entries where company_id = ca and description = 'idempotency probe';
  if k <> 2 then raise exception 'FAIL: a new request id did not post'; end if;
  begin
    perform public.idem_call(gen_random_uuid(), 'delete_journal', '{}'::jsonb);
    raise exception 'FAIL: idem_call ran a function outside its list';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 3;

  -- SST from documents equals the output-tax account in the ledger.
  r := public.sst_summary(ca, current_date - 1, current_date + 1);
  if (select coalesce(sum((x->>'tax')::numeric), 0) from jsonb_array_elements(r->'by_code') x where x->>'side' = 'AR')
     <> (select coalesce(sum((x->>'movement')::numeric), 0) from jsonb_array_elements(r->'accounts') x where x->>'role' = 'OUTPUT') then
    raise exception 'FAIL: SST from documents differs from the output-tax account: %', r;
  end if;
  checks := checks + 1;

  -- The worklist sees its own books' drafts and open periods.
  r := public.attention_summary(ca);
  if not (r->>'can_view')::boolean or (r->>'open_past_periods') is null then raise exception 'FAIL: attention_summary incomplete: %', r; end if;
  checks := checks + 1;

  -- ── H. Inventory (Phase 3.2): weighted-average cost, COGS, warehouses ────
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  it := public.save_item(ca, null, '{"code":"STK-1","description":"Stock widget","track_stock":true,"buy_price":5}'::jsonb);
  select inventory_account_id, cogs_account_id into ia, ca2 from public.items where id = it;
  if ia is null or ca2 is null then raise exception 'FAIL: a stock item did not get default inventory and COGS accounts'; end if;
  checks := checks + 1;

  perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'STK-B1'),
    jsonb_build_array(jsonb_build_object('item_id', it, 'qty', 10, 'unit_price', 5)), true);
  perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'STK-B2'),
    jsonb_build_array(jsonb_build_object('item_id', it, 'qty', 10, 'unit_price', 7)), true);
  select qty, value into q, v from public.item_costs where item_id = it;
  if q <> 20 or v <> 120 then raise exception 'FAIL: two purchases gave % units worth %, expected 20 worth 120', q, v; end if;
  checks := checks + 1;

  iv := public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'INVOICE', 'contact_id', cu, 'date', current_date),
    jsonb_build_array(jsonb_build_object('item_id', it, 'qty', 5, 'unit_price', 20, 'account_id', rev)), true);
  select coalesce(sum(debit - credit), 0) into n from public.journal_lines where journal_entry_id = (iv->>'journal_id')::uuid and account_id = ca2;
  select qty, value into q, v from public.item_costs where item_id = it;
  if n <> 30 or q <> 15 or v <> 90 then
    raise exception 'FAIL: selling 5 at average 6.00 posted COGS % and left % units worth %', n, q, v;
  end if;
  checks := checks + 1;

  begin
    perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'INVOICE', 'contact_id', cu, 'date', current_date),
      jsonb_build_array(jsonb_build_object('item_id', it, 'qty', 100, 'unit_price', 20, 'account_id', rev)), true);
    raise exception 'FAIL: sold more stock than was on hand';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'STOCK_SHORT:%' then raise exception 'FAIL: overselling refused for the wrong reason: %', sqlerrm; end if;
  end;
  checks := checks + 1;

  wh2 := public.save_warehouse(ca, null, '{"code":"WH2","name":"Second store"}'::jsonb);
  perform public.post_stock_transfer(ca, jsonb_build_object('date', current_date, 'to_warehouse_id', wh2,
    'lines', jsonb_build_array(jsonb_build_object('item_id', it, 'qty', 4))));
  select qty into q from public.stock_balances where item_id = it and warehouse_id = wh2;
  select value into v from public.item_costs where item_id = it;
  if q <> 4 or v <> 90 then raise exception 'FAIL: a transfer moved % units and changed the value to %', q, v; end if;
  checks := checks + 1;

  perform public.post_stock_adjustment(ca, jsonb_build_object('kind', 'COUNT', 'date', current_date, 'warehouse_id', wh2,
    'lines', jsonb_build_array(jsonb_build_object('item_id', it, 'counted', 3))));
  select qty, value into q, v from public.item_costs where item_id = it;
  if q <> 14 or v <> 84 then raise exception 'FAIL: counting 3 of 4 left % units worth %, expected 14 worth 84', q, v; end if;
  checks := checks + 1;

  perform public.void_trade_doc((iv->>'id')::uuid, current_date, 'inventory test');
  select qty, value into q, v from public.item_costs where item_id = it;
  if q <> 19 or v <> 114 then raise exception 'FAIL: voiding the sale left % units worth %, expected 19 worth 114', q, v; end if;
  checks := checks + 1;

  r := public.stock_gl_check(ca);
  if not (r->>'in_balance')::boolean then raise exception 'FAIL: stock value and the inventory account disagree: %', r; end if;
  select count(*) into k from public.items i join public.item_costs c on c.item_id = i.id
   where i.company_id = ca and (c.qty <> (select coalesce(sum(qty), 0) from public.stock_moves where item_id = i.id)
                             or c.value <> (select coalesce(sum(value), 0) from public.stock_moves where item_id = i.id)
                             or c.qty <> (select coalesce(sum(qty), 0) from public.stock_balances where item_id = i.id));
  if k <> 0 then raise exception 'FAIL: running stock balances drifted from the stock ledger'; end if;
  checks := checks + 2;

  perform set_config('role', 'postgres', true);
  begin
    update public.stock_moves set qty = qty + 1 where item_id = it;
    raise exception 'FAIL: a stock movement was edited';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  -- ── I. Purchasing (3.3): order → goods received → invoice, three-way match ─
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  it2 := public.save_item(ca, null, '{"code":"STK-2","description":"Matched widget","track_stock":true}'::jsonb);
  po := public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'PURCHASE_ORDER', 'contact_id', su, 'date', current_date),
    jsonb_build_array(jsonb_build_object('item_id', it2, 'qty', 10, 'unit_price', 5)), true);
  select id into pl from public.trade_doc_lines where doc_id = (po->>'id')::uuid;
  grn := public.post_goods_receipt(ca, jsonb_build_object('po_id', po->>'id', 'date', current_date, 'reference', 'DO-1',
    'lines', jsonb_build_array(jsonb_build_object('po_line_id', pl, 'qty', 6))));
  select qty, value into q, v from public.item_costs where item_id = it2;
  r := public.grni_check(ca);
  if q <> 6 or v <> 30 or (r->>'gl_balance')::numeric <> 30 or not (r->>'in_balance')::boolean then
    raise exception 'FAIL: receiving 6 of 10 at 5.00 gave % units worth %, GRNI %', q, v, r;
  end if;
  checks := checks + 1;

  begin
    perform public.post_goods_receipt(ca, jsonb_build_object('po_id', po->>'id', 'date', current_date,
      'lines', jsonb_build_array(jsonb_build_object('po_line_id', pl, 'qty', 5))));
    raise exception 'FAIL: received more than was ordered';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'MATCH:%' then raise exception 'FAIL: over-receipt refused for the wrong reason: %', sqlerrm; end if;
  end;
  checks := checks + 1;

  grn2 := public.post_goods_receipt(ca, jsonb_build_object('po_id', po->>'id', 'date', current_date,
    'lines', jsonb_build_array(jsonb_build_object('po_line_id', pl, 'qty', 4))));
  select id into g1 from public.goods_receipt_lines where stock_doc_id = (grn->>'id')::uuid;
  select id into g2 from public.goods_receipt_lines where stock_doc_id = (grn2->>'id')::uuid;

  begin
    perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'M-0'),
      jsonb_build_array(jsonb_build_object('item_id', it2, 'qty', 12, 'unit_price', 5, 'grn_line_id', g1)), true);
    raise exception 'FAIL: invoiced more than was received';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'MATCH:%' then raise exception 'FAIL: over-invoicing refused for the wrong reason: %', sqlerrm; end if;
  end;
  begin
    perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'M-1'),
      jsonb_build_array(jsonb_build_object('item_id', it2, 'qty', 6, 'unit_price', 5.5, 'grn_line_id', g1)), true);
    raise exception 'FAIL: a price 10%% above the order posted without confirmation';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'PRICE_VARIANCE:%' then raise exception 'FAIL: price difference refused for the wrong reason: %', sqlerrm; end if;
  end;
  checks := checks + 2;

  bx := public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'M-1',
      'allow_price_variance', true),
    jsonb_build_array(jsonb_build_object('item_id', it2, 'qty', 6, 'unit_price', 5.5, 'grn_line_id', g1)), true);
  select value into v from public.item_costs where item_id = it2;
  r := public.grni_check(ca);
  if v <> 53 or (r->>'open_value')::numeric <> 20 or not (r->>'in_balance')::boolean then
    raise exception 'FAIL: a confirmed +0.50 difference on 6 units left stock worth % and GRNI %', v, r;
  end if;
  r := public.stock_gl_check(ca);
  if not (r->>'in_balance')::boolean then raise exception 'FAIL: stock and ledger disagree after a price difference: %', r; end if;
  checks := checks + 2;

  begin
    perform public.void_stock_doc((grn->>'id')::uuid, current_date, 'test');
    raise exception 'FAIL: voided goods received that were already invoiced';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  checks := checks + 1;

  perform public.void_trade_doc((bx->>'id')::uuid, current_date, 'test');
  perform public.save_trade_doc(ca, null, jsonb_build_object('doc_type', 'BILL', 'contact_id', su, 'date', current_date, 'reference', 'M-2'),
    jsonb_build_array(jsonb_build_object('item_id', it2, 'qty', 6, 'unit_price', 5, 'grn_line_id', g1),
                      jsonb_build_object('item_id', it2, 'qty', 4, 'unit_price', 5, 'grn_line_id', g2)), true);
  select value into v from public.item_costs where item_id = it2;
  r := public.grni_check(ca);
  if v <> 50 or (r->>'open_value')::numeric <> 0 or (r->>'gl_balance')::numeric <> 0 then
    raise exception 'FAIL: after voiding and invoicing in full, stock is worth % and GRNI %', v, r;
  end if;
  select count(*) into k from public.grn_open_lines(ca);
  if k <> 0 then raise exception 'FAIL: % goods-received lines still show as not invoiced', k; end if;
  checks := checks + 2;

  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.post_stock_adjustment(ca, jsonb_build_object('date', current_date,
      'lines', jsonb_build_array(jsonb_build_object('item_id', it, 'qty', 1000, 'unit_cost', 1))));
    raise exception 'FAIL: another company adjusted these books'' stock';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into k from public.stock_moves where company_id = ca;
  if k <> 0 then raise exception 'FAIL: another company can see % stock movements', k; end if;
  checks := checks + 2;

  -- A payment marked paid twice extends the plan once.
  perform set_config('role', 'postgres', true);
  insert into public.payments (company_id, plan_code, billing_cycle, amount, gateway, mode, created_by)
  values (ca, 'STARTER', 'MONTH', 49, 'BILLPLZ', 'SANDBOX', ua) returning id into sv;
  perform public._billing_mark_paid(sv, 49, '{}'::jsonb);
  perform public._billing_mark_paid(sv, 49, '{}'::jsonb);
  select count(*) into k from public.subscriptions
   where company_id = ca and status = 'ACTIVE' and plan_code = 'STARTER'
     and current_period_end between now() + interval '27 days' and now() + interval '32 days';
  if k <> 1 then raise exception 'FAIL: a payment paid twice did not extend the plan exactly one month'; end if;
  checks := checks + 1;

  perform set_config('role', 'postgres', true);
  raise notice 'INVARIANTS PASSED (% checks)', checks;
end $$;
