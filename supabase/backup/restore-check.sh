#!/usr/bin/env bash
# Restore drill: load DUMP_DIR/zycount.dump into a brand-new database and prove
# the books came back whole. A backup that has never been restored is a hope,
# not a backup — so every daily backup runs this before it is kept.
#
#   ADMIN_URL    superuser URL of a scratch Postgres (the runner's local
#                Supabase database), e.g. postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres
#   DUMP_DIR     folder from dump.sh (zycount.dump, counts.tsv)
#   STRICT_COUNTS=1  fail on any row-count difference (CI). Otherwise a
#                difference is reported, and only a table that came back
#                empty fails (a write landing between dump and count is fine).
set -euo pipefail
: "${ADMIN_URL:?ADMIN_URL is not set}"
: "${DUMP_DIR:?DUMP_DIR is not set}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
DB="${RESTORE_DB:-zy_restore}"
DUMP_DIR="$(cd "$DUMP_DIR" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET_URL="${ADMIN_URL%/*}/$DB"

pg() { docker run --rm --network host -v "$DUMP_DIR":/in:ro -v "$HERE":/sql:ro -e ADMIN="$ADMIN_URL" -e TARGET="$TARGET_URL" "$PG_IMAGE" "$@"; }

pg sh -c "psql \"\$ADMIN\" -X -v ON_ERROR_STOP=1 -c 'drop database if exists $DB' -c 'create database $DB'"
pg sh -c 'psql "$TARGET" -X -v ON_ERROR_STOP=1 \
  -c "create schema if not exists extensions" \
  -c "create extension if not exists pgcrypto schema extensions" \
  -c "create extension if not exists \"uuid-ossp\" schema extensions"'

# Objects Supabase itself owns can clash on a fresh database; those errors are
# listed, and the verification below decides whether the books survived.
set +e
pg sh -c 'pg_restore --dbname="$TARGET" --no-comments /in/zycount.dump' > "$DUMP_DIR/restore.log" 2>&1
rc=$?
set -e
# "schema public already exists" is expected: every new database has one.
errors=$(grep "^pg_restore: error" "$DUMP_DIR/restore.log" | grep -vc 'schema "public" already exists' || true)
echo "pg_restore exit $rc, $errors unexpected errors"
grep "^pg_restore: error" "$DUMP_DIR/restore.log" | grep -v 'schema "public" already exists' | cut -c1-200 | head -20 || true

pg sh -c 'psql "$TARGET" -X -v ON_ERROR_STOP=1 -f /sql/verify.sql'

pg sh -c 'psql "$TARGET" -X -At -F "	" -v ON_ERROR_STOP=1 -f /sql/counts.sql' > "$DUMP_DIR/counts.restored.tsv"
fail=0; diffs=0
while IFS=$'\t' read -r tbl src; do
  got=$(awk -F'\t' -v t="$tbl" '$1 == t { print $2 }' "$DUMP_DIR/counts.restored.tsv")
  got=${got:-0}
  if [ "$got" != "$src" ]; then
    diffs=$((diffs + 1)); echo "count differs: $tbl source=$src restored=$got"
    if [ "${STRICT_COUNTS:-0}" = "1" ] || { [ "$src" -gt 0 ] && [ "$got" -eq 0 ]; }; then fail=1; fi
  fi
done < "$DUMP_DIR/counts.tsv"
tables=$(wc -l < "$DUMP_DIR/counts.tsv")
rows=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$DUMP_DIR/counts.restored.tsv")
echo "restored $rows rows across $tables tables, $diffs count differences"
[ "$fail" -eq 0 ] || { echo "RESTORE FAIL: rows missing after restore"; exit 1; }

pg sh -c "psql \"\$ADMIN\" -X -c 'drop database if exists $DB'" > /dev/null
echo "RESTORE DRILL PASSED"
