-- Load test fixture (audit R8). Run as a superuser on a scratch database:
-- one company, one customer, and zl_load.post_one(), which pgbench calls from
-- many connections at once. Every call does what a busy office does:
--   1. posts a sales invoice through idem_call, then sends the SAME request
--      again (a double-click / network retry) — it must not post twice;
--   2. records a cash sale (record_transaction), which takes the next voucher number.
-- All of it in one company, so every call fights for the same number series.
create schema if not exists zl_load;
drop table if exists zl_load.ctx;
create table zl_load.ctx (uid uuid, cid uuid, cash uuid, rev uuid, cu uuid);

do $$
declare u uuid := gen_random_uuid(); c uuid; cash uuid; rev uuid; cu uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'load-' || u || '@test.local', '{"full_name":"Load Test"}', now(), now());
  c := public.create_company_for_user(u, 'Load Test Sdn Bhd', 'BUSINESS');
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  select id into cash from public.accounts where company_id = c and is_cash and is_postable and type = 'ASSET' order by code limit 1;
  select id into rev from public.accounts where company_id = c and type = 'REVENUE' and is_postable order by code limit 1;
  perform public.save_contact(c, null, '{"kind":"CUSTOMER","name":"Busy Customer Sdn Bhd"}'::jsonb);
  select id into cu from public.contacts where company_id = c and kind = 'CUSTOMER';
  insert into zl_load.ctx values (u, c, cash, rev, cu);
end $$;

create or replace function zl_load.post_one() returns void language plpgsql as $$
declare x zl_load.ctx; rid uuid := gen_random_uuid(); a jsonb; r1 jsonb; r2 jsonb;
begin
  select * into x from zl_load.ctx;
  perform set_config('request.jwt.claims', json_build_object('sub', x.uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  -- Same arguments the browser sends (p_id null = a new document).
  a := jsonb_build_object('p_company', x.cid, 'p_id', null, 'p_post', true,
         'p_doc', jsonb_build_object('doc_type', 'INVOICE', 'contact_id', x.cu, 'date', current_date),
         'p_lines', jsonb_build_array(jsonb_build_object('description', 'Load', 'qty', 1, 'unit_price', 10.10, 'account_id', x.rev)));
  r1 := public.idem_call(rid, 'save_trade_doc', a);
  r2 := public.idem_call(rid, 'save_trade_doc', a);
  if (r1->>'id') is distinct from (r2->>'id') then raise exception 'LOAD FAIL: a retried request posted a second invoice'; end if;
  perform public.record_transaction(x.cid, 'IN', current_date, 25.50, x.cash, x.rev, 'load cash sale');
end $$;
grant usage on schema zl_load to authenticated;
grant select on zl_load.ctx to authenticated;
