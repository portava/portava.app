#!/usr/bin/env bash
#
# assert-nonprod-supabase.sh — ALLOWLIST gate on the Supabase project CI talks to.
#
# Reads (from the environment):
#   SUPABASE_URL                — the project CI is about to point at
#   CI_SUPABASE_PROJECT_REF     — the ONE project ref CI is allowed to use,
#                                 supplied as a repo variable or secret
#   KNOWN_PROD_PROJECT_REF      — REQUIRED; a ref that is never acceptable even
#                                 if someone sets CI_SUPABASE_PROJECT_REF to it
#
# KNOWN_PROD_PROJECT_REF WAS OPTIONAL, AND THAT MADE THE SECONDARY ASSERTION
# DELETABLE IN ONE LINE, SILENTLY.
#
# It is set in exactly one place: the top-level `env:` block of
# .github/workflows/live-db.yml. This script used to guard its use with
# `[ -n "$KNOWN_PROD_PROJECT_REF" ]`, so deleting that single YAML line removed
# the production denylist entirely — and the script still printed
# "Supabase target verified" and exited 0, with one line of its output changed
# from "passed" to "SKIPPED". Reproduced: with the variable unset and both
# SUPABASE_URL and CI_SUPABASE_PROJECT_REF pointing at the production ref, this
# script exited 0. A guard whose removal is reported as a pass is not a guard.
#
# So an unset or malformed KNOWN_PROD_PROJECT_REF is now a HARD FAILURE, before
# anything else is evaluated. The cost is real and accepted: this script can no
# longer be run standalone without supplying it. That is the point — the caller
# must state what production is before it is allowed to write to a database.
#
# WHY AN ALLOWLIST
#
# This gate used to be a denylist of exactly one ref (production, copied out of
# .replit). A denylist answers "is this the one project I thought to forbid?".
# The question that matters is "is this the one project I sanctioned?" — and a
# denylist answers that wrongly for every ref nobody listed. That used to be
# argued from hypotheticals (a colleague's project, a customer's project, a typo
# that happens to resolve). It no longer needs to be. The demonstrated case is
# stronger than any of them:
#
#   Enumerating GET https://api.supabase.com/v1/projects with the CI credential
#   on 2026-08-11 returned THREE projects, all reachable by that one token:
#
#     zheztcvfhkwbouspesew   travel-buddy
#     hwokxgbmezheskbzskfr   portava-ci
#     ajrurzioarfkagpuxfnb   travel-buddy
#
# Two of the three carry the SAME display name. So this is not merely a case
# where an allowlist is safer than a denylist — A NAME-BASED ALLOWLIST COULD NOT
# HAVE WORKED AT ALL. "Allow the project called travel-buddy" resolves to two
# different databases, one of which is pinned below as production. Only a ref
# discriminates. That is why every comparison in this script is on the ref and
# never on a name, and why the same rule binds any human instruction that tells
# an operator which project to open.
#
# The same enumeration settled what the credential is: the token is account-level
# (sbp_ prefix, three projects returned), so it constrains nothing about which
# project is reached. The target check is the only thing on this axis.
#
# These jobs create and delete real auth users, promote and demote a test
# victim's role and is_official flag, and attempt a real INSERT into
# public.rank_events. Pointing them at an unsanctioned project is not a lesser
# failure than pointing them at production.
#
# So: CI runs if and only if the resolved project ref EQUALS the expected CI
# ref. Everything else — including an unset expectation, including an
# unparseable URL — fails closed.
#
# The production denylist is KEPT, demoted to a secondary assertion. It is the
# one case the allowlist cannot catch on its own: an operator setting the
# expected CI ref *to* production. Belt, then braces.
#
# A VERDICT WIDER THAN THE EVIDENCE
# =================================
#
# Everything above concerns WHICH PROJECT. It says nothing about WHICH
# MECHANISM, and until 2026-08-11 this script printed "Supabase target
# verified" — a sentence about targets — on the strength of a check about
# environment variables. That is not a wrong verdict. It is a verdict wider
# than the evidence, and the gap is invisible from the output.
#
# There are FOUR ways this repo can reach a Supabase database. Two are covered:
#
#   1. @supabase/supabase-js behind ciSupabaseGuard.mjs        — covered
#   2. the read-only audit path behind ciProdReadOnlyAuditGuard — covered
#   3. the Supabase CLI                                        — NOT covered
#   4. direct libpq via TRIGGER_PSQL_URL / ENGAGEMENT_PSQL_URL — NOT covered
#
# (1) and (2) are the "two front doors" the Node guards enumerate, and
# check:guard-coverage makes their coverage a fact. That coverage is real and
# it is not total: it is coverage of the module's own import surface, not of
# every path to the database.
#
# (3) is a separate binary that reads none of the guards. It resolves its
# target from supabase/.temp/linked-project.json — committed to this repo,
# pinning the PRODUCTION ref, until it was removed on 2026-08-11.
#
# (4) IS NOT MERELY UNGUARDED. IT IS STRUCTURALLY OUTSIDE THIS ARCHITECTURE.
# Every assertion in this file resolves a project ref and compares it. A libpq
# connection string carries no ref — there is no SUPABASE_URL to parse and
# nothing for the allowlist to bind to. The allowlist cannot be extended to
# cover it; it would have to be a different check on a different key. Calling
# that a gap understates it. scripts/check-db-triggers.sh:194-196 and
# scripts/check-engagement-indexes.sh:91-94 read those variables today under
# TRIGGER_QUERY_MODE=psql / ENGAGEMENT_QUERY_MODE=psql.
#
# So this script now asserts ITS OWN COVERAGE before it asserts anything about
# refs: if a mechanism it cannot see is present in the environment it is
# guarding, it refuses rather than reporting green about the part it can see.
# The static counterpart — `npx supabase`, which installs on demand and so is
# invisible to a PATH check — is in .github/scripts/assert-ci-scripts.mjs.
#
# WHAT THIS DOES NOT CLAIM
# ========================
#
# This closes the mechanisms ENUMERATED AS OF TODAY. The PSQL_URL pair was
# found roughly an hour after the CLI path, in the same shape, by the same
# question asked once more. The honest claim is "these are refused" — not
# "unsanctioned paths are impossible". Anyone adding a fifth way to reach a
# database is not defeating this script; they are outrunning its list, and the
# list is the thing to extend.
#
# It also defends CI ONLY. A developer laptop has no gate at all: nothing here
# runs there, and the same CLI and the same psql variables work exactly as
# well. A fix that oversells its own coverage is the same defect one level up,
# so this is stated rather than implied.

