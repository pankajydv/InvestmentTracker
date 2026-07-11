# ── Stage 1: Build frontend ──────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/client
# Per-deploy service-worker cache version (git SHA when available); used by
# scripts/stamp-sw.mjs during `npm run build` for no-touch cache busting.
ARG SW_BUILD_ID=""
ENV SW_BUILD_ID=$SW_BUILD_ID
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: Production server ──────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Install build tools for better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# Copy server code
COPY server/ ./server/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/client/dist ./client/dist

# Create data directory for SQLite (will be mounted as persistent volume)
RUN mkdir -p /data

# Environment
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "server/index.js"]
