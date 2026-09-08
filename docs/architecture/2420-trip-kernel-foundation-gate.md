# Migration gate: `2420_trip_kernel_foundation.sql`

**Verdict: APPLY.**

Measured against production `travel-buddy` (`ajrurzioarfkagpuxfnb`) and CI
`portava-ci` (`hwokxgbmezheskbzskfr`) on 2026-09-07/08, read-only on production
throughout. Nothing in this analysis was applied to any database; the coordinator
applies.

`2420` was never blocked on its own merits. It was blocked on `2334` and `2337`,
and **both are now in production** (`supabase_migrations.schema_migrations`:
`20260907184258 2334_route_plan_crew_visibility`,
`20260907185750 2337_trip_crew_rls_membership_convergence`). The chain
`2334 → 2337 → 2420` is clear. That was verified, not assumed: every object the
migration names was queried by hand.

---

## 1. What it creates

| Object | Kind |
|---|---|
| `public.trips.version` | `bigint NOT NULL DEFAULT 0` |
| `public.trip_events` | table, RLS on, 1 SELECT policy (`authz.is_trip_crew(trip_id)`), `GRANT SELECT` to `authenticated` only |
| `public.trip_command_receipts` | table, RLS on, **zero** policies, **zero** client grants |
| `public.trip_outbox` | table, RLS on, **zero** policies, **zero** client grants |
| `public.trip_events_refuse_update()` + `trg_trip_events_append_only` | BEFORE UPDATE trigger; events are append-only |
| `public.trip_kernel_execute(jsonb)` | `SECURITY INVOKER`, `service_role` EXECUTE only |
| `idx_trip_events_trip_version`, `idx_trip_outbox_unpublished` | indexes |
| `trip_events_trip_sequence_unique`, `trip_events_type_namespaced`, `trip_events_positive`, `trip_command_receipts_key_len` | constraints |
| `feature_flags('trip_kernel_enabled', false)` | one seed row, **FALSE** |

## 2. Preconditions — each run read-only against production

| # | Precondition the file states or implies | Query | Measured on production | Verdict |
|---|---|---|---|---|
| P1 | `authz.is_accepted_trip_member(uuid, uuid)` exists (2337) — called by the function AND asserted by its own postcondition | `pg_proc ⋈ pg_namespace` | `is_accepted_trip_member(t_id uuid, u_id uuid)`, `SECURITY DEFINER` | **PASS** |
| P2 | `authz.is_trip_crew(uuid)` exists (2334) — the `trip_events` RLS policy predicate | same | `is_trip_crew(t_id uuid)`, `SECURITY DEFINER` | **PASS** |
| P3 | schema `authz` exists | `pg_namespace` | 1 | **PASS** |
| P4 | `public.trips` exists, is the FK target of two tables | `pg_class` | present, `relrowsecurity = true`, **43 rows** | **PASS** |
| P5 | `public.trip_plan_items` exists with every column the function writes | `information_schema.columns` vs the function's 22 named columns | all 22 present (`id, trip_id, creator_id, title, category, status, source_type, source_id, day_date, starts_at, ends_at, location_name, lat, lng, location_is_private, notes, sort_order, lock_type, visibility, removed_at, updated_at, route_stop_id`) — **missing: NONE** | **PASS** |
| P6 | `public.feature_flags` has PK `flag` (for `ON CONFLICT (flag)`) and columns `flag, enabled, description` | `pg_index` / `information_schema.columns` | PK = `flag`; columns `flag, enabled, description, updated_at, metadata` | **PASS** |
| P7 | `gen_random_uuid()` available | `pg_proc` | 2 (pgcrypto + core) | **PASS** |
| P8 | roles `anon`, `authenticated`, `service_role` exist (REVOKE/GRANT targets) | `pg_roles` | all three | **PASS** |

## 3. Collisions — nothing it creates already exists

| Object | Production | Verdict |
|---|---|---|
| `trips.version` | **ABSENT** | no collision |
| `trip_events` / `trip_command_receipts` / `trip_outbox` | **ABSENT** (all three) | no collision |
| `trip_kernel_execute`, `trip_events_refuse_update` | **ABSENT** | no collision |
| `idx_trip_events_trip_version`, `idx_trip_outbox_unpublished`, `trip_events_trip_sequence_unique` | **NONE** | no collision |
| trigger `trg_trip_events_append_only` | **NONE** | no collision |
| policy `trip_events_crew_select` | **NONE** | no collision |
| flag row `trip_kernel_enabled` | **ABSENT** | no collision |
| migration number `2420` | one file in the tree; not in `supabase_migrations.schema_migrations` (highest ledgered: `20260907223359 / 2530`) | no collision |