set -euo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

SUPABASE_URL="${SUPABASE_URL:-}"
CI_SUPABASE_PROJECT_REF="${CI_SUPABASE_PROJECT_REF:-}"
KNOWN_PROD_PROJECT_REF="${KNOWN_PROD_PROJECT_REF:-}"

# ── -1. COVERAGE PRECONDITIONS. Run before anything about refs. ──────────────
# Each of these means "a way to reach a database that nothing below can see is
# present in this job". The ref logic would still pass, and its pass would mean
# less than it says.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# -1a. The Supabase CLI, installed on the runner.
if command -v supabase >/dev/null 2>&1; then
  fail "The Supabase CLI is on PATH in this job. This guard cannot see a CLI invocation: it compares environment variables, while the CLI resolves its target from supabase/.temp/linked-project.json and its own SUPABASE_ACCESS_TOKEN. If it ran, every assertion below would still pass and would still print 'verified' — about a path the CLI was not on. Nothing in this repo sanctions the CLI in CI (see supabase/README.md). Remove the install step, or extend the guards to cover it before adding one."
fi

# -1b. Committed CLI target state anywhere in the checked-out tree.
# The checkout puts this on the runner whether or not any step uses it, so its
# presence is the precondition to refuse on, not its use.
LINK_STATE="$(find "$REPO_ROOT" -type d -name node_modules -prune -o -type f -name 'linked-project.json' -print 2>/dev/null | head -5)"
if [ -n "$LINK_STATE" ]; then
  fail "Committed Supabase CLI link state is present in the checked-out tree: $(printf '%s' "$LINK_STATE" | tr '\n' ' '). That file names a project ref and is read by the CLI, not by anything this guard inspects. It was committed to this repo pinning the PRODUCTION ref until 2026-08-11. CI has no legitimate use for it. Remove it from version control (see supabase/README.md)."
