-- Fiscal periods with posted/draft counts, computed in the database so the
-- periods screen stays correct however many journals a company has.
create or replace function public.period_summary(p_company uuid)
returns table (id uuid, name text, year int, period_no smallint, start_date date, end_date date,
               status public.period_status, closed_at timestamptz, reopened_at timestamptz, reopen_reason text,
               posted int, drafts int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm(p_company, 'period.view') then
    raise exception 'PERMISSION_DENIED: Your role cannot view fiscal periods in this company.';
  end if;
  return query
  select p.id, p.name, p.year, p.period_no, p.start_date, p.end_date, p.status, p.closed_at, p.reopened_at, p.reopen_reason,
    (select count(*)::int from public.journal_entries e
      where e.company_id = p_company and e.status in ('POSTED','REVERSED') and e.date between p.start_date and p.end_date),
    (select count(*)::int from public.journal_entries e
      where e.company_id = p_company and e.status = 'DRAFT' and e.date between p.start_date and p.end_date)
  from public.fiscal_periods p
  where p.company_id = p_company
  order by p.start_date;
end $$;

grant execute on function public.period_summary(uuid) to authenticated;
