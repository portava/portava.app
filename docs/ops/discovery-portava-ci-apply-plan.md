# Discovery — the `portava-ci` apply plan (40 migrations)

*Prepared 2026-09-28 by lane W10-D on `disc-w10-d-rollout` (base `debd5ad4f`, whose migration tree is byte-identical to PR #528's head `84318d1b2`). Census section: census-discovery §83.*

**Nothing in this document has been applied to `portava-ci` or to production.** This session has no `portava-ci` credentials. The plan exists so that whoever holds them can apply the set as one verified, mechanical step.

| | |
|---|---|
| Target | `portava-ci`, ref `hwokxgbmezheskbzskfr`. Never production (`ajrurzioarfkagpuxfnb`): the applier refuses that ref by construction. |
| Authority | Owner, 2026-09-28: *"after checking dependencies, preserving existing data and flag values, and verifying recovery and postconditions. Do not modify the intentional 2481 ledger entry."* |
| Set | 40 files, `3338` … `3441`, listed in §1. **Plus whatever lands after `debd5ad4f`** (§1.3). |
| Rehearsal | Local PostgreSQL 16 harness, port 55455, from a restored pre-apply baseline (§4). Controlled evidence, not `portava-ci` evidence. |
| Blockers found | The apply itself passes. **Certification does not pass at this tree without four small fixes in other lanes' files (§5.3, F1–F4).** None of them is a data risk. |

---

## 1. The pending set

### 1.1 How it was computed

The set was recomputed with the repository's own logic, not copied:

1. `scripts/src/apply-migrations.ts` was imported as a library: `listMigrationFiles`, `planApply`, `classifyMigration`, `assertUnambiguousOrder`, `formatDryRun`. The harness driver is `artifacts/api-server/scripts/local-db/rehearse-pending-apply.ts`.
2. The ledger it planned against models `portava-ci`'s, built from committed records only:
   - every file below `3338` is recorded (`docs/migrations.md`: 3310–3315, 3320–3321 and every earlier batch are applied there);
   - `3350` is recorded (`docs/migrations.md`, "2026-09-27 — 3350 applied to `portava-ci`");
   - nothing at or above `3338` except 3350 is recorded (the same entry: 3352 and 3360 were **not** applied; PR #528's database-state table: 3338 and 3366–3422 are applied to no shared database).
3. The result was compared with CI's own dry run against the real `portava-ci` ledger: run 36392056669, job 108830529119, head `84318d1b2`, 2026-09-28 07:35 UTC.

**Result: identical — the same 40 files, in the same order, with the same shape for every file.** CI's run reported `Proven applied, skipped: 223`, `Ledger row present but NOT proof of an apply (2254 backfill): 384`, `Would apply 40`. The harness model differs only in the proven/backfill split (225/382), which does not change the pending set.

### 1.2 The 40, in apply order

`shape` is the applier's classification. `+post` means the file has a post-`COMMIT` postcondition tail, which the applier runs in a second transaction. `sha256` is the first 12 hex digits of the file at `debd5ad4f`; the ledger will record the full digest.

| # | file | shape | sha256 | rollback file (`db/rollback/`) |
|---|---|---|---|---|
| 1 | `3338_media_processing_worker_flag.sql` | unwrapped | `eab83e0eb25a` | `2026-09-26-3338-…` ¹ |
| 2 | `3340_media_tab_world_default_flag.sql` | unwrapped | `2cba1cac5a0f` | `2026-09-27-3340-…` ¹ |
| 3 | `3341_media_watch_context_overlay_flag.sql` | unwrapped | `61ba39d3bad8` | `2026-09-27-3341-…` ¹ |
| 4 | `3342_media_watch_tap_to_play_flag.sql` | unwrapped | `3b7814ab09ac` | `2026-09-27-3342-…` ¹ |
| 5 | `3343_media_watch_stage24_ranking_flag.sql` | unwrapped | `a639ea2e19f3` | `2026-09-27-3343-…` ¹ |
| 6 | `3351_media_find_busier_flag.sql` | unwrapped | `f32653d1c04b` | `2026-09-27-3351-…` ¹ |
| 7 | `3352_media_perspective_vantage.sql` | unwrapped | `f536af0ce70c` | `2026-09-27-3352-…` ¹ |
| 8 | `3355_media_vision_provider_flag.sql` | unwrapped | `2f7d81d0b249` | `2026-09-27-3355-…` ¹ |
| 9 | `3356_media_moderation_classifier_flag.sql` | unwrapped | `8d519c54f64e` | `2026-09-27-3356-…` ¹ |
| 10 | `3357_media_transcoder_flag.sql` | unwrapped | `948728ad3287` | `2026-09-27-3357-…` ¹ |
| 11 | `3358_media_captions_flag.sql` | unwrapped | `02d2f73e87d7` | `2026-09-27-3358-…` ¹ |
| 12 | `3359_passport_postcard_cover_nullable.sql` | unwrapped | `dbb7c5740f13` | `2026-09-27-3359-…` ¹ |
| 13 | `3360_intel_evidence_sealed_reference.sql` | unwrapped | `7005d31bc5f1` | `2026-09-27-3360-…` |
| 14 | `3361_intel_evidence_sealed_reference_validate.sql` | unwrapped | `641b88a08b23` | `2026-09-27-3361-…` |
| 15 | `3362_posts_client_column_grants.sql` | unwrapped +post | `b071a8167304` | `2026-09-27-3362-…` |
| 16 | `3363_place_copies_client_column_grants.sql` | unwrapped +post | `dcfacb7cfada` | `2026-09-27-3363-…` |
| 17 | `3364_pulse_geo_tags_write_boundary.sql` | unwrapped +post | `cb4c51df701b` | `2026-09-27-3364-…` |
| 18 | `3365_post_media_write_boundary.sql` | unwrapped +post | `fd267f7a7db6` | `2026-09-27-3365-…` |
| 19 | `3366_discovery_search_protected_zones_flag.sql` | unwrapped +post | `00a8a197a69b` | `2026-09-27-3366-…` |
| 20 | `3375_rank_events_schema_version_admitted.sql` | unwrapped +post | `88a598246d96` | `2026-09-27-3375-…` |
| 21 | `3376_discovery_recommendations_per_request.sql` | unwrapped +post | `c26eea613294` | `2026-09-27-3376-…` |
| 22 | `3380_content_trails_label_cap_serialised.sql` | unwrapped +post | `e117087c803f` | `2026-09-27-3380-…` |
| 23 | `3381_trail_lifecycle_transitions.sql` | unwrapped +post | `eaa77232c5a8` | `2026-09-27-3381-…` |
| 24 | `3385_creator_share_ledger_includes_creator_entries.sql` | unwrapped | `67c756623199` | `2026-09-27-3385-…` |
| 25 | `3386_creator_attribution_recommendation_link.sql` | unwrapped | `9c293bd49d63` | `2026-09-27-3386-…` |
| 26 | `3387_creator_ledger_integrity_and_audit.sql` | unwrapped | `04f22c759c87` | `2026-09-27-3387-…` |
| 27 | `3390_discovery_rls_explicit_policies.sql` | unwrapped | `9876df5322af` | `2026-09-27-3390-…` |
| 28 | `3391_discovery_stop_condition_measurements.sql` | unwrapped | `bf6b6ff95bea` | `2026-09-27-3391-…` |
| 29 | `3395_discovery_dwell_telemetry_flag.sql` | unwrapped +post | `7053b7a5ec4a` | `2026-09-27-3395-…` |
| 30 | `3400_media_pending_upload_sweep_flag.sql` | unwrapped +post | `97be7f79b1f7` | `2026-09-27-3400-…` |
| 31 | `3410_discovery_trend_snapshot_parity.sql` | unwrapped +post | `a2d3287c487b` | `2026-09-27-3410-…` |
| 32 | `3415_trail_proposal_serialised.sql` | unwrapped +post | `11e135efdbf6` | `2026-09-27-3415-…` |
| 33 | `3416_trail_relations_projection.sql` | unwrapped +post | `c16b1636f8a8` | `2026-09-27-3416-…` |
| 34 | `3417_place_momentum_dismiss_excluded.sql` | unwrapped +post | `e90c4f77e04f` | `2026-09-27-3417-…` |
| 35 | `3420_rank_events_outcome_receipts.sql` | unwrapped +post | `9ffb97fce682` | `2026-09-27-3420-…` |
| 36 | `3421_ranking_debug_samples_content_id_nullable.sql` | unwrapped +post | `0ff2c553349b` | `2026-09-27-3421-…` |
| 37 | `3422_tags_client_write_boundary.sql` | unwrapped +post | `25bd47b45c21` | `2026-09-27-3422-…` |
| 38 | `3435_place_momentum_feature_version.sql` | unwrapped +post | `9c8418705d59` | `2026-09-28-3435-…` |
| 39 | `3440_canonical_search_key_letter_fold.sql` | unwrapped | `e8e86d91f0a0` | none — reversal in the file's footer (§3) |
| 40 | `3441_trail_letter_fold_decompose_first.sql` | unwrapped | `a5f2ab459f25` | none — forward fix (§3) |

¹ **These eleven rollback files do not delete their ledger row** (measured, §4.4). Recovery must add `DELETE FROM public.schema_migration_ledger WHERE filename = '<file>';`, or the applier will treat the migration as still applied. The same is true of 3350's rollback, although `docs/migrations.md`'s 2026-09-27 entry says it removes the ledger row. It does not.

### 1.3 Plus whatever lands after `debd5ad4f`

Wave-10 lanes are adding migrations now (for example the ranker designs' flags, seeded FALSE). Every file that lands after `debd5ad4f` joins this set in byte order. Before the apply:

1. Re-run the dry run (§2, step 2) on the exact tree that will be applied. The list must be these 40 plus the new files, and nothing else.
2. For every new file, add a row to §3 (dependencies, what it creates, rows touched, postconditions, recovery) and re-run §4 on the harness.
3. If any of the 40 files changes bytes before the apply (for example a fix to 3440/3441 from census §74, or F2–F4 below), re-run §4. The ledger records the checksum at apply time. **After the apply, none of these files may change again**: a changed applied file is drift, and the applier refuses to run over it.

---

## 2. The command sequence

Run from the repository root, on the exact commit that will be merged. Use a shell with no Supabase CLI on `PATH`, and with none of `TRIGGER_PSQL_URL`, `ENGAGEMENT_PSQL_URL`, `SUPABASE_DB_URL` or `DB_URL` set. The target guard refuses otherwise (`.github/scripts/assert-nonprod-supabase.sh`).

```bash
export CI_SUPABASE_PROJECT_REF=hwokxgbmezheskbzskfr
export KNOWN_PROD_PROJECT_REF=ajrurzioarfkagpuxfnb
export SUPABASE_URL=https://hwokxgbmezheskbzskfr.supabase.co
export SUPABASE_PROJECT_TOKEN=…          # Management API token for portava-ci only
```

**Step 1 — pre-flight reads (read-only).** Run the SQL in §2.1 through the Management API SQL editor for `portava-ci`. Every expectation must hold. If one does not, stop: that file would refuse, or would not preserve a value.

**Step 2 — dry run.**

```bash
pnpm --filter @workspace/scripts run db:apply-migrations:dry-run
```

Expected output (exactly, with the numbers as CI printed them on `84318d1b2`):

```
Proven applied, skipped: 223
Ledger row present but NOT proof of an apply (2254 backfill): 384. Not applied. …
Would apply 40 migration(s), IN THIS ORDER:
    1. 3338_media_processing_worker_flag.sql   [shape=unwrapped]
    …
   40. 3441_trail_letter_fold_decompose_first.sql   [shape=unwrapped]
apply-migrations --dry-run PASSED — 40 pending, 223 already recorded, nothing written.
```

There must be no `Ledger rows with no file on disk` line and no `REFUSED`. If the tree carries files from §1.3, the count grows by exactly those.

**Step 3 — zero-persistence rehearsal on `portava-ci` (recommended).** This is the check that proves every dependency against `portava-ci`'s own catalogue before anything persists.

```bash
cd artifacts/api-server
LOCAL_DB_URL=postgresql://127.0.0.1/unused LOCAL_DB_WORK=/tmp/w10d \
  node --import tsx/esm scripts/local-db/rehearse-pending-apply.ts emit-rollback-rehearsal /tmp/w10d/rehearsal.sql
```

It writes one SQL file: `BEGIN;`, every body exactly as the applier would send it, every post-`COMMIT` postcondition, a `NOTICE`, then `ROLLBACK;`. Send the file as one query through the same Management API endpoint the applier uses. Expected: `NOTICE: W10-D rollback rehearsal: all 40 bodies and postconditions held; rolling back.` An `ERROR` names the file that would refuse and changes nothing. The script only writes the file; it refuses any `LOCAL_DB_URL` that is not local, and it has no Supabase transport. It covers the 40 files of §1.2 by name; a file from §1.3 is not in it, so extend `CI_PENDING_84318D1B2` (and re-run §4) before using it on a larger set.

**Step 4 — apply.**

```bash
pnpm --filter @workspace/scripts run db:apply-migrations
```

Expected: 40 lines `→ <file>: applied + recorded (one transaction)`, 19 lines `→ <file>: postconditions verified (separate transaction)` (the `+post` files), the backfill NOTE, then:

```
apply-migrations PASSED — 40 migration(s) applied and recorded in public.schema_migration_ledger, each in one transaction with its ledger row.
```

Exit 0. On a stop, the applier names the file, and the files before it are applied and recorded. Take §3's recovery for that file. Do not continue by hand.

**Step 5 — idempotence.** Run step 4 again. Expected: `apply-migrations: NOTHING TO DO — 263 canonical migration(s) carry a ledger row that proves they were applied …`, exit 0.

**Step 6 — certify.** `certify:migrations` scopes itself by `run=<GITHUB_RUN_ID>` in the ledger notes. A run from a terminal has no run id, so it would certify nothing. Name the files:

```bash
cd artifacts/api-server
pnpm run certify:migrations -- --files 3338_media_processing_worker_flag.sql,3340_media_tab_world_default_flag.sql,3341_media_watch_context_overlay_flag.sql,3342_media_watch_tap_to_play_flag.sql,3343_media_watch_stage24_ranking_flag.sql,3351_media_find_busier_flag.sql,3352_media_perspective_vantage.sql,3355_media_vision_provider_flag.sql,3356_media_moderation_classifier_flag.sql,3357_media_transcoder_flag.sql,3358_media_captions_flag.sql,3359_passport_postcard_cover_nullable.sql,3360_intel_evidence_sealed_reference.sql,3361_intel_evidence_sealed_reference_validate.sql,3362_posts_client_column_grants.sql,3363_place_copies_client_column_grants.sql,3364_pulse_geo_tags_write_boundary.sql,3365_post_media_write_boundary.sql,3366_discovery_search_protected_zones_flag.sql,3375_rank_events_schema_version_admitted.sql,3376_discovery_recommendations_per_request.sql,3380_content_trails_label_cap_serialised.sql,3381_trail_lifecycle_transitions.sql,3385_creator_share_ledger_includes_creator_entries.sql,3386_creator_attribution_recommendation_link.sql,3387_creator_ledger_integrity_and_audit.sql,3390_discovery_rls_explicit_policies.sql,3391_discovery_stop_condition_measurements.sql,3395_discovery_dwell_telemetry_flag.sql,3400_media_pending_upload_sweep_flag.sql,3410_discovery_trend_snapshot_parity.sql,3415_trail_proposal_serialised.sql,3416_trail_relations_projection.sql,3417_place_momentum_dismiss_excluded.sql,3420_rank_events_outcome_receipts.sql,3421_ranking_debug_samples_content_id_nullable.sql,3422_tags_client_write_boundary.sql,3435_place_momentum_feature_version.sql,3440_canonical_search_key_letter_fold.sql,3441_trail_letter_fold_decompose_first.sql
```

Expected at `debd5ad4f`, **without** F1–F4 (§5.3):
- Stage 1 passes: 647 files, 647 ledger rows, 384 not comparable (backfill).
- Stages 2 and 3 were not reproduced offline (§4.6), so no expectation is claimed.
- **Stage 4 fails** on the eight files in §5.3. Each failure is a false alarm, proven on the harness.
- Stage 5 (`audit:schema`, `check:missing-live-columns`) is not reached.

With F1–F4 landed before the apply, the expected result is `certify:migrations PASSED`.

**Step 7 — audit.**

```bash
cd artifacts/api-server && pnpm run audit:schema
```

Expected at `debd5ad4f` **without F1**: exit 1 with exactly one finding, `✖ 3360_intel_evidence_sealed_reference.sql — missing function intel_evidence_rekey_reference`. 3361 drops that function by design, and the auditor reads each file's claims independently (§5.3 F1). Every other one of CI's 58 missing objects is gone (§4.3). With F1: `✔ Live schema contains every object claimed by the migrations.`

**Step 8 — post-apply reads.** Run §2.2.

### 2.1 Pre-flight SQL (read-only) and what each answer must be

```sql
-- (a) None of the 40 has a ledger row; 3350 and 2481 are as recorded.
SELECT count(*) FROM public.schema_migration_ledger
 WHERE filename ~ '^(3338|3340|3341|3342|3343|3351|3352|3355|3356|3357|3358|3359|3360|3361|3362|3363|3364|3365|3366|3375|3376|3380|3381|3385|3386|3387|3390|3391|3395|3400|3410|3415|3416|3417|3420|3421|3422|3435|3440|3441)_';   -- 0
SELECT filename, applied_by, applied_at, checksum FROM public.schema_migration_ledger
 WHERE filename ~ '^(2481|3350)_' ORDER BY 1;          -- record these values verbatim; §2.2 compares them

-- (b) Flag values: the 14 flags the set seeds. Each must be ABSENT or FALSE.
--     A TRUE row makes its file's postcondition refuse (the apply stops there,
--     keeping the TRUE value: proven in §4.2). Record which rows PRE-EXIST:
--     their rollback would delete them (§3, flag-seed recovery).
SELECT flag, enabled, left(description, 60) FROM public.feature_flags WHERE flag IN (
  'media_processing_worker_enabled','MEDIA_TAB_WORLD_DEFAULT_ENABLED','MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED',
  'MEDIA_WATCH_TAP_TO_PLAY_ENABLED','MEDIA_WATCH_STAGE24_RANKING_ENABLED','media_find_busier_enabled',
  'media_perspective_vantage_enabled','media_vision_provider_enabled','media_moderation_classifier_enabled',
  'media_transcoder_enabled','media_captions_enabled','discovery_search_protected_zones_enabled',
  'discovery_dwell_telemetry_enabled','media_pending_upload_sweep_enabled','discovery_trending_api_enabled');
-- Snapshot every flag, to compare after (§2.2):
SELECT md5(string_agg(flag||'|'||enabled||'|'||coalesce(description,'')||'|'||coalesce(metadata::text,''), E'\n' ORDER BY flag)), count(*) FROM public.feature_flags;

-- (c) Data preconditions that refuse an apply.
SELECT count(*) FROM public.rank_events WHERE schema_version <> 1;                          -- 0   (3375)
SELECT count(*) FROM (SELECT 1 FROM public.content_trails WHERE relationship='primary'
  GROUP BY source_type, source_id HAVING count(*) > 1) d;                                   -- 0   (3380)
SELECT count(*) FROM public.intel_evidence WHERE evidence_kind IN ('photo','video')
  AND reference IS NOT NULL AND reference !~ '^ievr1\.[A-Za-z0-9_-]+$';                   -- 0   (3361's own predicate; 0 rows in the table on 2026-09-27)
SELECT count(*) FROM public.ranking_debug_samples;                                          -- any; content_id must be NOT NULL today (3421)

-- (d) Objects the set depends on.
SELECT to_regclass('public.media_processing_attempts'),   -- 2951, for 3338
       to_regclass('public.creator_share_ledger'),        -- 2930, for 3385
       to_regclass('public.creator_attributions'),        -- 2920, for 3386/3387
       to_regclass('public.creator_rule_versions'),       -- 2920, for 3387
       to_regclass('public.rent_buddy_earnings_entries'), -- 2901, for 3387
       to_regclass('public.place_momentum'),              -- 2892, for 3410/3417/3435
       to_regclass('public.trails'),                      -- 2910, for 3380/3381/3415/3416
       to_regclass('public.protected_zones');             -- 2217, read by 3366's pass (not required)
SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
   AND ((table_name='rank_events' AND column_name IN ('schema_version','recommendation_id','outcome_at','surface'))
     OR (table_name='canonical_locations' AND column_name='search_key'));                  -- 5
SELECT current_setting('server_encoding');                                                  -- UTF8 (3415, 3440, 3441)
SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';                                 -- pg_trgm (3440)

-- (e) Ownership and grant shape, which 3362–3365 and 3422 check before they act.
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relacl
  FROM pg_class c WHERE c.oid IN ('public.posts'::regclass, 'public.pulse_geo_tags'::regclass,
       'public.passport_postcards'::regclass, 'public.post_media'::regclass, 'public.tags'::regclass);
-- owner must be the role the Management API runs as (current_user); RLS on for all five.

-- (f) The size of 3440's rewrite (census §73.9, run here against portava-ci).
SELECT count(*), pg_size_pretty(pg_total_relation_size('public.canonical_locations')) FROM public.canonical_locations;
```

Step 3's rollback rehearsal re-checks every one of these, and every other precondition, in the files' own words. The reads above are there so that the operator knows the answers before sending anything.

### 2.2 Post-apply reads

```sql
-- 40 new rows, all manual (or ci), real sha256; 2481 and 3350 byte-identical to §2.1 (a).
SELECT count(*), min(applied_by), max(applied_by), bool_and(checksum ~ '^[0-9a-f]{64}$')
  FROM public.schema_migration_ledger WHERE filename ~ '^(33[3-9]\d|34[0-4]\d)_' AND filename <> '3350_media_neighborhood_only_location_mode.sql';
SELECT filename, applied_by, applied_at, checksum FROM public.schema_migration_ledger WHERE filename ~ '^(2481|3350)_';
-- Every pre-existing flag row unchanged: re-run §2.1 (b)'s md5 restricted to the pre-existing flags.
-- 14 new flag rows, every one FALSE:
SELECT count(*) FILTER (WHERE enabled) AS on_rows, count(*) FROM public.feature_flags WHERE flag IN (…the 14 of §2.1 (b) that were absent…);
-- The stop-measurement function answers, and 3390's posture holds:
SELECT public.discovery_stop_measurements(now() - interval '1 day', now()) -> 'rls_leak';   -- {"state":"measured","deviations":0,…}
```

---

## 3. Per migration: dependencies, what it does, rows touched, postconditions, recovery

**The one rule for flag values.** Every flag-seeding file (3338, 3340–3343, 3351, 3352, 3355–3358, 3366, 3395, 3400, 3410) inserts its row `ON CONFLICT (flag) DO NOTHING`, so an existing row keeps its value and its description. Its postcondition then refuses if the row reads TRUE, so the apply stops rather than record a file whose "ships OFF" claim is false. No file updates an existing flag row. Proven in §4.2.

**The one rule for flag-seed recovery.** Each flag-seed rollback deletes the row while it reads FALSE. If §2.1 (b) found the row PRE-EXISTING, the rollback would delete a row this apply did not create (measured in §4.4 on 3351). For those files, recovery is `DELETE FROM public.schema_migration_ledger WHERE filename = …` only, leaving the row in place.

**Postconditions are verified four ways.** (1) In the applying transaction (every file). (2) The post-`COMMIT` tail, run by the applier (the 19 `+post` files). (3) `certify:migrations` stage 4, which re-runs every assertion-only non-`$pre$` block after commit (§4.3: 64 blocks). (4) `audit:schema`'s object claims, and the catalogue fingerprint on the harness.

| file | depends on | creates / changes | existing rows | postconditions (and how verified) | recovery |
|---|---|---|---|---|---|
| 3338 | `feature_flags`; `media_processing_attempts` (2951) | flag `media_processing_worker_enabled` FALSE | none; an existing row is kept | row present; not TRUE; NOTICE counts the queued/failed assets a flip would claim | rollback deletes the FALSE row (refuses if TRUE) **+ ledger DELETE** |
| 3340 | `feature_flags` | flag `MEDIA_TAB_WORLD_DEFAULT_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3341 | `feature_flags` | flag `MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3342 | `feature_flags` | flag `MEDIA_WATCH_TAP_TO_PLAY_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3343 | `feature_flags` | flag `MEDIA_WATCH_STAGE24_RANKING_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3351 | `feature_flags` | flag `media_find_busier_enabled` FALSE | none | present; not TRUE | as 3338; **deletes a pre-existing row** (§4.4) |
| 3352 | `posts` | `posts.perspective_vantage text NULL` + CHECK over the §12 vocabulary; flag `media_perspective_vantage_enabled` FALSE | catalogue-only ADD COLUMN (no rewrite); the CHECK validates existing rows, all NULL | column present; flag present, not TRUE; vantage count reported | rollback drops constraint, column, flag row **+ ledger DELETE**; free while no row carries a vantage |
| 3355 | `feature_flags` | flag `media_vision_provider_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3356 | `feature_flags` | flag `media_moderation_classifier_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3357 | `feature_flags` | flag `media_transcoder_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3358 | `feature_flags` | flag `media_captions_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3359 | `passport_postcards.media_url NOT NULL` (baseline) | `DROP NOT NULL` | none | column nullable | rollback `SET NOT NULL` (fails if a NULL was written since; that failure is the point) **+ ledger DELETE** |
| 3360 | `intel_evidence` (2130), `.reference` (2223) | CHECK `intel_evidence_media_reference_sealed` NOT VALID; `intel_evidence_rekey_reference(uuid,text,text)` (service_role); column comment | none: NOT VALID skips existing rows | constraint present; function created; no end-user EXECUTE; no append-only trigger disabled | rollback file (drops the function and the constraint, restores the column comment, deletes its ledger row) |
| 3361 | 3360; **0 plaintext photo/video references** | `VALIDATE CONSTRAINT`; `DROP FUNCTION intel_evidence_rekey_reference` | reads every row (validation); writes none. `portava-ci` had 0 `intel_evidence` rows on 2026-09-27 | validated; function gone | rollback file (recreates 3360's function; constraint back to NOT VALID) |
| 3362 | `posts` RLS on; the exact column set (after 3352); client SELECT as 2148 left it; no column ACLs | REVOKE table SELECT from anon/authenticated; GRANT SELECT on 40 columns | none | tail: no private or withheld column readable by a client role; none lost; no table-level client privilege; service_role reads all | rollback restores table-level SELECT exactly; deletes its ledger row |
| 3363 | `pulse_geo_tags`, `passport_postcards`, `post_media`: RLS on, exact columns, client table SELECT | column-level SELECT for client roles on the three tables | none | tail: no place column readable by a client role | rollback file (restores table SELECT) |
| 3364 | `pulse_geo_tags` owned by the applying role; plain client write grants | REVOKE client writes; records the prior ACL in the table comment | none | tail: no client write privilege | rollback restores the exact recorded ACL |
| 3365 | `post_media` owned by the applying role; 2158's descriptor columns | client writes narrowed to 2158's allowlists | none | tail: anon writes nothing; authenticated only inside the allowlists | rollback restores the recorded ACL |
| 3366 | `feature_flags` | flag `discovery_search_protected_zones_enabled` FALSE | none | present; not TRUE | rollback deletes the FALSE row and its ledger row |
| 3375 | `rank_events.schema_version` (2890), every row = 1 | CHECK `schema_version IN (1)` | validates every row once (ACCESS EXCLUSIVE, one scan) | a version-2 probe is refused and not persisted; surface CHECK intact | rollback drops the CHECK; free |
| 3376 | `auth.users`, `rank_events` | table `recommendations` (service-role only, RLS, append-only), writer `record_discovery_serve_request(jsonb)`, 2 indexes, 2 policies | none | tail: a client probe is refused; function service-role only | rollback drops the table; **refuses once rows exist** unless forced, because the rows are the only record of anonymous serves |
| 3380 | 2910's label-cap function and trigger; no content with two primaries | advisory lock added to `content_trails_label_cap()`; partial UNIQUE index `uq_content_trails_one_primary` | index build reads `content_trails` | tail: index present; function locks | rollback restores 2910's body, drops the index |
| 3381 | 2910's state CHECKs | two BEFORE UPDATE transition triggers + functions | none (an UPDATE probe on a sentinel id rolls back) | tail: illegal transitions refused | rollback drops both triggers and functions |
| 3385 | 2930's view, 2921's table, `cee_account_known` | `CREATE OR REPLACE VIEW creator_share_ledger` with a third partition | none | in-transaction: 14 columns, account CASE total, no service_role UPDATE | rollback restores 2930's definition (**leaves 3385's view comment**, §4.4) |
| 3386 | 2920; `rank_events.recommendation_id` (2891) | `creator_attributions.recommendation_id` + shape CHECK + existence trigger + partial index | ADD COLUMN NULL (catalogue-only) | in-transaction only (no re-runnable block) | rollback refuses while 3387 is applied, or while any attribution carries an id |
| 3387 | 2920, 2921, `creator_rule_versions`, 3386, 2901's table | 4 triggers, 6 functions, `creator_ledger_audit_events`, `creator_ledger_append(jsonb)`, FKs → ON DELETE CASCADE | FK swap validates existing rows (0 on every reachable DB) | in-transaction only | rollback refuses while the audit table holds rows |
| 3390 | `auth.uid()`, the three roles, the core Discovery tables and the client policies it preserves | explicit policies on the 16 Discovery tables; REVOKE TRUNCATE/REFERENCES/TRIGGER from client roles | none | in-transaction `$post$` (reads a temp table: F4) | rollback drops its policies (**does not re-grant** the three revoked privileges, §4.4) |
| 3391 | `rank_events.outcome_at`, `discovery_places`, `discovery_place_reports`, 3390 | partial index `rank_events_discovery_served_at`; `discovery_stop_measurements(since, until)` | index build under SHARE lock on `rank_events` | function answers; `rls_leak.deviations = 0` (§4.3) | rollback drops both |
| 3395 | `feature_flags` | flag `discovery_dwell_telemetry_enabled` FALSE | none | present; not TRUE | rollback deletes the FALSE row and its ledger row |
| 3400 | `feature_flags` | flag `media_pending_upload_sweep_enabled` FALSE | none | present; not TRUE | as 3395 |
| 3410 | `place_momentum` (2892), `rank_events.surface` | 3 nullable columns; `rebuild_place_momentum` corpus/window/explanation repaired; flag `discovery_trending_api_enabled` FALSE | ADD COLUMN NULL; nothing schedules a rebuild | tail: parity with the classifier; flag not TRUE | rollback restores 2892's body, drops the columns and the flag row (**leaves the two functions' EXECUTE revoked** from anon/authenticated, §4.4) |
| 3415 | 2910's `trails.canonicalization`; UTF8 | 8 functions incl. `trail_propose` | none (probe rolls back) | tail: verdicts, slug parity, isolation guard | rollback drops the 8 functions |
| 3416 | 2910's tables | `trail_relations` (service role), `rebuild_trail_relations(ts)` | none (probe rolls back) | tail: rebuild reproduces declared, parent and common-content relations | rollback drops both |
| 3417 | 2892 + 3410's body | `rebuild_place_momentum`: dismiss weighs 0 | none | tail: the body is 3410's but for one arm | rollback restores 3410's body |
| 3420 | `rank_events` uuid ids; no prior column or table | `rank_events.outcome_client_event_id`; `rank_event_outcome_receipts`; receipt trigger; 4 deny policies | ADD COLUMN NULL (catalogue-only) | tail: a second keyed outcome collides; later keyed outcomes allowed | rollback drops trigger, function, table, column; keyed retries become keyless |
| 3421 | `ranking_debug_samples.content_id NOT NULL`; 2060's columns | `DROP NOT NULL` | none | tail: a sample without content_id lands (probe rolls back) | rollback **deletes samples without content_id**, then SET NOT NULL |
| 3422 | `tags` owned by the applying role; parties-only SELECT policies | REVOKE client writes on `tags`; prior ACL recorded in the comment | none | tail: no client write privilege | rollback restores the recorded ACL |
| 3435 | 3417's body | `place_momentum.feature_version`; `rebuild_place_momentum` writes it | ADD COLUMN NULL; old rows stay NULL | tail: every 3417 column written with the same value | rollback restores 3417's body and drops the column |
| 3440 | 2220's generated `search_key`; `pg_trgm`; UTF8 | replaces `input_normalize_city_key`; **drops and re-adds `canonical_locations.search_key`, recomputing every row, under ACCESS EXCLUSIVE**; rebuilds the trigram index | **rewrites `search_key` on every row**. `name`, `normalized_name` and `display_name` are untouched | in-transaction: column generated, index present, 2220's three launch keys, Ǿresund → oresund, ß unchanged | **no rollback file.** The footer's reversal was rehearsed (§4.4): `DROP INDEX canonical_locations_search_key_trgm_idx; ALTER TABLE canonical_locations DROP COLUMN search_key;` then re-run 2220, then `DELETE` 3440's ledger row. Reversing reopens §66.5's defect |
| 3441 | 3415's `trail_letter_fold`; UTF8 | replaces `trail_letter_fold` | none | in-transaction | **no rollback file.** Forward fix, or re-run 3415's `CREATE OR REPLACE FUNCTION public.trail_letter_fold` block and `DELETE` 3441's ledger row. Rolling back 3415 removes the function outright (rehearsed) |

**The 2481 entry.** 2481 is outside the pending set (its row is `applied_by='ci'`, 2026-09-09) and nothing in this set names it. The applier writes a ledger row only for the file it is applying (`ON CONFLICT (filename)` on that filename), so 2481's row cannot be touched. §2.1 (a) and §2.2 read it before and after; the two readings must be identical.

**What must NOT happen:**
- `--apply-unproven` is not used, for any file. None of the 40 has a backfill row, so it would have nothing to do, and on the 384 backfill rows it would replay migrations that may already be applied.
- 2481's ledger row is not modified, re-inserted or deleted.
- No file is applied by hand with `psql -f` or pasted into the SQL editor outside the applier. That would skip the ledger row, and the applier would then try to apply the file again.
- No rollback file is run except as the recovery for a named failure.
- Nothing is sent to production. The applier refuses its ref, and so does the guard.

---

## 4. Rehearsal on the local harness (controlled evidence)

**Environment:** PostgreSQL 16 at `127.0.0.1:55455`, data dir `/var/tmp/w10d-localdb` (mode 777, 1 MB WAL segments), work dir `/var/tmp/w10d-work`. Driver: `artifacts/api-server/scripts/local-db/rehearse-pending-apply.ts`. Seed: `rehearse-pending-apply.seed.sql`. Run 2026-09-28.

### 4.1 The restored baseline

- `LOCAL_DB_TO=3338 scripts/local-db/up.sh`: the baseline (388 tables), then the chain from 2093 to before 3338. 314 applied in order, 12 known-unreplayable (2 of those applied on retry), exactly as `up.sh` always reports them.
- 3350 applied by `psql -f`, as `portava-ci` holds it.
- `model-ledger`: 225 proven rows written for the psql-replayed files. `plan` then printed the 40 of §1.2, and the driver compared them with CI's list: `plan: IDENTICAL to CI's dry run on 84318d1b2 (40 files, same order)` and `every shape … matches CI's`.
- Seed data loaded (the seed file): pre-existing flags (`discovery_serve_log_enabled` TRUE, as in production; `media_find_busier_enabled` FALSE with a non-seed description), one account, 4 `canonical_locations` rows (Øresund, Ǿresund, Đà Nẵng, Straße), 3 `rank_events` rows, a Trail with a primary member, and a debug sample.
- Snapshot database `w10d_baseline` taken (`CREATE DATABASE … TEMPLATE`). Catalogue fingerprint: 12,320 lines (tables, columns, constraints, indexes, function bodies and ACLs, triggers, policies, views, comments). Data fingerprint: row count and md5 of the pre-existing columns of 18 tables, plus the `search_key` values.

### 4.2 Apply, data preservation, and the flag-value negative control

- `apply`: **40 applied**, each in one transaction with its ledger row, and **19 post-`COMMIT` postcondition tails verified**. The whole run took 3.6 s.
- **Data:** every pre-existing row of the 18 tables is byte-identical after the apply, compared by md5 of its pre-existing columns. The one documented exception: `search_key` moved for exactly one seed row, `Ǿresund: resund → oresund` (3440). Øresund, Đà Nẵng and Straße kept theirs.
- **Flags:** all 92 pre-existing `feature_flags` rows are identical (flag, enabled, md5(description), metadata), including the pre-existing `media_find_busier_enabled` row with its own description. 14 rows were added, every one FALSE.
- **Negative control:** in a copy of the baseline with `media_find_busier_enabled` set TRUE, the apply stopped at `3351_media_find_busier_flag.sql (failed)` with `POSTCONDITION FAILED: media_find_busier_enabled is ON — …`. Five files had applied before it. The flag still read TRUE. 3351 had no ledger row. So a TRUE flag is never overwritten, and a file that would claim otherwise is never recorded.

### 4.3 Postconditions, objects and the stop measurement

- **Certify stage 4, reproduced** with the same block selection `certify:migrations` uses (`topLevelStatements` → `isAssertionOnlyDoBlock` → not `isPreconditionDoBlock`): 64 blocks re-run after commit, 15 `$pre$` blocks held back. **8 failed**, all listed in §5.3. None is a defect in what was applied.
- **Objects:** 57 of the 58 objects CI's `audit:schema` named missing on `84318d1b2` are present. The 58th is `intel_evidence_rekey_reference`, which 3361 drops by design (F1). The 7 columns and 1 table the live column checks named are all present.
- `discovery_stop_measurements(now()-1 day, now())`: `rls_leak: {"state":"measured","deviations":0}`, `attribution_double_count: {"duplicate_groups":0}`, `reports_hides` and `creator_concentration` measured over the 3 seed exposures.

### 4.4 Idempotence, every rollback, and the round trip

- **Idempotence:** a second `apply` printed `NOTHING TO DO — 265 proven row(s), 0 pending`, and `plan` printed `Would apply: NOTHING`.
- **Rollbacks:** all 38 rollback files ran, newest first, and every one succeeded. 27 removed their own ledger row. **11 did not (3338–3359)**, and the driver deleted those rows so that the round trip could continue (§1.2 ¹).
- **3440's reversal** (footer SQL, then 2220) ran: `input_normalize_city_key('Ǿresund')` read `resund` again, and the stored key for Ǿresund returned to `resund`.
- **3441** needed no separate step: 3415's rollback removed `trail_letter_fold` outright.
- **Catalogue after all rollbacks vs the baseline: 12,320 lines each, 8 lines differ.** All eight leave the database *tighter* or equal, never wider:
  - `place_momentum_classify` and `rebuild_place_momentum`: EXECUTE for anon/authenticated is not restored by 3410's rollback;
  - `discovery_cache`, `discovery_geocode_cache`, `discovery_place_reports`, `discovery_place_saves` and `rank_events`: TRUNCATE/REFERENCES/TRIGGER for anon/authenticated are not re-granted by 3390's rollback (`arwdDxt` → `arwd`);
  - `creator_share_ledger`'s comment is 3385's, not 2930's.
- **Data after all rollbacks:** identical to the baseline except one row. **3351's rollback deleted the pre-existing `media_find_busier_enabled` row** (92 → 91 flags). That is the flag-seed recovery rule in §3.
- **Re-apply after rollback:** `plan` printed the same 40 again (identical to CI), and all 40 applied. **The catalogue after the re-apply equals the catalogue after the first apply: 12,536 lines, 0 differences.**

### 4.5 `scripts/local-db/run-tests.sh`

| database | result |
|---|---|
| the rehearsed database (baseline + seed + apply → rollback → re-apply) | 374 / 377 pass, 0 skipped. The 3 failures are harness artefacts of the rehearsal itself, each explained below. |
| a fresh standard chain at this tree (`up.sh`, 355 applied in order) | **377 / 377 pass, 0 skipped, 0 cancelled** (64 suites) |

The three failures on the rehearsed database:
- `discoverySearchCanonicalFold` K6 collides with a seed `canonical_locations` row (`uq_canonical_locations_identity`). With the four seed rows deleted, the suite passes 13/13.
- `pulseGeoTagsWriteBoundary` G4-5 and `postMediaWriteBoundary` G5-5 assert `ledger: 0` for 3364/3365. That holds on the standard harness, which replays files with psql and writes no ledger row. On the rehearsed database the applier wrote a row. On the fresh standard chain, the three suites pass 25/25.

### 4.6 The rollback-rehearsal file (step 3), itself rehearsed

- On a second pre-3338 baseline (rebuilt with `LOCAL_DB_TO=3338`, plus 3350, the modelled ledger and the seed), the emitted file (295,703 bytes) ran. It printed `all 40 bodies and postconditions held; rolling back.` with psql exit 0.
- Catalogue, data and ledger (607 rows) were identical before and after it: 0 differences.
- **Negative control:** with `media_find_busier_enabled` TRUE, the file stopped at 3351's postcondition (psql exit 3), and the catalogue was again identical.

**Not reproduced offline:** certify stages 2, 3 and 5, and `audit:schema` itself (all need the Management API). The objects check in §4.3 covers stage 2's question for the objects CI named.

---

## 5. Turning the live-DB checks green

### 5.1 Why they are red on PR #528 today

On `84318d1b2` (run 36392056669):
- `schema drift` failed at `audit:schema`: *"58 missing object(s) across 14 file(s)"*;
- `api-server · check:all + live_pulse gate` failed on `check:write-path-columns` (`rank_event_outcome_receipts`, `creator_attributions.recommendation_id`, `posts.perspective_vantage`, `rank_events.outcome_client_event_id`) and `check:missing-live-columns` (7 columns from 3352, 3386, 3410, 3420 and 3435);
- `live DB · RLS + role/is_official write boundaries` and `post-media revocation` were skipped behind `schema-drift`;
- `live DB · verdict` failed because of the above.

### 5.2 What the apply changes

After step 4, on the PR's next push or re-run:
- **`schema drift`:** the dry run prints `Would apply: NOTHING`. `audit:schema` finds 57 of the 58 objects and **still reports 3360's function** until F1 lands. With F1, the job is green. That green run is the `portava-ci` rehearsal record (§6).
- **`check:all + live_pulse gate`:** every object both column checks named is present (§4.3), so both should pass. That is inferred from their own output, not re-run here.
- **The two skipped jobs** run for the first time on this tree, and their result is not predicted here.
- **`live DB · verdict`** turns green when all of the above pass.

### 5.3 Four fixes needed first, found by the rehearsal (not this lane's files)

| id | file (owner) | defect | exact fix | why it matters |
|---|---|---|---|---|
| **F1** | `artifacts/api-server/src/scripts/auditMigrationsVsLive.ts` (CI/database owner) | 3360 claims `function:intel_evidence_rekey_reference`, and 3361 drops it by design. The auditor reads each file's claims independently, so after the apply it reports the function missing forever. | Add `"function:intel_evidence_rekey_reference"` to `ALLOWLIST` with the same reasoning as the `intel_append_only_stmt` entry: created by 3360, dropped by 3361 once no plaintext key remains. | Without it, `schema drift` and certify stage 5 stay red after a correct apply. It can land before or after the apply. |
| **F2** | the first `DO $$` block of 3362 (line 88), 3363 (68), 3364 (55), 3365 (58), 3421 (48) and 3422 (84) (media G1 lane; P15) | Precondition blocks written `DO $$ … $$;` that refuse a second apply ("already carries 3364's record", "content_id is already nullable", "do not both hold table-level SELECT"). Certify stage 4 re-runs every untagged block after commit, so each fails by construction: the same trap as 2965 (`migrationSqlBlocks.ts`, `isPreconditionDoBlock`). | Retag each of those six blocks `DO $pre$ … $pre$;`. No statement changes. | Certify stage 4 fails on six correctly applied files. |
| **F3** | `artifacts/api-server/src/migrations/3360_intel_evidence_sealed_reference.sql:186#DO $post$` (census-map §45 lane) | Its `$post$` block asserts the rekey function exists, and 3361 (applied right after it) drops the function. Re-run after 3361, the block fails. | Guard the function assertion on 3361 not having run, for example `IF to_regprocedure(…) IS NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='intel_evidence_media_reference_sealed' AND convalidated) THEN RAISE …`. | Certify stage 4 fails on 3360. |
| **F4** | `artifacts/api-server/src/migrations/3390_discovery_rls_explicit_policies.sql:254#DO $post$` (P9 lane) | Its `$post$` block reads `_p3390_tables`, a `TEMP … ON COMMIT DROP` table created in the same transaction. Re-run after commit, it fails with `relation "_p3390_tables" does not exist`. | Inline the table list as a `VALUES` list in the block, or tag the block `$pre$`. `rls_leak` from 3391 already re-measures the posture after commit (§4.3). | Certify stage 4 fails on 3390. |

**F2–F4 change the bytes of unapplied files, so they must land BEFORE the apply.** Afterwards they would be drift. F1 is a script change and can land at any time. If the owner wants the apply before these land, the apply is still safe. The consequence is only that step 6 and step 7 fail with exactly the messages above, and those can be adjudicated from this section.

### 5.4 The ordering hazard on `main`

After a pre-merge apply, `portava-ci` holds 40 ledger rows whose files are not on `main`. `main`'s `schema-drift` job then:
- lists them as `Ledger rows with no file on disk: 40` in its dry run (informational);
- applies nothing;
- **fails certify stage 1** (`check:migration-ledger`: orphaned rows), until PR #528 merges.

This is the state `docs/migrations.md` records as the historical cause of `CI (live DB)` going red on `main`. It clears on merge. **So apply immediately before merging #528, and merge as soon as the PR's live-DB run is green.** Do not change any of the 40 files between the apply and the merge.

---

## 6. Q66-3, DC-18, DC-26, DV-70 — what this plan settles and what it does not

- **Q66-3 is decided (register D-W10D-1): a pre-merge `portava-ci` apply followed by a green `schema drift` run on this tree IS the CI rehearsal** that `12` and `10` §7 name. The workflow's `schema-drift` job on `portava-ci` is the rehearsal: it computes the plan against the ledger, audits the live schema against every claim, and on `main` applies and certifies. A pre-merge apply by the applier, plus that job green on the PR head, exercises the same code against the same database.
- **None of the four rows moves on this plan.** Each stays `IMPLEMENTATION-COMPLETE; awaits:` until the apply happens and a green `schema drift` run exists on `portava-ci` for the applied tree. Census §83 has the statements.