fi

# -1c. A Supabase CLI project marker with a pinned project_id.
CFG_HITS="$(find "$REPO_ROOT" -type d -name node_modules -prune -o -type f -path '*/supabase/config.toml' -print 2>/dev/null | head -5)"
for cfg in $CFG_HITS; do
  if grep -qE '^[[:space:]]*project_id[[:space:]]*=' "$cfg" 2>/dev/null; then
    fail "$cfg declares a project_id. That is a Supabase CLI project marker naming a target the CLI would adopt, and no guard here reads it. If the CLI is genuinely needed, give it a target on the command line instead. See supabase/README.md."
  fi
done

# -1d. A libpq connection string — mechanism (4) in the header.
# NOT a duplicate of the allowlist: a connection string carries no project ref,
# so the allowlist below has nothing to compare and would pass in silence.
# DB_URL and SUPABASE_DB_URL have no reader in this repo today and are refused
# anyway, because a name in a runbook eventually becomes a name in a workflow.
for psql_var in TRIGGER_PSQL_URL ENGAGEMENT_PSQL_URL SUPABASE_DB_URL DB_URL; do
  eval "psql_val=\${$psql_var:-}"
  if [ -n "$psql_val" ]; then
    fail "$psql_var is set in this job. It is a direct Postgres connection string, and the sanctioned path for these jobs is the Supabase Management API with the ref resolved from SUPABASE_URL. A libpq string carries no project ref, so every assertion below would pass without ever inspecting where that connection points. Unset it, or route the check through the Management API. (The value is not printed.)"
  fi
done

# ── 0. The production ref must be declared. No declaration, no run. ──────────
if [ -z "$KNOWN_PROD_PROJECT_REF" ]; then
  fail "KNOWN_PROD_PROJECT_REF is empty or not configured. It is set in the top-level 'env:' block of .github/workflows/live-db.yml, and it is the SECONDARY assertion that refuses to run even when the allowlist matches — the one case the allowlist cannot catch by itself is an operator setting CI_SUPABASE_PROJECT_REF *to* production. This used to be optional, which meant deleting that one YAML line silently removed the production denylist while this script still reported success. It is now required and fails closed: restore 'KNOWN_PROD_PROJECT_REF' in .github/workflows/live-db.yml (and in any other caller), set to the project ref of the PRODUCTION Supabase project. See docs/ci/README.md."
fi

if ! printf '%s' "$KNOWN_PROD_PROJECT_REF" | grep -qE '^[a-z0-9]+$'; then
  fail "KNOWN_PROD_PROJECT_REF is '$KNOWN_PROD_PROJECT_REF', which is not a bare project ref (lowercase letters and digits only). A value of the wrong shape can never equal a ref resolved from a URL, so the secondary production assertion below could never fire — it would be present, evaluated, and incapable of failing. It must be the '<project-ref>' portion of https://<project-ref>.supabase.co, not a full URL."
fi

# ── 1. The expectation itself must exist. No expectation, no run. ────────────
if [ -z "$CI_SUPABASE_PROJECT_REF" ]; then
  fail "CI_SUPABASE_PROJECT_REF is empty or not configured, so there is no sanctioned project to compare against and this job CANNOT verify what database it is about to write to. It fails closed. Set the repository variable (Settings -> Secrets and variables -> Actions -> Variables) or the environment secret CI_SUPABASE_PROJECT_REF to the project ref of the dedicated NON-PRODUCTION Supabase project — the '<project-ref>' in https://<project-ref>.supabase.co. See docs/ci/README.md."
