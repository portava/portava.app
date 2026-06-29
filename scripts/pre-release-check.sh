#!/usr/bin/env bash
# pre-release-check.sh — run all four CI validation steps before cutting an EAS build.
#
# Usage (from the workspace root):
#   bash scripts/pre-release-check.sh
#
# Exits 0 only when every check passes. Any failure prints a summary and exits 1.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

PASS=0
FAIL=1

results=()        # "PASS|<name>" or "FAIL|<name>|<detail>"
overall=$PASS

sep() { printf '%s\n' "$(printf '─%.0s' {1..60})"; }

run_check() {
  local name="$1"
  local label="$2"
  shift 2
  printf '\n'
  sep
  printf '▶  %s\n' "$label"
  sep
  if "$@"; then
    results+=("PASS|${name}")
    printf '✔  %s passed\n' "$name"
  else
    results+=("FAIL|${name}|exit code $?")
    overall=$FAIL
    printf '✘  %s FAILED\n' "$name"
  fi
}

# ── 1. Monorepo typecheck ────────────────────────────────────────────────────
run_check "typecheck" \
  "TypeScript — monorepo (all workspace packages)" \
  pnpm run typecheck

# ── 2. Standalone typecheck ──────────────────────────────────────────────────
run_check "typecheck-standalone" \
  "TypeScript — travel-buddy-standalone" \
  bash -c 'cd travel-buddy-standalone && pnpm typecheck'

# ── 3. Dependency drift ──────────────────────────────────────────────────────
run_check "dependency-drift" \
  "Dependency drift (artifacts/travel-buddy vs standalone)" \
  bash scripts/sync-standalone.sh --check-deps

# ── 4. Source drift ──────────────────────────────────────────────────────────
run_check "source-drift" \
  "Source drift (synced directories)" \
  bash scripts/sync-standalone.sh --check-source

# ── 5. API server build ───────────────────────────────────────────────────────
run_check "api-server-build" \
  "API server esbuild bundle (artifacts/api-server)" \
  pnpm --filter @workspace/api-server run build

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n'
sep
printf '  PRE-RELEASE CHECK SUMMARY\n'
sep
for entry in "${results[@]}"; do
  status="${entry%%|*}"
  rest="${entry#*|}"
  name="${rest%%|*}"
  if [[ "$status" == "PASS" ]]; then
    printf '  ✔  %-30s PASS\n' "$name"
  else
    detail="${rest#*|}"
    printf '  ✘  %-30s FAIL  (%s)\n' "$name" "$detail"
  fi
done
sep

if [[ "$overall" -eq $PASS ]]; then
  printf '\nAll checks passed — safe to trigger an EAS build.\n\n'
  exit 0
else
  printf '\nOne or more checks failed. Fix the issues above before building a release.\n'
  printf 'See replit.md → "Release checklist" for remediation steps.\n\n'
  exit 1
fi
