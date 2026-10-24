-- Source documents: photos, scans and PDFs of receipts, bills, payment slips,
-- cheques and transfer screenshots, kept as evidence beside the entry they
-- support. Files live in the private `attachments` bucket under
-- <company_id>/<yyyy>/<mm>/<uuid>.<ext>; this table is the register.
-- A file can be read by anyone who can view the books, added by anyone who
-- can create entries, and never changed. Once it backs a posted document it
-- can only be detached by someone who may reverse journals, and every step
-- is in the audit trail.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.attachments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  path         text not null unique check (length(path) between 10 and 300),
  file_name    text not null check (length(file_name) between 1 and 200),
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   int not null check (size_bytes between 1 and 10485760),
  sha256       text check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by  uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  status       text not null default 'NEW' check (status in ('NEW', 'SCANNED', 'RECORDED')),
  scan         jsonb check (scan is null or pg_column_size(scan) < 65536),
  scan_engine  text check (scan_engine is null or length(scan_engine) <= 60),
  scanned_at   timestamptz,
  entity_type  text check (entity_type in ('JOURNAL', 'TRADE_DOC')),
  entity_id    uuid,
  linked_at    timestamptz,
  linked_by    uuid,
  note         text check (note is null or length(note) <= 500),
  check ((entity_type is null) = (entity_id is null))
);
create index attachments_company_idx on public.attachments(company_id, created_at desc);
create index attachments_entity_idx on public.attachments(entity_id);
create index attachments_sha_idx on public.attachments(company_id, sha256);
alter table public.attachments enable row level security;
create policy "attachments by permission" on public.attachments for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));

create policy "attachments: read with the books" on storage.objects for select to authenticated
  using (bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (select c::text from public.companies_with_perm('journal.view') c));

create policy "attachments: add when you can create entries" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (select c::text from public.companies_with_perm('journal.create') c));

-- Only the uploader removes a file, and only once it is off the register
-- (delete_attachment clears the row first; an upload whose registration
-- failed can also be cleaned up).
create policy "attachments: uploader removes unregistered files" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and owner_id = auth.uid()::text
    and not exists (select 1 from public.attachments a where a.path = objects.name));

-- Every automatic read, for the daily allowance and the record.
create table public.attachment_scans (
  id            bigint generated always as identity primary key,
  attachment_id uuid not null references public.attachments(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  user_id       uuid default auth.uid(),
  requested_at  timestamptz not null default now(),
  engine        text,
  ok            boolean not null default false
);
create index attachment_scans_company_idx on public.attachment_scans(company_id, requested_at desc);
create index attachment_scans_attachment_idx on public.attachment_scans(attachment_id);
alter table public.attachment_scans enable row level security;
create policy "attachment scans by permission" on public.attachment_scans for select to authenticated
  using (company_id in (select public.companies_with_perm('journal.view')));

-- What an attachment is linked to, in words.
create or replace function public._attachment_target(p_type text, p_id uuid)
returns table (company_id uuid, label text, posted boolean)
language sql stable security definer set search_path = public as $$
  select j.company_id, coalesce(j.doc_no, j.reference, 'Journal'), j.status <> 'DRAFT'
  from public.journal_entries j where p_type = 'JOURNAL' and j.id = p_id
  union all
  select d.company_id, coalesce(d.doc_no, 'Draft'), d.status <> 'DRAFT'
  from public.trade_docs d where p_type = 'TRADE_DOC' and d.id = p_id;
$$;

create or replace function public.register_attachment(p_company uuid, p_path text, p_file_name text, p_mime text,
                                                      p_size int, p_sha256 text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_dup public.attachments; v_label text;
begin
  perform public._require_perm(p_company, 'journal.create');
  if p_path is null or split_part(p_path, '/', 1) <> p_company::text then
    raise exception 'VALIDATION: That file isn''t stored under these books.';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name = p_path) then
    raise exception 'NOT_FOUND: The upload didn''t finish. Try again.';
  end if;
  select * into v_dup from public.attachments a
   where a.company_id = p_company and a.sha256 = lower(p_sha256) and p_sha256 is not null
   order by a.created_at limit 1;
  insert into public.attachments (company_id, path, file_name, mime, size_bytes, sha256)
  values (p_company, p_path, left(coalesce(nullif(btrim(p_file_name), ''), 'document'), 200), p_mime, p_size, lower(p_sha256))
  returning id into v_id;
  perform public._audit(p_company, 'attachment.add', 'attachment', v_id::text, 'Added ' || left(coalesce(p_file_name, 'document'), 120),
    jsonb_build_object('size', p_size, 'mime', p_mime, 'duplicate_of', v_dup.id));
  if v_dup.id is not null and v_dup.entity_id is not null then
    select t.label into v_label from public._attachment_target(v_dup.entity_type, v_dup.entity_id) t;
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', case when v_dup.id is null then null else jsonb_build_object(
    'id', v_dup.id, 'file_name', v_dup.file_name, 'created_at', v_dup.created_at,
    'entity_type', v_dup.entity_type, 'entity_id', v_dup.entity_id, 'label', v_label) end);
