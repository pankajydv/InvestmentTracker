#!/usr/bin/env bash
# Flip Caddy's reverse-proxy upstream to the given port, validate, and graceful-reload.
# Installed to /usr/local/bin/investtrack-switch-upstream.sh and invoked by the
# blue/green deploy via: sudo /usr/local/bin/investtrack-switch-upstream.sh <port>
# (allowed passwordless for the deploy user via /etc/sudoers.d/investtrack-caddy).
set -euo pipefail

PORT="${1:?usage: switch-upstream.sh <port>}"
UPSTREAM_FILE=/etc/caddy/investtrack-upstream.caddy

echo "reverse_proxy 127.0.0.1:${PORT}" > "$UPSTREAM_FILE"
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
