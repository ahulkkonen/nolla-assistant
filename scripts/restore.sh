#!/bin/sh
# Rebuild /data from the bucket on a fresh host. Needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY,
# S3_SECRET_KEY and RESTIC_PASSWORD in the environment, plus restic on PATH.
#   docker compose run --rm backup /scripts/restore.sh
#   scripts/restore.sh                       (standalone, as a user that can write /data)
set -eu
DATA=/data
export RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-s3:$S3_ENDPOINT/$S3_BUCKET/restic}
export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-$S3_ACCESS_KEY}
export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-$S3_SECRET_KEY}

MCP=/backup-extra/mcp-workspace
# `mcp` restores only the Google token volume. The backup service mounts it read-only, so run:
#   docker run --rm --env-file <restore env> -v <project>_mcp-workspace-data:$MCP \
#     --entrypoint /scripts/restore.sh <project>-backup mcp
if [ "${1:-}" = mcp ]; then
  restic restore latest --tag full --target / --include "$MCP"
  exit 0
fi

mkdir -p "$DATA/sessions" "$DATA/files" "$DATA/pi" "$DATA/work"

for db in app vault; do
  if [ -e "$DATA/$db.db" ]; then echo "$DATA/$db.db exists: restore into an empty volume"; exit 1; fi
done

# Everything (sessions, files, work dirs, pi, memory, app.db) from the latest nightly snapshot.
# /backup-extra is a read-only mount here: exclude the whole tree, or restic fails on its lchown.
restic restore latest --tag full --target / --exclude /data/vault.db --exclude '/data/vault.db-*' --exclude /backup-extra
# The newest hourly database snapshot wins over the nightly copy. A snapshot without a WAL file
# must not leave the nightly WAL next to it.
for db in app vault; do
  if restic ls latest --tag "$db" >/dev/null 2>&1; then
    rm -f "$DATA/$db.db-wal" "$DATA/$db.db-shm"
    restic restore latest --tag "$db" --target /
  else echo "no hourly $db snapshot yet"; fi
done
find "$DATA" -type f | sed "s|^$DATA/||" | sort | sed 's/^/restored: /'
echo "Google tokens ($MCP) are not restored here: run this script with the argument mcp (see the top)."
