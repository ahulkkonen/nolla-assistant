#!/bin/sh
# No arguments: snapshot app.db and vault.db hourly with restic and run the full restic backup
# nightly at 03:00 Europe/Helsinki. Litestream is gone since phase 30: its replica was plain SQLite
# pages in the bucket, and restic encrypts. vault.db is SQLCipher, which Litestream never read.
# With arguments (docker compose run --rm backup /scripts/restore.sh): run that command instead.
[ $# -gt 0 ] && exec "$@"

nightly() {
  [ "${BACKUP_RUN_NOW:-}" = 1 ] && /backup-now.sh
  while :; do
    now=$(date +%s)
    next=$(date -d "$(date +%F) 03:00:00" +%s)
    [ "$next" -le "$now" ] && next=$(date -d "$(date -d "@$((now + 86400))" +%F) 03:00:00" +%s)
    wait_s=$((next - now))
    sleep "$wait_s"
    /backup-now.sh
  done
}

# Each database with its WAL, so commits not yet checkpointed are kept; tag = the database name.
# At most one hour of changes can be lost. The nightly forget in backup-now.sh also thins these
# snapshots (own path groups).
# ponytail: a file copy of a live WAL database; a checkpoint between the two reads can lose the
# commits of that moment. Use `sqlite3 .backup` (app.db) if a restore ever shows it.
hourly() {
  while :; do
    sleep 3600
    restic cat config >/dev/null 2>&1 || restic init >/dev/null 2>&1
    for db in app vault; do
      [ -e "/data/$db.db" ] || continue
      if out=$(restic backup "/data/$db.db" $( [ -e "/data/$db.db-wal" ] && echo "/data/$db.db-wal" ) --tag "$db" 2>&1); then
        echo "$(date -Iseconds) restic $db ok"
      else
        echo "$(date -Iseconds) restic $db FAILED: $(echo "$out" | tail -n 3 | tr '\n' ' ')"
      fi
    done
  done
}

nightly &
loop=$!
hourly &
dbs=$!
trap 'kill "$loop" "$dbs" 2>/dev/null; exit 0' TERM INT
wait
