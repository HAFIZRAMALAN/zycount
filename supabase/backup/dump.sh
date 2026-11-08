#!/usr/bin/env bash
# Dump Zycount's books to OUT_DIR (no encryption here — backup.yml encrypts).
#
#   SRC_URL   Postgres URL of the database to dump. For the hosted project use
#             the *Session pooler* string (GitHub runners have no IPv6).
#   OUT_DIR   where zycount.dump, counts.tsv and manifest.txt are written.
#   Optional, for the uploaded files (receipts, bills):
#   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  → files/<bucket>/<path>
#
# The client is postgres:17 in Docker, so pg_dump always matches the server's
# major version without installing anything on the runner.
set -euo pipefail
: "${SRC_URL:?SRC_URL is not set}"
: "${OUT_DIR:?OUT_DIR is not set}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"

pg() { docker run --rm --network host -v "$OUT_DIR":/out -v "$HERE":/sql:ro -e PGURL="$SRC_URL" "$PG_IMAGE" "$@"; }

# Our schemas only: public (the books), auth (sign-ins), storage (file index),
# supabase_migrations (schema history). Vault is left out on purpose: its
# secrets are encrypted with this project's own key and can't be read anywhere
# else — re-enter API keys after a disaster restore.
pg sh -c 'pg_dump "$PGURL" --format=custom --compress=9 \
  --schema=public --schema=auth --schema=storage --schema=supabase_migrations \
  --file=/out/zycount.dump'

# Row counts straight after the dump, to compare with the restored copy.
pg sh -c 'psql "$PGURL" -X -At -F "	" -v ON_ERROR_STOP=1 -f /sql/counts.sql > /out/counts.tsv'

{
  echo "zycount backup"
  echo "taken_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "server=$(pg sh -c 'psql "$PGURL" -X -At -c "show server_version"')"
  echo "dump_bytes=$(wc -c < "$OUT_DIR/zycount.dump")"
  echo "tables=$(wc -l < "$OUT_DIR/counts.tsv")"
} > "$OUT_DIR/manifest.txt"

# Uploaded files, when a service key is provided.
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  pg sh -c 'psql "$PGURL" -X -At -F "	" -c "select bucket_id, name from storage.objects order by 1, 2"' > "$OUT_DIR/objects.tsv"
  n=0; failed=0
  while IFS=$'\t' read -r bucket name; do
    [ -z "$bucket" ] && continue
    mkdir -p "$OUT_DIR/files/$bucket/$(dirname "$name")"
    enc="$(printf '%s' "$name" | jq -sRr @uri | sed 's/%2F/\//g')"
    if curl -sf --retry 2 -o "$OUT_DIR/files/$bucket/$name" \
         -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
         "$SUPABASE_URL/storage/v1/object/authenticated/$bucket/$enc"; then
      n=$((n + 1))
    else
      failed=$((failed + 1)); echo "could not download $bucket/$name" >&2
    fi
  done < "$OUT_DIR/objects.tsv"
  echo "files=$n files_failed=$failed" >> "$OUT_DIR/manifest.txt"
  [ "$failed" -eq 0 ] || { echo "Some files were not downloaded." >&2; exit 1; }
else
  echo "files=skipped (no SUPABASE_SERVICE_ROLE_KEY)" >> "$OUT_DIR/manifest.txt"
fi

cat "$OUT_DIR/manifest.txt"
