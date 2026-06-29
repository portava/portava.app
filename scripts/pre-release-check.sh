#!/usr/bin/env bash
# pre-release-check.sh — run all five CI validation steps before cutting an EAS build.
#
# Usage (from the workspace root):
#   bash scripts/pre-release-check.sh
#
# Exits 0 only when every check passes. Any failure prints a summary and exits 1.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# ── Required-tool preflight ──────────────────────────────────────────────────
# Shell-level prerequisites for this script and the sync helpers it calls.
# tsc is resolved through pnpm package scripts (node_modules/.bin) and does
# not need to be on PATH.  eas and expo are only required when you intend to
# trigger an EAS build — they are checked here so a missing CLI fails fast
# rather than partway through a build.
#
# Tool      Why needed
# -------   -----------------------------------------------------------------
# bash      explicit sub-shell calls in run_check (bash -c / bash scripts/…)
# git       sync-standalone.sh uses git diff for source-drift checks
# node      pnpm runs on Node; also used directly by build scripts
# pnpm      all package installs and workspace script execution
# eas       EAS build / submit commands (eas-cli, must be installed globally)
# expo      Expo CLI — expo export and doctor steps in CI

declare -A tool_fix=(
  [bash]="install Bash 4+ (macOS: brew install bash; Linux: apt-get install bash)"
  [git]="install Git (https://git-scm.com/downloads or your OS package manager)"
  [node]="use Node Version Manager (nvm) or actions/setup-node in CI"
  [pnpm]="corepack enable && corepack prepare pnpm@latest --activate"
  [eas]="npm install -g eas-cli  (or pnpm add -g eas-cli)"
  [expo]="npm install -g expo-cli  (or pnpm add -g expo-cli)"
)

missing_tools=()
for tool in bash git node pnpm eas expo; do
  if ! command -v "$tool" &>/dev/null; then
    missing_tools+=("$tool")
  fi
done
if [[ ${#missing_tools[@]} -gt 0 ]]; then
  printf '\n❌  pre-release-check: required tool(s) not found on PATH:\n'
  for t in "${missing_tools[@]}"; do
    printf '      • %-8s  fix: %s\n' "$t" "${tool_fix[$t]}"
  done
  printf '\nInstall the missing tool(s) and re-run.\n'
  printf 'See docs/eas-runbook.md → "Required tools" for full install instructions.\n\n'
  exit 1
fi

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
