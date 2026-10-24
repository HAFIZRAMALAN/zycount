-- A bank line that pays a customer's invoice (or a supplier's bill) becomes a receipt
-- (or payment) that knocks those documents off, in one step. Suggestions rank the open
-- documents by what the bank text says: document number, reference, the contact's name,
-- and whether the amount settles one document or the contact's whole balance.

create or replace function public._norm(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g');
$$;

-- How strongly a contact's name shows up in a bank description (0–45).
create or replace function public._name_hits(p_name text, p_text text)
returns int language sql immutable set search_path = public as $$
  select case
    when length(public._norm(p_name)) >= 5 and strpos(public._norm(p_text), public._norm(p_name)) > 0 then 45
    else least(45, 15 * (
      select count(distinct w)::int from regexp_split_to_table(lower(coalesce(p_name, '')), '[^a-z0-9]+') w
      where length(w) >= 4
        and w not in ('sdn', 'bhd', 'berhad', 'enterprise', 'trading', 'company', 'services', 'service', 'resources',
                      'holdings', 'group', 'global', 'solutions', 'industries', 'marketing', 'international', 'malaysia')
        and strpos(' ' || regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', ' ', 'g') || ' ', ' ' || w || ' ') > 0))
  end;
$$;

-- Open invoices (money in) or bills (money out) this bank line could be settling, best first.
create or replace function public._bank_suggest(p_line public.bank_lines)
returns table (doc_id uuid, doc_type text, doc_no text, date date, due_date date, reference text,
               contact_id uuid, contact_name text, total numeric, outstanding numeric, contact_open numeric, score int, why text)
language sql stable security definer set search_path = public as $$
  with open_docs as (
    select d.id, d.doc_type, d.doc_no, d.date, d.due_date, d.reference, d.contact_id, c.name as cname,
           d.total, d.total - d.allocated as outstanding
    from public.trade_docs d
    join public.contacts c on c.id = d.contact_id
    cross join lateral public._trade_meta(d.doc_type) m
    where d.company_id = p_line.company_id and d.status = 'POSTED' and m.effect = 1 and d.total > d.allocated
      and d.side = case when p_line.amount > 0 then 'AR' else 'AP' end
  ), by_contact as (
    select o.contact_id, sum(o.outstanding) as open_total from open_docs o group by o.contact_id
  ), scored as (
    select o.*, bc.open_total,
      (case when length(public._norm(o.doc_no)) >= 3 and strpos(public._norm(concat_ws(' ', p_line.description, p_line.reference)), public._norm(o.doc_no)) > 0 then 60 else 0 end) as s_no,
      (case when length(public._norm(o.reference)) >= 4 and strpos(public._norm(concat_ws(' ', p_line.description, p_line.reference)), public._norm(o.reference)) > 0 then 40 else 0 end) as s_ref,
      (case when o.outstanding = abs(p_line.amount) then 50 else 0 end) as s_amt,
      (case when bc.open_total = abs(p_line.amount) and o.outstanding <> abs(p_line.amount) then 30 else 0 end) as s_all,
      public._name_hits(o.cname, coalesce(p_line.description, '') || ' ' || coalesce(p_line.reference, '')) as s_name,
      (case when o.date > p_line.date then -40 else 0 end) as s_future
    from open_docs o join by_contact bc on bc.contact_id = o.contact_id
  )
  select s.id, s.doc_type, s.doc_no, s.date, s.due_date, s.reference, s.contact_id, s.cname, s.total, s.outstanding, s.open_total,
         (s.s_no + s.s_ref + s.s_amt + s.s_all + s.s_name + s.s_future)::int,
         concat_ws(' · ',
           case when s.s_no > 0 then 'number in bank text' end,
           case when s.s_ref > 0 then 'reference in bank text' end,
           case when s.s_amt > 0 then 'exact amount' end,
           case when s.s_all > 0 then 'settles the whole balance' end,
           case when s.s_name > 0 then 'name in bank text' end)
  from scored s
  where s.s_no + s.s_ref + s.s_amt + s.s_all + s.s_name > 0
  order by (s.s_no + s.s_ref + s.s_amt + s.s_all + s.s_name + s.s_future) desc, coalesce(s.due_date, s.date), s.doc_no
  limit 40;
$$;

create or replace function public.bank_line_suggestions(p_line uuid)
returns table (doc_id uuid, doc_type text, doc_no text, date date, due_date date, reference text,
               contact_id uuid, contact_name text, total numeric, outstanding numeric, contact_open numeric, score int, why text)
language plpgsql stable security definer set search_path = public as $$
declare v_l public.bank_lines;
begin
  select * into v_l from public.bank_lines where id = p_line;
  if not found then raise exception 'NOT_FOUND: Bank line not found.'; end if;
  perform public._require_perm(v_l.company_id, 'journal.view');
  return query select * from public._bank_suggest(v_l);
end $$;

-- The best suggestion for every unmatched line of a statement, for the list view.
create or replace function public.bank_statement_suggestions(p_statement uuid)
returns table (line_id uuid, doc_id uuid, doc_no text, contact_id uuid, contact_name text, outstanding numeric,
               contact_open numeric, score int, why text)
language plpgsql stable security definer set search_path = public as $$
declare v_s record;
begin
  select * into v_s from public.bank_statements where id = p_statement;
  if not found then raise exception 'NOT_FOUND: Statement not found.'; end if;
  perform public._require_perm(v_s.company_id, 'journal.view');
  return query
  select l.id, g.doc_id, g.doc_no, g.contact_id, g.contact_name, g.outstanding, g.contact_open, g.score, g.why
  from public.bank_lines l
  cross join lateral (select * from public._bank_suggest(l) limit 1) g
  where l.statement_id = p_statement and l.status = 'UNMATCHED' and g.score >= 50;
end $$;

-- Posts a receipt (money in) or payment (money out) for the line's contact, knocks off the
-- chosen documents, and matches the bank line — all or nothing. What is not knocked off
-- stays on the receipt as an advance, to apply later.
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

  v_r := public.save_trade_doc(v_l.company_id, null,
    jsonb_build_object('doc_type', case when v_in then 'RECEIPT' else 'PAYMENT' end, 'contact_id', p_contact, 'date', v_l.date,
      'amount', v_total, 'bank_charge', v_charge, 'money_account_id', v_st.account_id, 'pay_method', 'Bank transfer',
      'reference', left(v_l.reference, 60),
      'description', left(coalesce(nullif(btrim(p_description), ''), v_l.description), 500)),
    '[]'::jsonb, true, p_series, p_doc_no, coalesce(p_allocations, '[]'::jsonb));
  select journal_entry_id into v_je from public.trade_docs where id = (v_r->>'id')::uuid;
  update public.bank_lines set status = 'MATCHED', entry_id = v_je, match_method = 'CREATED', note = null, updated_at = now()
  where id = p_line;
  return v_r || jsonb_build_object('applied', v_applied, 'advance', v_total - v_applied, 'contact', v_c.name);
end $$;

revoke execute on function public._bank_suggest(public.bank_lines), public._name_hits(text, text) from public, anon, authenticated;
revoke execute on function public.bank_line_suggestions(uuid), public.bank_statement_suggestions(uuid),
  public.settle_from_bank_line(uuid, uuid, jsonb, numeric, uuid, text, text) from public, anon;
grant execute on function public.bank_line_suggestions(uuid), public.bank_statement_suggestions(uuid),
  public.settle_from_bank_line(uuid, uuid, jsonb, numeric, uuid, text, text) to authenticated;
