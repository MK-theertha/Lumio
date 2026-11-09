#!/usr/bin/env bash
# Restores a backup. Refuses to run unless the database being overwritten is named on purpose.
#   restore.sh <backup file>
#   RESTORE_URI, BACKUP_PASSPHRASE_FILE, and RESTORE_CONFIRM set to the target database name.
#   Optional: SOURCE_DB and RESTORE_DB, to restore into a differently named database for a drill.
set -euo pipefail

file=${1:?Usage: restore.sh <backup file>}
: "${RESTORE_URI:?}" "${BACKUP_PASSPHRASE_FILE:?}" "${RESTORE_CONFIRM:?}"

source_db=${SOURCE_DB:-lumio}
restore_db=${RESTORE_DB:-$source_db}
if [ "$RESTORE_CONFIRM" != "$restore_db" ]; then
  echo "RESTORE_CONFIRM must equal the target database name, $restore_db" >&2
  exit 1
fi
if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256")
fi

openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$file" |
  mongorestore --uri="$RESTORE_URI" --archive --gzip --drop \
    --nsInclude="$source_db.*" --nsFrom="$source_db.*" --nsTo="$restore_db.*"
