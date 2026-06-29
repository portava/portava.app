#!/usr/bin/env bash
# Waits for Metro to be ready then pre-builds the Android bundle into cache.
# Run in the background after `expo start` so the tunnel never has to wait for
# a cold compile.
PORT="${PORT:-20682}"
BUNDLE_PATH="/node_modules/.pnpm/expo-router@6.0.24_@expo+metro-runtime@6.1.2_@types+react-dom@19.1.11_@types+react@19.1_8472e5b30deff9f5532c2616249b5deb/node_modules/expo-router/entry.bundle"
PARAMS="platform=android&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&transform.reactCompiler=true&unstable_transformProfile=hermes-stable"

echo "[prewarm] Waiting for Metro on port $PORT..."
for i in $(seq 1 60); do
  STATUS=$(curl -s --max-time 2 "http://localhost:$PORT/status" 2>/dev/null)
  if [ "$STATUS" = "packager-status:running" ]; then
    break
  fi
  sleep 2
done

if [ "$STATUS" != "packager-status:running" ]; then
  echo "[prewarm] Metro not ready after 120s — skipping"
  exit 1
fi

echo "[prewarm] Metro ready. Building Android bundle in background..."
START=$(date +%s)
HTTP=$(curl -s --max-time 600 -o /dev/null \
  -w "%{http_code}" \
  "http://localhost:$PORT${BUNDLE_PATH}?${PARAMS}" 2>/dev/null)
END=$(date +%s)
ELAPSED=$((END - START))

if [ "$HTTP" = "200" ]; then
  echo "[prewarm] Android bundle cached in ${ELAPSED}s — device loads will be instant"
else
  echo "[prewarm] Bundle request returned HTTP $HTTP after ${ELAPSED}s"
fi
