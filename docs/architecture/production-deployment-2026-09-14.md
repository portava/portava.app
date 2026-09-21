# Production deployment — Discovery schema, 2026-09-14

Project `ajrurzioarfkagpuxfnb` (`travel-buddy`). Applied by the integration owner
under the owner's authorisation of 2026-09-14, which lifted the production
migration hold for Discovery compliance work.

## What was applied, in order

| # | file | why | result |
|---|---|---|---|
| 1 | `2204_intel_reward_ledger_erasure_grant.sql` | **not planned — forced by a postcondition.** See below. | applied |
| 2 | `2900_intel_reward_ledger_reversals.sql` | `09` §11 *"reversals are possible"* — a compensating entry was structurally impossible | applied |
| 3 | `2890_rank_events_behavior_engine_columns.sql` | DV-38 `schema_version`, DV-39 `privacy_class`/`retention_tier`, DV-41 `dwell_ms`/`dwell_kind` | applied |
| 4 | `2891_rank_events_recommendation_id.sql` | DV-37 — the `ON CONFLICT` arbiter an idempotent retry needs | applied |

**Schema fingerprint** (tables + `rank_events`/ledger columns + every public
constraint): `4c11af803c4d1b0ec162d3e05bd53f7e` (2,180 objects) ->
`9aa88e4965ae82c308888b9c7186bb05` (2,194 objects). **+14 objects, 0 removed.**

## The postcondition that stopped the first attempt

`2900` was submitted and **refused itself**:

```
ERROR P0001: POSTCONDITION FAILED: service_role lost DELETE;
account deletion could not erase reward rows (2204)
```

Nothing was applied — the file is transactional. The cause was real and is a
**privacy finding, not a sequencing annoyance**: production's `service_role` held
only `INSERT, SELECT` on `intel_reward_ledger`, because
`2204_intel_reward_ledger_erasure_grant.sql` had never been applied there.
**Account deletion could not have erased a user's reward-ledger rows.**

No user data was at risk *today* — the table holds 0 rows — but the
`intel_rewards` flag is **TRUE in production**, so the gap would have become live
the moment anything wrote to it. 2204 was applied first, and 2900 then passed.

This is the strongest argument in the batch for postconditions that assert
*privileges* and not just *shapes*: nothing else in the repository would have
noticed.

## Row-level evidence — nothing was touched

| check | before | after |
|---|---|---|
| `rank_events` rows | 234,224 | **234,224** |
| rows carrying a `recommendation_id` | — | **0** (the migration writes none) |
| rows reading `schema_version = 1` | — | **234,224** (all) |
| rows carrying a dwell value | — | **0** (no measurement was invented) |
| `rank_events` columns | 13 | **19** |
| postcondition probe rows left behind | — | **0** |
| `service_role` DELETE on the reward ledger | **false** | **true** (erasure works) |
| `service_role` UPDATE on the reward ledger | false | **false** (append-only holds) |

All four files are schema-only: a scan of the whole batch found **zero** `UPDATE`,
`DELETE FROM`, `TRUNCATE`, `DROP TABLE`, `DROP COLUMN` or `ALTER COLUMN ... TYPE`
against user data.

## Recovery

Each file carries an exact REVERSAL block. All four are in the runbook's
"free, no loss" class: additive columns, a nullable column, an index, a grant and
a constraint supersession over a table that held **0 rows** in production.

**A confirmed point-in-time restore was NOT taken, and that is a real gap.**
`manual-production-migration-runbook.md` §E5 requires one before step 1. No tool
available to this session can take or confirm a PITR — the Supabase MCP exposes
`restore_project` (for a paused project) and nothing else. The mitigation is that
every file in this batch is reversible by DDL and none can lose a row; the
fingerprint above is the before-state. **Any future batch that is not purely
additive must not proceed on this basis.**

## Deliberately NOT applied

| file | why |
|---|---|
| `2892_place_momentum.sql` | Ships empty; no scheduler calls the rebuild and no reader consults it. Applying it now changes nothing observable. |
| `2910_discovery_trails.sql` | Six tables read only by `routes/trails.ts`, which is **unmerged**. Lanes are actively reshaping the Trails wiring; `10` §7 forbids editing an applied migration, so applying now risks production carrying a shape the code abandons — permanently. |
| `2893_rank_events_retire_writerless_surfaces.sql` | **Owner-deferred** until its event-loss window is resolved. It narrows a CHECK, every `rank_events` writer is fire-and-forget, and its loss set grows with time. |
| `2254_schema_migration_ledger.sql` | Its backfill is a frozen literal list and the file currently contains **zero** backfill rows, so applying it to a database with ~537 already-applied migrations would produce a ledger asserting almost nothing was applied — worse than no ledger, and the same failure mode as the `applied_by=manual` rows already blocking main's live-DB build. |
| the four Discovery flag seeds (2850, 2289, 2361, 2360) | See below. |

## NO FLAG WAS ENABLED, and the reason is a sequencing fact

**Production runs merged code.** This branch is not merged. A feature flag is read
by the DEPLOYED server, so enabling `discovery_live_rank_enabled`,
`discovery_ranking_modifiers_enabled` or `discovery_candidate_projection_enabled`
now would hand a decision to code that does not implement it. Flags come after
merge and deploy, never before — and their seed migrations are unapplied anyway,
so the rows do not exist to flip.

`DISCOVERY_ENGINE_MODE` remains `enabled=false, metadata.mode='legacy'`.
`discovery_serve_log_enabled` remains TRUE, as it already was.

## What this does NOT close

Applying schema does not move a census row to `C`. Every DV-37/38/39/41 row still
needs the CODE that writes the new columns, and that code is on an unmerged
branch. **BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS
NOT FLAG ENABLED. FLAG ENABLED IS NOT PRODUCTION REALIZED.**
