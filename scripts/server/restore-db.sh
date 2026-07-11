#!/usr/bin/env bash
#
# Restore the Investment Tracker SQLite DB from a Backblaze B2 backup.
#
# Usage:
#   ./restore-db.sh                 # restores the LATEST backup from B2
#   ./restore-db.sh <object-name>   # restores a specific backup (name in the bucket)
#
# Backups are plain gzip (not encrypted). This script restores into a staging
# path and verifies it. It does NOT overwrite the live DB automatically — the
# final swap is a deliberate manual step (printed at the end) so you don't
# clobber good data by accident.

set -euo pipefail

CONFIG_FILE="${BACKUP_DB_ENV:-/etc/investtrack/backup-db.env}"
STAGING="${STAGING:-/tmp/investtrack-restore}"

log() { echo "[restore-db] $*"; }
die() { echo "[restore-db] ERROR: $*" >&2; exit 1; }

[ -f "$CONFIG_FILE" ] || die "config not found: $CONFIG_FILE"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${RCLONE_REMOTE:?set RCLONE_REMOTE in $CONFIG_FILE}"
: "${RCLONE_CONFIG:=/etc/investtrack/rclone.conf}"
export RCLONE_CONFIG

mkdir -p "$STAGING"

OBJECT="${1:-}"
if [ -z "$OBJECT" ]; then
  log "finding latest backup in $RCLONE_REMOTE ..."
  OBJECT="$(rclone lsf "$RCLONE_REMOTE/" --include 'investments-*.db.gz' | sort | tail -n1)"
  [ -n "$OBJECT" ] || die "no backups found in $RCLONE_REMOTE"
fi
log "restoring object: $OBJECT"

rclone copy "$RCLONE_REMOTE/$OBJECT" "$STAGING/" --no-traverse
DB_OUT="$STAGING/investments.restored.db"

log "decompressing ..."
gunzip -c "$STAGING/$OBJECT" > "$DB_OUT"

log "verifying integrity ..."
sqlite3 "$DB_OUT" 'PRAGMA integrity_check;' | grep -q '^ok$' || die "integrity_check FAILED"
COUNT="$(sqlite3 "$DB_OUT" 'SELECT count(*) FROM investments;' 2>/dev/null || echo '?')"
log "OK. Restored DB at: $DB_OUT (investments rows: $COUNT)"

cat <<EOF

Next steps to go live with this restore (manual, deliberate):
  1. Stop the app:        docker stop investment-tracker-blue investment-tracker-green 2>/dev/null || true
  2. Back up current:     cp ${DB_PATH:-/data/investments.db} ${DB_PATH:-/data/investments.db}.pre-restore-\$(date +%F) 2>/dev/null || true
  3. Swap in restore:     cp "$DB_OUT" ${DB_PATH:-/data/investments.db}
  4. Remove stale WAL:    rm -f ${DB_PATH:-/data/investments.db}-wal ${DB_PATH:-/data/investments.db}-shm
  5. Start the app again (your normal start/deploy flow).
EOF
