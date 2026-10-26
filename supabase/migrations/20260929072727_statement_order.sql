-- Statement lines on the same day follow the order they were posted, so the
-- running balance reads naturally (invoice, then its receipt or credit note).
create or replace function public.contact_statement(p_contact uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_c public.contacts; v_open numeric; v_rows jsonb; v_aging jsonb; v_to date := coalesce(p_to, current_date);
        v_from date := coalesce(p_from, date_trunc('month', coalesce(p_to, current_date))::date);
begin
  select * into v_c from public.contacts where id = p_contact;
  if not found then raise exception 'NOT_FOUND: Contact not found.'; end if;
  perform public._require_perm(v_c.company_id, 'journal.view');
  if v_from > v_to then raise exception 'VALIDATION: The start date is after the end date.'; end if;

  select coalesce(sum(m.effect * d.total), 0) into v_open
  from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
  where d.contact_id = p_contact and m.effect <> 0 and d.date < v_from
    and (d.status = 'POSTED' or (d.status = 'VOID' and d.void_date >= v_from));

  with ev as (
    select d.date, 0 as ord, coalesce(d.posted_at, d.created_at) as at, d.doc_type, d.doc_no, d.due_date, d.reference,
           coalesce(d.description, m.label) as description, m.effect * d.total as amt, d.id
    from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.contact_id = p_contact and m.effect <> 0 and d.status in ('POSTED', 'VOID') and d.date between v_from and v_to
    union all
    select d.void_date, 1, d.updated_at, d.doc_type, d.doc_no, null, d.reference, 'Cancelled: ' || coalesce(d.void_reason, ''), -m.effect * d.total, d.id
    from public.trade_docs d cross join lateral public._trade_meta(d.doc_type) m
    where d.contact_id = p_contact and m.effect <> 0 and d.status = 'VOID' and d.void_date between v_from and v_to)
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'date', r.date, 'doc_type', r.doc_type, 'doc_no', r.doc_no,
           'due_date', r.due_date, 'reference', r.reference, 'description', r.description,
           'increase', case when r.amt > 0 then r.amt else 0 end, 'decrease', case when r.amt < 0 then -r.amt else 0 end,
           'balance', r.bal) order by r.date, r.ord, r.at, r.doc_no), '[]'::jsonb) into v_rows
  from (select ev.*, v_open + sum(ev.amt) over (order by ev.date, ev.ord, ev.at, ev.doc_no rows between unbounded preceding and current row) as bal from ev) r;

  select to_jsonb(a) into v_aging from public.trade_aging(v_c.company_id, case v_c.kind when 'CUSTOMER' then 'AR' else 'AP' end, v_to) a
   where a.contact_id = p_contact;
  return jsonb_build_object('contact', to_jsonb(v_c), 'from', v_from, 'to', v_to, 'opening', v_open, 'lines', v_rows,
    'closing', v_open + coalesce((select sum((x->>'increase')::numeric - (x->>'decrease')::numeric) from jsonb_array_elements(v_rows) x), 0),
    'aging', coalesce(v_aging, '{}'::jsonb));
end $$;
