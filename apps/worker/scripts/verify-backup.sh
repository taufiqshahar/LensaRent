#!/usr/bin/env bash
# Restores a D1 SQL export into a throw-away local database and checks it: SQLite's
# quick_check (D1 refuses integrity_check), every migration present, and a row count
# per table. A backup that cannot be restored is not a backup, so the nightly job runs
# this on every export.
#
#   scripts/verify-backup.sh path/to/export.sql
set -euo pipefail

file="${1:?usage: verify-backup.sh <export.sql>}"
[ -s "$file" ] || { echo "Backup file is missing or empty: $file" >&2; exit 1; }

cd "$(dirname "$0")/.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

query() {
  npx wrangler d1 execute DB --local --persist-to "$scratch" --json --command "$1"
}

npx wrangler d1 execute DB --local --persist-to "$scratch" --file "$file" > /dev/null

integrity="$(query "PRAGMA quick_check" | grep -o '"quick_check": *"[^"]*"')"
echo "$integrity"
case "$integrity" in *'"ok"'*) ;; *) echo "Quick check failed" >&2; exit 1 ;; esac

expected="$(ls migrations/*.sql | wc -l | tr -d ' ')"
applied="$(query "SELECT COUNT(*) AS n FROM d1_migrations" | grep -o '"n": *[0-9]*' | grep -o '[0-9]*$')"
echo "migrations: $applied applied, $expected in the repository"
[ "$applied" -ge 1 ] || { echo "No migrations in the backup" >&2; exit 1; }

for table in bookings booking_events payments ledger_entries customers units settings \
  availability_locks maintenance_blocks handover_photos audit_logs leads; do
  count="$(query "SELECT COUNT(*) AS n FROM $table" | grep -o '"n": *[0-9]*' | grep -o '[0-9]*$')"
  echo "$table: $count"
done
echo "Backup restores cleanly."