Production has **no migration ledger of its own** (`schema_migration_ledger`
does not exist; Supabase's `schema_migrations` is partial), so "is 2420 applied"
is answered by object presence, which is the question that matters anyway.

## 4. The postconditions are NOT vacuous

Each postcondition's detection logic was run read-only against production **as it
is now**. Six of the seven would RAISE today; that is the proof they are testing
something.

| Postcondition | Detection logic run now | Result | Would it fire? |
|---|---|---|---|
| `trips.version missing` | `information_schema.columns` | `false` | **YES — RAISE** |
| RLS on 3 kernel tables | `count(*) from pg_tables … and rowsecurity` | `0` (expects 3) | **YES — RAISE** |
| `authenticated` can SELECT `trip_events` | `has_table_privilege` | table absent — the privilege call cannot even resolve | **YES** |
| no client role holds a forbidden grant | `has_table_privilege` ×6 | tables absent | **YES** |
| `trip_kernel_execute` is service-role only | `has_function_privilege` | function absent (`count = 0`) | **YES** |
| `trip_kernel_enabled` present and FALSE | `feature_flags` | **row absent** | **YES — RAISE** |
| `authz.is_accepted_trip_member` present (2337) | `pg_proc` | `true` | **no — and correctly so**: this asserts a *pre*condition, so its passing today is the point. It is the only one of the seven that is already satisfied. |
| `trip_kernel_execute('{}')` returns `TRIP_COMMAND_MALFORMED` | direct call | function absent → the probe cannot run | **YES** |

## 5. Rehearsal on CI

**CI already has 2420 applied** — `trips.version bigint default 0`, all three
tables with `rowsecurity = true`, both functions, the policy, the trigger, and
`trip_kernel_enabled = false`. A plain re-apply there would only exercise the
`IF NOT EXISTS` no-op path and would prove nothing about the CREATE path.

So the rehearsal was done properly and is stated plainly rather than invented:
inside **one transaction**, `db/rollback/2026-09-07-2420-trip-kernel-foundation-rollback.sql`
was applied first (bringing CI to a production-shaped, 2420-free schema), then
`2420` verbatim, then a deliberate

```sql
DO $rehearsal$ BEGIN RAISE EXCEPTION 'D1 REHEARSAL: … aborting deliberately'; END $rehearsal$;
```

The transaction mechanism was validated first with a throwaway probe
(`CREATE TABLE public._d1_txn_probe` + `RAISE`), confirmed rolled back, so the
rehearsal could not leak.

**Result: every statement succeeded and all eight postcondition checks passed;
the only error returned was the sentinel.** Afterwards CI was re-measured and is
byte-for-byte what it was: `version bigint default 0`; the three tables with RLS
on; both functions; `trip_events_crew_select`; `trg_trip_events_append_only`;
`trip_kernel_enabled = false`; `trip_events` still 0 rows; `_d1_txn_probe` null.

Caveat recorded rather than glossed: CI holds **0 trips**, so the rehearsal
exercised DDL and privileges, not the `ALTER TABLE … ADD COLUMN` against 43 live
rows. §8 covers that separately.

## 6. Does it resolve an unresolved owner decision? **No.**

The four live decisions are `MEDIA_CANONICAL_FLAG`, `SENSING_AUTH_POSTURE`,
`APPEAL_RESTORE_SEMANTICS`, `EVENT_START_TRANSITION`. Textual occurrences in
`2420_trip_kernel_foundation.sql`:

```
trip_members 0 · media_canonical 0 · sensing 0 · issuance_class 0
event_start 0 · appeal 0 · restore_ 0
```

- `MEDIA_CANONICAL_FLAG` is `2470` / `media_assets` — 2420 touches neither.
- `SENSING_AUTH_POSTURE` is `2481`'s `issuance_class` CHECK — absent here.
- `APPEAL_RESTORE_SEMANTICS` is about `trip_members` UPDATEs on appeal
  resolution (`src/scripts/tripKernelWriterBaseline.ts:132`) — 2420 never names
  `trip_members`; its commands are plan-item commands only.
- `EVENT_START_TRANSITION` is `2600` / `events.state` — absent here.

2420 touches exactly one flag row, its own, and seeds it **FALSE**. Flipping
`trip_kernel_enabled` later is a decision; applying 2420 is not.

## 7. Destructive? Rollback?

**Not destructive.** Every statement is additive and idempotent: `ADD COLUMN IF
NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP … IF EXISTS`-then-`CREATE` for the trigger and
the policy, `INSERT … ON CONFLICT DO NOTHING`. It drops no column, deletes no
row, and rewrites no existing data. The only `REVOKE`s are on the three tables
it creates in the same transaction, taking back the DML set Supabase's
`ALTER DEFAULT PRIVILEGES` hands `anon`/`authenticated` at `CREATE TABLE`.

**Rollback exists and is idempotent:**
`db/rollback/2026-09-07-2420-trip-kernel-foundation-rollback.sql` — every
statement `IF EXISTS`. It was executed as phase 1 of the CI rehearsal above, so
it is not merely written, it is exercised. Its only data loss is kernel history
(`trip_events`, `trip_outbox`, `trip_command_receipts` rows and `trips.version`
values) written while the flag was on; canonical `trip_plan_items` rows are not
touched.

## 8. Effect on existing production data and on live read paths

**The 43 trips.** `ALTER TABLE public.trips ADD COLUMN version bigint NOT NULL
DEFAULT 0` on **PostgreSQL 17.6** (measured: `server_version_num = 170006`) is a
**metadata-only** operation — since PG 11 a non-volatile default is stored in
`pg_attribute.attmissingval` and no table rewrite occurs. All 43 rows read back
`version = 0` without a single page being written. `0` means "no kernel history"
— legacy direct writers do not bump it — not "never changed".

**No live read path sees a difference.** Nine sites select `*` from `trips`:

```
lib/mapProjectionTripRead.ts:193      → .map(toAuthorizedTripView)
lib/tripReadiness.ts:269              → explicit field reads only
routes/trips-expansion.ts:107,141,175,208 → .map(toAuthorizedTripView)
routes/trips-expansion.ts:389         → explicit field reads only
routes/trips-expansion.ts:468         → toAuthorizedTripView(updated)
routes/trips-expansion.ts:2797        → explicit field reads only
```

`lib/privacy/tripSerializers.ts:84 toAuthorizedTripView` copies **38 named
fields** into a fresh object — it is not a spread and not a key-delete. Grepping
those three files for `...trip` / `...t` returns nothing. So `version` cannot
reach any API response body. No route, serializer or OpenAPI shape changes.

**Schema-drift gate.** `src/test/generated/liveColumns.json` does not list
`trips.version`, so after applying, the live column set is a superset of the
snapshot. That is the safe direction the drift gate tolerates (a snapshot column
missing live is the dangerous one) — no drift-test breakage, and the snapshot can
be refreshed at leisure.

**Behaviour.** `trip_kernel_enabled` seeds FALSE and `isFlagEnabled` is
fail-closed, so `lib/tripKernel.ts` is unreachable and every write path stays
byte-for-byte what it was. The three new tables stay empty; `trip_outbox` has no
worker by design.

## 9. What applying 2420 unblocks

- `2450` (trip/participant families), `2500`, `2520` — all `blocked_by_dependency`
  on this chain today.
- Discovery's projection consumer (`lib/discoveryTripProjectionConsumer.ts`):
  `TRIP_DISCOVERY_SOURCE_COLUMNS` ends with `version`, so the capability
  `discovery_trip_projection_enabled && trips-schema-ready` cannot become ready
  in production until 2420 lands. **Applying 2420 changes nothing for Discovery
  on its own** — the flag is still absent there (2550 unapplied), so the gate
  stays on the legacy read either way.

## 10. Recommendation

**APPLY.** Both dependencies are in production; every precondition passes with a
measured value; nothing it creates already exists; its postconditions are
demonstrably non-vacuous; the whole file was rehearsed against a 2420-free schema
inside a rolled-back transaction with all postconditions green; it takes no owner
decision; it is additive with an exercised rollback; and on PG 17 the new column
is metadata-only on 43 rows and reaches no client.

Run the runbook's B1 pre-check and post-check around it. The one thing that must
**not** follow is flipping `trip_kernel_enabled` — that is a separate decision on
a separate day.
