-- After the load run: psql -v ok=<transactions pgbench reported as processed>
-- Raises 'LOAD FAIL: …' or ends with notice 'LOAD CHECK PASSED'.
select set_config('zl.ok', :'ok', false);
do $$
declare x zl_load.ctx; ok bigint := current_setting('zl.ok')::bigint; inv bigint; txn bigint; bad bigint; r record;
begin
  select * into x from zl_load.ctx;
  select count(*) into inv from public.trade_docs where company_id = x.cid and doc_type = 'INVOICE' and status = 'POSTED';
  select count(*) into txn from public.journal_entries where company_id = x.cid and description = 'load cash sale' and status = 'POSTED';
  if inv <> ok then raise exception 'LOAD FAIL: % calls succeeded but % invoices posted (a retry posted twice, or a post was lost)', ok, inv; end if;
  if txn <> ok then raise exception 'LOAD FAIL: % calls succeeded but % cash sales posted', ok, txn; end if;

  -- Gap-free, duplicate-free numbering per series (prefix before the running number).
  for r in
    select 'invoice' kind, regexp_replace(doc_no, '\d+$', '') prefix, count(*) n, count(distinct doc_no) d,
           min((regexp_match(doc_no, '(\d+)$'))[1]::bigint) lo, max((regexp_match(doc_no, '(\d+)$'))[1]::bigint) hi
      from public.trade_docs where company_id = x.cid and status = 'POSTED' group by 2
    union all
    select 'journal', regexp_replace(reference, '\d+$', ''), count(*), count(distinct reference),
           min((regexp_match(reference, '(\d+)$'))[1]::bigint), max((regexp_match(reference, '(\d+)$'))[1]::bigint)
      from public.journal_entries where company_id = x.cid and status = 'POSTED' group by 2
  loop
    if r.n <> r.d then raise exception 'LOAD FAIL: duplicate % numbers in series %', r.kind, r.prefix; end if;
    if r.hi - r.lo + 1 <> r.n then
      raise exception 'LOAD FAIL: % series % has gaps (% numbers between % and %)', r.kind, r.prefix, r.n, r.lo, r.hi;
    end if;
    raise notice 'series % %: % numbers, % to %, no gaps', r.kind, r.prefix, r.n, r.lo, r.hi;
  end loop;

  select count(*) into bad from public.journal_entries e where e.company_id = x.cid and e.status = 'POSTED'
     and (e.total_debit <> e.total_credit
          or e.total_debit <> (select coalesce(sum(debit), 0) from public.journal_lines where journal_entry_id = e.id));
  if bad > 0 then raise exception 'LOAD FAIL: % unbalanced entries', bad; end if;
  raise notice 'LOAD CHECK PASSED: % invoices, % cash sales, 0 gaps, 0 duplicates, 0 unbalanced', inv, txn;
end $$;
