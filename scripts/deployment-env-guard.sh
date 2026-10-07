#!/usr/bin/env bash
# deployment-env-guard.sh — a BETA build can never bake in PRODUCTION.
#
# The shell twin of artifacts/api-server/src/lib/deploymentEnvironment.ts, run by
# scripts/build-production.sh BEFORE anything is built. The web bundle that
# travel-buddy-standalone/scripts/build.js produces inlines every EXPO_PUBLIC_*
# value at build time, so a beta deployment that inherited .replit's production
# EXPO_PUBLIC_SUPABASE_URL would ship a client that talks to production even if
# the API itself refused to start.
#
#   PORTAVA_DEPLOYMENT_ENV unset/""  → no label (production today). Allowed, except
#                                       SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL naming
#                                       the beta project, which needs the beta label.
#   PORTAVA_DEPLOYMENT_ENV=production → allowed, same exception.
#   PORTAVA_DEPLOYMENT_ENV=beta       → EXPO_PUBLIC_SUPABASE_URL AND SUPABASE_URL must be
#                                       exactly https://emfpckykpzfturllshly.supabase.co
#                                       (optional trailing slash), and no variable may
#                                       name production — its ref, its API host
#                                       portava.replit.app (case-insensitively) or its
#                                       publishable key (the one .replit commits) — or
#                                       hold a LIVE-mode provider credential (Stripe
#                                       sk_live_/rk_live_/pk_live_, Persona
#                                       persona_production_, a Sumsub prd: app token);
#                                       PAYMENTS_ALLOW_LIVE must be unset, empty or
#                                       "false" (named, never printed).
#   anything else                     → refused (a typo must not switch the guard off).
#   any label but beta, with REPLIT_DOMAINS naming portava-beta.replit.app → refused:
#                                       the beta fork must be labelled, or it builds
#                                       whatever .replit's inherited values point at.
#
# The API's rule additionally demands NODE_ENV=production for a beta process; the
# build does not (the case table in beta-deployment-guard.test.ts states both).
#
# Exit 0 = build may proceed; exit 1 = refused (one line naming the variable).
# scripts/src/beta-deployment-guard.test.ts runs this script and the TypeScript
# rule over one case table so the two cannot drift.
set -uo pipefail

BETA_REF="emfpckykpzfturllshly"
PROD_REF="ajrurzioarfkagpuxfnb"
# Production's publishable key (public; committed in .replit [userenv.shared], so a fork inherits it).
PROD_PUBLISHABLE_KEY="sb_publishable_xp3JiB50mBYHn1S_XjzOAg_rIoEqZKS"
VAR="PORTAVA_DEPLOYMENT_ENV"

refuse() {
  echo "[deployment-env-guard] REFUSING TO BUILD ($VAR): $1" >&2
  exit 1
}

# https://<ref>.supabase.co[/] -> ref ; anything else -> empty
ref_of() {
  case "$1" in
    https://*.supabase.co|https://*.supabase.co/) ;;
    *) echo ""; return ;;
  esac
  local r="${1#https://}"
  r="${r%/}"
  r="${r%.supabase.co}"
  case "$r" in
    *[!a-z0-9]*|"") echo "" ;;
    *) echo "$r" ;;
  esac
}

LABEL="${PORTAVA_DEPLOYMENT_ENV:-}"
case "$LABEL" in
  ""|production|beta) ;;
  *) refuse "$VAR is set to an unrecognised value. Accepted: production, beta, or unset. An unrecognised label is refused rather than ignored, because ignoring it would switch the beta guard off." ;;
esac

API_REF="$(ref_of "${SUPABASE_URL:-}")"
WEB_REF="$(ref_of "${EXPO_PUBLIC_SUPABASE_URL:-}")"

if [ "$LABEL" = "beta" ]; then
  [ "$WEB_REF" = "$BETA_REF" ] || refuse "$VAR=beta but EXPO_PUBLIC_SUPABASE_URL is not the portava-beta project (https://$BETA_REF.supabase.co). The web bundle inlines it; refusing to build a beta client against another project."
  [ "$API_REF" = "$BETA_REF" ] || refuse "$VAR=beta but SUPABASE_URL is not the portava-beta project (https://$BETA_REF.supabase.co)."
  NAMING=""
  LIVE=""
  PROD_KEY_LC="$(printf '%s' "$PROD_PUBLISHABLE_KEY" | tr 'A-Z' 'a-z')"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    value="$(printenv "$name" 2>/dev/null)" || continue
    # Case-insensitive, like the API rule (namesProduction): production's ref
    # or publishable key anywhere, or production's API host as a host
    # (portava-beta.replit.app is not it). grep -E, so the boundary is the same
    # expression in both places.
    if printf '%s' "$value" | tr 'A-Z' 'a-z' | grep -qE "$PROD_REF|$PROD_KEY_LC|(^|[^a-z0-9-])portava\.replit\.app([^a-z0-9-]|\$)"; then
      NAMING="${NAMING:+$NAMING, }$name"
    fi
    # Case-SENSITIVE, like the API rule (holdsLiveCredential): documented live prefixes.
    if printf '%s' "$value" | grep -qE '(^|[^A-Za-z0-9])(sk_live_|rk_live_|pk_live_|persona_production_)'; then
      LIVE="${LIVE:+$LIVE, }$name"
    else
      case "$name" in
        SUMSUB_*) if printf '%s' "$value" | grep -qE '^[[:space:]]*prd:'; then LIVE="${LIVE:+$LIVE, }$name"; fi ;;
      esac
    fi
  done <<EOF
$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort -u)
EOF
  [ -z "$NAMING" ] || refuse "$VAR=beta but these variables name production (its project ref, portava.replit.app or its publishable key): $NAMING. Replace each with its portava-beta value (values are not printed)."
  case "${PAYMENTS_ALLOW_LIVE-}" in
    ""|false) ;;
    *) case ", $LIVE," in *", PAYMENTS_ALLOW_LIVE,"*) ;; *) LIVE="${LIVE:+$LIVE, }PAYMENTS_ALLOW_LIVE" ;; esac ;;
  esac
  [ -z "$LIVE" ] || refuse "$VAR=beta but these variables hold a LIVE-mode provider credential or permit live mode: $LIVE. The beta uses provider test/sandbox keys only and never sets PAYMENTS_ALLOW_LIVE (values are not printed)."
  echo "[deployment-env-guard] $VAR=beta: SUPABASE_URL and EXPO_PUBLIC_SUPABASE_URL name portava-beta; no variable names production."
  exit 0
fi

if printf '%s' "${REPLIT_DOMAINS:-}" | tr 'A-Z' 'a-z' | grep -qE '(^|[^a-z0-9-])portava-beta\.replit\.app([^a-z0-9-]|$)'; then
  refuse "REPLIT_DOMAINS names the beta origin portava-beta.replit.app but $VAR is ${LABEL:-unset}. The beta fork must declare $VAR=beta (as a Secret), or it builds whatever .replit's inherited values point at, which is production."
fi

if [ "$API_REF" = "$BETA_REF" ] || [ "$WEB_REF" = "$BETA_REF" ]; then
  refuse "a Supabase URL names the portava-beta project but $VAR is ${LABEL:-unset}. The beta project is built only by a deployment labelled $VAR=beta."
fi
exit 0
