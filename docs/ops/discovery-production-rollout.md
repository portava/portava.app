# Discovery — production rollout

*Prepared 2026-09-28 by lane W10-D on `disc-w10-d-rollout` (base `debd5ad4f`). Census section: census-discovery §83. The owner decisions this plan needs are in `docs/ops/discovery-owner-approval-request.md` (request ids `W10D-…`). The `portava-ci` rehearsal that precedes all of it is `docs/ops/discovery-portava-ci-apply-plan.md`. **Amended by lane W11-P at `3fd11f858` (census-discovery §96): §9 extends P1 to this tree and lists the new flags, and the approval request is now one numbered list of actions (its §2 maps each `W10D-…` id to an action).***

**Nothing here has been done.** Production (`ajrurzioarfkagpuxfnb`) has only been read, by earlier lanes, on the dates given. Every step below is a production activation, which the owner has not delegated. Each step names the approval it needs.

| State | Discovery work |
|---|---|
| Built on the branch (PR #528) | yes |
| Rehearsed on `portava-ci` | **no** — the apply plan is ready, and the apply awaits an operator with credentials |
| Merged to `main` | no |
| Migrations applied to production | the four of 2026-09-14 (2204, 2900, 2890, 2891), 2910 (2026-09-20) and 2220; nothing since |
| API deployed with this branch | no |
| Client build shipped with this branch | no |
| Any Discovery flag turned on by this programme | no |

---

## 0. Gates before step 1

1. **The `portava-ci` rehearsal is green.** The 40-file apply (apply plan, steps 1–8) is done, and a green `schema drift` run exists on `portava-ci` for the tree being deployed. That is `10` §7's *"production rollout only after CI rehearsal"* (decision D-W10D-1). F1–F4 of the apply plan §5.3 have landed.
2. **PR #528 is merged**, and `main`'s `schema-drift` job has applied and certified whatever `main` added on top.
3. **A confirmed point-in-time restore point** is taken for production and its timestamp recorded in the rollout record (§8). `manual-production-migration-runbook.md` §E5 requires it for any batch that is not purely additive. Batch P1 is not purely additive: 3440 rewrites a column, 3375 validates every `rank_events` row, and 3362–3365 and 3422 revoke client privileges. The 2026-09-14 deployment recorded that it proceeded without one, and it said no non-additive batch may do so again.
4. **The owner's answers:** W10D-A1 (the production apply), W10D-A2 (3376), W10D-A3/A4/A5 (deploy, flags, mode), and W10D-B0 (C-11) for batch P2. They are listed per step below.

---

## 1. Migrations, in order

### 1.1 How production is applied

The applier (`scripts/src/apply-migrations.ts`) **refuses the production ref by construction**. Production is applied the way `docs/migrations.md` and `docs/architecture/production-deployment-2026-09-14.md` record:
- the applier's own functions build each statement: `classifyMigration`, `checksumOf`, and `buildApplyStatement` with `appliedBy: 'manual'`;
- each statement is sent unchanged through the Management API, one file per transaction, with its ledger row inside it;
- each file's PRE read is taken before it, and its POST read after.

Production has had `schema_migration_ledger` since 2026-09-22 (`artifacts/api-server/baseline/20260922_production_tables.txt`).

### 1.2 Production's state for each file, and where that comes from

| source | date | what it establishes |
|---|---|---|
| `artifacts/api-server/src/lib/capability/snapshots/20260922-production-schema.json` (the current snapshot, `current.ts`) | captured 2026-09-22 16:07 UTC, watermark `20260922155706` | table presence (497 tables), column lists, and every `feature_flags` value (201 flags) |
| census-discovery §47.1 (integrator's read-only read) | 2026-09-27 | the Discovery flag values, `rank_events` activity, 2910 applied, 2920/2921/2930 absent |
| census-discovery §49.4 | 2026-09-27 | `rank_events.schema_version` all 1 (234,224 rows); 3366 flag absent; `recommendations` absent; `canonical_locations` 31 rows, `search_key` fully populated |
| `docs/architecture/production-deployment-2026-09-14.md` | 2026-09-14 | 2890, 2891 applied; 2892, 2893 and the flag seeds 2850/2289/2360 deliberately not applied |

**Read first, every time.** Before step P0, re-read the ledger. Expected: 0 rows for every file marked *unapplied* below. For the three marked *confirm*, the read decides.

```sql
SELECT filename, applied_by, applied_at FROM public.schema_migration_ledger
 WHERE filename ~ '^(2289|2297|2360|2850|2892|2893|2894|2901|2920|2921|2922|2930|2995|33[3-9]\d|34[0-4]\d)_' ORDER BY 1;
```

### 1.3 Batch P0 — prerequisites (flag rows seeded FALSE, and one empty table)

| step | file | production state (source) | prerequisite | what it does in production |
|---|---|---|---|---|
| P0.1 | `2289_discovery_ranking_modifiers_flag.sql` | unapplied: flag absent (snapshot) | — | row `discovery_ranking_modifiers_enabled` FALSE. Absent and FALSE read alike. |
| P0.2 | `2297_rank_events_dismiss_outcome.sql` | **confirm** (not in any committed read) | — | admits `dismiss` as an outcome |
| P0.3 | `2360_discovery_buddy_launch_gate_flag.sql` | unapplied: flag absent (snapshot) | — | row FALSE |
| P0.4 | `2850_discovery_live_rank_flag.sql` | unapplied: flag absent (snapshot) | — | row FALSE |
| P0.5 | `2892_place_momentum.sql` | unapplied: table absent (snapshot) | — | empty table + rebuild function; no reader and no scheduler (2026-09-14 record) |
| P0.6 | `2894_rank_events_trip_add_outcome.sql` | **confirm** | — | admits `trip_add` |
| P0.7 | `2995_rank_events_discovery_dismissed_index.sql` | **confirm** | P0.2 | partial index for the dismiss read |

All of P0 is additive or a flag row seeded FALSE. **Approval: W10D-A1.**

### 1.4 Batch P1 — the Discovery set that does not wait on the creator economy

Applied in this order. It is the canonical byte order of the files; skipping 3385–3387 until P2 breaks no dependency. The media files of the same range (3338–3365) follow `docs/ops/sensing-production-approval-request.md` section H (H1–H16). They are not repeated here.

| step | file | prerequisite in production | notes for production |
|---|---|---|---|
| P1.1 | `3366_discovery_search_protected_zones_flag.sql` | — | flag FALSE. `protected_zones` exists with 0 active rows (§49.4), so turning it on later is the identity. |
| P1.2 | `3375_rank_events_schema_version_admitted.sql` | 2890 (applied 2026-09-14) | validates all 234,224 rows under ACCESS EXCLUSIVE: one sequential scan. No surface has written since 2026-08-27 (§49.4). Precondition: 0 rows ≠ 1 (§49.4: all 1). |
| P1.3 | `3376_discovery_recommendations_per_request.sql` | — | **W10D-A2: an explicit yes.** `discovery_serve_log_enabled` is already TRUE in production (snapshot; §47.1), so from the API deploy (§2 step D2) onwards, every served Discovery request writes one row, anonymous serves included. Rows are labelled `raw_recent`, and no retention is enforced. Its rollback refuses once rows exist. |
| P1.4 | `3380_content_trails_label_cap_serialised.sql` | 2910 (applied 2026-09-20; 0 rows) | the index builds instantly |
| P1.5 | `3381_trail_lifecycle_transitions.sql` | 2910 | two triggers; 0 rows |
| P1.6 | `3390_discovery_rls_explicit_policies.sql` | P0.5 and P1.3 first, so that `place_momentum` and `recommendations` get their explicit policies (3390 skips an absent table) | policies only; revokes TRUNCATE/REFERENCES/TRIGGER from client roles on the 16 tables |
| P1.7 | `3391_discovery_stop_condition_measurements.sql` | P1.6 | builds a partial index on `rank_events` under a SHARE lock (≈234k rows). `attribution_double_count` reads `input_absent` until P2 (per 3391's header; that absent-table path was not rehearsed here). |
| P1.8 | `3395_discovery_dwell_telemetry_flag.sql` | — | flag FALSE. Turning it on is W10D-C1 (consent). |
| P1.9 | `3400_media_pending_upload_sweep_flag.sql` | — | flag FALSE. Turning it on deletes abandoned uploads (D-5, a routine rule, but its activation is production activation). |
| P1.10 | `3410_discovery_trend_snapshot_parity.sql` | P0.5 | three nullable columns; the trend API flag FALSE |
| P1.11 | `3415_trail_proposal_serialised.sql` | 2910; `server_encoding` UTF8 | 8 functions |
| P1.12 | `3416_trail_relations_projection.sql` | 2910 | table + rebuild; no reader, no job |
| P1.13 | `3417_place_momentum_dismiss_excluded.sql` | P1.10 | function body |
| P1.14 | `3420_rank_events_outcome_receipts.sql` | 2891 | catalogue-only ADD COLUMN; receipts table |
| P1.15 | `3421_ranking_debug_samples_content_id_nullable.sql` | baseline table | DROP NOT NULL |
| P1.16 | `3422_tags_client_write_boundary.sql` | table owned by the applying role | revokes client writes on `tags` (census §62.6's approval step) |
| P1.17 | `3435_place_momentum_feature_version.sql` | P1.13 | nullable column |
| P1.18 | `3440_canonical_search_key_letter_fold.sql` | 2220 (applied), `pg_trgm` | **rewrites `search_key` on every row under ACCESS EXCLUSIVE.** Sized by census §73.9's read-only SQL: run it immediately before, and record both numbers. The last committed count is 31 rows (§49.4, 2026-09-27), so the lock is held for milliseconds at that size. Readers of `search_key` wait behind the lock. On failure the transaction restores 2220's state. |
| P1.19 | `3441_trail_letter_fold_decompose_first.sql` | P1.11 | function only |
| + | whatever lands after `debd5ad4f` | — | each new Discovery flag is seeded FALSE and joins P1 in byte order. **At `3fd11f858` these are the 33 files of §9.1** (P1.17a and P1.20–P1.51) |

**Approval: W10D-A1 (the batch), W10D-A2 (3376 specifically).**

**§73.9, run immediately before P1.18:**

```sql
SELECT count(*) AS rows, pg_size_pretty(pg_total_relation_size('public.canonical_locations')) AS size FROM public.canonical_locations;
SELECT count(*) FROM public.canonical_locations WHERE normalize(name, NFD) ~ '[^\x01-\x7F̀-ͯ]';
SELECT public.input_normalize_city_key('Ǿresund') AS acute, public.input_normalize_city_key('Øresund') AS plain;  -- 'resund','oresund' before; 'oresund','oresund' after
```

### 1.5 Batch P2 — the creator ledger (waits on W10D-B0, C-11 erasure retention)

**2901 goes first, before any ledger row can exist,** because 2930's view and 3387's one-earning rule read `rent_buddy_earnings_entries`. 2901 as written carries the erasure defect of census §52.2 item 3: its `beneficiary_user_id … ON DELETE SET NULL` is an UPDATE on an append-only table, so erasing any buddy with an earning fails; and 3387's cascades delete a creator's ledger on erasure, i.e. answer C-11 by default. **Since census §107 (2026-09-30), `3510_creator_ledger_erasure_policy_undecided.sql` closes both without answering:** it makes 2901's key CASCADE and puts a row-level guard on all four ledgers that refuses every DELETE (SQLSTATE CL451) until the owner chooses, so P2 followed by 3510 imposes no erasure policy. W10D-B0 (C-11) then selects one of the two answers, both written, rehearsed and HELD in `reconciliation-staging/`:

| C-11 answer | what must be written before P2 | then |
|---|---|---|
| **delete on erasure** — NOT chosen; held unapplied and unaltered, so the choice stays reversible | `reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql`: a ledger row is deleted only in its own beneficiary's erasure, as whole transactions (a counterparty's erasure is refused), through an audited SECURITY DEFINER door for the tombstone flow; service_role loses DELETE | promote it into the chain after 3510, with its rollback |
| **retain, pseudonymised** (not anonymous: census §107.4) — **CHOSEN by the owner 2026-10-04, and PROMOTED** | `artifacts/api-server/src/migrations/3513_creator_ledger_erasure_retain_pseudonymised.sql` (was `reconciliation-staging/3512_…`), rollback `db/rollback/2026-10-04-3513-…`: rows are never deleted; an audited SECURITY DEFINER door replaces the person's id with one random pseudonym in every column of the four ledgers; a pseudonymised record is frozen; `AccountDeletionService`'s `pseudonymise_creator_ledger` step calls that door and REFUSES the erasure when the ledger cannot be read | **DONE (code only).** It is in the chain and applied to NO hosted database: the same ruling says do not apply, deploy or enable collection until legal review confirms Q11(a). The decision also requires a DEFINED RETENTION PERIOD, which has no value yet and which 3513 therefore does not enforce — it retains indefinitely, so the apply waits on the period as much as on the review |

| step | file | production state | prerequisite |
|---|---|---|---|
| P2.1 | `2901_rent_buddy_earnings_entries.sql` (its SET NULL is replaced by 3510, after P2.8) | unapplied (snapshot: table absent) | W10D-A1 |
| P2.2 | `2920_creator_attributions.sql` | unapplied (§47.1) | W10D-B0 |
| P2.3 | `2921_creator_earning_entries.sql` | unapplied (§47.1) | P2.2 |
| P2.4 | `2922_creator_attribution_flag.sql` | unapplied (flag absent) | — (flag FALSE) |
| P2.5 | `2930_creator_share_canonical_view.sql` | unapplied (§47.1) | P2.1, P2.3 |
| P2.6 | `3385_creator_share_ledger_includes_creator_entries.sql` | unapplied | P2.5 |
| P2.7 | `3386_creator_attribution_recommendation_link.sql` | unapplied | P2.2; 2891 |
| P2.8 | `3387_creator_ledger_integrity_and_audit.sql` | unapplied | P2.1, P2.3, P2.7 |

Every table in P2 ships empty, and `creator_attribution_enabled` (2922) stays FALSE. **P2.9 is `3510_creator_ledger_erasure_policy_undecided.sql`, applied in the same run right after P2.8** (it requires 3387's audit table); with it the batch decides nothing about erasure. Turning the flag on needs C-1 (the published percentages) at the least. **Approval: W10D-A1 for the batch (P2.1–P2.9); W10D-B0 only to promote 3511 or 3513.** W10D-B0 was GIVEN on 2026-10-04 — answer B, retain pseudonymised — and 3513 is in the chain as a result. It is applied to NO database: the ruling that chose it also said not to apply, deploy or enable collection until legal review confirms Q11(a), and the retention period it requires still has no value.

### 1.6 Batch P3 — optional, last or never

| step | file | why last |
|---|---|---|
| P3.1 | `2893_rank_events_retire_writerless_surfaces.sql` | E-4 (W10D-A6). It narrows `rank_events_surface_check`. Its own header says *"apply it LAST or not at all"*, and its reversal is not free. §49.4 found no row on the seven surfaces it retires. |

---

## 2. Deployment order

**D1 migrations → D2 API deploy → D3 client build → D4 flags.** Each step starts only after the previous step's verification (§4) is clean.

| step | what | why this position |
|---|---|---|
| D1 | P0, then P1 (then P2 when W10D-B0 allows, and P3 if W10D-A6 approves) | Every file is additive, a flag row seeded FALSE, or a narrowing that the deployed (old) API does not exercise. The old API still writes `schema_version` 1 (3375), never names `outcome_client_event_id` (3420), and reads posts only as `service_role` (3362). So D1 changes no served response. |
| D2 | the API built from merged `main` | The new API names objects D1 created: `recommendations` through `record_discovery_serve_request`, `rank_events.outcome_client_event_id`, `rank_event_outcome_receipts`, and `creator_attributions.recommendation_id` (P2). Deployed before D1, those writes and reads fail: this is what `check:write-path-columns` exists to catch. From D2, `discovery_serve_log_enabled` = TRUE makes 3376's writer live (W10D-A2). |
| D3 | the travel-buddy client build | The client sends the viewer's token (DV-02/DV-47), reads the dwell flag and sends keyed outcomes. Against an old API, the served id and the keyed-outcome field have no reader. |
| D4 | flags, in §3's order | A flag is read by the deployed server. Turning one on before D2 hands a decision to code that does not implement it (the 2026-09-14 record). |

---

## 3. Every Discovery flag

"Production" is the value read at the source and date given. "Absent" reads as FALSE everywhere (`isFlagEnabled` is fail-closed). The recommended value is this lane's recommendation. **Turning any flag on in production is the owner's decision (the request named in the last column).**

| flag | seeded by | production value (source, date) | recommended | activation order and gate |
|---|---|---|---|---|
| `discovery_serve_log_enabled` | 2090 | **TRUE** (snapshot 2026-09-22; §47.1 2026-09-27) | keep TRUE | already on. At D2 it starts 3376's per-request rows: W10D-A2. |
| `DISCOVERY_ENGINE_MODE` | 2091 | `enabled=false`, `metadata.mode='legacy'` (§47.1 2026-09-27) | the §3.1 sequence | M1–M5 below; approval W10D-A5 (E-2) |
| `disable_discovery_pde` | 2091 | FALSE (snapshot; §47.1) | keep FALSE | the manual stop. Set TRUE to halt PDE (§6). |
| `discovery_search_protected_zones_enabled` | 3366 | absent (§49.4 2026-09-27) | **TRUE** after D2 | F1. W10D-A4c (A-3). With 0 active zones it is the identity. |
| `discovery_candidate_projection_enabled` | 2361 | FALSE (snapshot; §47.1) | TRUE after D2 | F2. W10D-A4a; `docs/ops/sensing-production-approval-request.md` item 5, and E-1 |
| `discovery_buddy_launch_gate_enabled` | 2360 | absent (snapshot) | TRUE after D2 | F3. W10D-A4b (E-10). It withholds buddies while the marketplace is off, which is privacy-conservative. |
| `discovery_live_rank_enabled` | 2850 | absent (snapshot) | FALSE until mode step M4 | W10D-A4d (E-10, A-6) |
| `discovery_ranking_modifiers_enabled` | 2289 | absent (snapshot) | FALSE | W10D-A4f (A-6). The build hold is lifted; production activation is not. |
| `DISCOVERY_DIVERSITY_ENABLED` | 2084 | FALSE (snapshot; §47.1) | FALSE | W10D-A4f (A-6) |
| `ACTIVITY_DISCOVERY_BOOST_ENABLED` | 2084 | FALSE (snapshot; §49.4) | FALSE | — |
| `CREATOR_FATIGUE_ENABLED` | 2084 | FALSE (snapshot) | FALSE | — |
| `RANKING_EXPERIMENT_ENABLED` | 2084 | FALSE (snapshot 2026-09-22; this answers the first half of §57.10 Q5 as of that date) | FALSE | — |
| `COMPASS_V1_RULE_BASED_ENABLED` | Compass | **TRUE** (§47.1) | keep TRUE | Q66-2 / C32 decides the `for_you` consolidation |
| `COMPASS_DIVERSITY_ENABLED` | 0053 | TRUE (snapshot) | keep | Compass's |
| `discovery_trip_projection_enabled` | 2550 | FALSE (snapshot) | FALSE | E-7 |
| `layover_discovery_mode_enabled` | 2971 | FALSE (snapshot; §47.1) | FALSE | D-4 |
| `discovery_dwell_telemetry_enabled` | 3395 | absent | **FALSE** | W10D-C1 (B-1, consent). Only after the owner approves collection. |
| `discovery_trending_api_enabled` | 3410 | absent | FALSE | W10D-C4 (B-3, trend disclosure) |
| `media_pending_upload_sweep_enabled` | 3400 | absent | FALSE | D-5; its activation deletes user uploads |
| `creator_attribution_enabled` | 2922 | absent (§47.1) | FALSE | W10D-B0 and W10D-B1–B11 (C-1 … C-12) |
| `wall_discovery_insertions_enabled` | Wall | FALSE (snapshot) | FALSE | Wall's |
| flags added after `debd5ad4f` (ranker designs and the other wave-10/11 lanes) | 3450–3500 | absent (the files postdate the snapshot) | FALSE | **listed one by one in §9.2**, each with its activation action |

### 3.1 Activation order (D4)

`12`'s deployment rule is *rehearse → verdict checks → shadow → cohort → observe → expand*. Each step holds for at least one full observation window (§5) with no stop condition tripped before the next step starts.

| # | change | expected effect | proceeds when |
|---|---|---|---|
| F1 | `discovery_search_protected_zones_enabled` → TRUE | none while 0 zones are registered | §4's reads clean |
| F2 | `discovery_candidate_projection_enabled` → TRUE | reason labels on the projection | Sensing pack item 5 approved |
| F3 | `discovery_buddy_launch_gate_enabled` → TRUE | buddies withheld while `rent_buddy_enabled` is off | E-10 |
| M1 | `DISCOVERY_ENGINE_MODE` → `enabled=true, metadata={"mode":"shadow","cohort":{"kind":"percent","percent":5}}` | users still get legacy; PDE ranks the same candidates after the response and writes `discovery_shadow_serves` | E-2 gate 1 (W10D-A5) |
| M2 | the same, `"mode":"compare"` | legacy served; comparison recorded | a shadow window with `report:discovery-divergence` read and no stop tripped |
| M3 | `"mode":"partial"`, cohort percent 5 | PDE serves 5 % of viewers | E-2 gate 2 (W10D-A5); `report:discovery-outcomes` read |
| M4 | `discovery_live_rank_enabled` → TRUE (optional, E-10/A-6) | bounded re-ordering of the head window | M3 observed |
| M5 | expand the percent 5 → 25 → 50, then `"mode":"pde","cohort":{"kind":"all"}` | PDE for everyone | each step observed; `kind: all` is the owner's decision (`lib/discoveryCohort.ts`) |

Two rules from `lib/discoveryEngineMode.ts` hold throughout. `partial` over `kind: all` is refused to legacy. And any tripped stop condition resolves every non-legacy mode to legacy within the resolver's 30-second cache.

---

## 4. Verification after each step

| after | read | expected |
|---|---|---|
| every migration | its POST read, and the ledger row | row present, `applied_by='manual'`, 64-hex checksum equal to the file's sha256 at the deployed commit |
| D1 complete | the §1.2 ledger query; `check:production-drift` refreshed against a new snapshot | every P0/P1 file recorded; the drift ratchet shrinks by the tables created |
| D1 complete | `SELECT flag, enabled FROM feature_flags WHERE flag IN (…§3…)` | every new row FALSE; `discovery_serve_log_enabled` still TRUE |
| D2 | `SELECT count(*), max(served_at) FROM public.recommendations;` | rows appear with traffic (W10D-A2) |
| D2 | `SELECT count(*) FROM public.rank_events WHERE schema_version <> 1;` | 0 |
| D3 | `SELECT count(*), max(served_at) FROM rank_events WHERE surface='discovery' AND served_at > now() - interval '1 hour';` | signed-in Discovery exposures appear (the DV-02/DV-47 production evidence) |
| each A-step | §5's reports and SQL | no stop condition tripped |

---

## 5. Monitoring

**Metrics, in process** (`lib/discoveryStopConditions.ts`, evaluated by `lib/discoveryEngineMode.ts` on every uncached resolution):
- `event_rejection_rate`, `recommendation_logging_gap` and `cache_bypass`, from the serve-log writer and the serve path;
- `creator_concentration`, `reports_hides`, `rls_leak` and `attribution_double_count`, from `public.discovery_stop_measurements(since, until)` (3391) through `lib/discoveryStopMeasurements.ts`.

The window is `STOP_WINDOW_MS` and the minimum sample `STOP_MIN_SAMPLE`.

**Log lines to alert on:**
- `discoveryEngineMode: a 12 stop condition has tripped — serving legacy` (it carries `tripped`, `eventRejectionRate` and `loggingGapRate`);
- `discoveryEngineMode: PDE stop engaged — serving legacy`;
- `… metadata.cohort is unusable — cohort is NOBODY`;
- `PARTIAL over cohort kind=all is a total rollout — serving legacy`.

**Reports (read-only, `artifacts/api-server`):**

| script | answers |
|---|---|
| `pnpm run report:discovery-serve-points` | of the serves users received, the fraction that reached a ranker |
| `pnpm run report:discovery-divergence` | legacy vs PDE, from `discovery_shadow_serves` (M1–M2) |
| `pnpm run report:discovery-outcomes` | `01` §12's items by arm, with samples; insufficient sample is never 0 % |
| `pnpm run report:discovery-trace-coverage` | served → exposure → outcome coverage by serve point |
| `pnpm run report:discovery-ecosystem` | the governor's monitors (concentration, new-creator success, stale content, spam) |

**SQL (read-only):**

```sql
SELECT public.discovery_stop_measurements(now() - interval '10 minutes', now());      -- the four DB-measured conditions
SELECT serve_point, viewer_class, count(*), sum(served_count) FROM public.recommendations
 WHERE served_at >= now() - interval '1 hour' GROUP BY 1, 2;                          -- per-request denominators (3376)
SELECT surface, outcome, count(*) FROM public.rank_events
 WHERE served_at >= now() - interval '1 hour' AND surface = 'discovery' GROUP BY 1, 2; -- exposures and outcomes
SELECT engine_mode, count(*) FROM public.discovery_shadow_serves WHERE observed_at >= now() - interval '1 hour' GROUP BY 1;
SELECT count(*) FROM public.rank_event_outcome_receipts;                              -- keyed outcomes (3420)
```

---

## 6. Stop conditions and their values

The halt values are **not set in this document.** They are the entries of `STOP_CONDITION_RULINGS` in `artifacts/api-server/src/lib/discoveryStopConditions.ts`, which another wave-10 lane is deciding, and which the owner rules on (A-5 → W10D-A7). At `debd5ad4f`:

| condition | ruling in the file | trips when |
|---|---|---|
| `event_rejection_rate` | `EVENT_REJECTION_RATE_THRESHOLD` (0.05), `unratified_proposal` | measured > threshold over `STOP_WINDOW_MS` with ≥ `STOP_MIN_SAMPLE` attempts |
| `recommendation_logging_gap` | `LOGGING_GAP_THRESHOLD` (0.10), `unratified_proposal` | as above |
| `creator_concentration` | `null` at `debd5ad4f` | cannot trip until ruled; measured and reported |
| `reports_hides` | `null` | as above |
| `cache_bypass` | `null` | as above |
| `rls_leak` | `null` | as above. **Operator rule, independent of the file:** any `deviations > 0` is a stop, because 3390's posture is exact. |
| `attribution_double_count` | `null` | as above. **Operator rule:** any `duplicate_groups > 0` is a stop. |

Whatever values that lane lands are the ones in force. Read them by name from the deployed commit and copy them into the rollout record (§8) before M1.

**What a trip does:** the resolver serves legacy automatically (within 30 s). **What the operator does:**
1. set `disable_discovery_pde` TRUE;
2. set `DISCOVERY_ENGINE_MODE.enabled = false`;
3. record the reading;
4. do not re-open until the cause is understood.

---

## 7. Recovery for each step

| step | recovery | loses |
|---|---|---|
| P0 flag seeds (2289, 2360, 2850) | each file's rollback in `db/rollback/` (2289's added by §97, W11-S): deletes its own FALSE row + its ledger row, refuses while TRUE | nothing |
| P0.5 2892 | `db/rollback/2026-09-28-2892-place-momentum-rollback.sql` (§97): drops the table and both functions + the ledger row; refuses while a row exists or a later file builds on it | nothing (empty) |
| P0.2/P0.6/P0.7 | the `db/rollback/` files for 2995, 2894, 2297, newest first (§97): each refuses instead of deleting a `dismiss`/`trip_add` row | nothing; with such a row the rollback refuses (retention question) |
| P1 each | its rollback file in `db/rollback/` (apply plan §3 gives each one's behaviour and the measured gaps); for 3440, its footer reversal via 2220 (rehearsed); for 3441, re-run 3415's `trail_letter_fold` block | 3376: the rows (its rollback refuses once they exist); 3421: debug samples without `content_id`; 3390/3410 rollbacks leave privileges tighter than before (measured) |
| P2 | rollback files, newest first (2901's, 2921's and 2930's added by §97). 3387's refuses while its audit table holds rows; 3386's while 3387 is applied; 2901's and 2921's while their ledgers hold any row | nothing while 2922 is FALSE (0 rows); a ledger row makes the rollback refuse (C-11) |
| P3 2893 | `db/rollback/2026-09-28-2893-rank-events-retire-writerless-surfaces-rollback.sql` (§97): re-widens to the fifteen, which is not free: writes refused in between are lost | refused events |
| any migration mid-batch | the failed file's transaction rolled back by itself; the files before it stay applied and recorded; stop the batch | nothing |
| worst case | restore to the §0 point-in-time restore point | everything after it |
| D2 API | redeploy the previous API build | nothing; D1's objects are inert to the old API |
| D3 client | the previous build stays in the stores; a client-side flag read falls back to off | nothing |
| D4 any flag | set it back to FALSE (for the mode: `enabled=false`) | nothing; takes effect within the 30-s mode cache or the flag cache |

---

## 8. DC-27 — the rollout record (template)

`12` requires *rehearse → verdict checks → shadow → cohort → observe → expand*. DC-27 is graded on this record. Fill one row per event, in order, at the time it happens. **Nothing below is filled in: Discovery has not been rolled out.**

```markdown
## Discovery rollout record

| # | phase | when (UTC) | who | tree (sha) | what was done | evidence (link, run id, SQL result) | verdict | next step allowed? |
|---|---|---|---|---|---|---|---|---|
| 1 | rehearse | | | | `portava-ci` apply (apply plan step 4); dry run, apply, idempotent re-run, certify | apply output; certify output; `schema drift` run id, green | | |
| 2 | verdict checks | | | | `CI`, `live DB` and `unwired` verdicts green on the merge commit; required checks on `main` (A-4) | run ids | | |
| 3 | production restore point | | | | PITR taken | Supabase restore point id / timestamp | | |
| 4 | migrations P0/P1 (P2, P3) | | | | per-file PRE/POST reads | ledger rows, POST results | | |
| 5 | API deploy (D2) | | | | build id | health, `recommendations` rows | | |
| 6 | client build (D3) | | | | build number, store rollout % | signed-in `rank_events` rows | | |
| 7 | stop values in force | | | | `STOP_CONDITION_RULINGS` at the deployed sha, copied | file + sha | | |
| 8 | shadow (M1) | start / end | | | mode, cohort | `report:discovery-divergence`, stop measurements | | |
| 9 | compare (M2) | | | | | | | |
| 10 | cohort (M3) | | | | percent | `report:discovery-outcomes`, stops | | |
| 11 | observe | window | | | no change | readings per window | | |
| 12 | expand (M5) | per step | | | percent → all | per step | | |
| — | any stop | | | | condition, reading, action taken (§6) | | | |
```

A row is complete only with its evidence cell. "Observe" needs at least one full window per `STOP_WINDOW_MS` with a sample at or above `STOP_MIN_SAMPLE`. A later row may not start before the earlier row's verdict is recorded.

---

## 9. At `3fd11f858` (lane W11-P, census-discovery §96)

*Docs only. **Nothing here has been done.** Production state for every file below is "unapplied": each file postdates the 2026-09-22 snapshot, and nothing has been applied to production since 2910 and 2220 (the table at the top). The numbered actions named below are those of `docs/ops/discovery-owner-approval-request.md`.*

### 9.1 Batch P1, continued — the 33 files after 3435

They go in byte order after P1.17 (3435). P1.18 (3440) and P1.19 (3441) keep their place: 3436 sorts before 3440. P1.20–P1.51 follow 3441. Every flag lands FALSE, because each seed's postcondition refuses TRUE.

| step | file | prerequisite in production | what it does in production | activation |
|---|---|---|---|---|
| P1.17a | `3436_trail_health_snapshot_provenance.sql` | 2910's `trail_health_snapshots` (present, snapshot) | two nullable columns | — |
| P1.20 | `3450_discovery_surface_objectives_flag.sql` | — | flag FALSE | action 10.11 |
| P1.21 | `3451_discovery_engagement_integrity_flag.sql` | — | flag FALSE | 10.8, only after question 9 |
| P1.22 | `3452_discovery_feature_families_flag.sql` | — | flag FALSE | 10.5 |
| P1.23 | `3453_discovery_intent_trip_terms_flags.sql` | — | two flags FALSE | 10.6, 10.10 |
| P1.24 | `3454_discovery_diversity_axes_flag.sql` | — | flag FALSE, with its metadata | 10.7 |
| P1.25 | `3455_discovery_for_you_pde_flag.sql` | — | flag FALSE | 8 |
| P1.26 | `3456_discovery_cache_a_ranked_flag.sql` | — | flag FALSE | 8 |
| P1.27 | `3460_discovery_search_protection_scope.sql` | P1.1 (3366) | rewrites that flag's description only | 5a |
| P1.28 | `3465_layover_consumer_flags.sql` | — | two flags FALSE | 5e, 23 |
| P1.29 | `3466_layover_place_dwell.sql` | `discovery_places` | empty table | 23 |
| P1.30 | `3467_cross_architecture_flags.sql` | P1.9 (3400) | two flags FALSE; corrects 3400's flag description | 5f, 5g, 5k |
| P1.31 | `3468_tag_permission_approval_required.sql` | `tag_permission_level` enum | enum value `approval_required` (nothing written with it); two flags FALSE | 5h, question 18(a) |
| P1.32 | `3469_compass_graph_decay_flag.sql` | — | flag FALSE | 5i |
| P1.33 | `3470_discovery_stop_enforcement_flag.sql` | — | flag FALSE | 6 |
| P1.34 | `3475_discovery_trend_v2_flags.sql` | — | five flags FALSE (`keep_days: null`) | 13, question 11(b) |
| P1.35 | `3476_discovery_trend_v2_store.sql` | P0.5 (2892), P1.10, P1.17 | nullable columns on `place_momentum`; empty `area_momentum` | 13 |
| P1.36 | `3477_discovery_trend_v2_rebuild.sql` | P1.35 | `rebuild_place_momentum` dispatches to v2 only when its flag is on; off, it runs 3435's body | 13 |
| P1.37 | `3480_discovery_candidate_sources_flag.sql` | — | two flags FALSE | 10.1; question 16(a) |
| P1.38 | `3481_discovery_exploration_inventory_flag.sql` | — | flag FALSE | 10.2 |
| P1.39 | `3482_discovery_cold_start_flag.sql` | — | flag FALSE | 10.3 |
| P1.40 | `3483_discovery_pipeline_stages_flags.sql` | — | three flags FALSE | 10.4, 10.9, 10.13 |
| P1.41 | `3484_compass_city_confidence_provenance.sql` | `compass_city_confidence` (present) | three nullable columns; flag FALSE | 5j |
| P1.42 | `3485_discovery_trail_exploration_flags.sql` | — | two flags FALSE | 14 |
| P1.43 | `3486_trail_moderation_audit.sql` | P1.5 (3381) | the admin audit and trend-review tables, and the merge and moderation paths | 14 |
| P1.44 | `3487_trail_member_exposures.sql` | 2910 | empty table | 14 |
| P1.45 | `3488_trail_content_suggestions.sql` | 2910, `profiles` | empty table | — |
| P1.46 | `3490_discovery_serve_path_flags.sql` | — | two flags FALSE | 5d, 10.14 |
| P1.47 | `3491_discovery_recommendations_output_kinds_serve_point.sql` | P1.3 (3376) | widens the serve-point CHECK from 1–12 to 1–13 | action 2 (only with 3376) |
| P1.48 | `3495_place_cooccurrence_trail_projection.sql` | 2910 | empty projection and its rebuild | 13 |
| P1.49 | `3496_discovery_w11x3_flags.sql` | — | two flags FALSE | 13 |
| P1.50 | `3497_discovery_trend_post_convergence_stored.sql` | P1.36; `memories` | re-creates the v2 rebuild with the post-after-visit leg | 13 |
| P1.51 | `3500_discovery_surface_objective_rank_flags.sql` | — | three flags FALSE | 10.12 |

**Approval: action 3 (the batch), and action 2 for 3376 and 3491.** Each file's rollback is listed in `docs/ops/discovery-portava-ci-apply-plan.md` §8.1.

### 9.2 The flags these files seed

All are absent in production today, because the files are unapplied. The recommended production value, until the named action, is FALSE.

| flag | seeded by | activation (approval request) |
|---|---|---|
| `discovery_surface_objectives_enabled` | 3450 | 10.11 |
| `discovery_engagement_integrity_enabled` | 3451 | 10.8 (question 9) |
| `discovery_feature_families_enabled` | 3452 | 10.5 |
| `discovery_intent_term_enabled`, `discovery_trip_match_enabled` | 3453 | 10.10, 10.6 |
| `discovery_diversity_axes_enabled` | 3454 | 10.7 |
| `discovery_for_you_pde_enabled`, `discovery_cache_a_ranked_enabled` | 3455, 3456 | 8 |
| `layover_snapshot_consumers_enabled`, `layover_place_dwell_enabled` | 3465 | 5e; 23 |
| `discovery_trip_viewer_projections_enabled`, `telegraph_discovery_actions_enabled` | 3467 | 5f; 5g |
| `tag_permission_approval_required_enabled`, `tag_permission_consent_copy_enabled` | 3468 | 5h; question 18(a) |
| `compass_graph_decay_enabled` | 3469 | 5i |
| `discovery_stop_enforcement_enabled` | 3470 | 6 (metadata `values_version`) |
| `discovery_trend_normalised_enabled`, `discovery_trend_rebuild_scheduler_enabled`, `discovery_trend_snapshot_retention_enabled`, `discovery_trend_lists_enabled`, `discovery_trend_rediscovery_retest_enabled` | 3475 | 13 (question 11(b); question 12 for the lists) |
| `discovery_candidate_sources_enabled`; `discovery_circle_candidates_enabled` | 3480 | 10.1; question 16(a) |
| `discovery_exploration_inventory_enabled` | 3481 | 10.2 |
| `discovery_cold_start_enabled` | 3482 | 10.3 |
| `discovery_outcome_learning_enabled`, `discovery_integrity_stage_enabled`, `discovery_output_kinds_enabled` | 3483 | 10.4, 10.9, 10.13 |
| `compass_city_confidence_windowed_reads_enabled` | 3484 | 5j |
| `discovery_trail_exploration_enabled`, `discovery_trail_health_order_enabled` | 3485 | 14 |
| `discovery_community_byline_canonical_enabled`, `discovery_platform_graph_provenance_enabled` | 3490 | 5d; 10.14 |
| `discovery_place_cooccurrence_enabled`, `discovery_trend_post_convergence_enabled` | 3496 | 13 |
| `discovery_trail_objective_rank_enabled`, `discovery_trending_objective_rank_enabled`, `discovery_trip_planning_objective_rank_enabled` | 3500 | 10.12 |

### 9.3 What changed in §3.1, §6 and §7 since `debd5ad4f`

- **§6's halt values are decided.** The five `null` rulings are now D-W10-O-1's values, versioned `stop-values-2026-09-28.1`. They are armed by `discovery_stop_enforcement_enabled` (3470; approval action 6), and an unreadable measurement halts when armed (D-W10-O-2). Copy the version and the values into the rollout record's row 7.
- **§3.1's M1 starts with a named-users cohort** (D-W10R4-2): `{"mode":"shadow","cohort":{"kind":"users","userIds":[…]}}` for 7 days, then 5 %.
- **Gate 2 is also two capability flags**, 3455 and 3456, alongside the staged mode (approval action 8).
- **A gap in §6's "what a trip does".** A tripped stop resolves the engine MODE to legacy. It does not turn off 3455, 3456, or any action-10 flag: `lib/discoveryOnePipeline.ts` and the §78 flag reader do not read the stop state. So step 1 of §6's operator response also sets those flags FALSE (approval action 8's SQL).
- **§7, for the new files.** Each file's rollback is in apply plan §8.1. The ones that refuse are 3468, 3476, 3484, 3486, 3487, 3488, 3491, 3497 and each flag seed while its flag is TRUE, each for the reason its header gives.
