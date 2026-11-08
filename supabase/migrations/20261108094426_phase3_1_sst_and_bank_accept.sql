-- Phase 3.1: SST summary report and one-click settlement of exact bank suggestions.

/** SST for a period: per tax code from posted documents, proved against the tax accounts in the ledger. */
create or replace function public.sst_summary(p_company uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_docs jsonb; v_gl jsonb;
begin
  perform public._require_perm(p_company, 'report.view');
  if p_from is null or p_to is null or p_from > p_to then raise exception 'VALIDATION: Choose a valid period.'; end if;

  select coalesce(jsonb_agg(x order by x->>'side' desc, x->>'code'), '[]'::jsonb) into v_docs from (
    select jsonb_build_object('side', d.side, 'tax_code_id', t.id, 'code', t.code, 'name', t.name, 'rate', t.rate,
      'documents', count(distinct d.id),
      'taxable', sum(case when m.effect = -1 then -l.amount else l.amount end),
      'tax', sum(case when m.effect = -1 then -l.tax_amount else l.tax_amount end)) x
    from public.trade_doc_lines l
    join public.trade_docs d on d.id = l.doc_id
    join public.tax_codes t on t.id = l.tax_code_id
    cross join lateral public._trade_meta(d.doc_type) m
    where d.company_id = p_company and d.status = 'POSTED' and m.posts and m.has_lines
      and d.date between p_from and p_to
    group by d.side, t.id, t.code, t.name, t.rate) s;

  select coalesce(jsonb_agg(x order by x->>'role', x->>'code'), '[]'::jsonb) into v_gl from (
    select jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name, 'role', r.role,
      'movement', coalesce((select case when r.role = 'OUTPUT' then sum(jl.credit - jl.debit) else sum(jl.debit - jl.credit) end
        from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
        where jl.account_id = a.id and je.status = 'POSTED' and je.date between p_from and p_to), 0)) x
    from (select distinct sales_account_id as account_id, 'OUTPUT' as role from public.tax_codes where company_id = p_company and sales_account_id is not null
          union select distinct purchase_account_id, 'INPUT' from public.tax_codes where company_id = p_company and purchase_account_id is not null) r
    join public.accounts a on a.id = r.account_id) g;

  return jsonb_build_object('from', p_from, 'to', p_to, 'by_code', v_docs, 'accounts', v_gl);
end $$;

/** Settles every unmatched line whose best suggestion is one document for exactly the line's amount. */
create or replace function public.bank_accept_suggestions(p_statement uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_s record; r record; v_used uuid[] := '{}'; v_ok int := 0; v_skip int := 0; v_line public.bank_lines;
begin
  select * into v_s from public.bank_statements where id = p_statement;
  if not found then raise exception 'NOT_FOUND: Statement not found.'; end if;
  perform public._require_perm(v_s.company_id, 'journal.post');
  for r in select * from public.bank_statement_suggestions(p_statement) order by score desc loop
    select * into v_line from public.bank_lines where id = r.line_id;
    if r.doc_id is null or r.doc_id = any(v_used) or v_line.status <> 'UNMATCHED' or abs(v_line.amount) <> r.outstanding then
      v_skip := v_skip + 1; continue;
    end if;
    begin
      perform public.settle_from_bank_line(r.line_id, r.contact_id, jsonb_build_array(jsonb_build_object('doc_id', r.doc_id, 'amount', r.outstanding)));
      v_used := v_used || r.doc_id; v_ok := v_ok + 1;
    exception when others then v_skip := v_skip + 1;
    end;
  end loop;
  return jsonb_build_object('settled', v_ok, 'skipped', v_skip);
end $$;

revoke execute on function public.sst_summary(uuid, date, date), public.bank_accept_suggestions(uuid) from public, anon;
grant execute on function public.sst_summary(uuid, date, date), public.bank_accept_suggestions(uuid) to authenticated;