end $$;

-- Called by the scan-document function before it spends anything: checks the
-- role and the daily allowance, and hands back what the reader needs to know.
create or replace function public.begin_attachment_scan(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_a public.attachments; v_c public.companies; v_today int; v_this int;
begin
  select * into v_a from public.attachments where id = p_id;
  if not found then raise exception 'NOT_FOUND: That file isn''t on record.'; end if;
  perform public._require_perm(v_a.company_id, 'journal.create');
  select count(*) into v_today from public.attachment_scans
   where company_id = v_a.company_id and requested_at > now() - interval '24 hours' and engine is distinct from 'pdf-text';
  if v_today >= 300 then
    raise exception 'LIMIT: These books have used today''s 300 automatic reads. Key it in by hand or try again tomorrow.';
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

create or replace function public.save_attachment_scan(p_id uuid, p_scan jsonb, p_engine text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_a public.attachments;
begin
  select * into v_a from public.attachments where id = p_id;
  if not found then raise exception 'NOT_FOUND: That file isn''t on record.'; end if;
  perform public._require_perm(v_a.company_id, 'journal.create');
  if p_scan is null or jsonb_typeof(p_scan) <> 'object' then raise exception 'VALIDATION: Nothing was read from the file.'; end if;
  if pg_column_size(p_scan) >= 65536 then raise exception 'VALIDATION: The reading is too large to keep.'; end if;
  update public.attachments set scan = p_scan, scan_engine = left(p_engine, 60), scanned_at = now(),
    status = case when status = 'NEW' then 'SCANNED' else status end
  where id = p_id;
  if p_engine = 'pdf-text' then
    insert into public.attachment_scans (attachment_id, company_id, engine, ok) values (p_id, v_a.company_id, p_engine, true);
  else
    update public.attachment_scans set engine = left(p_engine, 60), ok = true
     where id = (select max(id) from public.attachment_scans where attachment_id = p_id and not ok);
  end if;
  return jsonb_build_object('id', p_id, 'status', case when v_a.status = 'NEW' then 'SCANNED' else v_a.status end);
end $$;

create or replace function public.link_attachment(p_id uuid, p_entity_type text, p_entity_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_a public.attachments; v_t record;
begin
  select * into v_a from public.attachments where id = p_id;
  if not found then raise exception 'NOT_FOUND: That file isn''t on record.'; end if;
  perform public._require_perm(v_a.company_id, 'journal.create');
  select * into v_t from public._attachment_target(p_entity_type, p_entity_id);
  if v_t.company_id is null or v_t.company_id <> v_a.company_id then
    raise exception 'NOT_FOUND: That entry isn''t in these books.';
  end if;
  if v_a.entity_id = p_entity_id then return jsonb_build_object('id', p_id, 'label', v_t.label); end if;
  if v_a.entity_id is not null then
    raise exception 'VALIDATION: This file already backs another entry. Detach it there first.';
  end if;
  update public.attachments set entity_type = p_entity_type, entity_id = p_entity_id, linked_at = now(),
    linked_by = auth.uid(), status = 'RECORDED' where id = p_id;
  perform public._audit(v_a.company_id, 'attachment.link', 'attachment', p_id::text,
    left(v_a.file_name, 120) || ' attached to ' || v_t.label, jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id));
  return jsonb_build_object('id', p_id, 'label', v_t.label);
end $$;

create or replace function public.unlink_attachment(p_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_a public.attachments; v_t record;
begin
  select * into v_a from public.attachments where id = p_id;
  if not found then raise exception 'NOT_FOUND: That file isn''t on record.'; end if;
  if v_a.entity_id is null then return jsonb_build_object('id', p_id); end if;
  select * into v_t from public._attachment_target(v_a.entity_type, v_a.entity_id);
  -- Evidence behind a posted entry is the audit trail: only those who may
  -- reverse entries can take it off, and they must say why.
  if coalesce(v_t.posted, false) then
    perform public._require_perm(v_a.company_id, 'journal.reverse');
    if nullif(btrim(p_reason), '') is null then
      raise exception 'VALIDATION: Say why this evidence is being detached from a posted entry.';
    end if;
  else
    perform public._require_perm(v_a.company_id, 'journal.create');
  end if;
  update public.attachments set entity_type = null, entity_id = null, linked_at = null, linked_by = null,
    status = case when scan is null then 'NEW' else 'SCANNED' end where id = p_id;
  perform public._audit(v_a.company_id, 'attachment.unlink', 'attachment', p_id::text,
    left(v_a.file_name, 120) || ' detached from ' || coalesce(v_t.label, 'entry') || coalesce(' — ' || left(btrim(p_reason), 200), ''),
    jsonb_build_object('entity_type', v_a.entity_type, 'entity_id', v_a.entity_id));
  return jsonb_build_object('id', p_id);
end $$;

-- Removes a file that backs nothing. Returns its path; the caller then
-- removes the stored object through the Storage API.
create or replace function public.delete_attachment(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_a public.attachments;
begin
  select * into v_a from public.attachments where id = p_id;
  if not found then raise exception 'NOT_FOUND: That file isn''t on record.'; end if;
  if v_a.entity_id is not null then raise exception 'VALIDATION: This file backs an entry. Detach it first.'; end if;
  if v_a.uploaded_by is distinct from auth.uid() then
    perform public._require_perm(v_a.company_id, 'journal.delete');
  else
    perform public._require_perm(v_a.company_id, 'journal.create');
  end if;
  delete from public.attachments where id = p_id;
  perform public._audit(v_a.company_id, 'attachment.delete', 'attachment', p_id::text, 'Deleted ' || left(v_a.file_name, 120), null);
  return jsonb_build_object('id', p_id, 'path', v_a.path, 'own', v_a.uploaded_by = auth.uid());
end $$;

revoke execute on function public._attachment_target(text, uuid) from public, anon, authenticated;
revoke execute on function public.register_attachment(uuid, text, text, text, int, text) from public, anon;
revoke execute on function public.begin_attachment_scan(uuid) from public, anon;
revoke execute on function public.save_attachment_scan(uuid, jsonb, text) from public, anon;
revoke execute on function public.link_attachment(uuid, text, uuid) from public, anon;
revoke execute on function public.unlink_attachment(uuid, text) from public, anon;
revoke execute on function public.delete_attachment(uuid) from public, anon;
grant execute on function public.register_attachment(uuid, text, text, text, int, text) to authenticated;
grant execute on function public.begin_attachment_scan(uuid) to authenticated;
grant execute on function public.save_attachment_scan(uuid, jsonb, text) to authenticated;
grant execute on function public.link_attachment(uuid, text, uuid) to authenticated;
grant execute on function public.unlink_attachment(uuid, text) to authenticated;
grant execute on function public.delete_attachment(uuid) to authenticated;
