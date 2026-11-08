-- Supabase advisor unindexed_foreign_keys.
create index if not exists bank_lines_company_idx on public.bank_lines (company_id);
create index if not exists bank_statements_account_idx on public.bank_statements (account_id);
create index if not exists company_invites_role_idx on public.company_invites (role);
