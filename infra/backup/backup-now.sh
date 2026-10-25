#!/bin/sh
# One restic run: init on first use, snapshot /data, prune. Logs one line.
# Litestream's local state directories (/data/.<db>-litestream) stay out: a restored copy would
# disagree with the replica.
# Manual trigger: docker compose exec backup /backup-now.sh
set -u
out=$(mktemp)
if { restic cat config >/dev/null 2>&1 || restic init; } >"$out" 2>&1 \
  && restic backup /data --exclude /data/work --exclude '/data/**/*.db-wal' --exclude '/data/**/*.db-shm' --exclude '/data/.*-litestream' >>"$out" 2>&1 \
  && restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune >>"$out" 2>&1; then
  echo "$(date -Iseconds) restic run ok"
else
  echo "$(date -Iseconds) restic run FAILED: $(tail -n 3 "$out" | tr '\n' ' ')"
  rm -f "$out"
  exit 1
fi
rm -f "$out"
