-- Supabase advisor function_search_path_mutable: pin the helper's search path.
alter function public._subscription_state(public.subscriptions) set search_path = public;
