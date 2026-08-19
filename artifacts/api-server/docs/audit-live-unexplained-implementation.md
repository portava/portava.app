# `audit:live-unexplained` — implementation & handback

**Branch:** `claude/bidirectional-auditor-20260819` (off canonical `main` `7fbf80652`)
**Delivers:** RECONCILIATION-PACKET.md Step 5 — the inverse (live → canonical) auditor.
**Status:** built + locally fixture-tested. NOT merged, NOT run against live, NOT wired
into the credentialed CI job (that job is owner-only, §6.6).

## Files
- `src/scripts/lib/liveVsCanonicalCore.ts` — pure, DB-free engine: `buildModel`,
  `computeUnexplained`, the five net-new extractors (constraints, extensions, function
  identity-args, policy predicates, column grants), the normalizers. No credential var,
  no client → intentionally unguarded (unreachable).
- `src/scripts/explainedLiveObjects.ts` — the EXPLAINED ledger + `validateLedgerShape`.
- `src/scripts/auditLiveVsCanonical.ts` — thin I/O shell. Guard import first; SELECT-only
  Management-API queries; reuses `liveQuery`/`fetchLiveSchema`/`parseMigration` +
  `parseBaselineTables` + `RLS_DISPOSITIONS`.
- `src/test/auditLiveVsCanonical.test.ts` — 29 fixture tests (all pass locally).
- edits: `auditMigrationsVsLive.ts` (export `parseMigration`/`liveQuery`/`fetchLiveSchema`;
  lazy projectRef; `main()` behind an entrypoint gate — **behavior-preserving for
  `audit:schema`**: same frozen-dir guards, same exit(2)/exit(1)/exit(0) contract),
  `package.json` (+`audit:live-unexplained`), `scripts/check-guard-coverage.mjs` (register
  the new read-only entry point).

## MODEL / contract
`MODEL = baseline_schema ∪ canonical files sorting >= "2100" ∪ EXPLAINED ledger` (full parse
of the baseline dump, not tables-only). Ten inventories. Exit `0` clean / `1` unexplained /
`2` cannot-establish (empty live census OR empty disposition manifest). RLS fourth failure
mode enforced (live table w/o record → 1; stale record → 1; class/live mismatch → 1;
vacuity → 2). Composition: the inverse RLS check owns only `live.relations MINUS rls-claim
tables`.

## Local verification done
- `node --test` fixture suite: **29 pass / 0 fail** (via a `.js→.ts` resolver shim; project
  normally uses tsx).
- `node --experimental-strip-types --check` on all edited/new TS: clean.
- `check-guard-coverage`: auditor correctly listed; **no new problems** (see pre-existing note).
- Hand-verified the `auditMigrationsVsLive.ts` diff is behavior-preserving for the CI gate.

## Post-build fixes applied (were reviewer "should" findings)
- **Trigger scope**: the inverse auditor now issues its own **public-scoped** trigger query
  instead of reusing `fetchLiveSchema`'s unscoped one (which would have flagged auth/storage
  system triggers as UNEXPLAINED_LIVE).
- **Disposition vacuity → exit 2**: added §5.4's fourth sub-case; new test covers it.

## Deferred — resolve against LIVE output in Replit (not silent gaps)
1. **Extensions seed**: baseline has zero `CREATE EXTENSION`; the ledger must enumerate the
   live `pg_extension` set (pgcrypto + whatever else — postgis/pg_graphql/vault/…). Until
   transcribed from the first live run, those extensions read as UNEXPLAINED_LIVE (by design —
   a forcing function).
2. **canonical >= "2100" is EMPTY today** (highest live file is 2095; the 2100+ work sits in
   `reconciliation-staging/`, not `src/migrations/`). So the E-class tables (`circles`,
   `compass_analytics`, `public_profile_verification`, `user_trust_scores`) and the undeclared
   `profiles` columns are explained by the **ledger only** for now; each flips to modelled once
   its corrective migration (2107/2108/2115/…) lands in `src/migrations/`.
3. **Routine (EXECUTE) grant excess** is collected on both sides but **not compared** — live
   keys by function identity-args, model `grantfn` keys by name only; reconciling the key
   format needs live output. Documented, not silently claimed.
4. **Ledger provenance strictness**: currently shape-checked (`file:line` regex), not resolved
   to a real file+line; strengthen once seed provenance is confirmed against live.
5. **deep_verifier** hard-gate = package.json script presence (the precedent
   `audit:shadow-append-only` is itself unreferenced by any workflow). Revisit if the owner
   wires the credentialed job.

## Pre-existing, NOT introduced here
`check:guard-coverage` already exits 1 on `7fbf80652` (main): `ogImageVisibility.test.ts` and
`storyMediaOwnership.test.ts` name a Supabase credential without importing a guard front door.
This branch adds no new guard-coverage problems.

## Replit handoff (owner / Claude Code)
1. `git fetch origin && git checkout claude/bidirectional-auditor-20260819`
2. `pnpm install` if needed, then confirm: `pnpm run audit:schema` still behaves as before.
3. **Read-only against PROD** (the sanctioned door, packet Step 8):
   `PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' pnpm run audit:live-unexplained`
   Expect a non-empty first-run finding set — triage each into "add to a >= 2100 migration"
   or "explain in the ledger", then re-run to green.
4. Clean-build proof job (§6.6) is **owner-only**; this deliverable stops at the npm script.
