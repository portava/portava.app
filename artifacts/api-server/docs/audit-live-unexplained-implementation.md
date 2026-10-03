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

## Second re-run (20,186) → cleared to ~0

Grant-role scoping dropped 70,783 → 20,186. Diagnosed the rest from the saved
`/tmp/audit.txt` (no extra prod run) — three causes, all cleared:

- **19,712 of 20,003 EXCESS were grants to the owner `postgres`** (+97 service_role):
  pg_dump never emits owner/internal grants, so the model can't carry them. Scoped
  grant-excess to the untrusted client roles `{anon, authenticated, public}` — the
  mobile anon-key surfaces where excess is a real signal (`afc9161df`).
- **16 UNEXPLAINED + 194 anon/authenticated EXCESS + 1 disposition were postgis-owned**
  (`spatial_ref_sys`/`geometry_columns`/`geography_columns`). Excluded extension-owned
  objects via `pg_depend deptype='e'`, like the function query already did (`d963f0691`).
- **164 POLICY_PREDICATE_DRIFT + 3 functions were `public.` over-qualification**
  (`model='…public.x…'` vs `live='…x…'`). pg_get_expr/pg_get_function_identity_arguments
  never qualify `public`; pg_dump does. Stripped `public.` in the normalizers (`d963f0691`).
- **2 STALE + 2 unexplained extensions**: reconciled the ledger to the live set
  `{pgcrypto, plpgsql, pg_stat_statements, uuid-ossp, supabase_vault, postgis, unaccent}`.

Suite 38/38. Predicted next run: **exit 0**, or a tiny handful of genuine drift.

## The prediction above was wrong for 23 runs (corrected 2026-10-03)

`Predicted next run: exit 0` (line 150) has not held once. `.github/workflows/
clean-build-proof.yml` runs this audit on a nightly schedule and runs 1 through
23 (2026-09-10 → 2026-10-02) are all `failure`. It has never passed. It runs on
`schedule` only, so it gates no merge and no branch — which is why a
permanently-red check went 23 runs without an owner.

Run 23 (`b99787c8`, 2026-10-02) reported **2087 findings**:

| code | count |
|---|---|
| UNEXPLAINED_LIVE | 980 |
| EXCESS_PRIVILEGE | 912 |
| DISPOSITION_MISSING | 135 |
| POLICY_PREDICATE_DRIFT | 58 |
| STALE_LEDGER_ENTRY | 1 |
| DISPOSITION_STALE | 1 |

and the 980 `UNEXPLAINED_LIVE` break down as 672 constraints, 164 indexes, 104
policies, 17 columns, 15 triggers, 5 functions, 3 relations.

### It was not drift. The MODEL could not read the migrations.

Three model-side defects, none of them a property of the database:

1. **The SQL scanners were comment-blind.** `balancedParenBody`, `splitTopLevel`
   and `readStatement` tracked single-quoted literals but not comments. An
   APOSTROPHE IN A COMMENT — `0127's vocabularies`, in
   `2860_layover_airport_truth_and_events.sql:165`, inside the body of
   `CREATE TABLE airport_fact_observations` — therefore opened a string literal.
   It ran to the next apostrophe, the opening quote of a real CHECK literal
   three lines down, and from there every quote in the body was read with its
   polarity reversed: real literals counted as prose and comment apostrophes as
   delimiters. The paren depth ended at 2, `balancedParenBody` returned null on
   the unbalanced result, and the whole `CREATE TABLE` body was skipped — so
   every constraint that table declared, named or not, was absent from the
   model. Closed by
   `blankSqlComments`, which blanks comment bytes to spaces (length-preserving,
   so every index-based scan is unaffected) while passing string literals,
   quoted identifiers and `$$` bodies through untouched.

