-- Users may rename themselves, but not change the email on their profile:
-- add_member() and the audit trail identify people by profiles.email.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (full_name) on public.profiles to authenticated;

alter table public.profiles add constraint profiles_full_name_length check (length(full_name) <= 100) not valid;
