#!/bin/bash
set -euo pipefail

# Remote deployment script for InvestmentTracker
# Receives all configuration and secrets as environment variables

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
  echo -e "${GREEN}[DEPLOY]${NC} $*"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $*"
}

error() {
  echo -e "${RED}[ERROR]${NC} $*"
  exit 1
}

# Validate required environment variables
for var in ORACLE_HOST ORACLE_USER ORACLE_PORT DEPLOY_DIR GOOGLE_CLIENT_ID ALLOWED_EMAILS ENABLE_SCHEDULER ALLOW_DB_MIGRATIONS; do
  if [ -z "${!var:-}" ]; then
    error "Missing required environment variable: $var"
  fi
done

log "Starting deployment to Oracle VM"
log "  Host: ${ORACLE_HOST}:${ORACLE_PORT}"
log "  User: ${ORACLE_USER}"
log "  Deploy directory: ${DEPLOY_DIR}"

# Step 1: Create deployment directory if it doesn't exist
log "Creating deployment directory..."
mkdir -p "${DEPLOY_DIR}" || error "Failed to create deployment directory"

# Step 2: Extract source archive
log "Extracting source archive..."
cd "${DEPLOY_DIR}" || error "Failed to change to deployment directory"
if [ ! -f "source.tar.gz" ]; then
  error "source.tar.gz not found in ${DEPLOY_DIR}"
fi
tar -xzf source.tar.gz || error "Failed to extract source archive"
log "Source extracted successfully"

# Step 3: Create/update .env file
log "Configuring environment variables..."
cat > .env <<EOF
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
ALLOWED_EMAILS=${ALLOWED_EMAILS}
ENABLE_SCHEDULER=${ENABLE_SCHEDULER}
ALLOW_DB_MIGRATIONS=${ALLOW_DB_MIGRATIONS}
APP_MODE=production
PORT=8080
DATA_DIR=/data
EOF
log "Environment file created"

# Step 4: Copy deployment configuration
log "Setting up deployment config..."
cp configs/investtrack-prod.json . || error "Failed to copy deployment config"

# Step 5: Verify Docker is available
log "Checking Docker availability..."
if ! command -v docker &> /dev/null; then
  error "Docker is not installed or not in PATH"
fi

# ---------------------------------------------------------------------------
# Blue/green zero-downtime deploy
#
# Two containers alternate: investment-tracker-blue (:8081) and
# investment-tracker-green (:8082). Caddy proxies to the ACTIVE color via
# /etc/caddy/investtrack-upstream.caddy. We start the new color, health-check it,
# flip Caddy (graceful reload = no dropped connections), THEN stop the old color.
# If anything fails before the flip, the old color keeps serving — no downtime.
#
# One-time server setup required (see scripts/server/Caddyfile.example):
#   - /etc/caddy/Caddyfile imports /etc/caddy/investtrack-upstream.caddy
#   - initial upstream file exists (defaults handled below if missing)
# ---------------------------------------------------------------------------
PORT_BLUE=8081
PORT_GREEN=8082
UPSTREAM_FILE=/etc/caddy/investtrack-upstream.caddy
IMAGE=investment-tracker:latest

# Determine the currently active color from the Caddy upstream file (default: none)
ACTIVE_COLOR=""
if [ -f "$UPSTREAM_FILE" ]; then
  if grep -q ":${PORT_GREEN}" "$UPSTREAM_FILE"; then
    ACTIVE_COLOR="green"
  elif grep -q ":${PORT_BLUE}" "$UPSTREAM_FILE"; then
    ACTIVE_COLOR="blue"
  fi
fi

if [ "$ACTIVE_COLOR" = "blue" ]; then
  NEW_COLOR="green"; NEW_PORT=$PORT_GREEN; OLD_COLOR="blue";  OLD_PORT=$PORT_BLUE
else
  # active is green OR unknown -> deploy blue
  NEW_COLOR="blue";  NEW_PORT=$PORT_BLUE;  OLD_COLOR="green"; OLD_PORT=$PORT_GREEN
fi
NEW_NAME="investment-tracker-${NEW_COLOR}"
OLD_NAME="investment-tracker-${OLD_COLOR}"

log "Active color: ${ACTIVE_COLOR:-none} -> deploying ${NEW_COLOR} on :${NEW_PORT}"

# Step 6: Build new image
log "Building Docker image..."
docker build --build-arg SW_BUILD_ID="${GIT_SHA:-}" -t "$IMAGE" . || error "Docker build failed"
log "Image built successfully"

# Step 7: Remove any stale container of the target color, then start the new one
log "Starting ${NEW_NAME} on port ${NEW_PORT}..."
docker rm -f "$NEW_NAME" 2>/dev/null || true
docker run -d \
  --name "$NEW_NAME" \
  --restart unless-stopped \
  -p "${NEW_PORT}:8080" \
  -v /data:/data \
  --env-file .env \
  "$IMAGE" || error "Failed to start ${NEW_NAME}"

# Step 8: Health check the NEW color before sending traffic to it
log "Health-checking ${NEW_NAME} (up to ~40s)..."
HEALTH_CHECK_RETRIES=20
HEALTH_CHECK_DELAY=2
RETRY=0
HEALTHY=0
while [ $RETRY -lt $HEALTH_CHECK_RETRIES ]; do
  if curl -sf "http://localhost:${NEW_PORT}/health" > /dev/null 2>&1; then
    HEALTHY=1
    log "Health check passed ✓"
    break
  fi
  RETRY=$((RETRY + 1))
  warn "Health check attempt ${RETRY} failed, retrying in ${HEALTH_CHECK_DELAY}s..."
  sleep $HEALTH_CHECK_DELAY
done

if [ "$HEALTHY" -ne 1 ]; then
  warn "New container ${NEW_NAME} failed health checks — aborting WITHOUT switching traffic."
  warn "Old container ${OLD_NAME} (if any) is still serving. Recent logs:"
  docker logs --tail 50 "$NEW_NAME" 2>&1 | sed 's/^/    /' || true
  docker rm -f "$NEW_NAME" 2>/dev/null || true
  error "Deployment aborted; production unchanged."
fi

# Step 9: Flip Caddy upstream to the new color (graceful, zero-downtime).
# Uses a single root helper (installed once) so the deploy user needs only one
# passwordless sudo entry. If the helper is missing (server not prepped yet) or
# the switch fails, we abort BEFORE removing the old container -> production
# stays up on the old color (fail-safe).
log "Switching Caddy upstream -> 127.0.0.1:${NEW_PORT}"
if ! sudo /usr/local/bin/investtrack-switch-upstream.sh "${NEW_PORT}"; then
  warn "Caddy upstream switch failed (helper missing or invalid config)."
  warn "Old container still serving; new container ${NEW_NAME} left running on :${NEW_PORT} for inspection."
  error "Deployment aborted at Caddy switch; production unchanged."
fi
log "Traffic now served by ${NEW_COLOR} ✓"

# Step 10: Retire the old color (keep it stopped for fast rollback) + legacy container
log "Stopping old container ${OLD_NAME} (kept for rollback)..."
docker stop "$OLD_NAME" 2>/dev/null || true
# Remove the pre-blue/green legacy fixed-8080 container if it still exists
docker rm -f investment-tracker 2>/dev/null || true

log "Deployment completed successfully! Live color: ${NEW_COLOR} (:${NEW_PORT})"
log "Rollback if needed:"
log "  docker start ${OLD_NAME} && sudo /usr/local/bin/investtrack-switch-upstream.sh ${OLD_PORT}"

exit 0
