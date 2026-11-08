-- "Needs attention": overdue invoices, bills due, drafts, bank lines to clear,
-- unfiled receipts, e-Invoice problems and months left open.
create or replace function public.attention_summary(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_j boolean; v jsonb := '{}'::jsonb; r record; v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  perform public._require_perm(p_company, 'company.view');
  v_j := public.has_perm(p_company, 'journal.view');
  if v_j then
    select count(*) filter (where d.side = 'AR' and d.due_date < v_today) ar_n,
           coalesce(sum(d.total - d.allocated) filter (where d.side = 'AR' and d.due_date < v_today), 0) ar_amt,
           count(*) filter (where d.side = 'AP' and d.due_date < v_today) ap_late_n,
           coalesce(sum(d.total - d.allocated) filter (where d.side = 'AP' and d.due_date < v_today), 0) ap_late_amt,
           count(*) filter (where d.side = 'AP' and d.due_date between v_today and v_today + 7) ap_due_n,
           coalesce(sum(d.total - d.allocated) filter (where d.side = 'AP' and d.due_date between v_today and v_today + 7), 0) ap_due_amt
      into r
      from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
     where d.company_id = p_company and d.status = 'POSTED' and m.effect = 1 and m.posts and d.total - d.allocated > 0;
    v := v || jsonb_build_object(
      'overdue_invoices', jsonb_build_object('count', r.ar_n, 'amount', r.ar_amt),
      'overdue_bills', jsonb_build_object('count', r.ap_late_n, 'amount', r.ap_late_amt),
      'bills_due_7', jsonb_build_object('count', r.ap_due_n, 'amount', r.ap_due_amt),
      'draft_documents', (select count(*) from public.trade_docs where company_id = p_company and status = 'DRAFT'),
      'draft_journals', (select count(*) from public.journal_entries where company_id = p_company and status = 'DRAFT'),
      'bank_to_clear', (select count(*) from public.bank_lines where company_id = p_company and status = 'UNMATCHED'),
      'inbox', (select count(*) from public.attachments where company_id = p_company and status <> 'RECORDED'),
      'einvoice_problems', (select count(*) from public.trade_docs where company_id = p_company and einvoice_status in ('INVALID', 'REJECTED')),
      'open_past_periods', (select count(*) from public.fiscal_periods where company_id = p_company and status = 'OPEN' and end_date < date_trunc('month', v_today)::date - 15),
      'oldest_open_period', (select jsonb_build_object('id', id, 'name', name, 'end_date', end_date) from public.fiscal_periods
                              where company_id = p_company and status = 'OPEN' and end_date < date_trunc('month', v_today)::date - 15 order by end_date limit 1));
  end if;
  return v || jsonb_build_object('as_at', v_today, 'can_view', v_j);
end $$;
revoke execute on function public.attention_summary(uuid) from public, anon;
grant execute on function public.attention_summary(uuid) to authenticated;
