#!/usr/bin/env bash
# android-dev.sh — start the standalone Expo dev server and print the
# correct manual connection URL for physical Android devices.
#
# Usage (via package.json scripts):
#   pnpm run dev           # prints the Android URL and starts Metro
#   pnpm run dev:android   # same, but clears Metro cache first (--clear)
#
# The tunnel domain is read dynamically from $REPLIT_EXPO_DEV_DOMAIN.
# If Replit ever rotates the domain, the printed URL updates automatically
# with no code change needed.

set -e

TUNNEL_URL="https://${REPLIT_EXPO_DEV_DOMAIN}"

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║          ANDROID DEV BUILD — MANUAL CONNECTION                   ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  1. Open the Travel Buddy development build on your device.      ║"
echo "║  2. Tap  ›  Enter URL manually                                   ║"
echo "║  3. Paste the URL below and tap Connect.                         ║"
echo "║                                                                  ║"
echo "  ${TUNNEL_URL}"
echo "║                                                                  ║"
echo "║  ⚠  Do NOT scan the Replit preview QR code.                     ║"
echo "║  ⚠  Do NOT use Expo Go — use the EAS development build.         ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Health-check Metro tunnel before Expo starts (best-effort; non-fatal)
if curl -sf --max-time 5 -o /dev/null "${TUNNEL_URL}"; then
  echo "✓ Metro tunnel is reachable at ${TUNNEL_URL}"
else
  echo "⚠ Could not reach ${TUNNEL_URL} yet — Metro may still be warming up."
fi
echo ""

export EXPO_PACKAGER_PROXY_URL="${TUNNEL_URL}"
export EXPO_PUBLIC_DOMAIN="${REPLIT_DEV_DOMAIN}"
export EXPO_PUBLIC_REPL_ID="${REPL_ID}"
export REACT_NATIVE_PACKAGER_HOSTNAME="${REPLIT_DEV_DOMAIN}"

# Guard: Replit may inject PORT=8080 (the API server's port) as the system
# default. The artifact system sets PORT=20682 via [services.env], but if that
# override is not applied, fall back to 20682 so Metro never conflicts with the
# API server.
EXPO_PORT="${PORT:-20682}"
if [ "$EXPO_PORT" = "8080" ]; then
  EXPO_PORT="20682"
fi
exec expo start --dev-client --localhost --port "$EXPO_PORT" "$@"
