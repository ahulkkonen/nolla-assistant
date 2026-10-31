#!/bin/sh
# Consistent copy of /data/<db>.db (app or vault) to /data/.backup/<db>.db, taken inside one read
# transaction while the server keeps writing. restic then backs up the copy, never the live file
# and its WAL (two reads that a checkpoint can split). Exit 0 without a copy when the database is
# missing. Callers hold /data/.backup.lock, so the hourly and the nightly run never share a copy.
#   app:   SQLite online backup (sqlite3 .backup).
#   vault: SQLCipher; sqlcipher_export into a new file with the same key. The key goes through
#          stdin, never argv.
set -eu
db=$1
src=/data/$db.db
dst=/data/.backup/$db.db
[ -e "$src" ] || exit 0
mkdir -p /data/.backup
rm -f "$dst"
case $db in
  app) sqlite3 -bail "$src" ".backup '$dst'" ;;
  vault)
    k=$(printf %s "${PSEUDO_VAULT_KEY:?PSEUDO_VAULT_KEY unset}" | sed "s/'/''/g")
    printf "PRAGMA key = '%s';\nATTACH DATABASE '%s' AS b KEY '%s';\nSELECT sqlcipher_export('b');\nDETACH DATABASE b;\n" \
      "$k" "$dst" "$k" | sqlcipher -bail "$src" >/dev/null
    ;;
  *) echo "db-copy: unknown database $db" >&2; exit 2 ;;
esac
