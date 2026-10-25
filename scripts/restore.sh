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

mkdir -p "$DATA/sessions" "$DATA/files" "$DATA/pi" "$DATA/work"

# Databases first: Litestream restores the newest state, newer than the nightly snapshot.
skip=
for db in app vault; do
  f=$DATA/$db.db
  if [ -e "$f" ]; then echo "skip $f: exists"; skip="$skip --exclude /data/$db.db"; continue; fi
  litestream restore -config "$CONFIG" -if-replica-exists -o "$f" "/data/$db.db"
  if [ -e "$f" ]; then echo "litestream restored $f"; skip="$skip --exclude /data/$db.db"
  else echo "no litestream replica for $db.db"; fi
done

# Everything else (sessions, files, pi, memory) from the latest snapshot. A database without a
# Litestream replica falls back to its snapshot copy.
# shellcheck disable=SC2086
restic restore latest --target / $skip
find "$DATA" -type f | sed "s|^$DATA/||" | sort | sed 's/^/restored: /'
