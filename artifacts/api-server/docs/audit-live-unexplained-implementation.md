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

## First read-only prod run (2026-08-19): 70,783 → grant-semantics fixes

The first `audit:live-unexplained` read-only run against prod returned **70,783
findings**. Diagnosed locally against the real 38k-line baseline (via a guard-free
copy of the parser): **not** a parse failure — `buildModel` captures constraints
(1436), indexes (697), policies (741), functions (76), triggers (23), tableGrants
(1220) from the dump. The flood was two Postgres grant semantics a naive exact-set
compare ignored, plus an enum gap:

- **`GRANT ALL`** is stored as the single privilege `"all"` in the dump, but
  `role_table_grants` never returns `all` — it returns each implied privilege as
  its own row. A model `"all"` now covers them all.
- **Column grants** — `role_column_grants` derives one row per column from a
  TABLE-level grant. A live column privilege is now explained if the model grants
  it (or ALL) on the column **or** on the whole table for that grantee.
- **Enum values** — labels live in the `CREATE TYPE … AS ENUM ( … )` body that
  pg_dump emits; `parseMigration` only read `ALTER TYPE ADD VALUE`. Added
  `extractEnumValues` (0 → 360 modelled).

**Validated locally** by synthesizing a self-consistent live from the baseline with
Postgres grant expansion (12,339 derived column grants): `EXCESS_PRIVILEGE` → **0**
(was the bulk of the 70,783). Fixture suite 33/33.

Residual expected on the next real run: the **extension seed** (owner reconciles
against `select extname from pg_extension`, per the ledger header — e.g. postgis,
unaccent were unexplained), any true `POLICY_PREDICATE_DRIFT`, and genuine drift.
Re-run after these fixes are pushed to see the collapsed set.

## Preemptive derivation-gap fixes (before re-run)

The grant flood was the largest but not the only Postgres live-vs-dump derivation
gap. Diagnosed the rest locally against the real baseline and fixed them so the
next real run collapses in one step:

- **Constraint-backed indexes** — Postgres auto-creates an index (named after the
  constraint) for every PRIMARY KEY / UNIQUE; pg_indexes lists them, pg_dump emits
  ADD CONSTRAINT. 393 PK + 121 UNIQUE = 514 were missing. model.indexes 697 → 1211.
- **View/matview columns** — information_schema.columns includes them; the model
  (CREATE TABLE only) has none. Now audits base-table (relkind r/p) columns only.

Sampled the model's function identity keys (`admin_set_profile_role(uuid,text)`)
and policy predicates (`((reviewer_id = auth.uid()) AND (entity_type =
'place'::public.review_entity_type))`) against the real baseline — both read as
clean pg_get_expr / identity-argument output, so POLICY_PREDICATE_DRIFT and
function-overload findings should be near-zero on re-run.

**Predicted re-run:** ~70,783 collapses to a small, triageable set — the documented
extension seed (owner reconciles against `pg_extension`), genuine post-baseline
drift, and possibly a few auto-named CHECK-constraint mismatches. Suite 35/35.

Branch: feat 6f8d3fe12 → grant semantics d17419a7c → constraint-backed indexes
89254ce9d → view columns 237e9ce2c. Awaiting the owner's Mac-side push of the
branch, then the Replit re-run.
