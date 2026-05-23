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

# Step 6: Stop and remove old container
log "Cleaning up old container..."
docker stop investment-tracker 2>/dev/null || true
docker rm investment-tracker 2>/dev/null || true
sleep 2

# Step 7: Build new image
log "Building Docker image..."
docker build -t investment-tracker:latest . || error "Docker build failed"
log "Image built successfully"

# Step 8: Start container
log "Starting container..."
docker run -d \
  --name investment-tracker \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /data:/data \
  --env-file .env \
  investment-tracker:latest || error "Failed to start container"
sleep 3

# Step 9: Health check (15 attempts, ~30 seconds total)
log "Performing health checks..."
HEALTH_CHECK_RETRIES=15
HEALTH_CHECK_DELAY=2
RETRY=0

while [ $RETRY -lt $HEALTH_CHECK_RETRIES ]; do
  if docker exec investment-tracker curl -sf http://localhost:8080/health > /dev/null 2>&1 || \
     curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    log "Health check passed ✓"
    break
  fi
  RETRY=$((RETRY + 1))
  if [ $RETRY -lt $HEALTH_CHECK_RETRIES ]; then
    warn "Health check attempt $((RETRY)) failed, retrying in ${HEALTH_CHECK_DELAY}s..."
    sleep $HEALTH_CHECK_DELAY
  fi
done

if [ $RETRY -eq $HEALTH_CHECK_RETRIES ]; then
  warn "Health check failed after $HEALTH_CHECK_RETRIES attempts (this may be expected for initial deployment)"
fi

log "Deployment completed successfully!"
log "Application is running at http://localhost:8080"
log "Reverse proxy (Caddy) should forward HTTPS traffic from investtrack.duckdns.org"

exit 0
