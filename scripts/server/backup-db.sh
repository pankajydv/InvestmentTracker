#!/usr/bin/env bash
#
# Off-box, encrypted daily backup of the Investment Tracker SQLite DB.
#
# Pipeline:  sqlite3 .backup (consistent snapshot)  ->  gzip
#            ->  upload to Backblaze B2 via rclone  ->  prune old local + remote copies
#
# Runs on the Oracle VM (invoked by investtrack-backup.timer / cron).
# Requires: sqlite3, gzip, rclone  (see docs/Troubleshooting.md)
#
# Config is read from an env file (default /etc/investtrack/backup-db.env), which
# must define the variables listed in backup-db.env.example. NO secrets live in
# this script; B2 credentials live in the rclone config. Backups are NOT
# client-side encrypted (kept simple for reliable restore) — keep the B2 bucket
# PRIVATE (default) so only your scoped application key can read them.

set -euo pipefail

CONFIG_FILE="${BACKUP_DB_ENV:-/etc/investtrack/backup-db.env}"

log()  { echo "[backup-db] $(date -u +%FT%TZ) $*"; }
die()  { echo "[backup-db] ERROR: $*" >&2; exit 1; }

[ -f "$CONFIG_FILE" ] || die "config file not found: $CONFIG_FILE"
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${DB_PATH:?set DB_PATH in $CONFIG_FILE}"
: "${RCLONE_REMOTE:?set RCLONE_REMOTE (e.g. b2:my-bucket/investtrack) in $CONFIG_FILE}"
: "${LOCAL_BACKUP_DIR:=/data/backups}"
: "${RETENTION_DAYS:=30}"
: "${RCLONE_CONFIG:=/etc/investtrack/rclone.conf}"

export RCLONE_CONFIG

command -v sqlite3 >/dev/null || die "sqlite3 not installed"
command -v rclone  >/dev/null || die "rclone not installed"
[ -f "$DB_PATH" ] || die "database not found: $DB_PATH"

mkdir -p "$LOCAL_BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP="$(mktemp /tmp/investments-snap.XXXXXX.db)"
OUT="$LOCAL_BACKUP_DIR/investments-${STAMP}.db.gz"

cleanup() { rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm" 2>/dev/null || true; }
trap cleanup EXIT

# 1. Consistent snapshot (safe while the app is running; handles WAL)
log "creating consistent snapshot..."
sqlite3 "$DB_PATH" ".backup '$SNAP'"
sqlite3 "$SNAP" 'PRAGMA integrity_check;' | grep -q '^ok$' \
  || die "integrity_check failed on snapshot"

# 2. Compress (no client-side encryption — bucket must be PRIVATE; see header)
log "compressing -> $(basename "$OUT")"
gzip -c "$SNAP" > "$OUT"

# 3. Upload off-box to Backblaze B2
log "uploading to $RCLONE_REMOTE ..."
rclone copy "$OUT" "$RCLONE_REMOTE/" --no-traverse

# 4. Prune local copies older than retention
log "pruning local copies older than ${RETENTION_DAYS}d"
find "$LOCAL_BACKUP_DIR" -name 'investments-*.db.gz' -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

# 5. Prune remote copies older than retention
log "pruning remote copies older than ${RETENTION_DAYS}d"
rclone delete "$RCLONE_REMOTE/" --min-age "${RETENTION_DAYS}d" \
  --include 'investments-*.db.gz' || true

log "backup OK -> $RCLONE_REMOTE/$(basename "$OUT")"
