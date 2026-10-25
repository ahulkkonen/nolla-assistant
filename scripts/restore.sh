#!/bin/sh
# Rebuild /data from the bucket on a fresh host. Needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY,
# S3_SECRET_KEY and RESTIC_PASSWORD in the environment, plus litestream and restic on PATH.
#   docker compose run --rm backup /scripts/restore.sh
#   scripts/restore.sh                       (standalone, as a user that can write /data)
set -eu
DATA=/data
CONFIG=${LITESTREAM_CONFIG:-/etc/litestream.yml}
[ -f "$CONFIG" ] || CONFIG=$(dirname "$0")/../infra/litestream.yml
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

# Databases first: Litestream restores the newest state, newer than the nightly snapshot.
skip=
# vault.db is SQLCipher (no SQLite header): restic only, hourly snapshots tagged `vault`.
for db in app; do
  f=$DATA/$db.db
  if [ -e "$f" ]; then echo "skip $f: exists"; skip="$skip --exclude /data/$db.db"; continue; fi
  litestream restore -config "$CONFIG" -if-replica-exists -o "$f" "/data/$db.db"
  if [ -e "$f" ]; then echo "litestream restored $f"; skip="$skip --exclude /data/$db.db"
  else echo "no litestream replica for $db.db"; fi
done

# Everything else (sessions, files, pi, memory) from the latest snapshot. /backup-extra is a
# read-only mount here: exclude the whole tree, or restic fails on its lchown. A database without a
# Litestream replica falls back to its snapshot copy.
# shellcheck disable=SC2086
restic restore latest --tag full --target / $skip --exclude /data/vault.db --exclude '/data/vault.db-*' --exclude /backup-extra
# Newest hourly vault snapshot wins over the nightly copy.
restic restore latest --tag vault --target / || echo "no vault snapshot yet"
find "$DATA" -type f | sed "s|^$DATA/||" | sort | sed 's/^/restored: /'
echo "Google tokens ($MCP) are not restored here: run this script with the argument mcp (see the top)."
