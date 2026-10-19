-- LHDN MyInvois e-Invoice. Each business book connects its own MyInvois ERP credentials
-- (client ID + secret, issued by LHDN to the taxpayer). The secret goes straight into
-- Supabase Vault and is only ever decrypted by the myinvois edge function (service role).
-- Invoices, cash sales, credit notes and debit notes are submitted as UBL 2.1 JSON v1.0.

create table public.einvoice_settings (
  company_id        uuid primary key references public.companies(id) on delete cascade,
  environment       text not null default 'SANDBOX' check (environment in ('SANDBOX', 'PRODUCTION')),
  client_id         text check (length(client_id) <= 100),
  secret_id         uuid,                       -- vault.secrets id; never exposed
  tin               text check (length(tin) <= 20),
  sst_no            text check (length(sst_no) <= 35),
  ttx_no            text check (length(ttx_no) <= 17),
  msic_code         text check (msic_code ~ '^[0-9]{5}$'),
  activity          text check (length(activity) <= 300),
  address_line      text check (length(address_line) <= 300),
  postcode          text check (length(postcode) <= 10),
  city              text check (length(city) <= 50),
  state_code        text check (state_code ~ '^[0-9]{2}$'),
  auto_submit       boolean not null default false,
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);
alter table public.einvoice_settings enable row level security;
-- No select policy: read through einvoice_settings_get(), which never returns the secret.

-- Access tokens are cached for the hour they are valid; only the edge function reads them.
create table public.einvoice_tokens (
  company_id   uuid primary key references public.companies(id) on delete cascade,
  environment  text not null,
  access_token text not null,
  expires_at   timestamptz not null
);
alter table public.einvoice_tokens enable row level security;

-- Every submission, status check and cancellation, as LHDN answered it.
create table public.einvoice_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  doc_id         uuid not null references public.trade_docs(id) on delete cascade,
  action         text not null check (action in ('SUBMIT', 'STATUS', 'CANCEL')),
  environment    text not null,
  submission_uid text,
  uuid           text,
  long_id        text,
  status         text,
  errors         jsonb,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index einvoice_events_doc_idx on public.einvoice_events(doc_id, created_at desc);
create index einvoice_events_company_idx on public.einvoice_events(company_id);
alter table public.einvoice_events enable row level security;
create policy "einvoice events by permission" on public.einvoice_events for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));

-- Tax type per code: 01 sales tax, 02 service tax, 06 not applicable, E exempt.
alter table public.tax_codes add column einvoice_tax_type text check (einvoice_tax_type in ('01', '02', '03', '04', '05', '06', 'E'));
update public.tax_codes set einvoice_tax_type = case when code like 'SV%' then '02' when code like 'ST%' then '01' end
 where einvoice_tax_type is null;

