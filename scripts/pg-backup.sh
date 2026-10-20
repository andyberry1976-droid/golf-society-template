#!/usr/bin/env bash
# Back up the Postgres (Supabase) database. Needs pg_dump (Postgres client tools) and DATABASE_URL.
#   DATABASE_URL='postgresql://…' ./scripts/pg-backup.sh            -> backups/demo-YYYYmmdd-HHMM.dump
# Restore into an empty database:  pg_restore --no-owner -d "$DATABASE_URL" backups/<file>.dump
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL (never commit it)}"
mkdir -p backups
out="backups/demo-$(date +%Y%m%d-%H%M).dump"
pg_dump --format=custom --no-owner --no-privileges --table=app_snapshots --table=app_meta --dbname="$DATABASE_URL" --file="$out"
echo "Saved $out"
# Also grab the latest app database as a plain SQLite file you can open anywhere:
node "$(dirname "$0")/pg-export.js" "${out%.dump}.db"
