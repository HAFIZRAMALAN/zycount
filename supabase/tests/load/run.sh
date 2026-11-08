#!/usr/bin/env bash
# Concurrent-posting load test (audit R8) against a scratch database. Two runs
# into ONE company, so every call competes for the same number series:
#
#   1. Stress — CLIENTS connections posting non-stop (no pause between calls).
#      Proves correctness under the worst contention: no gaps, no duplicates,
#      no double posts, nothing unbalanced, nothing failed. Latency here is
#      mostly queueing for the series lock and is reported, not judged.
#   2. Busy office — the same connections, throttled to RATE calls a second in
#      total (each call = an invoice sent twice + a cash sale). p95 must stay
#      under P95_MS.
#
#   DB_URL     superuser URL, e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres
#   CLIENTS    connections (default 50)    SECONDS_  length of each run (default 60)
#   RATE       calls/second in run 2 (default 20)    P95_MS  limit for run 2 (default 500)
set -euo pipefail
: "${DB_URL:?DB_URL is not set}"
CLIENTS="${CLIENTS:-50}"; DURATION="${SECONDS_:-60}"; RATE="${RATE:-20}"; P95_MS="${P95_MS:-500}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
pg() { docker run --rm --network host -v "$HERE":/t:ro -v "$OUT":/out -e DB="$DB_URL" -w /out "$PG_IMAGE" "$@"; }

pg sh -c 'psql "$DB" -X -q -v ON_ERROR_STOP=1 -f /t/setup.sql'

# One pgbench run; prints "processed failed p95ms". --max-tries retries
# deadlocks/serialization failures like a real client would.
bench() {
  local name="$1"; shift
  pg sh -c "pgbench \"\$DB\" -n -c $CLIENTS -j 4 -T $DURATION --max-tries=3 $* -f /t/post.sql -l --log-prefix=/out/$name" > "$OUT/$name.txt"
  local ok failed p95
  ok=$(awk '/number of transactions actually processed/ { split($0, a, ": "); split(a[2], b, "/"); print b[1] }' "$OUT/$name.txt")
  failed=$(awk '/number of failed transactions/ { split($0, a, ": "); split(a[2], b, " "); print b[1] }' "$OUT/$name.txt")
  # Column 3 of the per-transaction log is latency in microseconds.
  p95=$(cat "$OUT/$name".* | awk '{ print $3 }' | sort -n | awk '{ a[NR] = $1 } END { i = int(NR * 0.95); if (i < 1) i = 1; printf "%d", a[i] / 1000 }')
  echo "${ok:-0} ${failed:-0} ${p95:-0}"
}

read -r ok1 failed1 p951 < <(bench stress)
echo "stress:      processed=$ok1 failed=$failed1 p95=${p951}ms ($CLIENTS connections, no pause, ${DURATION}s)"
read -r ok2 failed2 p952 < <(bench office -R "$RATE")
echo "busy office: processed=$ok2 failed=$failed2 p95=${p952}ms (limit ${P95_MS}ms, $RATE calls/s, ${DURATION}s)"

pg sh -c "psql \"\$DB\" -X -v ON_ERROR_STOP=1 -v ok=$((ok1 + ok2)) -f /t/check.sql"
[ "$failed1" = "0" ] && [ "$failed2" = "0" ] || { echo "LOAD FAIL: $((failed1 + failed2)) transactions failed"; exit 1; }
[ "$ok2" -gt 0 ] || { echo "LOAD FAIL: the busy-office run processed nothing"; exit 1; }
[ "$p952" -le "$P95_MS" ] || { echo "LOAD FAIL: busy-office p95 ${p952}ms is over ${P95_MS}ms"; exit 1; }
echo "LOAD TEST PASSED"
