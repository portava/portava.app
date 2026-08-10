#!/usr/bin/env bash
#
# fix-drop2.sh — resolves the two MECHANICAL failures from apply-drop2.sh.
# Run from the repo root (~/workspace). Idempotent: safe to re-run.
#
# It does NOT touch the two EXEMPT classifications for auditStorageExif.ts and
# backfillFeedVariants.ts. Those are security-relevant assertions about files I
# have not read, and they belong to Claude Code, which wrote both.
#
# 1. MEMORY.md   — drifted, so apply-drop2 correctly skipped it. Your copy has
#                  Claude Code's overnight entries. This ADDS the 14 missing
#                  index lines and replaces the dead jsx-fragment-ternary link,
#                  without touching anything already there.
# 2. checkMediaObjects.ts — the anchored edit refused because I hand-patched this
#                  file on your machine earlier with different comment text, so it
#                  matched neither block. It is read-only (no .insert/.update/
#                  .upsert/.delete/.rpc anywhere; the only such hits are in doc
#                  comments), so it belongs behind the read-only door, which is
#                  what READ_ONLY_AUDIT_ENTRY_POINTS already says.

set -uo pipefail
M=.agents/memory/MEMORY.md
C=artifacts/api-server/src/scripts/checkMediaObjects.ts
red(){ printf '\033[31m%s\033[0m\n' "$*"; }; grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
[ -f "$M" ] || { red "no $M — run from the repo root"; exit 1; }
[ -f "$C" ] || { red "no $C — run from the repo root"; exit 1; }
cp "$M" "$M.pre-fix"; cp "$C" "$C.pre-fix"
echo "backed up to *.pre-fix"

echo; echo "-- 1. checkMediaObjects.ts -> read-only front door --"
if grep -q 'ciProdReadOnlyAuditGuard.mjs' "$C"; then
  echo "   already on the read-only door"
else
  perl -pi -e 's{\Qimport "../lib/ciSupabaseGuard.mjs";\E}{import "../lib/ciProdReadOnlyAuditGuard.mjs";}' "$C"
  perl -pi -e 's{\QSee src/lib/ciSupabaseGuard.mjs\E}{See src/lib/ciProdReadOnlyAuditGuard.mjs}' "$C"
  grep -q 'ciProdReadOnlyAuditGuard.mjs' "$C" && grn "   switched" || { red "   FAILED - restore: mv $C.pre-fix $C"; exit 1; }
fi
grep -n '^import ' "$C" | head -3 | sed 's/^/     /'

echo; echo "-- 2. MEMORY.md: replace the dead jsx-fragment-ternary line --"
python3 - <<'PYEOF'
import io,sys
p='.agents/memory/MEMORY.md'
s=open(p).read().split('\n')
lost="- **LOST, and contradicted \u2014 `jsx-fragment-ternary.md` was never written.** This line claimed \"`<>...</>` inside a ternary causes TS2657 in RN TypeScript projects; use a `<View>` wrapper instead\". The entry file it linked was never committed (`.agents/memory` has 4 commits; no add of that path in any of them), so this bullet was the whole of it. It is **not** being reconstructed, because the tree contradicts it: 20 `.tsx` files under `travel-buddy-standalone/` do exactly what it forbids (`travel-buddy-standalone/app/admin/media/index.tsx:173`, `travel-buddy-standalone/src/components/MediaFilterEditor.tsx:168`, `travel-buddy-standalone/app/trip/new.tsx:277`, \u2026) and are not excluded from typecheck. Re-derive with `grep -rlE '\\?\\s*<>|:\\s*<>' --include='*.tsx' .`. What is lost is whatever narrower condition made it true \u2014 a specific `jsxFactory`/`jsxFragmentFactory` config, or one file's tsconfig. If you hit TS2657 for real, write a fresh entry with the repro; do not restore this claim as stated."
hit=[i for i,l in enumerate(s) if 'jsx-fragment-ternary' in l]
if not hit: print('   no jsx-fragment-ternary line found - nothing to replace')
elif any('LOST, and contradicted' in s[i] for i in hit): print('   already replaced')
else:
    for i in hit: s[i]=lost
    open(p,'w').write('\n'.join(s)); print('   replaced line %d' % (hit[0]+1))