fi

if ! printf '%s' "$CI_SUPABASE_PROJECT_REF" | grep -qE '^[a-z0-9]+$'; then
  fail "CI_SUPABASE_PROJECT_REF is '$CI_SUPABASE_PROJECT_REF', which is not a bare project ref (lowercase letters and digits only). It must be the '<project-ref>' portion of https://<project-ref>.supabase.co, not a full URL and not a key."
fi

# ── 2. The URL must be parseable, or it cannot be compared at all. ───────────
if [ -z "$SUPABASE_URL" ]; then
  fail "SUPABASE_URL is empty, so no project ref can be resolved. An unresolvable target is not a safe target."
fi

if ! printf '%s' "$SUPABASE_URL" | grep -qE '^https://[a-z0-9]+\.supabase\.co/?$'; then
  fail "SUPABASE_URL does not match https://<project-ref>.supabase.co — its project ref cannot be resolved, so it cannot be checked against the allowlist. An unverifiable target is treated as an unsafe one. (The value is not printed.)"
fi

ACTUAL_REF="$(printf '%s' "$SUPABASE_URL" | sed -E 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#')"

if [ -z "$ACTUAL_REF" ]; then
  fail "Could not extract a project ref from SUPABASE_URL even though it matched the expected shape. Refusing to proceed."
fi

# ── 3. THE ALLOWLIST. Exactly one acceptable value. ──────────────────────────
if [ "$ACTUAL_REF" != "$CI_SUPABASE_PROJECT_REF" ]; then
  fail "Supabase project ref '$ACTUAL_REF' is NOT the sanctioned CI project '$CI_SUPABASE_PROJECT_REF'. This is an allowlist, not a denylist: any ref other than the expected one fails, including a second production project nobody thought to list. These jobs create and delete real auth users, mutate profiles.role and profiles.is_official, and attempt a write probe against public.rank_events. Point SUPABASE_URL at the sanctioned non-production project, or update CI_SUPABASE_PROJECT_REF deliberately. See docs/ci/README.md."
fi

# ── 4. Secondary: the sanctioned ref must not itself be production. ──────────
# No `[ -n "$KNOWN_PROD_PROJECT_REF" ]` guard: it is non-empty and well-formed by
# step 0 above, or this script already exited. An assertion that can be switched
# off by removing the value it reads is not an assertion.
if [ "$ACTUAL_REF" = "$KNOWN_PROD_PROJECT_REF" ]; then
  fail "The resolved project ref '$ACTUAL_REF' is the PRODUCTION project recorded in .replit, and CI_SUPABASE_PROJECT_REF has been set to it. The allowlist matched, and this secondary assertion refuses anyway. These checks perform write probes against real auth users. Create a dedicated non-production project. See docs/ci/README.md."
fi

# The verdict names its own scope. "Supabase target verified" was a claim about
# targets backed by a check on environment variables; the difference was
# invisible from the output, which is what made it worth fixing.
echo "Supabase target verified FOR THE ENV-VAR PATH: the ref resolved from SUPABASE_URL matches the sanctioned CI project (allowlist)."
echo "  expected ref : $CI_SUPABASE_PROJECT_REF"
echo "  resolved ref : $ACTUAL_REF"
echo "  secondary production check: passed (resolved ref is not '$KNOWN_PROD_PROJECT_REF')."
echo "  coverage preconditions: passed — no Supabase CLI on PATH, no committed link state or"
echo "                          project_id marker in the tree, no libpq connection string set."
echo "  NOT verified here: anything that reaches a database without resolving a ref from"
echo "                     SUPABASE_URL. Those mechanisms are refused above, not inspected."
# There is deliberately no "SKIPPED" branch here any more. A skipped assertion
# printed alongside "verified" is how this guard reported its own removal as a
# pass.
