#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
for tool in initdb pg_ctl psql; do command -v "$tool" >/dev/null || { echo "Missing local PostgreSQL tool: $tool" >&2; exit 1; }; done
monitor_tmp="$(mktemp -d "${TMPDIR:-/tmp}/portava-intelligence-monitor.XXXXXX")"
cleanup() {
  pg_ctl -D "$monitor_tmp/data" -m fast -w stop >/dev/null 2>&1 || true
  rm -rf "$monitor_tmp"
}
trap cleanup EXIT
initdb -D "$monitor_tmp/data" -U postgres -A trust --no-locale > "$monitor_tmp/init.log"
# A private UNIX socket only: no TCP listener and no connection to Supabase.
pg_ctl -D "$monitor_tmp/data" -l "$monitor_tmp/server.log" -o "-c listen_addresses='' -k $monitor_tmp" -w start > /dev/null
psql_args=(-X -v ON_ERROR_STOP=1 -h "$monitor_tmp" -U postgres -d postgres)
psql "${psql_args[@]}" -f "$repo_dir/supabase/tests/intelligence_system_monitor.fixture.sql" > /dev/null
# pg_cron is a hosted extension. Validate the entire schema and collector here;
# scheduling is separately verified on the authorized production project.
awk '/^create extension if not exists pg_cron/{exit} {print}' "$repo_dir/supabase/migrations/20261113111829_intelligence_system_monitor.sql" > "$monitor_tmp/schema.sql"
psql "${psql_args[@]}" -f "$monitor_tmp/schema.sql" > /dev/null
psql "${psql_args[@]}" -f "$repo_dir/supabase/tests/intelligence_system_monitor.sql" > /dev/null
psql "${psql_args[@]}" -f "$repo_dir/supabase/tests/intelligence_system_monitor.fixture-checks.sql" > /dev/null
psql "${psql_args[@]}" -f "$repo_dir/supabase/tests/whole_system_monitor.fixture.sql" > /dev/null
psql "${psql_args[@]}" -f "$repo_dir/supabase/migrations/20261113120000_whole_system_monitor.sql" > /dev/null
psql "${psql_args[@]}" -f "$repo_dir/supabase/tests/whole_system_monitor.fixture-checks.sql" > /dev/null
echo "PASS: monitor privacy, state semantics, deduplication, timing, outage isolation, and thirteen-system collection and same-hour upgrade."
