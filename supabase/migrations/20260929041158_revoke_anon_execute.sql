-- Nothing in Zycount is callable before sign-in (sign-up runs in an Edge Function
-- with the service role). Functions re-created in later migrations picked up the
-- platform's default grant to anon; take it away for all, now and in future.
revoke execute on all functions in schema public from public, anon;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
