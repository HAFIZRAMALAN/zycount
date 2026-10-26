-- ═══════════════════════════════════════════════════════════════════════════
-- Review fixes:
--  • Members join through invite links instead of by email. Sign-up does not
--    prove someone owns an address, so add_member(email) could hand a
--    company's books to whoever registered that address first.
--  • Reversed opening balances no longer block entering them again.
--  • Shareholders' drawings (a debit-balance equity account) open on the debit side.
--  • record_transaction remembers what the person chose (in / out / transfer).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Invite links ───────────────────────────────────────────────────────────
create table public.company_invites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  role        text not null references public.roles(name),
  token_hash  text not null unique,
  note        text check (note is null or length(note) <= 200),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
create index company_invites_company_idx on public.company_invites(company_id, created_at desc);
alter table public.company_invites enable row level security;
create policy "invites by permission" on public.company_invites for select to authenticated
  using (company_id in (select public.companies_with_perm('user.view')));

-- Returns the link token once; only its SHA-256 is stored.
create or replace function public.create_invite(p_company uuid, p_role text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_token text; v_id uuid;
begin
  perform public._require_perm(p_company, 'user.create');
  if not exists (select 1 from public.roles where name = p_role) then raise exception 'VALIDATION: Unknown role %.', p_role; end if;
  if p_role = 'SuperAdmin' and not public.has_perm(p_company, 'role.edit') then
    raise exception 'PERMISSION_DENIED: Only administrators can invite an owner.';
  end if;
  if (select count(*) from public.company_invites
       where company_id = p_company and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'LIMIT_REACHED: Cancel some open invites before creating more.';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.company_invites (company_id, role, token_hash, note, created_by)
  values (p_company, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;
  perform public._audit(p_company, 'user.invite', 'Invite', v_id::text,
    format('Created an invite link for the %s role%s', p_role, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
  return v_token;
end $$;

create or replace function public.revoke_invite(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_i record;
begin
  select * into v_i from public.company_invites where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Invite not found.'; end if;
  perform public._require_perm(v_i.company_id, 'user.create');
  if v_i.accepted_at is not null then raise exception 'INVALID_STATE: This invite has already been used.'; end if;
  update public.company_invites set revoked_at = now() where id = p_id and revoked_at is null;
  perform public._audit(v_i.company_id, 'user.invite_cancel', 'Invite', p_id::text, format('Cancelled an invite for the %s role', v_i.role));
end $$;

create or replace function public.accept_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_i record; v_name text; v_email text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Sign in to accept the invite.'; end if;
  select * into v_i from public.company_invites
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') for update;
  if not found then raise exception 'INVITE_INVALID: This invite link is not valid. Ask for a new one.'; end if;
  select name into v_name from public.companies where id = v_i.company_id;
  if v_i.accepted_at is not null then
    if v_i.accepted_by = auth.uid() then
      return jsonb_build_object('company_id', v_i.company_id, 'name', v_name, 'role', v_i.role, 'already', true);
    end if;
    raise exception 'INVITE_USED: This invite has already been used. Ask for a new one.';
  end if;
  if v_i.revoked_at is not null then raise exception 'INVITE_INVALID: This invite was cancelled. Ask for a new one.'; end if;
  if v_i.expires_at <= now() then raise exception 'INVITE_EXPIRED: This invite has expired. Ask for a new one.'; end if;

  if exists (select 1 from public.company_members where company_id = v_i.company_id and user_id = auth.uid()) then
    update public.company_invites set accepted_by = auth.uid(), accepted_at = now() where id = v_i.id;
    return jsonb_build_object('company_id', v_i.company_id, 'name', v_name, 'role', v_i.role, 'already', true);
  end if;
  insert into public.company_members (company_id, user_id, role) values (v_i.company_id, auth.uid(), v_i.role);
  update public.company_invites set accepted_by = auth.uid(), accepted_at = now() where id = v_i.id;
  select email into v_email from public.profiles where id = auth.uid();
  perform public._audit(v_i.company_id, 'user.join', 'User', auth.uid()::text,
    format('%s joined as %s through an invite link', coalesce(v_email, 'A user'), v_i.role));
  return jsonb_build_object('company_id', v_i.company_id, 'name', v_name, 'role', v_i.role, 'already', false);
end $$;

-- Adding people by email trusted an unverified address; invites replace it.
revoke execute on function public.add_member(uuid, text, text) from authenticated;

-- ─── What the person chose in the money forms ───────────────────────────────
alter table public.journal_entries add column txn_kind text check (txn_kind in ('IN', 'OUT', 'TRANSFER'));

create or replace function public.record_transaction(p_company uuid, p_kind text, p_date date, p_amount numeric,
                                                     p_money_account uuid, p_other_account uuid,
                                                     p_description text default null, p_reference text default null,
                                                     p_tax_rate numeric default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_amount numeric; v_net numeric; v_tax numeric := 0; v_tax_acc uuid; v_lines jsonb; v_desc text; v_saved jsonb;
  v_kind text := upper(coalesce(p_kind, ''));
begin
  perform public._require_perm(p_company, 'journal.create');
  perform public._require_perm(p_company, 'journal.post');
  if v_kind not in ('IN', 'OUT', 'TRANSFER') then raise exception 'VALIDATION: Choose money in, money out or transfer.'; end if;
  if p_date is null then raise exception 'VALIDATION: Choose a date.'; end if;
  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then raise exception 'VALIDATION: Enter an amount greater than zero.'; end if;
  if v_amount > 9999999999999999.99 then raise exception 'VALIDATION: That amount is too large.'; end if;
  if p_money_account is null or p_other_account is null then raise exception 'VALIDATION: Choose both accounts.'; end if;
  if p_money_account = p_other_account then raise exception 'VALIDATION: Choose two different accounts.'; end if;
  if (select count(*) from public.accounts where company_id = p_company and id in (p_money_account, p_other_account)) <> 2 then
    raise exception 'VALIDATION: Account not found in these books.';
  end if;

  v_net := v_amount;
  if coalesce(p_tax_rate, 0) <> 0 then
    if v_kind <> 'IN' then raise exception 'VALIDATION: SST is split out only on money received.'; end if;
    if p_tax_rate not in (5, 6, 8, 10) then raise exception 'VALIDATION: Choose an SST rate of 5, 6, 8 or 10%%.'; end if;
    select id into v_tax_acc from public.accounts
     where company_id = p_company and code = '2150' and is_postable and is_active;
    if not found then raise exception 'VALIDATION: These books have no active SST Output Tax account (2150).'; end if;
    v_net := round(v_amount * 100 / (100 + p_tax_rate), 2);
    v_tax := v_amount - v_net;
  end if;

  v_desc := coalesce(nullif(btrim(p_description), ''),
                     case v_kind when 'IN' then 'Money in' when 'OUT' then 'Money out' else 'Transfer' end);
  if v_kind = 'IN' then
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_money_account, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', p_other_account, 'debit', 0, 'credit', v_net));
    if v_tax > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_tax_acc, 'debit', 0, 'credit', v_tax,
                                                                 'description', format('SST %s%%', p_tax_rate::int)));
    end if;
  else
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_other_account, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', p_money_account, 'debit', 0, 'credit', v_amount));
  end if;

  v_saved := public.save_journal(p_company, null, p_date, left(v_desc, 500), nullif(btrim(p_reference), ''), v_lines, null);
  update public.journal_entries set source = 'BANK', txn_kind = v_kind where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid) || jsonb_build_object('kind', v_kind, 'tax', v_tax);
end $$;

-- ─── Opening balances ───────────────────────────────────────────────────────
-- A positive amount is the account's usual side: assets in debit; liabilities,
-- equity and contra-assets in credit; drawings (a contra-equity) in debit.
create or replace function public.post_opening_balances(p_company uuid, p_date date, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb; v_acc record; v_amt numeric; v_lines jsonb := '[]'::jsonb; v_dr numeric := 0; v_cr numeric := 0;
  v_plug record; v_saved jsonb; v_diff numeric; v_debit_side boolean; v_seen uuid[] := '{}';
begin
  perform public._require_perm(p_company, 'journal.create');
  perform public._require_perm(p_company, 'journal.post');
  if p_date is null then raise exception 'VALIDATION: Choose the date of the opening balances.'; end if;
  -- Only a live opening journal blocks re-entry: once reversed, the original is
  -- REVERSED and its reversal carries reversal_of_id.
  if exists (select 1 from public.journal_entries
              where company_id = p_company and source = 'OPENING_BALANCE' and status = 'POSTED' and reversal_of_id is null) then
    raise exception 'DUPLICATE: Opening balances are already posted. Reverse that journal first to enter them again.';
  end if;
  select a.id, a.code, a.name into v_plug from public.accounts a join public.companies c on c.id = a.company_id
   where a.company_id = p_company and a.code = case c.kind when 'PERSONAL' then '3100' else '3200' end;
  if not found then raise exception 'VALIDATION: The equity account for the balancing figure is missing.'; end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    begin
      v_amt := round(coalesce(nullif(v_line->>'amount', '')::numeric, 0), 2);
    exception when others then
      raise exception 'VALIDATION: An amount is not a number.';
    end;
    if v_amt = 0 then continue; end if;
    select id, code, name, type, is_postable, is_active into v_acc from public.accounts
     where id = (v_line->>'account_id')::uuid and company_id = p_company;
    if not found then raise exception 'VALIDATION: Account not found in these books.'; end if;
    if v_acc.id = any (v_seen) then raise exception 'VALIDATION: % % appears twice.', v_acc.code, v_acc.name; end if;
    v_seen := v_seen || v_acc.id;
    if v_acc.type not in ('ASSET', 'LIABILITY', 'EQUITY') then
      raise exception 'VALIDATION: Opening balances are for what you own, owe and equity — % % is %.', v_acc.code, v_acc.name, lower(v_acc.type::text);
    end if;
    if v_acc.id = v_plug.id then
      raise exception 'VALIDATION: % % takes the balancing figure automatically.', v_acc.code, v_acc.name;
    end if;
    v_debit_side := (v_acc.type = 'ASSET' and v_acc.name !~* '^(accumulated|allowance)')
                 or (v_acc.type = 'EQUITY' and (v_acc.code = '3300' or v_acc.name ~* 'drawing'));
    if v_debit_side = (v_amt > 0) then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'debit', abs(v_amt), 'credit', 0));
      v_dr := v_dr + abs(v_amt);
    else
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'debit', 0, 'credit', abs(v_amt)));
      v_cr := v_cr + abs(v_amt);
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'VALIDATION: Enter at least one balance.'; end if;

  v_diff := v_dr - v_cr;
  if v_diff > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_plug.id, 'debit', 0, 'credit', v_diff,
                                                               'description', 'Balancing figure'));
  elsif v_diff < 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_plug.id, 'debit', -v_diff, 'credit', 0,
                                                               'description', 'Balancing figure'));
  end if;

  v_saved := public.save_journal(p_company, null, p_date, 'Opening balances', null, v_lines, null);
  update public.journal_entries set source = 'OPENING_BALANCE' where id = (v_saved->>'id')::uuid;
  return public.post_journal((v_saved->>'id')::uuid) || jsonb_build_object('balancing', v_diff);
end $$;

grant execute on function public.create_invite(uuid, text, text), public.revoke_invite(uuid), public.accept_invite(text)
to authenticated;
