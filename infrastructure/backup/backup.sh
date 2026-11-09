#!/usr/bin/env bash
# Writes an encrypted, compressed, point-in-time copy of the database.
#   MONGODB_URI, BACKUP_PASSPHRASE_FILE and BACKUP_DIR are required.
#   BACKUP_S3_URI is optional, for example s3://lumio-backups/production.
set -euo pipefail

: "${MONGODB_URI:?}" "${BACKUP_PASSPHRASE_FILE:?}" "${BACKUP_DIR:?}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/lumio-$stamp.archive.gz.enc"
mkdir -p "$BACKUP_DIR"

# --oplog gives one consistent moment across collections, including transactions in progress.
mongodump --uri="$MONGODB_URI" --oplog --archive --gzip |
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$target"

test -s "$target"
sha256sum "$target" > "$target.sha256"
if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$target" "$BACKUP_S3_URI/"
  aws s3 cp "$target.sha256" "$BACKUP_S3_URI/"
fi
echo "$target"
