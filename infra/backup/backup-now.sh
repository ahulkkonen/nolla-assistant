#!/bin/sh
# One restic run: init on first use, snapshot /data, prune. Logs one line.
# Litestream's local state directories (/data/.<db>-litestream) stay out: a restored copy would
# disagree with the replica. The work dirs are user files since phase 11 and are in; their trash
# (deleted files, purged after 30 days) stays out.
# Manual trigger: docker compose exec backup /backup-now.sh
# /backup-extra/mcp-workspace is the read-only mcp-workspace-data volume (Google tokens, decision
# 0005). entrypoint.sh runs this script nightly, so the volume is in every nightly snapshot.
set -u
extra=
[ -d /backup-extra/mcp-workspace ] && extra=/backup-extra/mcp-workspace
out=$(mktemp)
if { restic cat config >/dev/null 2>&1 || restic init; } >"$out" 2>&1 \
  && restic backup /data $extra --tag full --exclude '/data/work/*/.trash' --exclude '/data/**/*.db-wal' --exclude '/data/**/*.db-shm' --exclude '/data/.*-litestream' >>"$out" 2>&1 \
  && restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune >>"$out" 2>&1; then
  echo "$(date -Iseconds) restic run ok"
else
  echo "$(date -Iseconds) restic run FAILED: $(tail -n 3 "$out" | tr '\n' ' ')"
  rm -f "$out"
  exit 1
fi
rm -f "$out"
