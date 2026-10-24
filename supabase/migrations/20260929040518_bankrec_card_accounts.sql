-- Personal books reconcile credit-card statements too: a card is a current
-- liability there, and the same matching rule holds (a purchase is money out).
create or replace function public._statement_account_ok(p_company uuid, p_account uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a join public.companies c on c.id = a.company_id
    where a.id = p_account and a.company_id = p_company and a.is_postable and a.is_active
      and (a.is_cash or (c.kind = 'PERSONAL' and a.type = 'LIABILITY' and a.sub_type = 'CURRENT_LIABILITY')));
$$;
revoke execute on function public._statement_account_ok(uuid, uuid) from public, anon, authenticated;

create or replace function public.import_bank_statement(p_company uuid, p_account uuid, p_name text, p_lines jsonb,
                                                        p_opening numeric default null, p_closing numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acc record; v_id uuid; v_line jsonb; v_no int := 0; v_date date; v_amt numeric; v_matched int;
begin
  perform public._require_perm(p_company, 'journal.create');
  select * into v_acc from public.accounts where id = p_account and company_id = p_company;
  if not found then raise exception 'VALIDATION: Account not found in these books.'; end if;
  if not public._statement_account_ok(p_company, p_account) then
    raise exception 'VALIDATION: % % is not a bank, cash or card account.', v_acc.code, v_acc.name;
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
    if abs(v_amt) > 9999999999999999.99 then raise exception 'VALIDATION: Line %: that amount is too large.', v_no + 1; end if;
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
