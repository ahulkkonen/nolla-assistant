#!/bin/sh
# No arguments: replicate app.db with Litestream, snapshot vault.db hourly with restic (Litestream
# cannot read SQLCipher files) and run the full restic backup nightly at 03:00 Europe/Helsinki.
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

# vault.db with its WAL, so commits not yet checkpointed are kept. At most one hour of new mappings
# can be lost. The nightly forget in backup-now.sh also thins these snapshots (own path group).
hourly() {
  while :; do
    sleep 3600
    [ -e /data/vault.db ] || continue
    restic cat config >/dev/null 2>&1 || restic init >/dev/null 2>&1
    if out=$(restic backup /data/vault.db $( [ -e /data/vault.db-wal ] && echo /data/vault.db-wal ) --tag vault 2>&1); then
      echo "$(date -Iseconds) restic vault ok"
    else
      echo "$(date -Iseconds) restic vault FAILED: $(echo "$out" | tail -n 3 | tr '\n' ' ')"
    fi
  done
}

litestream replicate -config /etc/litestream.yml &
ls=$!
nightly &
loop=$!
hourly &
vault=$!
trap 'kill "$ls"' TERM INT
wait "$ls"
code=$?
kill "$loop" "$vault" 2>/dev/null
exit "$code"