2. **Postgres-generated constraint names were not derived.** pg_dump writes
   every constraint as `ALTER TABLE … ADD CONSTRAINT <name>`, so the baseline
   names them all. A hand-written migration names almost none: `id uuid PRIMARY
   KEY`, `session_id uuid REFERENCES …`, `status text CHECK (…)` and `UNIQUE
   (session_id, dedup_key)` declare four constraints and name zero. Postgres
   names them itself and pg_constraint carries those names. `deriveImplicit
   Constraints` now reproduces the `ChooseConstraintName`/`makeObjectName`
   rules, including the numeric label suffix on a collision, the backing index a
   PK/UNIQUE creates, the `ALTER TABLE … ADD COLUMN … CHECK/REFERENCES` form
   (how a constraint reaches a BASELINE table — `media_assets_purge_status_
   check` from 2952, `compass_conversations_trip_id_fkey` from 2996) and
   `CREATE CONSTRAINT TRIGGER`, which is a contype-`t` pg_constraint row as well
   as a pg_trigger row (`cee_transaction_balances`, 3387).

3. **The canonical band had an off-by-one that no number can fix.** The file
   filter read `f.slice(0, 4) >= "2100"` on this document's own premise that
   nothing below 2100 post-dates the baseline. `2095_discovery_place_photos.sql`
   is the counter-example: the 2026-08-19 baseline dump contains no `CREATE
   TABLE public.discovery_place_photos`, so 2095 post-dates the capture, sat
   below the band, and its relation, its primary key and its two CHECK
   constraints were unexplainable by construction. No prefix encodes a date, so
   there is no boundary to move the band to — only the next off-by-one. The band
   is removed: the canonical set is every migration file.

### Measured, not predicted

Each of the 672 live constraint keys and 164 live index keys was read off run
23's log and replayed against the model built from the real baseline plus the
real migration set. **666 of 672 constraint findings and 160 of 164 index
findings are explained by the model after these three fixes.** The suite is
49/49, with 12 new cases transcribed from the migrations that produced the
findings — prose, unnamed constraints and all, because every fixture that
existed was written without either and that is why 23 red runs never reached
this file.

### What remains is NOT model-side, and some of it is real drift

* **6 constraints, 3 relations and 4 functions are genuine drift on
  portava-ci** — live objects no migration in the tree declares and the baseline
  does not contain. `sensing_anon_publications` and `sensing_anon_projection`
  (2 tables, 5 constraints, `sensing_record_contribution`,
  `sensing_publication_cas`, `purge_sensing_expired`) appear in no `.sql` file in
  the repository at all; so does `record_distribution_negative_signal`. And
  `highlights.highlights_expiry_is_permanent_or_dated` is a constraint on a
  BASELINE table that no migration declares. Nothing here drops or alters them:
  they are reported, and whoever owns that feature reconciles them into a
  migration or into the EXPLAINED ledger. The permanent-Highlights constraint
  overlaps the production-rollout work on 3502/2975 and is flagged to it rather
  than touched.

* **101 of the 104 policy findings are dynamic DDL and cannot be parsed from
  text, by nature.** `3390_discovery_rls_explicit_policies.sql:200-226` creates
  them in a plpgsql loop with `EXECUTE format('CREATE POLICY %I ON public.%I …')`
  over a temp table, and the `_clients`/`_anon` suffix of each name is decided at
  run time by a query against another temp table. No text parser can derive those
  names, and a parser that tried to interpret the loop would be guessing. The
  EXPLAINED ledger is the right home for them — that is what the ledger is for —
  and populating it is separate work, not a parser fix.

* `EXCESS_PRIVILEGE` (912), `DISPOSITION_MISSING` (135) and
  `POLICY_PREDICATE_DRIFT` (58) are untouched here and unmeasured against this
  change. The 135 missing dispositions are a consequence of the same tables
  being invisible to the model and should be re-measured after this lands rather
  than reasoned about.

* **`creator_ledger_erasure_policy_undecided()` was a clock artefact, not
  drift.** Run 23 checked out `b99787c8`, which predates the merge of #559;
  3510 declares that function and is on `main` now.

* **A PG 17 upgrade of portava-ci will turn this red again, loudly.** From 17,
  NOT NULL constraints are pg_constraint rows named `<table>_<column>_not_null`,
  and the live census filters no `contype`. Nothing in any migration text
  corresponds to them. That is a server-version fact to handle when the upgrade
  happens; `deriveImplicitConstraints` deliberately does not guess the names now.