-- ─── Settings ───────────────────────────────────────────────────────────────
create or replace function public.einvoice_settings_get(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v public.einvoice_settings; v_c public.companies;
begin
  perform public._require_perm(p_company, 'company.view');
  select * into v_c from public.companies where id = p_company;
  select * into v from public.einvoice_settings where company_id = p_company;
  return jsonb_build_object(
    'environment', coalesce(v.environment, 'SANDBOX'), 'client_id', v.client_id, 'has_secret', v.secret_id is not null,
    'tin', v.tin, 'brn', v_c.registration_no, 'sst_no', coalesce(v.sst_no, v_c.tax_registration_no), 'ttx_no', v.ttx_no,
    'msic_code', v.msic_code, 'activity', v.activity, 'address_line', coalesce(v.address_line, v_c.address),
    'postcode', v.postcode, 'city', v.city, 'state_code', v.state_code, 'email', v_c.email, 'phone', v_c.phone,
    'auto_submit', coalesce(v.auto_submit, false), 'updated_at', v.updated_at,
    'connected', v.client_id is not null and v.secret_id is not null);
end $$;

create or replace function public.save_einvoice_settings(p_company uuid, p_data jsonb, p_client_secret text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old public.einvoice_settings; v_secret uuid; v_kind text; v_env text; v_secret_txt text := nullif(btrim(p_client_secret), '');
begin
  perform public._require_perm(p_company, 'company.edit');
  select kind into v_kind from public.companies where id = p_company;
  if v_kind is distinct from 'BUSINESS' then raise exception 'VALIDATION: e-Invoice is for business books.'; end if;
  v_env := upper(coalesce(nullif(btrim(p_data->>'environment'), ''), 'SANDBOX'));
  if v_env not in ('SANDBOX', 'PRODUCTION') then raise exception 'VALIDATION: Choose sandbox or production.'; end if;
  if nullif(btrim(p_data->>'tin'), '') is not null and upper(btrim(p_data->>'tin')) !~ '^(C|IG|D|E|F|FA|PT|TA|TC|TN|TR|TP|J|LE|EI)[0-9]{6,14}$' then
    raise exception 'VALIDATION: That TIN does not look right — e.g. C20880050010 for a company, IG… for an individual.';
  end if;
  if nullif(btrim(p_data->>'msic_code'), '') is not null and btrim(p_data->>'msic_code') !~ '^[0-9]{5}$' then
    raise exception 'VALIDATION: The MSIC code is 5 digits, e.g. 62010.';
  end if;
  if nullif(btrim(p_data->>'state_code'), '') is not null and btrim(p_data->>'state_code') !~ '^[0-9]{2}$' then
    raise exception 'VALIDATION: Choose the state.';
  end if;
  if v_secret_txt is not null and length(v_secret_txt) > 200 then raise exception 'VALIDATION: That client secret is too long.'; end if;

  select * into v_old from public.einvoice_settings where company_id = p_company for update;
  v_secret := v_old.secret_id;
  if v_secret_txt is not null then
    if v_secret is null then
      v_secret := vault.create_secret(v_secret_txt, 'myinvois-' || p_company::text, 'MyInvois client secret');
    else
      perform vault.update_secret(v_secret, v_secret_txt);
    end if;
  end if;

  insert into public.einvoice_settings as s (company_id, environment, client_id, secret_id, tin, sst_no, ttx_no, msic_code, activity,
                                             address_line, postcode, city, state_code, auto_submit, updated_at, updated_by)
  values (p_company, v_env, nullif(btrim(p_data->>'client_id'), ''), v_secret, upper(nullif(btrim(p_data->>'tin'), '')),
          nullif(btrim(p_data->>'sst_no'), ''), nullif(btrim(p_data->>'ttx_no'), ''), nullif(btrim(p_data->>'msic_code'), ''),
          left(nullif(btrim(p_data->>'activity'), ''), 300), left(nullif(btrim(p_data->>'address_line'), ''), 300),
          nullif(btrim(p_data->>'postcode'), ''), nullif(btrim(p_data->>'city'), ''), nullif(btrim(p_data->>'state_code'), ''),
          coalesce((p_data->>'auto_submit')::boolean, false), now(), auth.uid())
  on conflict (company_id) do update set environment = excluded.environment, client_id = excluded.client_id, secret_id = excluded.secret_id,
    tin = excluded.tin, sst_no = excluded.sst_no, ttx_no = excluded.ttx_no, msic_code = excluded.msic_code, activity = excluded.activity,
    address_line = excluded.address_line, postcode = excluded.postcode, city = excluded.city, state_code = excluded.state_code,
    auto_submit = excluded.auto_submit, updated_at = now(), updated_by = auth.uid();
  -- A new secret or environment means a new token.
  if v_secret_txt is not null or v_env is distinct from v_old.environment or nullif(btrim(p_data->>'client_id'), '') is distinct from v_old.client_id then
    delete from public.einvoice_tokens where company_id = p_company;
  end if;
  perform public._audit(p_company, 'einvoice.settings', 'Company', p_company::text,
    format('Updated e-Invoice settings (%s)%s', lower(v_env), case when v_secret_txt is not null then ' with a new client secret' else '' end));
  return public.einvoice_settings_get(p_company);
end $$;

-- ─── What the edge function needs ───────────────────────────────────────────
-- Everything to build the UBL document, checked for what LHDN will reject. Called with
-- the person's own token, so their permission is enforced.
create or replace function public.einvoice_payload(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_d public.trade_docs; v_s public.einvoice_settings; v_co public.companies; v_c public.contacts; v_orig public.trade_docs;
        v_missing text[] := '{}'; v_type text;
begin
  select * into v_d from public.trade_docs where id = p_doc;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v_d.company_id, 'journal.post');
  v_type := case v_d.doc_type when 'INVOICE' then '01' when 'CASH_SALE' then '01' when 'CREDIT_NOTE' then '02' when 'DEBIT_NOTE' then '03' end;
  if v_type is null then raise exception 'VALIDATION: Only invoices, cash sales, credit notes and debit notes go to MyInvois.'; end if;
  if v_d.status <> 'POSTED' then raise exception 'INVALID_STATE: Post the document before sending it to LHDN.'; end if;
  select * into v_co from public.companies where id = v_d.company_id;
  select * into v_s from public.einvoice_settings where company_id = v_d.company_id;
  if v_s.client_id is null or v_s.secret_id is null then
    raise exception 'EINVOICE_NOT_CONNECTED: Connect MyInvois first — Settings → e-Invoice, with the client ID and secret from your MyInvois portal.';
  end if;
  if v_s.tin is null then v_missing := array_append(v_missing, 'your TIN'::text); end if;
  if v_co.registration_no is null then v_missing := array_append(v_missing, 'your registration no.'::text); end if;
  if v_s.msic_code is null then v_missing := array_append(v_missing, 'your MSIC code'::text); end if;
  if v_s.activity is null then v_missing := array_append(v_missing, 'your business activity'::text); end if;
  if coalesce(v_s.address_line, v_co.address) is null or v_s.city is null or v_s.state_code is null then v_missing := array_append(v_missing, 'your full address'::text); end if;
  if v_co.phone is null then v_missing := array_append(v_missing, 'your phone number'::text); end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'VALIDATION: Add % in Settings → e-Invoice first.', array_to_string(v_missing, ', ');
  end if;
  if v_d.contact_id is not null then
    select * into v_c from public.contacts where id = v_d.contact_id;
    if v_c.tin is null and coalesce(v_c.country, 'MY') = 'MY' and v_c.reg_no is not null then
      raise exception 'VALIDATION: % has no TIN. Add it on the customer (or leave the registration no. blank to issue to the general public).', v_c.name;
    end if;
  end if;
  if v_type in ('02', '03') then
    select * into v_orig from public.trade_docs where id = v_d.source_doc_id;
    if v_orig.id is null or v_orig.einvoice_uuid is null or v_orig.einvoice_status not in ('VALID', 'SUBMITTED') then
      raise exception 'VALIDATION: A % must point to an invoice already validated by LHDN. Raise it from that invoice, and submit the invoice first.',
        case v_type when '02' then 'credit note' else 'debit note' end;
    end if;
  end if;
  if v_d.einvoice_status in ('VALID', 'SUBMITTED') then
    raise exception 'INVALID_STATE: % is already with LHDN (%).', v_d.doc_no, lower(v_d.einvoice_status);
  end if;

  return jsonb_build_object(
    'type', v_type, 'environment', v_s.environment,
    'doc', to_jsonb(v_d),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'qty', l.qty, 'uom', l.uom,
                 'unit_price', l.unit_price, 'discount', l.discount, 'amount', l.amount, 'tax_amount', l.tax_amount, 'total', l.total,
                 'tax_rate', l.tax_rate, 'tax_code', t.code, 'tax_type', coalesce(t.einvoice_tax_type, case when coalesce(l.tax_rate, 0) = 0 then '06' end),
                 'classification', coalesce(nullif(i.classification, ''), '022')) order by l.line_no)
               from public.trade_doc_lines l left join public.tax_codes t on t.id = l.tax_code_id left join public.items i on i.id = l.item_id
               where l.doc_id = p_doc), '[]'::jsonb),
    'supplier', jsonb_build_object('name', v_co.name, 'tin', v_s.tin, 'brn', v_co.registration_no,
                 'sst', coalesce(v_s.sst_no, v_co.tax_registration_no), 'ttx', v_s.ttx_no, 'msic', v_s.msic_code, 'activity', v_s.activity,
                 'address', coalesce(v_s.address_line, v_co.address), 'postcode', v_s.postcode, 'city', v_s.city, 'state', v_s.state_code,
                 'phone', v_co.phone, 'email', v_co.email),
    'buyer', case when v_c.id is null then null else to_jsonb(v_c) end,
    'original', case when v_orig.id is null then null else jsonb_build_object('doc_no', v_orig.doc_no, 'uuid', v_orig.einvoice_uuid) end);