PYEOF
echo; echo "-- 3. MEMORY.md: append the 14 missing index lines --"
python3 - <<'PYEOF'
p='.agents/memory/MEMORY.md'
s=open(p).read()
adds = ["- [Scope account work by owner id, never by a content attribute](account-identity-by-id.md) \u2014 posts.source='seed_script' is not an ownership marker (a real active account owns 21 such posts); resolve to an id, re-read live, and count the predicate's matches before deleting.", "- [A green npm test covers no database behaviour](api-server-live-db-suites.md) \u2014 the api-server `test` script pins SUPABASE_URL to a dead port and omits rlsHardening / profileRoleNotSelfWritable / isOfficialPrivileged; run those three by name with real credentials.", "- [Compass \"For You\" data was dropped, not fabricated](compass-for-you-real-data-plumbing.md) \u2014 the hydrator's SELECTs omitted real lat/lng/image columns and the client hardcoded `lat: null`; before calling recommendation data fake, check the source table. Null coords made Directions silently anchor on the *viewer's* location (700+ km off) instead of failing.", "- [Counter updates must be atomic](counter-update-atomicity.md) \u2014 completion review rejects read-modify-write increments and array-length recounts; use a SECURITY DEFINER RPC with `GREATEST(0, col + delta)` plus a concurrency test. Also carries the sed recipe for the recurring api-server `package.json` test-list rebase conflict.", "- [Event drafts need a flattening mapper](event-drafts-flat-shape.md) \u2014 `event_drafts` rows are `{data: jsonb, last_saved_at}` but the client `EventDraft` type wants flat fields + `updatedAt`; returning the raw row yields \"Untitled draft\" / \"Saved Invalid Date\" and typechecks clean because both sides are `any` at the boundary. All four drafts endpoints.", "- [gpt-5-mini reasoning tokens eat the whole budget](gpt5-reasoning-token-budget.md) \u2014 empty completions are a token-budget symptom, not a prompt bug; set `reasoning_effort` (\"low\", or \"minimal\" for classifiers). Don't bump `max_completion_tokens` blind \u2014 compass test fakes match on the exact value.", "- [Never check production through DATABASE_URL](live-db-vs-local-postgres.md) \u2014 `DATABASE_URL` is read only by `lib/db` (pg/drizzle) and no api-server path reaches production through it, so querying it to check production gives a confident wrong answer. WHICH database it points at is an unverified runtime observation, not an in-tree fact \u2014 re-check before relying on it. Use the Management API `database/query` endpoint.", "- [messages.ciphertext schema drift](messages-ciphertext-schema-drift.md) \u2014 an unapplied E2EE migration broke **every** message send project-wide (`Could not find the 'ciphertext' column`), surfacing as an event-chat membership bug; on any \"send fails\" report check `db_error`/schema-cache first and diff live `information_schema.columns`.", "- [A migration file is not evidence, in either direction](migration-applied-vs-committed.md) \u2014 no runner, no schema_migrations table; committed \u2260 applied, and \"in no migration file\" \u2260 drift (numbered .sql is scattered across many roots \u2014 `find`, don't assume; check for a concurrent session first).", "- [OAuth SSO \u2014 Apple + Google](oauth-sso-implementation.md) \u2014 `expo-apple-authentication` + `signInWithIdToken` for Apple (iOS only), `signInWithOAuth` + `WebBrowser` + PKCE exchange for Google; why NOT `expo-auth-session` (config-plugins conflict breaks the lockfile check); Apple sends `fullName` on first auth only; needs an EAS rebuild.", "- [posts.media_urls drives rendering, not post_media](posts-media-urls-vs-post-media.md) \u2014 two independent media stores that can disagree; every render path reads media_urls, and cleaning one does not fix the other.", "- [RNTL/React 19 act-scope pollution](rntl-react19-act-pollution.md) \u2014 do not wrap a mocked `Alert.alert` async `onPress` in `act()`; the nested scope leaks and breaks the *next* test's render. Call the handler bare and await it. (Same family as `rntl-alert-act-overlap.md` and `rn-alert-onpress-act-poison.md`.)", "- [Stash reconciliation across a semantic rename](stash-reconciliation-semantic-drift.md) \u2014 never `git checkout stash@{N} -- <path>` wholesale after other work merged; a stash can carry an abandoned competing design that clobbers the merged one and surfaces days later as \"Property 'sN' does not exist\" in ~20 unrelated files. Diff stash vs HEAD per file, then typecheck immediately.", "- [Workflow count limit forces consolidation](workflow-count-limit.md) \u2014 the Replit cap is 10 workflows *including* artifact-managed service ones, so a 2-for-1 swap can still leave you over budget; merge single-purpose checks into one labelled sequential shell script that continues past failures and exits non-zero if any failed."]
added=[a for a in adds if a.split('](')[1].split(')')[0] not in s]
if not added:
    print('   all 14 already indexed')
else:
    if not s.endswith('\n'): s += '\n'
    s += '\n' + '\n'.join(added) + '\n'
    open(p,'w').write(s); print('   appended %d index line(s)' % len(added))
PYEOF

echo; echo "-- verifying --"
node artifacts/api-server/scripts/check-memory-citations.mjs 2>&1 | tail -8
echo "   citations exit=${PIPESTATUS[0]}"
echo
echo "REMAINING, and deliberately not touched here:"
echo "  auditStorageExif.ts and backfillFeedVariants.ts need EXEMPT entries in"
echo "  artifacts/api-server/scripts/check-guard-coverage.mjs. Hand those to Claude"
echo "  Code — it wrote both files and can state accurately what each does."
echo
echo "UNDO:  mv .agents/memory/MEMORY.md.pre-fix .agents/memory/MEMORY.md"
echo "       mv artifacts/api-server/src/scripts/checkMediaObjects.ts.pre-fix artifacts/api-server/src/scripts/checkMediaObjects.ts"
