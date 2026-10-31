#!/bin/sh
# One restic run: init on first use, snapshot /data, prune. Logs one line.
# The live databases stay out: db-copy.sh writes a consistent copy of each to /data/.backup first,
# and the snapshot holds those copies. The -shm files and the state directories of the old
# Litestream replication (/data/.<db>-litestream) stay out. The work dirs are user files since
# phase 11 and are in; their trash (deleted files, purged after 30 days) stays out.
# Manual trigger: docker compose exec backup /backup-now.sh
# /backup-extra/mcp-workspace is the read-only mcp-workspace-data volume (Google tokens, decision
# 0005). entrypoint.sh runs this script nightly, so the volume is in every nightly snapshot.
set -u
extra=
[ -d /backup-extra/mcp-workspace ] && extra=/backup-extra/mcp-workspace
out=$(mktemp)
# The lock keeps the hourly run (entrypoint.sh) off /data/.backup during this run.
exec 9>/data/.backup.lock
flock 9
if { restic cat config >/dev/null 2>&1 || restic init; } >"$out" 2>&1 \
  && /db-copy.sh app >>"$out" 2>&1 && /db-copy.sh vault >>"$out" 2>&1 \
  && restic backup /data $extra --tag full --exclude '/data/work/*/.trash' \
    --exclude /data/app.db --exclude '/data/app.db-*' --exclude /data/vault.db --exclude '/data/vault.db-*' \
    --exclude '/data/**/*.db-shm' --exclude '/data/.*-litestream' --exclude /data/.backup.lock >>"$out" 2>&1 \
  && restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune >>"$out" 2>&1; then
  echo "$(date -Iseconds) restic run ok"
else
  echo "$(date -Iseconds) restic run FAILED: $(tail -n 3 "$out" | tr '\n' ' ')"
  rm -f "$out"
  exit 1
fi
rm -f "$out"
