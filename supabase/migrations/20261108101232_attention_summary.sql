-- "Needs attention": one call for the work waiting in a set of books
-- (dashboard worklist and the top-bar bell). Final body in 20261108101252.
create or replace function public.attention_summary(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_perm(p_company, 'company.view');
  return '{}'::jsonb;
end $$;
revoke execute on function public.attention_summary(uuid) from public, anon;
grant execute on function public.attention_summary(uuid) to authenticated;