end $$;

-- Who may act on a document's e-Invoice, and in which environment. The edge function
-- calls this with the person's token before using the service role.
create or replace function public.einvoice_doc_access(p_doc uuid, p_perm text default 'journal.post')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_d public.trade_docs; v_env text;
begin
  select * into v_d from public.trade_docs where id = p_doc;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v_d.company_id, case when p_perm in ('journal.post', 'journal.reverse', 'journal.view') then p_perm else 'journal.post' end);
  select environment into v_env from public.einvoice_settings where company_id = v_d.company_id;
  return jsonb_build_object('company_id', v_d.company_id, 'doc_no', v_d.doc_no, 'uuid', v_d.einvoice_uuid,
    'status', v_d.einvoice_status, 'environment', coalesce(v_env, 'SANDBOX'));
end $$;

create or replace function public.einvoice_company_access(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_env text;
begin
  perform public._require_perm(p_company, 'journal.view');
  select environment into v_env from public.einvoice_settings where company_id = p_company;
  return jsonb_build_object('company_id', p_company, 'environment', coalesce(v_env, 'SANDBOX'));
end $$;

-- Service role only: the decrypted credentials.
create or replace function public._einvoice_credentials(p_company uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('client_id', s.client_id, 'client_secret', d.decrypted_secret, 'environment', s.environment)
  from public.einvoice_settings s left join vault.decrypted_secrets d on d.id = s.secret_id
  where s.company_id = p_company;
$$;

-- Service role only: record what LHDN said, keep the document's status in step.
create or replace function public._einvoice_record(p_doc uuid, p_action text, p_env text, p_result jsonb, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_d public.trade_docs; v_status text := nullif(p_result->>'status', '');
begin
  select * into v_d from public.trade_docs where id = p_doc for update;
  if not found then return; end if;
  insert into public.einvoice_events (company_id, doc_id, action, environment, submission_uid, uuid, long_id, status, errors, created_by)
  values (v_d.company_id, p_doc, p_action, p_env, p_result->>'submission_uid', p_result->>'uuid', p_result->>'long_id', v_status,
          p_result->'errors', p_user);
  if v_status in ('PENDING', 'SUBMITTED', 'VALID', 'INVALID', 'CANCELLED') then
    update public.trade_docs set einvoice_status = v_status, einvoice_uuid = coalesce(p_result->>'uuid', einvoice_uuid) where id = p_doc;
  end if;
  perform public._audit(v_d.company_id, 'einvoice.' || lower(p_action), 'TradeDoc', p_doc::text,
    format('e-Invoice %s %s: %s%s', lower(p_action), v_d.doc_no, coalesce(lower(v_status), 'no answer'),
           case when p_env = 'SANDBOX' then ' (sandbox)' else '' end));
end $$;

-- The latest LHDN answer per document, for the document page.
create or replace function public.einvoice_doc_status(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_d public.trade_docs; v_e public.einvoice_events; v_ok public.einvoice_events;
begin
  select * into v_d from public.trade_docs where id = p_doc;
  if not found then raise exception 'NOT_FOUND: Document not found.'; end if;
  perform public._require_perm(v_d.company_id, 'journal.view');
  select * into v_e from public.einvoice_events where doc_id = p_doc order by created_at desc limit 1;
  select * into v_ok from public.einvoice_events where doc_id = p_doc and long_id is not null order by created_at desc limit 1;
  return jsonb_build_object('status', v_d.einvoice_status, 'uuid', v_d.einvoice_uuid, 'long_id', v_ok.long_id,
    'environment', coalesce(v_e.environment, (select environment from public.einvoice_settings where company_id = v_d.company_id), 'SANDBOX'),
    'errors', v_e.errors, 'last_at', v_e.created_at,
    'submitted_at', (select min(created_at) from public.einvoice_events where doc_id = p_doc and action = 'SUBMIT' and uuid = v_d.einvoice_uuid),
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', x.action, 'status', x.status, 'at', x.created_at) order by x.created_at desc)
                        from (select * from public.einvoice_events where doc_id = p_doc order by created_at desc limit 10) x), '[]'::jsonb));
end $$;

revoke all on table public.einvoice_settings, public.einvoice_tokens from anon, authenticated;
revoke execute on function public._einvoice_credentials(uuid), public._einvoice_record(uuid, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public._einvoice_credentials(uuid), public._einvoice_record(uuid, text, text, jsonb, uuid) to service_role;
grant select, insert, update, delete on table public.einvoice_tokens to service_role;
revoke execute on function public.einvoice_settings_get(uuid), public.save_einvoice_settings(uuid, jsonb, text),
  public.einvoice_payload(uuid), public.einvoice_doc_access(uuid, text), public.einvoice_company_access(uuid),
  public.einvoice_doc_status(uuid) from public, anon;
grant execute on function public.einvoice_settings_get(uuid), public.save_einvoice_settings(uuid, jsonb, text),
  public.einvoice_payload(uuid), public.einvoice_doc_access(uuid, text), public.einvoice_company_access(uuid),
  public.einvoice_doc_status(uuid) to authenticated;
