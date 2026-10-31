#!/bin/sh
# Rebuild /data from the bucket on a fresh host. Needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY,
# S3_SECRET_KEY, RESTIC_PASSWORD and PSEUDO_VAULT_KEY in the environment, plus restic, sqlite3 and
# sqlcipher on PATH.
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

# Everything but the databases (sessions, files, work dirs, pi, memory) from the latest nightly
# snapshot. /backup-extra is a read-only mount here: exclude the whole tree, or restic fails on
# its lchown.
restic restore latest --tag full --target / --exclude /backup-extra --exclude /data/.backup

# Each database from the newer of the nightly snapshot and its hourly one. Both hold the
# consistent copy /data/.backup/<db>.db (infra/backup/db-copy.sh). Two --tag flags match either
# tag, and `latest` is the snapshot with the newest time among them. A failed listing stops the
# restore; only an empty list means "no snapshot".
check() { # $1 = db: prints the last line of PRAGMA integrity_check
  case $1 in
    app) sqlite3 -bail "$DATA/app.db" 'PRAGMA integrity_check;' | tail -n 1 ;;
    vault)
      k=$(printf %s "${PSEUDO_VAULT_KEY:?PSEUDO_VAULT_KEY unset}" | sed "s/'/''/g")
      printf "PRAGMA key = '%s';\nPRAGMA integrity_check;\n" "$k" | sqlcipher -bail "$DATA/vault.db" | tail -n 1
      ;;
  esac
}
for db in app vault; do
  list=$(restic snapshots --tag full --tag "$db" --json)
  if [ "$list" = "[]" ] || [ "$list" = "null" ]; then echo "no snapshot of $db.db"; continue; fi
  restic restore latest --tag full --tag "$db" --target / --include "/data/.backup/$db.db"
  # The database did not exist when the newest snapshot ran.
  if [ ! -e "$DATA/.backup/$db.db" ]; then echo "newest snapshot holds no $db.db"; continue; fi
  mv "$DATA/.backup/$db.db" "$DATA/$db.db"
  result=$(check "$db")
  if [ "$result" != ok ]; then echo "$db.db failed PRAGMA integrity_check: $result"; exit 1; fi
  echo "$db.db: integrity ok"
done
rmdir "$DATA/.backup" 2>/dev/null || true
find "$DATA" -type f | sed "s|^$DATA/||" | sort | sed 's/^/restored: /'
echo "Google tokens ($MCP) are not restored here: run this script with the argument mcp (see the top)."
