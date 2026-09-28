# Discovery — the `portava-ci` apply plan (40 migrations at `debd5ad4f`; **73 at `3fd11f858`**, §8)

*Prepared 2026-09-28 by lane W10-D on `disc-w10-d-rollout` (base `debd5ad4f`, whose migration tree is byte-identical to PR #528's head `84318d1b2`). Census section: census-discovery §83.*

**Nothing in this document has been applied to `portava-ci` or to production.** This session has no `portava-ci` credentials. The plan exists so that whoever holds them can apply the set as one verified, mechanical step.

| | |
|---|---|
| Target | `portava-ci`, ref `hwokxgbmezheskbzskfr`. Never production (`ajrurzioarfkagpuxfnb`): the applier refuses that ref by construction. |
| Authority | Owner, 2026-09-28: *"after checking dependencies, preserving existing data and flag values, and verifying recovery and postconditions. Do not modify the intentional 2481 ledger entry."* |
| Set | 40 files, `3338` … `3441`, listed in §1. **Plus whatever lands after `debd5ad4f`**: at W10-F's tree that is `3436`, so **41** (§1.3, §7). **At `3fd11f858` the set is 73: §8 is the current list, and it supersedes §1.2 for the apply.** |
| Rehearsal | Local PostgreSQL 16 harness, port 55455, from a restored pre-apply baseline (§4); re-run by W10-F on port 55458 after the fixes (§7). Controlled evidence, not `portava-ci` evidence. |
| Blockers found | The apply itself passes. **W10-D found four certification blockers (§5.3, F1–F4); W10-F found a fifth (F5) and landed all five (census-discovery §87).** On the harness, `certify:migrations` itself now passes stages 1–4, and `audit:schema` reports nothing in or caused by the set (§7). None was a data risk. |

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

¹ **RESOLVED by W10-F (§7.4).** At `debd5ad4f` these rollback files did not delete their ledger row — twelve, not eleven, measured again in §7.4 — and neither did 3350's. Each now deletes it in its own transaction and asserts it is gone. **The sha256 column is `debd5ad4f`'s:** 3360, 3362–3365, 3390, 3421 and 3422 changed bytes for F2–F4, and 3440/3441 for census §77. §7.1 lists the digests at W10-F's tree; the ledger records the digest of the tree actually applied.

### 1.3 Plus whatever lands after `debd5ad4f`

Wave-10 lanes are adding migrations now (for example the ranker designs' flags, seeded FALSE). Every file that lands after `debd5ad4f` joins this set in byte order (**at `3fd11f858`: 33 more, 73 in all, listed in §8**). Before the apply:

1. Re-run the dry run (§2, step 2) on the exact tree that will be applied. The list must be these 40 plus the new files, and nothing else.
2. For every new file, add a row to §3 (dependencies, what it creates, rows touched, postconditions, recovery) and re-run §4 on the harness.
3. If any of the 40 files changes bytes before the apply (for example a fix to 3440/3441 from census §74, or F2–F4 below), re-run §4. The ledger records the checksum at apply time. **After the apply, none of these files may change again**: a changed applied file is drift, and the applier refuses to run over it. *(Done once by W10-F, §7: `3436` landed, 3440/3441 changed for §77, and F2–F4 changed eight files; §4 was re-run on all of it.)*

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

There must be no `Ledger rows with no file on disk` line and no `REFUSED`. If the tree carries files from §1.3, the count grows by exactly those. **At W10-F's tree: 41**, the 40 plus `3436_trail_health_snapshot_provenance.sql` (39th, `+postconditions`), measured on the harness (§7.2).

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

Expected: 40 lines `→ <file>: applied + recorded (one transaction)`, 19 lines `→ <file>: postconditions verified (separate transaction)` (the `+post` files), the backfill NOTE, then (at W10-F's tree, with 3436: 41 and 20):

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

*Historical — expected at `debd5ad4f`, **without** F1–F4 (§5.3):* stage 1 passes; stage 4 fails on the eight files of §5.3, each a false alarm; stage 5 is not reached. W10-F reproduced exactly that with the tool itself (§7.3, "before").

**Expected at W10-F's tree (F1–F5 landed), measured with `certify:migrations` itself on the harness (§7.3):**
- Stage 1 passes: every file on disk has a ledger row (648 at W10-F's tree; `portava-ci` also carries 384 backfill rows, not comparable).
- Stage 2: `24 declared object(s) present.` (26 with 3436 in `--files`). Stage 3: RLS and the policy-shape wiring pass.
- Stage 4: `59 assertion block(s) re-run against the committed database.`, `21 $pre$ precondition block(s) held back`, and 3386/3387 named as preconditions-only (60 and 22 with 3436).
- Stage 5: `audit:schema` and `check:missing-live-columns` — see step 7.
- Result: **`certify:migrations PASSED`**. On the harness, stage 5 stops on objects the harness never had (§7.3); on `portava-ci`, which carries them, none is expected. That last step is inferred, not measured.

Add `3436_trail_health_snapshot_provenance.sql` to `--files` when it is in the applied set.

**Step 7 — audit.**

```bash
cd artifacts/api-server && pnpm run audit:schema
```

*Historical — at `debd5ad4f`, without F1 and F5:* exit 1, and not with one finding as W10-D predicted but seven: `3360 … missing function intel_evidence_rekey_reference` (F1) and six `missing grant select on {posts, passport_postcards, post_media} to {anon, authenticated}` under 2148, 2151 and 2158 (F5). W10-F measured both with `audit:schema` itself on the harness (§7.3). Every other one of CI's 58 missing objects is gone (§4.3).

**Expected at W10-F's tree:** `✔ Live schema contains every object claimed by the migrations.` On the harness, the findings left after the apply are a subset of what the pre-apply baseline already reported — 37 findings in 11 files the harness cannot replay or never had (§7.3) — and none is in, or caused by, the set.

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
--     since W10-F their rollback keeps them (§3, flag-seed recovery; §7.4).
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

**The one rule for flag-seed recovery (W10-F, §7.4).** Each flag-seed rollback (3338, 3340–3343, 3350, 3351, 3352, 3355–3358, 3366, 3395, 3400, 3410) deletes the flag row only while it reads FALSE **and** carries its forward file's own seed description, byte for byte (an md5 in the rollback). A row that existed before the apply kept its own description (`ON CONFLICT DO NOTHING`), so the rollback keeps it and says so in a NOTICE. Every one of them, and 3359's, now deletes its forward file's ledger row. *(At `debd5ad4f` the rollback deleted a pre-existing row, measured in §4.4 on 3351, and twelve left their ledger row.)*

**Postconditions are verified four ways.** (1) In the applying transaction (every file). (2) The post-`COMMIT` tail, run by the applier (the 19 `+post` files). (3) `certify:migrations` stage 4, which re-runs every assertion-only non-`$pre$` block after commit (§7.3: 59 blocks, 21 `$pre$` held). (4) `audit:schema`'s object claims, and the catalogue fingerprint on the harness.

| file | depends on | creates / changes | existing rows | postconditions (and how verified) | recovery |
|---|---|---|---|---|---|
| 3338 | `feature_flags`; `media_processing_attempts` (2951) | flag `media_processing_worker_enabled` FALSE | none; an existing row is kept | row present; not TRUE; NOTICE counts the queued/failed assets a flip would claim | rollback deletes its own FALSE row (refuses if TRUE; keeps a pre-existing row) and its ledger row (W10-F) |
| 3340 | `feature_flags` | flag `MEDIA_TAB_WORLD_DEFAULT_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3341 | `feature_flags` | flag `MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3342 | `feature_flags` | flag `MEDIA_WATCH_TAP_TO_PLAY_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3343 | `feature_flags` | flag `MEDIA_WATCH_STAGE24_RANKING_ENABLED` FALSE | none | present; not TRUE | as 3338 |
| 3351 | `feature_flags` | flag `media_find_busier_enabled` FALSE | none | present; not TRUE | as 3338; a pre-existing row is kept (§7.4; at `debd5ad4f` it was deleted, §4.4) |
| 3352 | `posts` | `posts.perspective_vantage text NULL` + CHECK over the §12 vocabulary; flag `media_perspective_vantage_enabled` FALSE | catalogue-only ADD COLUMN (no rewrite); the CHECK validates existing rows, all NULL | column present; flag present, not TRUE; vantage count reported | rollback drops constraint, column, its own flag row and its ledger row (W10-F); free while no row carries a vantage |
| 3355 | `feature_flags` | flag `media_vision_provider_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3356 | `feature_flags` | flag `media_moderation_classifier_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3357 | `feature_flags` | flag `media_transcoder_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3358 | `feature_flags` | flag `media_captions_enabled` FALSE | none | present; not TRUE | as 3338 |
| 3359 | `passport_postcards.media_url NOT NULL` (baseline) | `DROP NOT NULL` | none | column nullable | rollback `SET NOT NULL` (fails if a NULL was written since; that failure is the point) and deletes its ledger row (W10-F) |
| 3360 | `intel_evidence` (2130), `.reference` (2223) | CHECK `intel_evidence_media_reference_sealed` NOT VALID; `intel_evidence_rekey_reference(uuid,text,text)` (service_role); column comment | none: NOT VALID skips existing rows | constraint present; function created (or, once 3361 has run, dropped with the constraint validated: F3); no end-user EXECUTE; no append-only trigger disabled | rollback file (drops the function and the constraint, restores the column comment, deletes its ledger row) |
| 3361 | 3360; **0 plaintext photo/video references** | `VALIDATE CONSTRAINT`; `DROP FUNCTION intel_evidence_rekey_reference` | reads every row (validation); writes none. `portava-ci` had 0 `intel_evidence` rows on 2026-09-27 | validated; function gone | rollback file (recreates 3360's function; constraint back to NOT VALID) |
| 3362 | `posts` RLS on; the exact column set (after 3352); client SELECT as 2148 left it; no column ACLs | REVOKE table SELECT from anon/authenticated; GRANT SELECT on 40 columns | none | tail: no private or withheld column readable by a client role; none lost; no table-level client privilege; service_role reads all | rollback restores table-level SELECT exactly; deletes its ledger row |
| 3363 | `pulse_geo_tags`, `passport_postcards`, `post_media`: RLS on, exact columns, client table SELECT | column-level SELECT for client roles on the three tables | none | tail: no place column readable by a client role | rollback file (restores table SELECT) |
| 3364 | `pulse_geo_tags` owned by the applying role; plain client write grants | REVOKE client writes; records the prior ACL in the table comment | none | tail: no client write privilege | rollback restores the exact recorded ACL |
| 3365 | `post_media` owned by the applying role; 2158's descriptor columns | client writes narrowed to 2158's allowlists | none | tail: anon writes nothing; authenticated only inside the allowlists | rollback restores the recorded ACL |
| 3366 | `feature_flags` | flag `discovery_search_protected_zones_enabled` FALSE | none | present; not TRUE | rollback deletes its own FALSE row (a pre-existing one is kept) and its ledger row |
| 3375 | `rank_events.schema_version` (2890), every row = 1 | CHECK `schema_version IN (1)` | validates every row once (ACCESS EXCLUSIVE, one scan) | a version-2 probe is refused and not persisted; surface CHECK intact | rollback drops the CHECK; free |
| 3376 | `auth.users`, `rank_events` | table `recommendations` (service-role only, RLS, append-only), writer `record_discovery_serve_request(jsonb)`, 2 indexes, 2 policies | none | tail: a client probe is refused; function service-role only | rollback drops the table; **refuses once rows exist** unless forced, because the rows are the only record of anonymous serves |
| 3380 | 2910's label-cap function and trigger; no content with two primaries | advisory lock added to `content_trails_label_cap()`; partial UNIQUE index `uq_content_trails_one_primary` | index build reads `content_trails` | tail: index present; function locks | rollback restores 2910's body, drops the index |
| 3381 | 2910's state CHECKs | two BEFORE UPDATE transition triggers + functions | none (an UPDATE probe on a sentinel id rolls back) | tail: illegal transitions refused | rollback drops both triggers and functions |
| 3385 | 2930's view, 2921's table, `cee_account_known` | `CREATE OR REPLACE VIEW creator_share_ledger` with a third partition | none | in-transaction: 14 columns, account CASE total, no service_role UPDATE | rollback restores 2930's definition (**leaves 3385's view comment**, §4.4) |
| 3386 | 2920; `rank_events.recommendation_id` (2891) | `creator_attributions.recommendation_id` + shape CHECK + existence trigger + partial index | ADD COLUMN NULL (catalogue-only) | in-transaction only (no re-runnable block) | rollback refuses while 3387 is applied, or while any attribution carries an id |
| 3387 | 2920, 2921, `creator_rule_versions`, 3386, 2901's table | 4 triggers, 6 functions, `creator_ledger_audit_events`, `creator_ledger_append(jsonb)`, FKs → ON DELETE CASCADE | FK swap validates existing rows (0 on every reachable DB) | in-transaction only | rollback refuses while the audit table holds rows |
| 3390 | `auth.uid()`, the three roles, the core Discovery tables and the client policies it preserves | explicit policies on the 16 Discovery tables; REVOKE TRUNCATE/REFERENCES/TRIGGER from client roles | none | `$post$` reads the catalogue only, re-runnable after commit (F4); the literal lists and service_role's BEFORE snapshot are checked in the applying transaction | rollback drops its policies (**does not re-grant** the three revoked privileges, §4.4) |
| 3391 | `rank_events.outcome_at`, `discovery_places`, `discovery_place_reports`, 3390 | partial index `rank_events_discovery_served_at`; `discovery_stop_measurements(since, until)` | index build under SHARE lock on `rank_events` | function answers; `rls_leak.deviations = 0` (§4.3) | rollback drops both |
| 3395 | `feature_flags` | flag `discovery_dwell_telemetry_enabled` FALSE | none | present; not TRUE | rollback deletes its own FALSE row (a pre-existing one is kept) and its ledger row |
| 3400 | `feature_flags` | flag `media_pending_upload_sweep_enabled` FALSE | none | present; not TRUE | as 3395 |
| 3410 | `place_momentum` (2892), `rank_events.surface` | 3 nullable columns; `rebuild_place_momentum` corpus/window/explanation repaired; flag `discovery_trending_api_enabled` FALSE | ADD COLUMN NULL; nothing schedules a rebuild | tail: parity with the classifier; flag not TRUE | rollback restores 2892's body, drops the columns and its own flag row (**leaves the two functions' EXECUTE revoked** from anon/authenticated, §4.4) |
| 3415 | 2910's `trails.canonicalization`; UTF8 | 8 functions incl. `trail_propose` | none (probe rolls back) | tail: verdicts, slug parity, isolation guard | rollback drops the 8 functions |
| 3416 | 2910's tables | `trail_relations` (service role), `rebuild_trail_relations(ts)` | none (probe rolls back) | tail: rebuild reproduces declared, parent and common-content relations | rollback drops both |
| 3417 | 2892 + 3410's body | `rebuild_place_momentum`: dismiss weighs 0 | none | tail: the body is 3410's but for one arm | rollback restores 3410's body |
| 3420 | `rank_events` uuid ids; no prior column or table | `rank_events.outcome_client_event_id`; `rank_event_outcome_receipts`; receipt trigger; 4 deny policies | ADD COLUMN NULL (catalogue-only) | tail: a second keyed outcome collides; later keyed outcomes allowed | rollback drops trigger, function, table, column; keyed retries become keyless |
| 3421 | `ranking_debug_samples.content_id NOT NULL`; 2060's columns | `DROP NOT NULL` | none | tail: a sample without content_id lands (probe rolls back) | rollback **deletes samples without content_id**, then SET NOT NULL |
| 3422 | `tags` owned by the applying role; parties-only SELECT policies | REVOKE client writes on `tags`; prior ACL recorded in the comment | none | tail: no client write privilege | rollback restores the recorded ACL |
| 3435 | 3417's body | `place_momentum.feature_version`; `rebuild_place_momentum` writes it | ADD COLUMN NULL; old rows stay NULL | tail: every 3417 column written with the same value | rollback restores 3417's body and drops the column |
| 3436 | 2910's `trail_health_snapshots` | two NULLABLE columns, `feature_version` and `source_window` (landed after `debd5ad4f`, census-discovery §75) | ADD COLUMN NULL (catalogue-only); old rows stay NULL | tail (`+postconditions`) | rollback file drops both columns and deletes its ledger row (§7.4) |
| 3440 | 2220's generated `search_key`; `pg_trgm`; UTF8 | replaces `input_normalize_city_key`; **drops and re-adds `canonical_locations.search_key`, recomputing every row, under ACCESS EXCLUSIVE**; rebuilds the trigram index | **rewrites `search_key` on every row**. `name`, `normalized_name` and `display_name` are untouched | in-transaction: column generated, index present, 2220's three launch keys, Ǿresund → oresund, ß unchanged | **no rollback file.** The footer's reversal was rehearsed (§4.4): `DROP INDEX canonical_locations_search_key_trgm_idx; ALTER TABLE canonical_locations DROP COLUMN search_key;` then re-run 2220, then `DELETE` 3440's ledger row. Reversing reopens §66.5's defect |
| 3441 | 3415's three fold functions; UTF8 | at W10-F's tree (§77): replaces `trail_letter_fold`, `trail_canonical_slug`, `trail_normalised_destination`; adds `trails.destination_key` (generated, stored) and `idx_trails_destination_key` | **recomputes `trails.slug` where it differs from the new canonical slug**, and computes `destination_key` for every Trail | in-transaction | **no rollback file.** Forward fix, or the footer's REVERSAL: drop the index and the column FIRST, then re-run 3415's three function blocks and `DELETE` 3441's ledger row. **3415's rollback fails while the column exists** (`cannot drop function trail_normalised_destination(text)`, measured §7.4); the driver now runs the footer first |

**The 2481 entry.** 2481 is outside the pending set (its row is `applied_by='ci'`, 2026-09-09) and nothing in this set names it. The applier writes a ledger row only for the file it is applying (`ON CONFLICT (filename)` on that filename), so 2481's row cannot be touched. §2.1 (a) and §2.2 read it before and after; the two readings must be identical.

**What must NOT happen:**
- `--apply-unproven` is not used, for any file. None of the 40 has a backfill row, so it would have nothing to do, and on the 384 backfill rows it would replay migrations that may already be applied.
- 2481's ledger row is not modified, re-inserted or deleted.
- No file is applied by hand with `psql -f` or pasted into the SQL editor outside the applier. That would skip the ledger row, and the applier would then try to apply the file again.
- No rollback file is run except as the recovery for a named failure.
- Nothing is sent to production. The applier refuses its ref, and so does the guard.

---

## 4. Rehearsal on the local harness (controlled evidence)

**Environment:** PostgreSQL 16 at `127.0.0.1:55455`, data dir `/var/tmp/w10d-localdb` (mode 777, 1 MB WAL segments), work dir `/var/tmp/w10d-work`. Driver: `artifacts/api-server/scripts/local-db/rehearse-pending-apply.ts`. Seed: `rehearse-pending-apply.seed.sql`. Run 2026-09-28. *This section is W10-D's run at `debd5ad4f`, kept as the record of the defects; §7 is W10-F's re-run after the fixes.*

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
- **`schema drift`:** the dry run prints `Would apply: NOTHING`. `audit:schema` finds 57 of the 58 objects; the 58th, 3360's function, is dropped by 3361 by design and is allowlisted (F1), and the six table-level SELECT grants 3362/3363 take back are allowlisted (F5). With F1–F5 landed (W10-F), the job is expected green. That green run is the `portava-ci` rehearsal record (§6).
- **`check:all + live_pulse gate`:** every object both column checks named is present (§4.3), so both should pass. That is inferred from their own output, not re-run here.
- **The two skipped jobs** run for the first time on this tree, and their result is not predicted here.
- **`live DB · verdict`** turns green when all of the above pass.

### 5.3 Five fixes needed first — all landed by W10-F (census-discovery §87)

| id | file (owner) | defect | exact fix | why it matters |
|---|---|---|---|---|
| **F1** | `artifacts/api-server/src/scripts/auditMigrationsVsLive.ts` (CI/database owner) | 3360 claims `function:intel_evidence_rekey_reference`, and 3361 drops it by design. The auditor reads each file's claims independently, so after the apply it reports the function missing forever. | Add `"function:intel_evidence_rekey_reference"` to `ALLOWLIST` with the same reasoning as the `intel_append_only_stmt` entry: created by 3360, dropped by 3361 once no plaintext key remains. | Without it, `schema drift` and certify stage 5 stay red after a correct apply. It can land before or after the apply. **Landed (W10-F).** |
| **F2** | the first `DO $$` block of 3362 (line 88), 3363 (68), 3364 (55), 3365 (58), 3421 (48) and 3422 (84) (media G1 lane; P15) | Precondition blocks written `DO $$ … $$;` that refuse a second apply ("already carries 3364's record", "content_id is already nullable", "do not both hold table-level SELECT"). Certify stage 4 re-runs every untagged block after commit, so each fails by construction: the same trap as 2965 (`migrationSqlBlocks.ts`, `isPreconditionDoBlock`). | Retag each of those six blocks `DO $pre$ … $pre$;`. No statement changes. | Certify stage 4 fails on six correctly applied files. **Landed (W10-F): line-neutral, the six tags only.** |
| **F3** | `artifacts/api-server/src/migrations/3360_intel_evidence_sealed_reference.sql:186#DO $post$` (census-map §45 lane) | Its `$post$` block asserts the rekey function exists, and 3361 (applied right after it) drops the function. Re-run after 3361, the block fails. | Guard the function assertion on 3361 not having run, for example `IF to_regprocedure(…) IS NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='intel_evidence_media_reference_sealed' AND convalidated) THEN RAISE …`. | Certify stage 4 fails on 3360. **Landed (W10-F):** when the function is absent the block now requires the constraint VALIDATED (3361's state); when present it still checks no end-user EXECUTE. Controls in §7.5. |
| **F4** | `artifacts/api-server/src/migrations/3390_discovery_rls_explicit_policies.sql:258#DO $post$` (P9 lane) | Its `$post$` block reads `_p3390_tables`, a `TEMP … ON COMMIT DROP` table created in the same transaction. Re-run after commit, it fails with `relation "_p3390_tables" does not exist`. | Inline the table list as a `VALUES` list in the block, or tag the block `$pre$`. `rls_leak` from 3391 already re-measures the posture after commit (§4.3). | Certify stage 4 fails on 3390. **Landed (W10-F):** the table and kept-path lists are literals in the block, which reads only the catalogue; in the applying transaction it checks them against the temp tables and service_role against its BEFORE snapshot. Controls in §7.5. |
| **F5** | `auditMigrationsVsLive.ts` `ALLOWLIST` (found by W10-F) | 2148, 2151 and 2158 claim table-level `GRANT SELECT` to anon/authenticated on `posts`, `passport_postcards` and `post_media`. 3362 and 3363 take those grants back by design and grant column SELECT instead; the auditor reads `role_table_grants`, which has no column grants, so after the apply it reports six grants missing. W10-D's objects check covered only what CI named before the apply, so it could not see this. | Six `grant:<table>.<role>.select` entries, reasoned like the `portava_featured` pair (2160 superseded by 2332). | `schema drift` and certify stage 5 stay red after a correct apply. **Landed (W10-F).** |

**F2–F4 change the bytes of unapplied files, so they must land BEFORE the apply.** Afterwards they would be drift. F1 and F5 are script changes and can land at any time. W10-F checked that none of the changed files is applied anywhere (§7.1). If the owner wants the apply before these land, the apply is still safe. The consequence is only that step 6 and step 7 fail with exactly the messages above, and those can be adjudicated from this section.

### 5.4 The ordering hazard on `main`

After a pre-merge apply, `portava-ci` holds 40 ledger rows whose files are not on `main`. `main`'s `schema-drift` job then:
- lists them as `Ledger rows with no file on disk: 40` in its dry run (informational);
- applies nothing;
- **fails certify stage 1** (`check:migration-ledger`: orphaned rows), until PR #528 merges.

This is the state `docs/migrations.md` records as the historical cause of `CI (live DB)` going red on `main`. It clears on merge. **So apply immediately before merging #528, and merge as soon as the PR's live-DB run is green.** Do not change any of the 40 files between the apply and the merge.

---

## 6. Q66-3, DC-18, DC-26, DV-70 — what this plan settles and what it does not

- **Q66-3 is decided (register D-W10D-1): a pre-merge `portava-ci` apply followed by a green `schema drift` run on this tree IS the CI rehearsal** that `12` and `10` §7 name. The workflow's `schema-drift` job on `portava-ci` is the rehearsal: it computes the plan against the ledger, audits the live schema against every claim, and on `main` applies and certifies. A pre-merge apply by the applier, plus that job green on the PR head, exercises the same code against the same database.
- **None of the four rows moves on this plan.** Each stays `IMPLEMENTATION-COMPLETE; awaits:` until the apply happens and a green `schema drift` run exists on `portava-ci` for the applied tree. Census §83 has the statements, restated by §87 after F1–F5.

---

## 7. W10-F: F1–F5 landed, and the rehearsal re-run (census-discovery §87)

*Lane W10-F, 2026-09-28, branch `disc-w10-f-certify` from `f3047e54d`. Harness: PostgreSQL 16 at `127.0.0.1:55458`, data dir `/var/tmp/w10f-localdb`, work dir `/var/tmp/w10f-work`. Controlled evidence. **Nothing was applied to `portava-ci` or to production.***

### 7.1 What changed, and that none of it is applied anywhere

| file | change | sha256 (first 12) at W10-F |
|---|---|---|
| `3360_intel_evidence_sealed_reference.sql` | F3: `$post$` accepts the function's absence only with the constraint validated | `00e4ba752a14` |
| `3362`, `3363`, `3364`, `3365`, `3421`, `3422` | F2: the six second-apply guards retagged `DO $pre$ … END $pre$;`, line-neutral | `137e41e660f8`, `8189a754d60f`, `b94335b6572c`, `0fc0f3f72606`, `539adc0a74aa`, `27ee9f6a4093` |
| `3390_discovery_rls_explicit_policies.sql` | F4: `$post$` reads only the catalogue | `9d8477bd6750` |
| `auditMigrationsVsLive.ts` | F1 + F5: seven `ALLOWLIST` entries, nothing else | — |
| 17 files in `db/rollback/` | 3338, 3340–3343, 3350, 3351, 3352, 3355–3359, 3366, 3395, 3400, 3410: a flag row is deleted only if its forward file wrote it; every one deletes its forward file's ledger row | — |
| `rehearse-pending-apply.ts` | 3441's and 3440's REVERSAL footers run in `rollback`; `objects` expects 3360's function ABSENT | — |

Also changed since `debd5ad4f`, by other lanes: 3440 (`4307723dfde5`) and 3441 (`8f26a6919e70`) for census §77, and the new `3436` (`e9e8f6bb89de`).

**Applied state, re-read before any byte changed:**
- `portava-ci`: `docs/migrations.md`'s 2026-09-27 entry records 3350 applied and 3352 and 3360 **not** applied; its 2026-09-28 entry records the 40 applied nowhere; CI's dry run on `84318d1b2` lists all 40 as pending.
- production: the latest committed snapshot (`20260922-production-schema.json`) has watermark `20260922155706`, before any of these files existed. `discovery-production-rollout.md` records "nothing since" 2910 and 2220. `sensing-production-approval-request.md` records 3338–3362 unapplied there and 3363–3365 as approval steps H14–H16.
- So no changed migration is applied anywhere. The rollback files carry no checksum in any ledger. 3350's rollback changed although 3350 is applied to `portava-ci`, because the rollback is a separate, never-run file.

### 7.2 The set at this tree

The same restored baseline as §4.1 (`LOCAL_DB_TO=3338`: 314 applied in order, 12 known-unreplayable, 2 on retry; 3350; `model-ledger` 225 rows; the seed; snapshot database `w10f_baseline`, catalogue 12,320 lines, the same count as §4.1). `plan` printed **41**: the 40 of §1.2 in the same order, plus `3436_trail_health_snapshot_provenance.sql` at position 39 with `+postconditions`.

### 7.3 `certify:migrations` and `audit:schema`, the tools themselves, before and after

**How the tools were pointed at the harness.** `certify:migrations`, `check:migration-ledger`, `audit:schema` and `check:missing-live-columns` each reach the database through one call: `fetch` to the Management API's `/v1/projects/<ref>/database/query`. They ran **unchanged**, through `pnpm run`, with a preload (`NODE_OPTIONS=--import=<scratch>/w10f-fetch-shim.mjs`) that replaces `globalThis.fetch`:
- It answers that endpoint for one **fake** project ref, `w10fharness55458`, by running the query on `127.0.0.1:55458` and returning the last statement's rows as JSON.
- It throws on every other URL.
- `SUPABASE_URL=https://w10fharness55458.supabase.co`, with `CI_SUPABASE_PROJECT_REF` set to the same fake ref and `KNOWN_PROD_PROJECT_REF=ajrurzioarfkagpuxfnb`. The in-process target guard passed on that basis.
- No real project ref and no real token were present.

The shim and its wrapper are scratch files, not in the tree. Command: `certify:migrations --files <the 40 of §1.2>`.

| | before (bytes at `f3047e54d`) | after (F1–F5) |
|---|---|---|
| stage 1 | `check:migration-ledger PASSED` — 648 files, 266 sha256 matched, 382 backfill | same |
| stage 2 | `24 declared object(s) present.` | same |
| stage 3 | pass | pass |
| stage 4 | **FAILED**: `57 assertion block(s) re-run`, `15 $pre$ held`, and 8 ✖: 3360 (`…was not created`), 3362, 3363, 3364, 3365, 3421, 3422 (their `PRECONDITION FAILED` guards), 3390 (`relation "_p3390_tables" does not exist`) | **pass**: `59 assertion block(s) re-run against the committed database.`, `21 $pre$ … held back`; 3386/3387 named preconditions-only |
| stage 5 | not reached | reached; `audit:schema` exits 1, on harness artefacts only (below) |

With `3436` added to `--files`, the after run reads 26 objects, 60 blocks and 22 `$pre$`, with the same verdicts.

**`audit:schema`, as sets of findings** (file :: claim):
- **pre-apply baseline:** 101 findings in 26 files.
- **after the apply, before the fixes:** 44 in 15 files. That is the baseline's harness artefacts plus **seven the set causes**: `3360 … missing function intel_evidence_rekey_reference` (F1), and `missing grant select on posts|passport_postcards|post_media to anon|authenticated` under 2148, 2151 and 2158 (F5).
- **after the apply, after the fixes:** 37 in 11 files, **every one of them already in the pre-apply baseline**:
  - `0067`, `0068` and `0103` (three policies the baseline structure lacks);
  - 2276–2279, 2970, 3002, 3003 and 3310, all in `KNOWN_UNREPLAYABLE.json`.
  - None is in the set. CI's run on `84318d1b2` listed none of them, so `portava-ci` carries them.

The after-fixes set is also exactly what certify's stage 5 printed. `check:missing-live-columns` gives the same answer before and after: 4 columns, all from 2276, 2279 and 2970 (harness artefacts).

**So on the harness, certification is clean for the set. The full `certify:migrations PASSED` line needs a database that holds the 11 unreplayable files' objects**, which `portava-ci` does and the harness cannot. That last step is inferred, not measured.

### 7.4 Apply, tails, idempotence, rollbacks, re-apply

| step | before (at `f3047e54d`) | after (F1–F5 and the rollback fixes) |
|---|---|---|
| apply | 41 applied, 20 post-`COMMIT` tails verified | the same, from a fresh copy of `w10f_baseline` |
| catalogue after apply | 12,540 lines | identical to before: 0 of 12,540 lines differ. The fixes change no applied object. |
| flags after apply | — | all 92 pre-existing rows identical, including `updated_at`; 14 added, all FALSE. Each added row's md5(description) equals the md5 the rollbacks carry, computed by PostgreSQL from each forward file's literal. |
| idempotent re-apply | — | `NOTHING TO DO — 266 proven row(s), 0 pending`; `plan`: `Would apply: NOTHING` |
| rollbacks | 3436 → 3416 ran, then **3415's rollback FAILED**: `cannot drop function trail_normalised_destination(text) because other objects depend on it` (3441's `trails.destination_key`, since §77). After 3441's footer, the rest ran; **12 left their ledger row** (3338, 3340–3343, 3351, 3352, 3355–3359) | `rollback` over all 41: 3441's and 3440's footers ran, then 39 rollback files, **every one removing its own ledger row**. Only 3350's row remains, as on `portava-ci`. |
| data after all rollbacks | differs from baseline: **92 → 91 flags** (3351's rollback deleted the pre-existing `media_find_busier_enabled`) | **identical to the baseline** (0 of 19 lines). The pre-existing row survives with its own description. |
| catalogue after all rollbacks | the 8 tighter lines of §4.4 | the same 8 lines. They come from the 3385/3390/3410 rollbacks and are out of scope. |
| re-apply after rollback | — | `plan` printed the 41 again; all applied; catalogue equal to the first apply's (0 of 12,540) |
| stage 4 over 41, after the re-apply | — | `60 block(s) re-run after commit, 22 $pre$ block(s) held back … every re-run block passed.` |
| objects (`objects`) | 57 of 58 present, `✖ 3360 function intel_evidence_rekey_reference` | `57 of 58 … present; 1 absent by design`, exit 0 |
| stop measurement | — | `rls_leak`: `{"state": "measured", "deviations": 0}` |
| step 3's rehearsal file | — | 305,961 bytes on a fresh `w10f_baseline` copy: `all 40 bodies and postconditions held; rolling back.`, psql exit 0, catalogue unchanged |

### 7.5 Controls and mutations

- **Mutations, each seen red then restored byte-identical (sha256):**
  - each of the eight migrations reverted to `f3047e54d`'s bytes, then stage 4 re-run on the applied database. Each went red with exactly its §7.3 "before" error, and green again once restored;
  - `auditMigrationsVsLive.ts` reverted, then `audit:schema`: the seven F1/F5 findings returned (44 in 15 files), and went away once it was restored.
- **3360 `$post$`, in a transaction rolled back after each case:**
  - constraint NOT VALID and no function: `POSTCONDITION FAILED: … was not created.`;
  - function present with EXECUTE granted to anon: `… an end-user role can execute …`;
  - 3360 alone (function present, service_role only, constraint NOT VALID): passes.
- **3390, its body run in a transaction rolled back after each case:**
  - unchanged: `3390 OK`;
  - one kept-path literal altered: `… literals differ from _p3390_tables / _p3390_keep`;
  - `REVOKE TRIGGER … FROM service_role` before the block: `1 table(s) changed service_role privileges`.
- **3390, after commit:** `GRANT TRUNCATE … TO anon` makes the `$post$` block alone fail with `discovery_cache TRUNCATE anon: still held`, so the post-commit block still reads the catalogue.

### 7.6 `run-tests.sh`, on a fresh standard chain at this tree

`up.sh`: 356 applied in order, 12 known-unreplayable, 2 on retry. Result: **377 / 380 pass, 0 skipped**. Every suite that runs a file this lane changed passes: 3360/3361, 3362, 3363, 3364, 3365, 3390, 3366 (Z4, the rollback) and 3395 (B1, the rollback), as well as 3391's stop measurements.

The 3 failures are in `trailsMemberVisibility` (TV6) and `trailsService` (H4 and the TV block), with `fetch failed` against the suite's own in-process HTTP server and `canceling statement due to statement timeout` in the log. Re-run alone, the failing cases changed each time: 4 failed, then 2. Load average was about 17 on 4 cores. Neither suite reads a file this lane changed, and the chain's DDL is the same at `f3047e54d`: the fixes touch only assertion blocks and rollback files. W10-D's 377/377 was at `debd5ad4f`, before §77 changed the Trail service. Not investigated further.

### 7.7 What is still owed

- The apply itself on `portava-ci` (steps 1–8), and a green `schema drift` run for the applied tree.
- Step 3's emitter covers the 40 by name. At this tree `3436` is pending too, so it is not in the zero-persistence file. Extend `CI_PENDING_84318D1B2`, or rely on step 4's own stop-at-first-failure.
- The 8 catalogue lines the 3385/3390/3410 rollbacks leave tighter (§4.4) are unchanged. They are not this lane's files.

---

## 8. The pending set at `3fd11f858` (lane W11-P, census-discovery §96)

*Lane W11-P, 2026-09-28, branch `disc-w11-approvals` at integration head `3fd11f858`. Docs only. **Nothing was applied to `portava-ci` or to production**, and this session still has no `portava-ci` credentials. What the owner must do to unblock the apply is in `docs/ops/discovery-owner-approval-request.md` §3. This section replaces §1.2 as the list to apply; §1–§7 stay as the record of §83 and §87.*

### 8.1 The 73, in apply order

**How the list was computed.** The applier was imported as a library (`scripts/src/apply-migrations.ts`: `listMigrationFiles`, `planApply`, `assertUnambiguousOrder`, `classifyMigration`, `checksumOf`). It planned against a modelled ledger in which every numbered file below `3338`, and `3350`, is proven applied, as §1.1 models `portava-ci`.
- `assertUnambiguousOrder` passed, and no file is `REFUSED`.
- The model does not carry the 27 date-named files (`20260720_…` to `20260815_…`). CI's own dry run on `84318d1b2` did not list them, so `portava-ci` records them; they are left out below.
- **The real list is whatever the dry run prints against the real ledger (step 4 of 8.4).** It must be these 73, plus any file `main` adds before the merge, and nothing else.

Rows 1–38 and 40–41 are §1.2's 40. Row 39 (`3436`) and rows 42–73 are the 33 added since `debd5ad4f`. `sha256` is the first 12 hex digits at `3fd11f858`. Against §1.2 and §7.1, only `3435` differs: it was amended by census §84 (D-W10-R1-17, "3435 (amended)") after W10-F's rehearsal, from `9c8418705d59` to `ea4620ab120b`.

| # | file | shape | sha256 | rollback file (`db/rollback/`) |
|---|---|---|---|---|
| 1 | `3338_media_processing_worker_flag.sql` | unwrapped | `eab83e0eb25a` | `2026-09-26-3338-media-processing-worker-flag-rollback.sql` |
| 2 | `3340_media_tab_world_default_flag.sql` | unwrapped | `2cba1cac5a0f` | `2026-09-27-3340-media-tab-world-default-flag-rollback.sql` |
| 3 | `3341_media_watch_context_overlay_flag.sql` | unwrapped | `61ba39d3bad8` | `2026-09-27-3341-media-watch-context-overlay-flag-rollback.sql` |
| 4 | `3342_media_watch_tap_to_play_flag.sql` | unwrapped | `3b7814ab09ac` | `2026-09-27-3342-media-watch-tap-to-play-flag-rollback.sql` |
| 5 | `3343_media_watch_stage24_ranking_flag.sql` | unwrapped | `a639ea2e19f3` | `2026-09-27-3343-media-watch-stage24-ranking-flag-rollback.sql` |
| 6 | `3351_media_find_busier_flag.sql` | unwrapped | `f32653d1c04b` | `2026-09-27-3351-media-find-busier-flag-rollback.sql` |
| 7 | `3352_media_perspective_vantage.sql` | unwrapped | `f536af0ce70c` | `2026-09-27-3352-media-perspective-vantage-rollback.sql` |
| 8 | `3355_media_vision_provider_flag.sql` | unwrapped | `2f7d81d0b249` | `2026-09-27-3355-media-vision-provider-flag-rollback.sql` |
| 9 | `3356_media_moderation_classifier_flag.sql` | unwrapped | `8d519c54f64e` | `2026-09-27-3356-media-moderation-classifier-flag-rollback.sql` |
| 10 | `3357_media_transcoder_flag.sql` | unwrapped | `948728ad3287` | `2026-09-27-3357-media-transcoder-flag-rollback.sql` |
| 11 | `3358_media_captions_flag.sql` | unwrapped | `02d2f73e87d7` | `2026-09-27-3358-media-captions-flag-rollback.sql` |
| 12 | `3359_passport_postcard_cover_nullable.sql` | unwrapped | `dbb7c5740f13` | `2026-09-27-3359-passport-postcard-cover-nullable-rollback.sql` |
| 13 | `3360_intel_evidence_sealed_reference.sql` | unwrapped | `00e4ba752a14` | `2026-09-27-3360-intel-evidence-sealed-reference-rollback.sql` |
| 14 | `3361_intel_evidence_sealed_reference_validate.sql` | unwrapped | `641b88a08b23` | `2026-09-27-3361-intel-evidence-sealed-reference-validate-rollback.sql` |
| 15 | `3362_posts_client_column_grants.sql` | unwrapped +post | `137e41e660f8` | `2026-09-27-3362-posts-client-column-grants-rollback.sql` |
| 16 | `3363_place_copies_client_column_grants.sql` | unwrapped +post | `8189a754d60f` | `2026-09-27-3363-place-copies-client-column-grants-rollback.sql` |
| 17 | `3364_pulse_geo_tags_write_boundary.sql` | unwrapped +post | `b94335b6572c` | `2026-09-27-3364-pulse-geo-tags-write-boundary-rollback.sql` |
| 18 | `3365_post_media_write_boundary.sql` | unwrapped +post | `0fc0f3f72606` | `2026-09-27-3365-post-media-write-boundary-rollback.sql` |
| 19 | `3366_discovery_search_protected_zones_flag.sql` | unwrapped +post | `00a8a197a69b` | `2026-09-27-3366-discovery-search-protected-zones-flag-rollback.sql` |
| 20 | `3375_rank_events_schema_version_admitted.sql` | unwrapped +post | `88a598246d96` | `2026-09-27-3375-rank-events-schema-version-admitted-rollback.sql` |
| 21 | `3376_discovery_recommendations_per_request.sql` | unwrapped +post | `c26eea613294` | `2026-09-27-3376-discovery-recommendations-per-request-rollback.sql` |
| 22 | `3380_content_trails_label_cap_serialised.sql` | unwrapped +post | `e117087c803f` | `2026-09-27-3380-content-trails-label-cap-serialised-rollback.sql` |
| 23 | `3381_trail_lifecycle_transitions.sql` | unwrapped +post | `eaa77232c5a8` | `2026-09-27-3381-trail-lifecycle-transitions-rollback.sql` |
| 24 | `3385_creator_share_ledger_includes_creator_entries.sql` | unwrapped | `67c756623199` | `2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql` |
| 25 | `3386_creator_attribution_recommendation_link.sql` | unwrapped | `9c293bd49d63` | `2026-09-27-3386-creator-attribution-recommendation-link-rollback.sql` |
| 26 | `3387_creator_ledger_integrity_and_audit.sql` | unwrapped | `04f22c759c87` | `2026-09-27-3387-creator-ledger-integrity-and-audit-rollback.sql` |
| 27 | `3390_discovery_rls_explicit_policies.sql` | unwrapped | `9d8477bd6750` | `2026-09-27-3390-discovery-rls-explicit-policies-rollback.sql` |
| 28 | `3391_discovery_stop_condition_measurements.sql` | unwrapped | `bf6b6ff95bea` | `2026-09-27-3391-discovery-stop-condition-measurements-rollback.sql` |
| 29 | `3395_discovery_dwell_telemetry_flag.sql` | unwrapped +post | `7053b7a5ec4a` | `2026-09-27-3395-discovery-dwell-telemetry-flag-rollback.sql` |
| 30 | `3400_media_pending_upload_sweep_flag.sql` | unwrapped +post | `97be7f79b1f7` | `2026-09-27-3400-media-pending-upload-sweep-flag-rollback.sql` |
| 31 | `3410_discovery_trend_snapshot_parity.sql` | unwrapped +post | `a2d3287c487b` | `2026-09-27-3410-discovery-trend-snapshot-parity-rollback.sql` |
| 32 | `3415_trail_proposal_serialised.sql` | unwrapped +post | `11e135efdbf6` | `2026-09-27-3415-trail-proposal-serialised-rollback.sql` |
| 33 | `3416_trail_relations_projection.sql` | unwrapped +post | `c16b1636f8a8` | `2026-09-27-3416-trail-relations-projection-rollback.sql` |
| 34 | `3417_place_momentum_dismiss_excluded.sql` | unwrapped +post | `e90c4f77e04f` | `2026-09-27-3417-place-momentum-dismiss-excluded-rollback.sql` |
| 35 | `3420_rank_events_outcome_receipts.sql` | unwrapped +post | `9ffb97fce682` | `2026-09-27-3420-rank-events-outcome-receipts-rollback.sql` |
| 36 | `3421_ranking_debug_samples_content_id_nullable.sql` | unwrapped +post | `539adc0a74aa` | `2026-09-27-3421-ranking-debug-samples-content-id-nullable-rollback.sql` |
| 37 | `3422_tags_client_write_boundary.sql` | unwrapped +post | `27ee9f6a4093` | `2026-09-27-3422-tags-client-write-boundary-rollback.sql` |
| 38 | `3435_place_momentum_feature_version.sql` | unwrapped +post | `ea4620ab120b` | `2026-09-28-3435-place-momentum-feature-version-rollback.sql` |
| 39 | `3436_trail_health_snapshot_provenance.sql` | unwrapped +post | `e9e8f6bb89de` | `2026-09-28-3436-trail-health-snapshot-provenance-rollback.sql` |
| 40 | `3440_canonical_search_key_letter_fold.sql` | unwrapped | `4307723dfde5` | `2026-09-28-3440-canonical-search-key-letter-fold-rollback.sql` (§97: the footer as a file, 8.5) |
| 41 | `3441_trail_letter_fold_decompose_first.sql` | unwrapped | `8f26a6919e70` | `2026-09-28-3441-trail-letter-fold-decompose-first-rollback.sql` (§97: the footer as a file, 8.5) |
| 42 | `3450_discovery_surface_objectives_flag.sql` | unwrapped +post | `4044d84afa01` | `2026-09-28-3450-discovery-surface-objectives-flag-rollback.sql` |
| 43 | `3451_discovery_engagement_integrity_flag.sql` | unwrapped +post | `1a73b4653ac1` | `2026-09-28-3451-discovery-engagement-integrity-flag-rollback.sql` |
| 44 | `3452_discovery_feature_families_flag.sql` | unwrapped +post | `b1bac69233a3` | `2026-09-28-3452-discovery-feature-families-flag-rollback.sql` |
| 45 | `3453_discovery_intent_trip_terms_flags.sql` | unwrapped +post | `465d51f3df90` | `2026-09-28-3453-discovery-intent-trip-terms-flags-rollback.sql` |
| 46 | `3454_discovery_diversity_axes_flag.sql` | unwrapped +post | `09b7bc707f78` | `2026-09-28-3454-discovery-diversity-axes-flag-rollback.sql` |
| 47 | `3455_discovery_for_you_pde_flag.sql` | unwrapped +post | `03d64e036183` | `2026-09-28-3455-discovery-for-you-pde-enabled-rollback.sql` |
| 48 | `3456_discovery_cache_a_ranked_flag.sql` | unwrapped +post | `1ab75ecc4a50` | `2026-09-28-3456-discovery-cache-a-ranked-enabled-rollback.sql` |
| 49 | `3460_discovery_search_protection_scope.sql` | unwrapped | `7900067214cd` (§97, 8.5; was `4cc721434321`) | `2026-09-28-3460-discovery-search-protection-scope-rollback.sql` |
| 50 | `3465_layover_consumer_flags.sql` | unwrapped +post | `d15caae1efb7` | `2026-09-28-3465-layover-consumer-flags-rollback.sql` |
| 51 | `3466_layover_place_dwell.sql` | unwrapped +post | `6b36b7723c8d` | `2026-09-28-3466-layover-place-dwell-rollback.sql` |
| 52 | `3467_cross_architecture_flags.sql` | unwrapped +post | `97fecf9092fe` | `2026-09-28-3467-cross-architecture-flags-rollback.sql` |
| 53 | `3468_tag_permission_approval_required.sql` | unwrapped +post | `165ea0584256` | `2026-09-28-3468-tag-permission-approval-required-rollback.sql` |
| 54 | `3469_compass_graph_decay_flag.sql` | unwrapped +post | `379214b39902` | `2026-09-28-3469-compass-graph-decay-flag-rollback.sql` |
| 55 | `3470_discovery_stop_enforcement_flag.sql` | unwrapped +post | `30cbe5d865da` | `2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql` |
| 56 | `3475_discovery_trend_v2_flags.sql` | unwrapped +post | `949d21b51837` | `2026-09-28-3475-discovery-trend-v2-flags-rollback.sql` |
| 57 | `3476_discovery_trend_v2_store.sql` | unwrapped +post | `68b579b67ee9` | `2026-09-28-3476-discovery-trend-v2-store-rollback.sql` |
| 58 | `3477_discovery_trend_v2_rebuild.sql` | unwrapped +post | `d79f421ce89a` | `2026-09-28-3477-discovery-trend-v2-rebuild-rollback.sql` |
| 59 | `3480_discovery_candidate_sources_flag.sql` | unwrapped +post | `586d50e9b3fc` | `2026-09-28-3480-discovery-candidate-sources-flag-rollback.sql` |
| 60 | `3481_discovery_exploration_inventory_flag.sql` | unwrapped +post | `4e516cbeec09` | `2026-09-28-3481-discovery-exploration-inventory-flag-rollback.sql` |
| 61 | `3482_discovery_cold_start_flag.sql` | unwrapped +post | `494599a781f0` | `2026-09-28-3482-discovery-cold-start-flag-rollback.sql` |
| 62 | `3483_discovery_pipeline_stages_flags.sql` | unwrapped +post | `d4a1cfbe8d81` | `2026-09-28-3483-discovery-pipeline-stages-flags-rollback.sql` |
| 63 | `3484_compass_city_confidence_provenance.sql` | unwrapped +post | `d8a8639382ea` | `2026-09-28-3484-compass-city-confidence-provenance-rollback.sql` |
| 64 | `3485_discovery_trail_exploration_flags.sql` | unwrapped +post | `3d4c81615b84` | `2026-09-28-3485-discovery-trail-exploration-flags-rollback.sql` |
| 65 | `3486_trail_moderation_audit.sql` | unwrapped +post | `87981591335f` | `2026-09-28-3486-trail-moderation-audit-rollback.sql` |
| 66 | `3487_trail_member_exposures.sql` | unwrapped +post | `b88c2860eae9` | `2026-09-28-3487-trail-member-exposures-rollback.sql` |
| 67 | `3488_trail_content_suggestions.sql` | unwrapped +post | `fe1212fdb269` | `2026-09-28-3488-trail-content-suggestions-rollback.sql` |
| 68 | `3490_discovery_serve_path_flags.sql` | unwrapped +post | `bbc15fc5a7d0` | `2026-09-28-3490-discovery-serve-path-flags-rollback.sql` |
| 69 | `3491_discovery_recommendations_output_kinds_serve_point.sql` | unwrapped +post | `c247691bc8c4` | `2026-09-28-3491-discovery-recommendations-output-kinds-serve-point-rollback.sql` |
| 70 | `3495_place_cooccurrence_trail_projection.sql` | unwrapped +post | `ed80b931ceb8` | `2026-09-28-3495-place-cooccurrence-trail-projection-rollback.sql` |
| 71 | `3496_discovery_w11x3_flags.sql` | unwrapped +post | `4270815582ef` | `2026-09-28-3496-discovery-w11x3-flags-rollback.sql` |
| 72 | `3497_discovery_trend_post_convergence_stored.sql` | unwrapped +post | `b1e2440a6d5c` | `2026-09-28-3497-discovery-trend-post-convergence-stored-rollback.sql` |
| 73 | `3500_discovery_surface_objective_rank_flags.sql` | unwrapped +post | `8fee881cf87b` | `2026-09-28-3500-discovery-surface-objective-rank-flags-rollback.sql` |

- **51 of the 73 carry a post-`COMMIT` postcondition tail.**
- **Every file has a rollback file** (3440's and 3441's since §97, their footers as files; 8.5). 3441's must run before 3415's rollback (§7.4).
- **Rollback order for the new files.** 3476's rollback refuses while 3477's v2 rebuild exists, so roll back 3477 first. 3497's comes before 3477's. 3491's refuses while any serve-point-13 row exists. 3468's refuses while a profile holds `approval_required`. 3486's refuses while audit or review rows exist, and 3488's while suggestions are pending.

### 8.2 Pre-flight additions to §2.1

```sql
-- (a') None of the 73 has a ledger row; 2481 and 3350 are recorded verbatim, as in §2.1 (a).
SELECT count(*) FROM public.schema_migration_ledger
 WHERE filename ~ '^(3338|3340|3341|3342|3343|3351|3352|3355|3356|3357|3358|3359|3360|3361|3362|3363|3364|3365|3366|3375|3376|3380|3381|3385|3386|3387|3390|3391|3395|3400|3410|3415|3416|3417|3420|3421|3422|3435|3436|3440|3441|3450|3451|3452|3453|3454|3455|3456|3460|3465|3466|3467|3468|3469|3470|3475|3476|3477|3480|3481|3482|3483|3484|3485|3486|3487|3488|3490|3491|3495|3496|3497|3500)_';   -- 0

-- (b') The 38 flags the 33 new files seed. Each must be ABSENT or FALSE (§3's flag rule applies unchanged).
SELECT flag, enabled FROM public.feature_flags WHERE flag IN (
  'discovery_surface_objectives_enabled','discovery_engagement_integrity_enabled','discovery_feature_families_enabled',
  'discovery_intent_term_enabled','discovery_trip_match_enabled','discovery_diversity_axes_enabled',
  'discovery_for_you_pde_enabled','discovery_cache_a_ranked_enabled',
  'layover_snapshot_consumers_enabled','layover_place_dwell_enabled',
  'discovery_trip_viewer_projections_enabled','telegraph_discovery_actions_enabled',
  'tag_permission_approval_required_enabled','tag_permission_consent_copy_enabled',
  'compass_graph_decay_enabled','discovery_stop_enforcement_enabled',
  'discovery_trend_normalised_enabled','discovery_trend_rebuild_scheduler_enabled','discovery_trend_snapshot_retention_enabled',
  'discovery_trend_lists_enabled','discovery_trend_rediscovery_retest_enabled',
  'discovery_candidate_sources_enabled','discovery_circle_candidates_enabled','discovery_exploration_inventory_enabled',
  'discovery_cold_start_enabled','discovery_integrity_stage_enabled','discovery_outcome_learning_enabled','discovery_output_kinds_enabled',
  'compass_city_confidence_windowed_reads_enabled','discovery_trail_exploration_enabled','discovery_trail_health_order_enabled',
  'discovery_community_byline_canonical_enabled','discovery_platform_graph_provenance_enabled',
  'discovery_place_cooccurrence_enabled','discovery_trend_post_convergence_enabled',
  'discovery_trail_objective_rank_enabled','discovery_trending_objective_rank_enabled','discovery_trip_planning_objective_rank_enabled');
-- Three of the 33 change a flag row they do not seed:
--   3460 rewrites the DESCRIPTION of discovery_search_protected_zones_enabled (3366), never its state;
--   3467 corrects the description of media_pending_upload_sweep_enabled (3400);
--   3477 and 3497 only READ flags.
```

In all, the 73 seed **53 flags**: §2.1 (b)'s 15, and these 38. The data preconditions of the 33 are each file's own `$pre$` blocks. For example:
- 3468 adds an enum value;
- 3476 needs `place_momentum` (2892);
- 3486 needs 3381's transition functions;
- 3491 needs `recommendations` (3376);
- 3497 needs 3477's rebuild.

Step 3's zero-persistence file checks every one of them once it is extended (8.3).

### 8.3 What has, and has not, been rehearsed

| files | rehearsed how | where |
|---|---|---|
| the 40 of §1.2, and 3436 | through the applier, from the modelled pre-3338 baseline: apply, idempotence, every rollback, re-apply, certify stage 4, `audit:schema` | §4 (W10-D) and §7 (W10-F), local harness |
| 3435's amended bytes, and the 32 files 3450–3500 | only in each lane's standard chain (`scripts/local-db/up.sh`, psql replay) and its DB suites, and in the integrator's merged-chain harness run (census §90) | local harness |

**So before the `portava-ci` apply, the next session re-runs §4 on the harness over all 73.**
1. Add the 33 files to the driver's expected list (`CI_PENDING_84318D1B2` in `rehearse-pending-apply.ts`, which step 3's emitter also reads).
2. Then run: `plan`, `apply`, idempotence, `rollback` over all 73 in dependency order, re-apply, stage 4, and `objects`.

This is controlled evidence, not `portava-ci` evidence. It is recommended, not a gate the owner set.

### 8.4 The command sequence at this tree

§2's steps, with these values:
1. **Step 1:** §2.1, plus 8.2.
2. **Step 2** (dry run): expect `Would apply 73 migration(s), IN THIS ORDER:`, the list of 8.1, and `apply-migrations --dry-run PASSED — 73 pending`. There must be no `Ledger rows with no file on disk` line and no `REFUSED`. `Proven applied, skipped` should read 223, as CI printed on `84318d1b2`, unless `portava-ci` has recorded more since.
3. **Step 3:** the zero-persistence file, once extended (8.3). Expect `all 73 bodies and postconditions held; rolling back.`
4. **Step 4** (apply): 73 lines `→ <file>: applied + recorded (one transaction)`, and 51 lines `→ <file>: postconditions verified (separate transaction)`.
5. **Step 5:** `NOTHING TO DO`. The proven count is step 2's skipped count plus 73: 296 if it was 223.
6. **Step 6:** certify with all 73 named:

   ```bash
   cd artifacts/api-server
   pnpm run certify:migrations -- --files 3338_media_processing_worker_flag.sql,3340_media_tab_world_default_flag.sql,3341_media_watch_context_overlay_flag.sql,3342_media_watch_tap_to_play_flag.sql,3343_media_watch_stage24_ranking_flag.sql,3351_media_find_busier_flag.sql,3352_media_perspective_vantage.sql,3355_media_vision_provider_flag.sql,3356_media_moderation_classifier_flag.sql,3357_media_transcoder_flag.sql,3358_media_captions_flag.sql,3359_passport_postcard_cover_nullable.sql,3360_intel_evidence_sealed_reference.sql,3361_intel_evidence_sealed_reference_validate.sql,3362_posts_client_column_grants.sql,3363_place_copies_client_column_grants.sql,3364_pulse_geo_tags_write_boundary.sql,3365_post_media_write_boundary.sql,3366_discovery_search_protected_zones_flag.sql,3375_rank_events_schema_version_admitted.sql,3376_discovery_recommendations_per_request.sql,3380_content_trails_label_cap_serialised.sql,3381_trail_lifecycle_transitions.sql,3385_creator_share_ledger_includes_creator_entries.sql,3386_creator_attribution_recommendation_link.sql,3387_creator_ledger_integrity_and_audit.sql,3390_discovery_rls_explicit_policies.sql,3391_discovery_stop_condition_measurements.sql,3395_discovery_dwell_telemetry_flag.sql,3400_media_pending_upload_sweep_flag.sql,3410_discovery_trend_snapshot_parity.sql,3415_trail_proposal_serialised.sql,3416_trail_relations_projection.sql,3417_place_momentum_dismiss_excluded.sql,3420_rank_events_outcome_receipts.sql,3421_ranking_debug_samples_content_id_nullable.sql,3422_tags_client_write_boundary.sql,3435_place_momentum_feature_version.sql,3436_trail_health_snapshot_provenance.sql,3440_canonical_search_key_letter_fold.sql,3441_trail_letter_fold_decompose_first.sql,3450_discovery_surface_objectives_flag.sql,3451_discovery_engagement_integrity_flag.sql,3452_discovery_feature_families_flag.sql,3453_discovery_intent_trip_terms_flags.sql,3454_discovery_diversity_axes_flag.sql,3455_discovery_for_you_pde_flag.sql,3456_discovery_cache_a_ranked_flag.sql,3460_discovery_search_protection_scope.sql,3465_layover_consumer_flags.sql,3466_layover_place_dwell.sql,3467_cross_architecture_flags.sql,3468_tag_permission_approval_required.sql,3469_compass_graph_decay_flag.sql,3470_discovery_stop_enforcement_flag.sql,3475_discovery_trend_v2_flags.sql,3476_discovery_trend_v2_store.sql,3477_discovery_trend_v2_rebuild.sql,3480_discovery_candidate_sources_flag.sql,3481_discovery_exploration_inventory_flag.sql,3482_discovery_cold_start_flag.sql,3483_discovery_pipeline_stages_flags.sql,3484_compass_city_confidence_provenance.sql,3485_discovery_trail_exploration_flags.sql,3486_trail_moderation_audit.sql,3487_trail_member_exposures.sql,3488_trail_content_suggestions.sql,3490_discovery_serve_path_flags.sql,3491_discovery_recommendations_output_kinds_serve_point.sql,3495_place_cooccurrence_trail_projection.sql,3496_discovery_w11x3_flags.sql,3497_discovery_trend_post_convergence_stored.sql,3500_discovery_surface_objective_rank_flags.sql
   ```

7. **Step 7:** `pnpm run audit:schema`. Expect `✔ Live schema contains every object claimed by the migrations.`
8. **Step 8:** §2.2. Also:
   - read the 38 new flag rows, every one FALSE;
   - read 2481's and 3350's ledger rows, which must be byte-identical to step 1.
9. **The live DB workflow.** Re-run `CI (live DB)` (`.github/workflows/live-db.yml`) on the PR head. `schema drift` and `live DB · verdict (cancelled or skipped is not a pass)` must both be green. That run is the rehearsal record (D-W10D-1), which DC-26 is graded on.
10. **Merge** at once (§5.4). Do not change any of the 73 files between the apply and the merge.

**The 2481 ledger entry is not touched.** It is outside the set. The applier writes only the row of the file it applies (§3), steps 1 and 8 read the row before and after, and `--apply-unproven` is not used.

### 8.5 W11-S: the 73 rehearsed end to end (census-discovery §97)

*Lane W11-S, 2026-09-28, branch `disc-w11-safety` at `532227796` plus this lane's commits. Harness: PostgreSQL 16 at `127.0.0.1:55465`, data dir `/var/tmp/w11s-localdb` (1 MB WAL segments), work dir `/var/tmp/w11s-work`, both deleted afterwards. The fetch preload for the Management-API tools answered one fake ref, `w11sharness55465`, from the harness and threw on every other URL (scratch file, not in the tree). Controlled evidence. **Nothing was applied to `portava-ci` or to production.** The numbers below are the final run, at the final bytes of every file.*

**The driver.** `rehearse-pending-apply.ts` now carries `PENDING_AT_3FD11F858`, 8.1's list with 8.1's `+post` column; `plan`, `postconditions`, `rollback` and `emit-rollback-rehearsal` use it (`REHEARSE_SET=84318d1b2` selects the historical 40). Register D-W11S-6.

| stage | result |
|---|---|
| baseline | `LOCAL_DB_TO=3338 up.sh`: 314 applied in order, 12 known-unreplayable, 2 on retry; 3350 by psql; `model-ledger` 225 rows; the seed; snapshot `w11s_base`, catalogue 12,320 lines |
| plan | `Proven applied, skipped: 225`, 382 backfill, **`Would apply 73`**, `IDENTICAL to apply plan §8.1 (73 files, same order)`, every shape as 8.1 |
| apply | **73 applied + recorded, 51 post-`COMMIT` tails verified**, `apply: PASSED` |
| certify stage 4 (driver) | `115 block(s) re-run after commit, 32 $pre$ block(s) held back … every re-run block passed` (3386, 3387 preconditions-only, as §7) |
| objects | 57 of CI's 58 present, 1 absent by design (3360's function) |
| data | every pre-existing row identical except `search_key` for Ǿresund (3440, documented). The 92 pre-existing flag rows are identical including `updated_at` (md5 over flag, enabled, description, metadata, updated_at); **52 flag rows added, every one FALSE** (53 seeded, `media_find_busier_enabled` pre-existed in the seed and kept its description) |
| idempotence | `NOTHING TO DO — 298 proven row(s), 0 pending`; `Would apply: NOTHING` |
| stop measurement | `rls_leak`: `{"state": "measured", "deviations": 0}` |
| rollback, all 73, newest first | **73 rollback files ran, every one removed its own ledger row.** 3440 and 3441 now through their files (8.6), not the driver's footer fallback |
| data after rollback | identical to the baseline (0 of 19 lines) |
| catalogue after rollback | **7 lines differ**, all tighter: EXECUTE on `place_momentum_classify` and `rebuild_place_momentum` not re-granted to anon/authenticated (3410's rollback) and TRUNCATE/REFERENCES/TRIGGER not re-granted on five tables (3390's). The eighth line of §4.4, 3385's comment on the restored view, is gone: 3385's rollback now restores 2930's comment (D-W11S-5). Measured before that fix: 8 lines |
| re-apply | the same 73; catalogue equal to the first apply's (0 of 12,777 lines); stage 4 passes again |
| `emit-rollback-rehearsal` | 492,354 bytes, all 73 files; on a fresh baseline copy: `NOTICE: W10-D rollback rehearsal: all 73 bodies and postconditions held; rolling back.`, psql exit 0, catalogue unchanged (0 of 12,320) |
| `certify:migrations --files <the 73>` (the tool itself, via the preload) | stage 1 `check:migration-ledger PASSED` (680 files); stage 2 `59 declared object(s) present.`; stage 3 pass; stage 4 `115 assertion block(s) re-run`, `32 $pre$ … held back`; stage 5 stops on `audit:schema` |
| `audit:schema` | after the apply: 37 findings in 11 files; the pre-apply baseline: 156 in 35. **0 findings after the apply that the baseline lacks**; the 37 are the harness artefacts §7.3 names (0067, 0068, 0103, 2276–2279, 2970, 3002, 3003, 3310) |
| `check:missing-live-columns` | 4 columns, all from 2276, 2279 and 2970, as §7.3 |

**Refusals and postcondition failures found, and what was done:**
1. **3460's postcondition failed certify stage 4** on the first run: `relation "_3460_before" does not exist`. Its `$post$` reads a `TEMP … ON COMMIT DROP` table, W10-F's F4 defect in a file that landed after F4. Fixed line-neutrally: after COMMIT the block re-checks the description only; in the applying transaction it still checks the flag's state (register D-W11S-3). 3460 is applied nowhere. Controls: after COMMIT a description without the gateway fails; inside a transaction a changed state fails (`the flag's state changed (f -> t)`); mutation: 3460 at its previous bytes fails the re-run again, restored by sha256 (`7900067214cd…`).
2. **Negative control, and a correction to §3.** With `discovery_for_you_pde_enabled` TRUE before the apply, the apply stopped at 3455 (`POSTCONDITION FAILED (3455): … is ON`) after 46 files; the flag still reads TRUE. **But 3455's ledger row exists**: its "ships OFF" check is its post-`COMMIT` tail, which runs after the body and the ledger row commit. §3's "a file that would claim otherwise is never recorded" holds for in-transaction checks (3351, §4.2) and not for the 26 flag files whose only TRUE check is after COMMIT (3366, 3395, 3400, 3410, 3450–3456, 3465, 3467–3470, 3475, 3480–3485, 3490, 3496, 3500). No value is ever overwritten and certify stage 4 re-runs the same block, so it cannot pass silently; **§2.1 (b) and 8.2 (b') are the gate** (every seeded flag ABSENT or FALSE before step 4). If it happens anyway: the file stays recorded, its rollback refuses while the flag is TRUE, and turning the flag off is the owner's call (register D-W11S-4).
3. No other refusal, postcondition failure or drift occurred.

### 8.6 Rollback files for the files that had none (W11-S, census-discovery §97)

Eleven files, `db/rollback/2026-09-28-<n>-…-rollback.sql`, each guarded, each deleting its forward file's ledger row, each with postconditions (register D-W11S-2).

| file | what it reverses | refuses when |
|---|---|---|
| 2289 | the flag row it wrote (md5 of its seed description), ledger row | the flag is TRUE; keeps a row 2289 did not write |
| 2297 | outcome CHECK back to 0197's seven; drops `record_distribution_negative_signal` | any `dismiss` row (**never deletes it**, unlike the file's note); 2894 or 2995 applied |
| 2892 | drops `place_momentum` and both functions | any row; a column a later file added (3410, 3435, 3476); `area_momentum` (3476); `rebuild_place_momentum_v` (3477) |
| 2893 | surface CHECK back to the post-2298 fifteen; its column comment removed | the CHECK is not exactly 2893's eight |
| 2894 | outcome CHECK back to 2297's eight | any `trip_add` row (never deletes it) |
| 2995 | drops `rank_events_discovery_dismissed` | — |
| 2901 | drops `rent_buddy_earnings_entries` | **any row (a true rollback would destroy financial records: C-11)**; 2930's view or 3387 present |
| 2921 | drops `creator_earning_entries` and its trigger function | **any row (C-11)**; `creator_attribution_enabled` TRUE; 3385 or 3387 applied |
| 2930 | drops `creator_share_ledger` | `creator_attribution_enabled` TRUE; 3385 applied |
| 3440 | the footer as a file: 2220's function (copied byte for byte), the column dropped and re-added, the index rebuilt | — (it rewrites `search_key` under ACCESS EXCLUSIVE, as 3440 did) |
| 3441 | the footer as a file: index and column first, then 3415's three functions (copied byte for byte) | — (stored slugs are not rewritten back; a NOTICE counts them) |

**Rehearsal (final bytes).**
- **The nine older files.** A no-apply baseline was built with up.sh's own loop minus the nine (`w11s_noapply`: 305 applied in order, the same 12 known-unreplayable, 2 on retry; skipping the nine broke nothing else). On a copy of the modelled head, the seed's one `dismiss` row was removed on that copy only (so that 2297 can proceed), and the nine rollbacks ran newest first (2995, 2930, 2921, 2901, 2894, 2893, 2892, 2297, 2289): **every one exit 0, every ledger row gone. Catalogue vs the no-apply baseline: 0 of 12,190 lines differ.** Re-applying the nine in byte order: every one exit 0, **catalogue vs the head: 0 of 12,320 lines differ.**
- **3440 and 3441** ran inside the 73's rollback (8.5): the catalogue after all 73 rolled back differs from the baseline only in the 7 tighter lines, none theirs; after re-apply, 0 differ. On the 73-applied head they also ran directly (3441 first), `Ǿresund` keying `resund` again, and a second run of each is a no-op.
- **Refusal controls, each seen on a fresh copy:** 2289 with its flag TRUE (the flag still TRUE, the ledger row kept); 2289 over a row it did not write (kept, NOTICE); 2297 under 2894, under 2995's index, and over a `dismiss` row; 2894 over a `trip_add` row; 2892 over a row, and on the 73-applied head (a later column); 2893 run twice; 2901 under 2930's view, over a row, and on the 73-applied head; 2921 with `creator_attribution_enabled` TRUE, over a row, and under 3387; 2930 with the flag TRUE and under 3385. Every refusal exited 3 and changed nothing.
- **Not rehearsed:** a production-sized `canonical_locations` for 3440's file (31 rows on 2026-09-27), and anything on `portava-ci` or production.

### 8.7 Pre-flight read against the real `portava-ci`, 2026-09-28 (integrator, read-only)

Run through the Supabase connector (`execute_sql`, project `hwokxgbmezheskbzskfr`) after it became available to this session. Only SELECTs were sent: nothing was written, applied or flipped.

| check (§2.1 / §8.2) | required | `portava-ci` |
|---|---|---|
| ledger rows for any of the 73 | 0 | **0** |
| total ledger rows / latest file | — | 607 / `3350_media_neighborhood_only_location_mode.sql` |
| `2481` ledger row (recorded verbatim; §8.4 step 8 compares) | untouched | `applied_by=ci`, `applied_at=2026-09-09 14:44:05.770512+00`, `checksum=56c1244782e8d2e911107c44cebb4461b378d0ca6f157e68e91a82ea084d12d1` |
| `3350` ledger row | as recorded | `applied_by=manual`, `applied_at=2026-09-27 09:33:12.17104+00`, `checksum=9d565ca9f3a9a0c1d2c4e189c79bcc898d7476e5b6bb7a985ec9a25a04b8eec9` |
| the 53 flags the set seeds | absent or FALSE | **none present** (so no postcondition can refuse on a TRUE row, and every rollback may delete what it seeds) |
| flag table snapshot | recorded | 116 rows, 9 TRUE, `md5 617552850b2121aced77cdb57b88a433` (flag, enabled, description) |
| `rank_events` rows with `schema_version <> 1` (3375) | 0 | **0** |
| duplicate primary `content_trails` (3380) | 0 | **0** |
| non-`ievr1.` photo/video evidence references (3361) | 0 | **0** |
| 2951, 2930, 2920, 2901, 2892, 2910 objects | present | **all present** |
| `rank_events`/`canonical_locations` columns | 5 | **5** |
| encoding / `pg_trgm` | UTF8 / present | **UTF8 / present** |
| owner of posts, pulse_geo_tags, passport_postcards, post_media, tags (3362–3365, 3422) | the applying role, RLS on | **`postgres` = `current_user`, RLS on for all five** |
| `canonical_locations` rows (3440's rewrite) | — | 0 (the rewrite is empty) |

**What this does not change.** The apply is still to be run **immediately before PR #528 merges** (§5.4: until the merge, `main`'s `schema-drift` job fails `check:migration-ledger` on ledger rows whose files are not on `main`), and **after** the last lane that adds or edits one of these files has landed and the §8.3 end-to-end rehearsal has passed. Merging is the owner's step.

**How it would run through the connector.** The applier (`scripts/src/apply-migrations.ts`) talks to the Management API with `SUPABASE_PROJECT_TOKEN`, which this session does not hold. Through the connector, the equivalent is to send, per file and in §8.1's order, exactly the statement the applier's own `buildApplyStatement` produces (body + ledger row in one transaction), then the file's post-`COMMIT` tail as a second statement — via `execute_sql`, **not** `apply_migration`, because `apply_migration` also records Supabase's own `supabase_migrations` history, which this repository's ledger does not use. Steps 5–8 of §8.4 then run unchanged (dry run → `NOTHING TO DO`, certify, `audit:schema`, post-reads), the certify and audit tools needing the same token; with the connector alone their queries can be read out of the tools and sent the same way.
