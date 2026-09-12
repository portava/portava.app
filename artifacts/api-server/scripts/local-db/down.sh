#!/usr/bin/env bash
# down.sh — stop a cluster up.sh booted (no-op for LOCAL_DB_URL mode). Data is discarded with LOCAL_DB_PURGE=1.
set -euo pipefail
DIR="${LOCAL_DB_DIR:-/tmp/portava-local-db}"
PG_BIN="${PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then PG_BIN=$(dirname "$(command -v pg_ctl)"); else PG_BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1); fi
fi
[ -f "$DIR/data/PG_VERSION" ] || { echo "local-db: nothing booted at $DIR"; exit 0; }
if [ "$(id -u)" = "0" ]; then su "${LOCAL_DB_USER:-portava_localdb}" -c "$PG_BIN/pg_ctl -D $DIR/data stop -m fast >/dev/null 2>&1 || true"; else "$PG_BIN/pg_ctl" -D "$DIR/data" stop -m fast >/dev/null 2>&1 || true; fi
[ "${LOCAL_DB_PURGE:-0}" = "1" ] && rm -rf "$DIR"
echo "local-db: stopped"
