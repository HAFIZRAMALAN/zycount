-- Audit L1: a journal line with more than 2 decimal places (0.005) was rounded
-- silently. It is now refused, so what the user typed is exactly what posts.
create or replace function public._write_lines(p_entry uuid, p_company uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb; v_no int := 0; v_debit numeric; v_credit numeric; v_account uuid; v_acc record;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'VALIDATION: Journal lines are required.';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'VALIDATION: A journal can have at most 500 lines.';
  end if;
  delete from public.journal_lines where journal_entry_id = p_entry;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin
      v_debit  := coalesce(nullif(btrim(v_line->>'debit'), '')::numeric, 0);
      v_credit := coalesce(nullif(btrim(v_line->>'credit'), '')::numeric, 0);
    exception when others then
      raise exception 'VALIDATION: Line %: amounts must be numbers.', v_no + 1;
    end;
    if v_debit = 0 and v_credit = 0 then continue; end if;   -- blank rows are ignored
    v_no := v_no + 1;
    if v_debit <> round(v_debit, 2) or v_credit <> round(v_credit, 2) then
      raise exception 'VALIDATION: Line %: amounts can have at most 2 decimal places (sen).', v_no;
    end if;
    if v_debit < 0 or v_credit < 0 then
      raise exception 'VALIDATION: Line %: amounts cannot be negative.', v_no;
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'VALIDATION: Line %: enter a debit or a credit, not both.', v_no;
    end if;
    if v_debit > 9999999999999999.99 or v_credit > 9999999999999999.99 then
      raise exception 'VALIDATION: Line %: amount is too large.', v_no;
    end if;
    begin
      v_account := (v_line->>'account_id')::uuid;
    exception when others then
      raise exception 'VALIDATION: Line %: choose an account.', v_no;
    end;
    select id, code, name, is_postable, is_active into v_acc from public.accounts
     where id = v_account and company_id = p_company;
    if not found then
      raise exception 'VALIDATION: Line %: account not found in this company.', v_no;
    end if;
    if not v_acc.is_postable then
      raise exception 'ACCOUNT_NOT_POSTABLE: % % is a heading — post to one of its sub-accounts.', v_acc.code, v_acc.name;
    end if;
    if not v_acc.is_active then
      raise exception 'ACCOUNT_NOT_POSTABLE: % % is archived.', v_acc.code, v_acc.name;
    end if;
    insert into public.journal_lines (journal_entry_id, account_id, line_no, description, debit, credit)
    values (p_entry, v_account, v_no, nullif(btrim(v_line->>'description'), ''), v_debit, v_credit);
  end loop;
  update public.journal_entries e set
    total_debit  = coalesce((select sum(debit)  from public.journal_lines where journal_entry_id = p_entry), 0),
    total_credit = coalesce((select sum(credit) from public.journal_lines where journal_entry_id = p_entry), 0)
  where e.id = p_entry;
end $$;
revoke execute on function public._write_lines(uuid, uuid, jsonb) from public, anon, authenticated;
