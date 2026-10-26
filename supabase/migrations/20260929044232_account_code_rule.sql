-- Journal lines point at account ids, so a code can change freely — except the
-- codes the posting rules look up: 2150 SST output tax, 3300 drawings and the
-- opening-balance equity account (3100 personal, 3200 business).
create or replace function public.change_account_code(p_id uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare v_a record; v_code text := btrim(coalesce(p_code, '')); v_locked text[];
begin
  select a.*, c.kind as company_kind into v_a from public.accounts a join public.companies c on c.id = a.company_id where a.id = p_id;
  if not found then raise exception 'NOT_FOUND: Account not found.'; end if;
  perform public._require_perm(v_a.company_id, 'account.edit');
  if v_code = v_a.code then return; end if;
  if v_code !~ '^[0-9A-Za-z.\-]{1,20}$' then raise exception 'VALIDATION: Account code must be 1–20 letters, digits, dots or dashes.'; end if;
  v_locked := array['2150', '3300', (case v_a.company_kind when 'PERSONAL' then '3100' else '3200' end)];
  if v_a.code = any (v_locked) then
    raise exception 'SYSTEM_ACCOUNT: % % is looked up by the posting rules, so its code stays.', v_a.code, v_a.name;
  end if;
  if v_code = any (v_locked) then
    raise exception 'VALIDATION: % is kept for the posting rules.', v_code;
  end if;
  if exists (select 1 from public.accounts where company_id = v_a.company_id and code = v_code) then
    raise exception 'DUPLICATE: Account code % is already in use.', v_code;
  end if;
  update public.accounts set code = v_code, updated_at = now() where id = p_id;
  perform public._audit(v_a.company_id, 'account.edit', 'Account', p_id::text, format('Changed account code %s to %s (%s)', v_a.code, v_code, v_a.name));
end $$;
