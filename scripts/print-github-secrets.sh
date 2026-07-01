#!/usr/bin/env bash
# print-github-secrets.sh — prints the three GitHub Actions secrets required
# to make the pre-release CI workflow pass.
#
# Run this locally (never in CI) to get the values to paste into:
#   GitHub → Settings → Secrets and variables → Actions
#
# Required secrets:
#   SUPABASE_URL          — the Supabase project URL
#   SUPABASE_PROJECT_TOKEN — project-scoped read-only Supabase token (CI)
#   EXPO_TOKEN            — Expo account token (eas-build job only)
#
# See docs/eas-runbook.md → "DB triggers check in CI" for full instructions.

set -euo pipefail

REPO="passporttravelbuddy-ops/travel-buddy"
SECRETS_URL="https://github.com/${REPO}/settings/secrets/actions"

printf '\n'
printf '═══════════════════════════════════════════════════════════\n'
printf '  GitHub Actions secrets setup for: %s\n' "$REPO"
printf '═══════════════════════════════════════════════════════════\n'
printf '\n'
printf '  Open this URL to add secrets:\n'
printf '    %s\n' "$SECRETS_URL"
printf '\n'
printf '  ── Secret 1: SUPABASE_URL ──────────────────────────────\n'

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/artifacts/api-server/.env"
SUPABASE_URL=""
if [[ -f "$ENV_FILE" ]]; then
  SUPABASE_URL=$(grep -E "^SUPABASE_URL=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [[ -n "$SUPABASE_URL" ]]; then
  printf '  Value: %s\n' "$SUPABASE_URL"
else
  printf '  ✘  Could not read SUPABASE_URL from %s\n' "$ENV_FILE"
  printf '     Run this script from the repo root after configuring the API server .env\n'
fi

printf '\n'
printf '  ── Secret 2: SUPABASE_PROJECT_TOKEN ────────────────────\n'
printf '  Create at:\n'
printf '    Supabase dashboard → Project Settings → API → Project API tokens\n'
printf '    Click "Generate new token" → name it "github-ci-trigger-check"\n'
printf '    Scope: Read-only.  Copy the generated value.\n'
printf '\n'
printf '    Alternatively, a personal access token from:\n'
printf '    https://supabase.com/dashboard/account/tokens\n'
printf '    also works (but is tied to your account).\n'

printf '\n'
printf '  ── Secret 3: EXPO_TOKEN ────────────────────────────────\n'
printf '  Create at:\n'
printf '    https://expo.dev/accounts/<your-account>/settings/access-tokens\n'
printf '    (only needed for the eas-build job, which runs on release branches)\n'

printf '\n'
printf '  ── After adding all three secrets ──────────────────────\n'
printf '  Push any commit to main or open a PR to main to trigger\n'
printf '  the pre-release workflow and turn the badge green.\n'
printf '\n'
printf '  The badge URL is already in replit.md.\n'
printf '\n'
