-- Zycount: platform API keys, subscription plans and online payment, and
-- idempotent money-moving calls. Closes the Phase 1/2 items left open by the
-- October audit (R3) and moves every service key out of hard-to-reach
-- dashboard settings into a register the platform admin manages in the app.
--
-- Secrets: the value goes straight into Supabase Vault. No API role can read
-- it back — the admin sees only the last four characters; edge functions read
-- it with the service role through _platform_secret().

-- ═══ 1. Platform secrets and settings ═══════════════════════════════════════
create table if not exists public.platform_secrets (
  name        text primary key check (name ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  secret_id   uuid not null,
  hint        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

create table if not exists public.platform_settings (
  key         text primary key check (key ~ '^[a-z][a-z0-9_.]{2,63}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

create table if not exists public.platform_audit (
  id          bigint generated always as identity primary key,
  user_id     uuid,
  user_email  text,
  action      text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

alter table public.platform_secrets enable row level security;
alter table public.platform_settings enable row level security;
alter table public.platform_audit enable row level security;
revoke all on table public.platform_secrets, public.platform_settings, public.platform_audit from anon, authenticated;

insert into public.platform_settings (key, value) values
  ('billing.gateway', 'null'::jsonb),
  ('billing.mode', '"SANDBOX"'::jsonb),
  ('billing.trial_days', '14'::jsonb),
  ('app.url', '"https://hafizramalan.github.io/zycount/app.html"'::jsonb)
on conflict (key) do nothing;

create or replace function public._require_platform_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Sign in again.'; end if;
  if not public.is_platform_admin() then raise exception 'PERMISSION_DENIED: Only Zycount administrators can do this.'; end if;
end $$;

create or replace function public._platform_log(p_action text, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.platform_audit (user_id, user_email, action, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), p_action, p_detail);
$$;

create or replace function public._platform_setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from public.platform_settings where key = p_key;
$$;

/** Names, hints and dates of the stored keys — never the values. */
create or replace function public.platform_secrets_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'hint', s.hint, 'updated_at', s.updated_at,
      'updated_by', p.email) order by s.name)
    from public.platform_secrets s left join public.profiles p on p.id = s.updated_by), '[]'::jsonb);
end $$;

/** Stores (or replaces) a key in Vault. An empty value removes it. */
create or replace function public.platform_secret_set(p_name text, p_value text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text := upper(btrim(coalesce(p_name, ''))); v_val text := btrim(coalesce(p_value, '')); v_id uuid; v_hint text;
begin
  perform public._require_platform_admin();
  if v_name !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception 'VALIDATION: Use capital letters, digits and _ for the key name, e.g. BILLPLZ_API_KEY.';
  end if;
  select secret_id into v_id from public.platform_secrets where name = v_name;
  if v_val = '' then
    if v_id is not null then
      delete from vault.secrets where id = v_id;
      delete from public.platform_secrets where name = v_name;
      perform public._platform_log('secret.remove', jsonb_build_object('name', v_name));
    end if;
    return jsonb_build_object('name', v_name, 'removed', true);
  end if;
  if length(v_val) > 8000 then raise exception 'VALIDATION: That key is too long.'; end if;
  v_hint := case when length(v_val) >= 12 then '••••' || right(v_val, 4) else '••••' end;
  if v_id is null then
    v_id := vault.create_secret(v_val, 'platform-' || v_name || '-' || replace(gen_random_uuid()::text, '-', ''), 'Zycount platform key ' || v_name);
    insert into public.platform_secrets (name, secret_id, hint, updated_by) values (v_name, v_id, v_hint, auth.uid());
  else
    perform vault.update_secret(v_id, v_val);
    update public.platform_secrets set hint = v_hint, updated_at = now(), updated_by = auth.uid() where name = v_name;
  end if;
  perform public._platform_log('secret.set', jsonb_build_object('name', v_name, 'hint', v_hint));
  return jsonb_build_object('name', v_name, 'hint', v_hint, 'removed', false);
end $$;

/** For edge functions (service role) only: the decrypted key, or null. */
create or replace function public._platform_secret(p_name text)
returns text language sql stable security definer set search_path = public as $$
  select d.decrypted_secret from public.platform_secrets s join vault.decrypted_secrets d on d.id = s.secret_id
   where s.name = upper(p_name);
$$;

create or replace function public.platform_settings_get()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_platform_admin();
  return coalesce((select jsonb_object_agg(key, value) from public.platform_settings), '{}'::jsonb);
end $$;

create or replace function public.platform_setting_set(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb := coalesce(p_value, 'null'::jsonb);
begin
  perform public._require_platform_admin();
  if p_key = 'billing.gateway' and not (v = 'null'::jsonb or v #>> '{}' in ('BILLPLZ', 'TOYYIBPAY', 'STRIPE')) then
    raise exception 'VALIDATION: Choose Billplz, ToyyibPay, Stripe or none.';
  elsif p_key = 'billing.mode' and v #>> '{}' not in ('SANDBOX', 'LIVE') then
    raise exception 'VALIDATION: Choose sandbox or live.';
  elsif p_key = 'billing.trial_days' and (jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between 0 and 90) then
    raise exception 'VALIDATION: Trial days must be 0 to 90.';
  elsif p_key = 'app.url' and (v #>> '{}') !~ '^https?://[^ ]+/app\.html$' then
    raise exception 'VALIDATION: The app address must end in /app.html.';
  elsif p_key not in ('billing.gateway', 'billing.mode', 'billing.trial_days', 'app.url') then
    raise exception 'VALIDATION: Unknown setting %.', p_key;
  end if;
  insert into public.platform_settings (key, value, updated_by) values (p_key, v, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  perform public._platform_log('setting.set', jsonb_build_object('key', p_key, 'value', v));
  return public.platform_settings_get();
end $$;

-- ═══ 2. Plans and subscriptions ═════════════════════════════════════════════
create table if not exists public.plans (
  code         text primary key check (code ~ '^[A-Z]{3,20}$'),
  name         text not null,
  price_month  numeric(18,2) not null default 0 check (price_month >= 0),
  price_year   numeric(18,2) not null default 0 check (price_year >= 0),
  max_users    int check (max_users is null or max_users > 0),
  scan_daily   int not null default 300 check (scan_daily >= 0),
  features     jsonb not null default '[]'::jsonb,
  kind         text not null default 'BUSINESS' check (kind in ('BUSINESS', 'PERSONAL')),
  sort         int not null default 0,
  is_active    boolean not null default true
);

insert into public.plans (code, name, price_month, price_year, max_users, scan_daily, kind, sort, features) values
  ('STARTER',  'Starter',   49,  490, 1,    30,  'BUSINESS', 1, '["1 user","Invoices, bills & receipts","Bank reconciliation","Financial reports","LHDN MyInvois e-Invoice"]'),
  ('BUSINESS', 'Business',  99,  990, 5,    150, 'BUSINESS', 2, '["Everything in Starter","Up to 5 users with roles","Receipt capture & documents","AR/AP contra & cash book"]'),
  ('PRO',      'Pro',       199, 1990, null, 300, 'BUSINESS', 3, '["Everything in Business","Unlimited users","Auditor & read-only access","Priority support"]'),
  ('PERSONAL', 'Personal',  0,   0,   5,    20,  'PERSONAL', 0, '["Your own money in double entry","Statement import","Share with family"]')
on conflict (code) do nothing;

create table if not exists public.subscriptions (
  company_id          uuid primary key references public.companies(id) on delete cascade,
  plan_code           text not null references public.plans(code),
  status              text not null check (status in ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'FREE')),
  billing_cycle       text check (billing_cycle in ('MONTH', 'YEAR')),
  trial_ends_at       timestamptz,
  current_period_end  timestamptz,
  note                text,
  updated_at          timestamptz not null default now()
);

create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  plan_code     text not null references public.plans(code),
  billing_cycle text not null check (billing_cycle in ('MONTH', 'YEAR')),
  amount        numeric(18,2) not null check (amount > 0),
  currency      char(3) not null default 'MYR',
  gateway       text not null check (gateway in ('BILLPLZ', 'TOYYIBPAY', 'STRIPE', 'MANUAL')),
  mode          text not null default 'SANDBOX' check (mode in ('SANDBOX', 'LIVE')),
  gateway_ref   text,
  pay_url       text,
  status        text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'FAILED', 'CANCELLED')),
  paid_at       timestamptz,
  period_start  timestamptz,
  period_end    timestamptz,
  raw           jsonb,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index if not exists payments_gateway_ref_uq on public.payments (gateway, gateway_ref) where gateway_ref is not null;
create index if not exists payments_company_idx on public.payments (company_id, created_at desc);
create index if not exists payments_created_by_idx on public.payments (created_by);
create index if not exists subscriptions_plan_idx on public.subscriptions (plan_code);
create index if not exists payments_plan_idx on public.payments (plan_code);
create index if not exists platform_secrets_updated_by_idx on public.platform_secrets (updated_by);
create index if not exists platform_settings_updated_by_idx on public.platform_settings (updated_by);

alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
revoke all on table public.plans, public.subscriptions, public.payments from anon, authenticated;
grant select on table public.plans to authenticated;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (true);
drop policy if exists subscriptions_read on public.subscriptions;
create policy subscriptions_read on public.subscriptions for select to authenticated using (public.has_perm(company_id, 'company.view'));
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated using (public.has_perm(company_id, 'company.view'));
grant select on table public.subscriptions, public.payments to authenticated;

/** New books start on a trial (business) or the free personal plan. */
create or replace function public._subscription_for_new_company()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_days int := coalesce((public._platform_setting('billing.trial_days') #>> '{}')::int, 14);
begin
  insert into public.subscriptions (company_id, plan_code, status, trial_ends_at)
  values (new.id, case when new.kind = 'PERSONAL' then 'PERSONAL' else 'BUSINESS' end,
          case when new.kind = 'PERSONAL' then 'FREE' else 'TRIAL' end,
          case when new.kind = 'PERSONAL' then null else now() + make_interval(days => v_days) end)
  on conflict (company_id) do nothing;
  return new;
end $$;
drop trigger if exists companies_subscription on public.companies;
create trigger companies_subscription after insert on public.companies
  for each row execute function public._subscription_for_new_company();

-- Books that already exist: personal ones are free; business ones get 30 days.
insert into public.subscriptions (company_id, plan_code, status, trial_ends_at, note)
select c.id, case when c.kind = 'PERSONAL' then 'PERSONAL' else 'BUSINESS' end,
       case when c.kind = 'PERSONAL' then 'FREE' else 'TRIAL' end,
       case when c.kind = 'PERSONAL' then null else now() + interval '30 days' end,
       'Existing books at launch of billing'
  from public.companies c
on conflict (company_id) do nothing;

/** The plan in force for these books, with its limits. Never fails. */
create or replace function public._company_plan(p_company uuid)
returns public.plans language sql stable security definer set search_path = public as $$
  select p.* from public.plans p
   where p.code = coalesce((select plan_code from public.subscriptions where company_id = p_company), 'BUSINESS');
$$;

create or replace function public._subscription_state(s public.subscriptions)
returns text language sql stable as $$
  select case
    when s.company_id is null then 'TRIAL'
    when s.status = 'FREE' then 'FREE'
    when s.status = 'CANCELLED' then 'CANCELLED'
    when s.status = 'TRIAL' and s.trial_ends_at is not null and s.trial_ends_at < now() then 'EXPIRED'
    when s.status = 'ACTIVE' and s.current_period_end is not null and s.current_period_end < now() then 'PAST_DUE'
    else s.status end;
$$;

create or replace function public.billing_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'gateway', public._platform_setting('billing.gateway') #>> '{}',
    'mode', coalesce(public._platform_setting('billing.mode') #>> '{}', 'SANDBOX'),
    'trial_days', coalesce((public._platform_setting('billing.trial_days') #>> '{}')::int, 14));
$$;

/** Plan, status, usage and payment history for one set of books. */
create or replace function public.my_subscription(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.subscriptions; p public.plans; v_users int; v_scans int;
begin
  perform public._require_perm(p_company, 'company.view');
  select * into s from public.subscriptions where company_id = p_company;
  p := public._company_plan(p_company);
  select count(*) into v_users from public.company_members m
   where m.company_id = p_company and not exists (select 1 from public.platform_admins a where a.user_id = m.user_id);
  select count(*) into v_scans from public.attachment_scans
   where company_id = p_company and requested_at > now() - interval '24 hours' and engine is distinct from 'pdf-text';
  return jsonb_build_object(
    'plan', to_jsonb(p),
    'status', public._subscription_state(s),
    'billing_cycle', s.billing_cycle,
    'trial_ends_at', s.trial_ends_at,
    'current_period_end', s.current_period_end,
    'usage', jsonb_build_object('users', v_users, 'scans_today', v_scans),
    'plans', (select jsonb_agg(to_jsonb(x) order by x.sort) from public.plans x
               where x.is_active and x.kind = (select kind from public.companies where id = p_company)),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'plan_code', y.plan_code, 'billing_cycle', y.billing_cycle,
        'amount', y.amount, 'gateway', y.gateway, 'mode', y.mode, 'status', y.status, 'paid_at', y.paid_at,
        'period_end', y.period_end, 'created_at', y.created_at, 'pay_url', case when y.status = 'PENDING' then y.pay_url end)
        order by y.created_at desc) from (select * from public.payments where company_id = p_company order by created_at desc limit 50) y), '[]'::jsonb),
    'billing', public.billing_config(),
    'can_pay', public.has_perm(p_company, 'company.edit'));
end $$;

/** Opens a pending payment for a plan. Called by the billing edge function as the user. */
create or replace function public.billing_begin(p_company uuid, p_plan text, p_cycle text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.plans; c public.companies; v_gw text; v_mode text; v_id uuid; v_amount numeric(18,2);
begin
  perform public._require_perm(p_company, 'company.edit');
  select * into c from public.companies where id = p_company;
  select * into p from public.plans where code = p_plan and is_active;
  if not found then raise exception 'VALIDATION: Choose a plan.'; end if;
  if p.kind <> c.kind then raise exception 'VALIDATION: That plan is for % books.', lower(p.kind); end if;
  if p_cycle not in ('MONTH', 'YEAR') then raise exception 'VALIDATION: Choose monthly or yearly.'; end if;
  v_amount := case when p_cycle = 'YEAR' then p.price_year else p.price_month end;
  if v_amount <= 0 then raise exception 'VALIDATION: This plan is free — nothing to pay.'; end if;
  v_gw := public._platform_setting('billing.gateway') #>> '{}';
  v_mode := coalesce(public._platform_setting('billing.mode') #>> '{}', 'SANDBOX');
  if v_gw is null then raise exception 'BILLING_OFF: Online payment isn''t switched on yet. Contact Zycount to pay by transfer.'; end if;
  if (select count(*) from public.payments where company_id = p_company and status = 'PENDING' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'LIMIT: Too many unfinished payments. Finish or wait for one before starting another.';
  end if;
  insert into public.payments (company_id, plan_code, billing_cycle, amount, gateway, mode, created_by)
  values (p_company, p.code, p_cycle, v_amount, v_gw, v_mode, auth.uid()) returning id into v_id;
  perform public._audit(p_company, 'billing.checkout', 'Payment', v_id::text,
    format('Started paying for the %s plan (%s), RM %s', p.name, lower(p_cycle) || 'ly', to_char(v_amount, 'FM999,990.00')));
  return jsonb_build_object('payment_id', v_id, 'amount', v_amount, 'currency', 'MYR', 'gateway', v_gw, 'mode', v_mode,
    'plan_code', p.code, 'plan_name', p.name, 'billing_cycle', p_cycle, 'company_name', c.name,
    'email', coalesce((select email from public.profiles where id = auth.uid()), c.email),
    'payer_name', coalesce((select nullif(full_name, '') from public.profiles where id = auth.uid()), c.name),
    'phone', c.phone, 'app_url', public._platform_setting('app.url') #>> '{}');
end $$;

/** True when the caller may look at this payment. */
create or replace function public.billing_payment_access(p_payment uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare y public.payments;
begin
  select * into y from public.payments where id = p_payment;
  if not found then raise exception 'NOT_FOUND: That payment isn''t on record.'; end if;
  perform public._require_perm(y.company_id, 'company.view');
  return jsonb_build_object('id', y.id, 'company_id', y.company_id, 'status', y.status, 'gateway', y.gateway, 'mode', y.mode, 'gateway_ref', y.gateway_ref);
end $$;

-- Service-role helpers used by the billing edge function.
create or replace function public._billing_payment(p_payment uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(y) from public.payments y where y.id = p_payment;
$$;

create or replace function public._billing_payment_by_ref(p_gateway text, p_ref text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(y) from public.payments y where y.gateway = p_gateway and y.gateway_ref = p_ref;
$$;

create or replace function public._billing_attach(p_payment uuid, p_ref text, p_url text)
returns void language sql security definer set search_path = public as $$
  update public.payments set gateway_ref = p_ref, pay_url = p_url where id = p_payment and status = 'PENDING';
$$;

/** Marks a payment paid and extends the subscription. Safe to call twice. */
create or replace function public._billing_mark_paid(p_payment uuid, p_amount numeric, p_raw jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare y public.payments; s public.subscriptions; v_start timestamptz; v_end timestamptz; v_name text;
begin
  select * into y from public.payments where id = p_payment for update;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment; end if;
  if y.status = 'PAID' then return jsonb_build_object('status', 'PAID', 'already', true); end if;
  if p_amount is not null and round(p_amount, 2) <> y.amount then
    update public.payments set raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('amount_mismatch', p_raw) where id = y.id;
    raise exception 'AMOUNT_MISMATCH: paid % but expected %', p_amount, y.amount;
  end if;
  select * into s from public.subscriptions where company_id = y.company_id for update;
  v_start := greatest(now(), coalesce(case when s.status = 'ACTIVE' then s.current_period_end end, now()));
  v_end := v_start + case when y.billing_cycle = 'YEAR' then interval '1 year' else interval '1 month' end;
  update public.payments set status = 'PAID', paid_at = now(), period_start = v_start, period_end = v_end,
         raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('paid', p_raw) where id = y.id;
  insert into public.subscriptions (company_id, plan_code, status, billing_cycle, current_period_end, updated_at)
  values (y.company_id, y.plan_code, 'ACTIVE', y.billing_cycle, v_end, now())
  on conflict (company_id) do update set plan_code = excluded.plan_code, status = 'ACTIVE', billing_cycle = excluded.billing_cycle,
    current_period_end = excluded.current_period_end, updated_at = now();
  select name into v_name from public.plans where code = y.plan_code;
  insert into public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, summary, metadata)
  values (y.company_id, null, 'billing@zycount', 'billing.paid', 'Payment', y.id::text,
    format('Paid RM %s for the %s plan — active until %s', to_char(y.amount, 'FM999,990.00'), v_name, to_char(v_end at time zone 'Asia/Kuala_Lumpur', 'DD Mon YYYY')),
    jsonb_build_object('gateway', y.gateway, 'ref', y.gateway_ref));
  return jsonb_build_object('status', 'PAID', 'already', false, 'period_end', v_end);
end $$;

create or replace function public._billing_mark_failed(p_payment uuid, p_status text, p_raw jsonb)
returns void language sql security definer set search_path = public as $$
  update public.payments set status = case when p_status in ('FAILED', 'CANCELLED') then p_status else 'FAILED' end,
         raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('failed', p_raw)
   where id = p_payment and status = 'PENDING';
$$;

-- Platform admin: every book's plan, every payment, and a manual override.
create or replace function public.admin_subscriptions()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_platform_admin();
  return jsonb_build_object(
    'books', coalesce((select jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.name, 'kind', c.kind,
        'plan_code', s.plan_code, 'status', public._subscription_state(s), 'trial_ends_at', s.trial_ends_at,
        'current_period_end', s.current_period_end, 'billing_cycle', s.billing_cycle, 'note', s.note) order by c.name)
      from public.companies c left join public.subscriptions s on s.company_id = c.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'company', c.name, 'plan_code', y.plan_code,
        'billing_cycle', y.billing_cycle, 'amount', y.amount, 'gateway', y.gateway, 'mode', y.mode, 'gateway_ref', y.gateway_ref,
        'status', y.status, 'paid_at', y.paid_at, 'created_at', y.created_at) order by y.created_at desc)
      from (select * from public.payments order by created_at desc limit 200) y join public.companies c on c.id = y.company_id), '[]'::jsonb),
    'revenue_30d', coalesce((select sum(amount) from public.payments where status = 'PAID' and mode = 'LIVE' and paid_at > now() - interval '30 days'), 0));
end $$;

create or replace function public.admin_set_subscription(p_company uuid, p_plan text, p_status text, p_until timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._require_platform_admin();
  if not exists (select 1 from public.plans where code = p_plan) then raise exception 'VALIDATION: Unknown plan.'; end if;
  if p_status not in ('TRIAL', 'ACTIVE', 'CANCELLED', 'FREE') then raise exception 'VALIDATION: Unknown status.'; end if;
  insert into public.subscriptions (company_id, plan_code, status, trial_ends_at, current_period_end, note, updated_at)
  values (p_company, p_plan, p_status, case when p_status = 'TRIAL' then p_until end, case when p_status = 'ACTIVE' then p_until end, nullif(btrim(p_note), ''), now())
  on conflict (company_id) do update set plan_code = excluded.plan_code, status = excluded.status,
    trial_ends_at = case when excluded.status = 'TRIAL' then excluded.trial_ends_at else subscriptions.trial_ends_at end,
    current_period_end = case when excluded.status = 'ACTIVE' then excluded.current_period_end else subscriptions.current_period_end end,
    note = excluded.note, updated_at = now();
  perform public._audit(p_company, 'billing.override', 'Subscription', p_company::text,
    format('A Zycount administrator set the plan to %s (%s)%s', p_plan, lower(p_status), coalesce(' until ' || to_char(p_until at time zone 'Asia/Kuala_Lumpur', 'DD Mon YYYY'), '')));
  perform public._platform_log('subscription.set', jsonb_build_object('company_id', p_company, 'plan', p_plan, 'status', p_status, 'until', p_until));
  return jsonb_build_object('ok', true);
end $$;

-- ═══ 3. Plan limits: automatic reads and users ══════════════════════════════
create or replace function public.begin_attachment_scan(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_a public.attachments; v_c public.companies; v_today int; v_this int; v_plan public.plans;
begin
  select * into v_a from public.attachments where id = p_id;
  if not found then raise exception 'NOT_FOUND: That file isn''t on record.'; end if;
  perform public._require_perm(v_a.company_id, 'journal.create');
  v_plan := public._company_plan(v_a.company_id);
  select count(*) into v_today from public.attachment_scans
   where company_id = v_a.company_id and requested_at > now() - interval '24 hours' and engine is distinct from 'pdf-text';
  if v_today >= coalesce(v_plan.scan_daily, 300) then
    raise exception 'LIMIT: These books have used today''s % automatic reads on the % plan. Key it in by hand, try again tomorrow, or upgrade in Plan & billing.',
      coalesce(v_plan.scan_daily, 300), coalesce(v_plan.name, 'current');
  end if;
  select count(*) into v_this from public.attachment_scans where attachment_id = p_id and engine is distinct from 'pdf-text';
  if v_this >= 5 then raise exception 'LIMIT: This file has been read 5 times already. Key it in by hand.'; end if;
  insert into public.attachment_scans (attachment_id, company_id) values (p_id, v_a.company_id);
  select * into v_c from public.companies where id = v_a.company_id;
  return jsonb_build_object('path', v_a.path, 'mime', v_a.mime, 'file_name', v_a.file_name,
    'company', jsonb_build_object('name', v_c.name, 'registration_no', v_c.registration_no,
      'tax_registration_no', v_c.tax_registration_no, 'kind', v_c.kind),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'type', a.type) order by a.code)
      from public.accounts a where a.company_id = v_a.company_id and a.is_postable and a.is_active
        and not a.is_control and not a.is_cash and a.type in ('EXPENSE', 'COST_OF_SALES', 'ASSET', 'REVENUE')), '[]'::jsonb));
end $$;

/** Raises when the plan's user limit is reached (members + open invites). */
create or replace function public._check_user_limit(p_company uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_plan public.plans; v_n int;
begin
  v_plan := public._company_plan(p_company);
  if v_plan.max_users is null then return; end if;
  select (select count(*) from public.company_members m where m.company_id = p_company
            and not exists (select 1 from public.platform_admins a where a.user_id = m.user_id))
       + (select count(*) from public.company_invites i where i.company_id = p_company
            and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
    into v_n;
  if v_n >= v_plan.max_users then
    raise exception 'LIMIT: The % plan allows % user%. Upgrade in Plan & billing, or cancel an open invite.',
      v_plan.name, v_plan.max_users, case when v_plan.max_users = 1 then '' else 's' end;
  end if;
end $$;

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
  -- A platform admin setting up a client's books may invite the owner past the limit.
  if not public.is_platform_admin() then perform public._check_user_limit(p_company); end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.company_invites (company_id, role, token_hash, note, created_by)
  values (p_company, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;
  perform public._audit(p_company, 'user.invite', 'Invite', v_id::text,
    format('Created an invite link for the %s role%s', p_role, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
  return v_token;
end $$;

-- ═══ 4. Idempotent money-moving calls (audit R3) ════════════════════════════
-- The browser sends one request id per submit attempt and re-sends the same id
-- when it retries. The first call's result is stored with the id in the same
-- transaction, so a retry after a timeout, or a double click, returns that
-- result instead of posting twice. A call that fails stores nothing.
create table if not exists public.idempotency_keys (
  user_id     uuid not null,
  request_id  uuid not null,
  fn          text not null,
  result      jsonb,
  created_at  timestamptz not null default now(),
  primary key (user_id, request_id)
);
create index if not exists idempotency_keys_created_idx on public.idempotency_keys (created_at);
alter table public.idempotency_keys enable row level security;
revoke all on table public.idempotency_keys from anon, authenticated;

create or replace function public.idem_call(p_request_id uuid, p_fn text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_prev public.idempotency_keys; v_oid oid; v_sql text; v_result jsonb; v_n int;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Sign in again.'; end if;
  if p_request_id is null then raise exception 'VALIDATION: Missing request id.'; end if;
  if p_fn not in ('save_trade_doc', 'record_cash_entry', 'record_transaction', 'post_contra', 'settle_from_bank_line') then
    raise exception 'VALIDATION: % can''t be called this way.', p_fn;
  end if;
  insert into public.idempotency_keys (user_id, request_id, fn) values (v_uid, p_request_id, p_fn) on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- Another call with this id finished first (we waited for it on the unique key).
    select * into v_prev from public.idempotency_keys where user_id = v_uid and request_id = p_request_id;
    if v_prev.fn <> p_fn then raise exception 'VALIDATION: That request id was used for something else.'; end if;
    return v_prev.result;
  end if;
  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_fn;
  select string_agg(format('%I => %s', a.name,
           case when a.typ = 'jsonb'::regtype then format('nullif($1->%L, ''null''::jsonb)', a.name)
                else format('($1->>%L)::%s', a.name, format_type(a.typ, null)) end), ', ')
    into v_sql
    from unnest((select proargnames from pg_proc where oid = v_oid), (select proargtypes::oid[] from pg_proc where oid = v_oid)) as a(name, typ)
   where p_args ? a.name;
  execute format('select to_jsonb(public.%I(%s))', p_fn, coalesce(v_sql, '')) using p_args into v_result;
  update public.idempotency_keys set result = v_result where user_id = v_uid and request_id = p_request_id;
  delete from public.idempotency_keys where created_at < now() - interval '7 days';
  return v_result;
end $$;

-- ═══ 5. Privileges ═══════════════════════════════════════════════════════════
revoke execute on function
  public._require_platform_admin(), public._platform_log(text, jsonb), public._platform_setting(text), public._platform_secret(text),
  public._subscription_for_new_company(), public._company_plan(uuid), public._subscription_state(public.subscriptions),
  public._billing_payment(uuid), public._billing_payment_by_ref(text, text), public._billing_attach(uuid, text, text),
  public._billing_mark_paid(uuid, numeric, jsonb), public._billing_mark_failed(uuid, text, jsonb), public._check_user_limit(uuid),
  public.platform_secrets_list(), public.platform_secret_set(text, text), public.platform_settings_get(), public.platform_setting_set(text, jsonb),
  public.billing_config(), public.my_subscription(uuid), public.billing_begin(uuid, text, text), public.billing_payment_access(uuid),
  public.admin_subscriptions(), public.admin_set_subscription(uuid, text, text, timestamptz, text), public.idem_call(uuid, text, jsonb),
  public.begin_attachment_scan(uuid), public.create_invite(uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.platform_secrets_list(), public.platform_secret_set(text, text), public.platform_settings_get(), public.platform_setting_set(text, jsonb),
  public.billing_config(), public.my_subscription(uuid), public.billing_begin(uuid, text, text), public.billing_payment_access(uuid),
  public.admin_subscriptions(), public.admin_set_subscription(uuid, text, text, timestamptz, text), public.idem_call(uuid, text, jsonb),
  public.begin_attachment_scan(uuid), public.create_invite(uuid, text, text)
to authenticated;

grant execute on function
  public._platform_secret(text), public._platform_setting(text), public._billing_payment(uuid), public._billing_payment_by_ref(text, text),
  public._billing_attach(uuid, text, text), public._billing_mark_paid(uuid, numeric, jsonb), public._billing_mark_failed(uuid, text, jsonb),
  public.billing_config()
to service_role;
