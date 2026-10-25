#!/bin/sh
# No arguments: replicate with Litestream and run restic nightly at 03:00 Europe/Helsinki.
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

litestream replicate -config /etc/litestream.yml &
ls=$!
nightly &
loop=$!
trap 'kill "$ls"' TERM INT
wait "$ls"
code=$?
kill "$loop" 2>/dev/null
exit "$code"
