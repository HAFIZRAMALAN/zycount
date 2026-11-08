#!/usr/bin/env bash
# Concurrent-posting load test (audit R8) against a scratch database.
#   DB_URL   superuser URL, e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres
#   CLIENTS  connections posting at once (default 50)
#   SECONDS_ how long to run (default 120)
#   P95_MS   fail if the 95th-percentile call is slower (default 500)
set -euo pipefail
: "${DB_URL:?DB_URL is not set}"
CLIENTS="${CLIENTS:-50}"; DURATION="${SECONDS_:-120}"; P95_MS="${P95_MS:-500}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
pg() { docker run --rm --network host -v "$HERE":/t:ro -v "$OUT":/out -e DB="$DB_URL" -w /out "$PG_IMAGE" "$@"; }

pg sh -c 'psql "$DB" -X -q -v ON_ERROR_STOP=1 -f /t/setup.sql'
# --max-tries retries deadlocks/serialization failures like a real client
# would; anything else counts as a failure and fails the test.
pg sh -c "pgbench \"\$DB\" -n -c $CLIENTS -j 4 -T $DURATION --max-tries=3 -f /t/post.sql -l --log-prefix=/out/tx" | tee "$OUT/pgbench.txt"

ok=$(awk '/number of transactions actually processed/ { split($0, a, ": "); split(a[2], b, "/"); print b[1] }' "$OUT/pgbench.txt")
failed=$(awk '/number of failed transactions/ { split($0, a, ": "); split(a[2], b, " "); print b[1] }' "$OUT/pgbench.txt")
failed=${failed:-0}
# Column 3 of the per-transaction log is latency in microseconds.
p95=$(cat "$OUT"/tx.* | awk '{ print $3 }' | sort -n | awk '{ a[NR] = $1 } END { i = int(NR * 0.95); if (i < 1) i = 1; printf "%d", a[i] / 1000 }')
echo "processed=$ok failed=$failed p95=${p95}ms (limit ${P95_MS}ms)"

pg sh -c "psql \"\$DB\" -X -v ON_ERROR_STOP=1 -v ok=$ok -f /t/check.sql"
[ "$failed" = "0" ] || { echo "LOAD FAIL: $failed transactions failed"; exit 1; }
[ "$p95" -le "$P95_MS" ] || { echo "LOAD FAIL: p95 ${p95}ms is over ${P95_MS}ms"; exit 1; }
echo "LOAD TEST PASSED"
