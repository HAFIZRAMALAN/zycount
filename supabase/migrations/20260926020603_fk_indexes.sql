-- Covering indexes for foreign keys flagged by the Supabase performance advisor.
create index if not exists companies_created_by_idx on public.companies(created_by);
create index if not exists company_members_role_idx on public.company_members(role);
create index if not exists journal_entries_period_idx on public.journal_entries(fiscal_period_id);
