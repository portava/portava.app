#!/usr/bin/env bash
#
# apply-discovery-gap.sh
#
# Adds one findings document. No code changes — deliberately.
# Run from the REPO ROOT (~/workspace) after unzipping discovery-gap.zip there.
#
# WHY NO CODE: the obvious fix (move logImpression so cached paths log too)
# is not implementable. logImpression requires ScoredCandidate[] with the
# ranker's feature vectors; cached paths serve DiscoveryPlace objects with no
# features, because no ranking ran. Which means Discovery's zero rows may not
# be a logging bug at all — it may be that Discovery ranking essentially never
# executes in production. Three candidate causes, each with a different fix,
# and they are separable from existing production logs. The doc says how.
set -uo pipefail
ROOT="$(pwd)"; STAGE="$ROOT/_discovery-gap"
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }; ylw(){ printf '\033[33m%s\033[0m\n' "$*"; }
red(){ printf '\033[31m%s\033[0m\n' "$*"; }; fail(){ red "✗ $*"; exit 1; }

echo "── discovery impression gap ──"
[ -d "$ROOT/artifacts/api-server" ] || fail "Run from the repo root (~/workspace)."
[ -d "$STAGE" ] || fail "No _discovery-gap/ here. Unzip discovery-gap.zip at the repo root first."

DST="$ROOT/docs/algorithm/discovery-impression-gap.md"
if [ -f "$DST" ]; then ylw "  • already exists — skipping"; else
  mkdir -p "$ROOT/docs/algorithm"
  cp "$STAGE/docs/algorithm/discovery-impression-gap.md" "$DST"
  grn "  wrote docs/algorithm/discovery-impression-gap.md"
fi

# Sanity: the code this reasons about should still look the way it did.
if ! grep -qF 'void logImpression(servedScored, callerUserId, "discovery");' \
     "$ROOT/artifacts/api-server/src/routes/discovery.ts" 2>/dev/null; then
  ylw "  ! discovery.ts no longer matches — the call site moved or changed."
  ylw "    Re-read the doc before acting on it."
fi

echo
cat <<'EOF'
Doc only — no tests, no typecheck impact, no count should move.

THE NEXT STEP IS A LOG COUNT, NOT A CODE CHANGE. Over a representative
window, count these three in production logs:

  "discovery: cache hit"                   (line 1104)
  "discovery: compass candidate cache hit" (line 1227)
  "discovery: cold fetch"                  (line 1439)

  almost no cold fetch      -> ranking never runs; this is a cache-policy
                               question, not a logging one
  cold fetch present, still
  zero rows                 -> unauthenticated traffic, or the ranker
                               returns nothing on the Discovery path

Commit:
  cd ~/workspace && git add docs/algorithm/discovery-impression-gap.md \
    && git commit -m "docs(ranking): discovery logs zero impressions — three causes, evidence needed"

Cleanup:
  rm -rf _discovery-gap apply-discovery-gap.sh discovery-gap.zip
EOF
