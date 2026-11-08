-- Exact row count of every table a restore must bring back.
select format('%I.%I', table_schema, table_name),
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
  from information_schema.tables
 where table_type = 'BASE TABLE'
   and (table_schema = 'public'
        or (table_schema = 'auth' and table_name in ('users', 'identities'))
        or (table_schema = 'storage' and table_name in ('buckets', 'objects')))
 order by 1;
