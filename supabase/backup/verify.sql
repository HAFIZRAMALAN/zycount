-- Run against a RESTORED copy. Raises 'RESTORE FAIL: …' if the books that came
-- back can't be trusted; ends with notice 'RESTORE VERIFIED'.
do $$
declare n bigint; d numeric; c numeric; bad bigint;
begin
  select count(*) into n from public.journal_entries;
  -- Every posted entry balances, and its header totals match its lines.
  select count(*) into bad from public.journal_entries e
   where e.status = 'POSTED'
     and (e.total_debit <> e.total_credit
          or e.total_debit <> coalesce((select sum(debit) from public.journal_lines l where l.journal_entry_id = e.id), 0)
          or e.total_credit <> coalesce((select sum(credit) from public.journal_lines l where l.journal_entry_id = e.id), 0));
  if bad > 0 then raise exception 'RESTORE FAIL: % posted journals do not balance', bad; end if;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into d, c
    from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id where e.status = 'POSTED';
  if d <> c then raise exception 'RESTORE FAIL: ledger out of balance (debit % vs credit %)', d, c; end if;

  -- Every line belongs to an entry and an account of the same company.
  select count(*) into bad from public.journal_lines l
    left join public.journal_entries e on e.id = l.journal_entry_id
    left join public.accounts a on a.id = l.account_id
   where e.id is null or a.id is null or a.company_id <> e.company_id;
  if bad > 0 then raise exception 'RESTORE FAIL: % journal lines lost their entry or account', bad; end if;

  -- Every company still has an owner who can sign in.
  select count(*) into bad from public.companies co
   where not exists (select 1 from public.company_members m join auth.users u on u.id = m.user_id where m.company_id = co.id);
  if bad > 0 then raise exception 'RESTORE FAIL: % companies have no member with a sign-in', bad; end if;

  raise notice 'RESTORE VERIFIED: % journals, ledger % = %', n, d, c;
end $$;
