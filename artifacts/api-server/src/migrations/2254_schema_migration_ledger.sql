-- 2254_schema_migration_ledger.sql
--
-- THE MIGRATION LEDGER — public.schema_migration_ledger
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band; see
-- src/scripts/migrationPrefixRules.ts).
--
--
-- THE FAILURE THIS IS WRITTEN AGAINST (2026-08-31)
-- ================================================
-- Five migrations were merged to main and never applied to the CI database
-- (portava-ci, ref hwokxgbmezheskbzskfr):
--
--     2220_canonical_locations_search_key.sql
--     2223_map_media_evidence.sql
--     2224_route_hop_signal.sql
--     2250_media_asset_canonical_model.sql
--     2252_hidden_gem_contributions.sql
--
-- Nothing in the merge path applies migrations, so `CI (live DB)` went red ON
-- MAIN ITSELF and stayed red until an unrelated PR tripped over it. The way it
-- surfaced was `check:missing-live-columns` naming individual columns — a
-- symptom several steps removed from the cause. Nobody reading
-- "media_assets.canonical_key is missing" concludes "main has five migrations
-- this database has never seen", because the database had no way to say that:
-- there was nothing that recorded what had been applied.
--
-- This table is that record. src/scripts/checkMigrationLedger.ts is the gate
-- that reads it and says the sentence.
--
--
-- THE BACKFILL, AND EXACTLY WHAT A BACKFILLED ROW CLAIMS
-- ======================================================
-- No ledger has ever existed in this repo. There are 381 migration files
-- on disk (382 counting this one) and NO RECORD of which of them ran. That
-- cannot be reconstructed:
--
--   * Object inspection is a guess. A file whose objects exist live may have
--     been applied, or the objects may have come from a later file, a hand-run
--     statement, or the baseline dump. A file whose objects are absent may be
--     unapplied, or applied-then-reverted, or an idempotent no-op.
--   * A wrong guess in EITHER direction is worse than an admission. Marking an
--     unapplied file "applied" hides the exact failure this table exists to
--     catch. Marking an applied file "unapplied" makes the gate cry wolf on
--     every run until somebody adds an allowlist, and then the gate is an
--     allowlist.
--
-- So the backfill below asserts one fact and no more:
--
--     A ROW WITH applied_by = 'backfill' MEANS: THIS FILENAME EXISTED IN
--     src/migrations/ AT THE MOMENT THIS MIGRATION RAN. IT IS NOT EVIDENCE
--     THAT THE FILE WAS EVER APPLIED TO THIS DATABASE, AND NOTHING VERIFIED
--     THAT IT WAS.
--
-- The ledger is authoritative FROM THIS POINT FORWARD. Rows written after this
-- migration, by the applier, carry applied_by = 'ci' or 'manual' and a real
-- sha256 of the file's bytes at apply time, and those rows do mean the file ran.
--
-- CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER: the five files named at the
-- top of this comment are INSIDE the backfill set, because they are on disk.
-- This gate will not catch them. check:missing-live-columns remains the
-- instrument for pre-ledger drift, and this table says nothing about anything
-- that happened before it existed.
--
-- WHY checksum = 'backfill' AND NOT A REAL HASH
-- ---------------------------------------------
-- Hashing the file on disk today would produce a genuine sha256 — of the
-- CURRENT bytes, which is not the same thing as the bytes that were applied,
-- because nothing knows whether the file was applied at all or whether it has
-- been edited since. A column called `checksum` holding a real-looking
-- 64-hex-character value is read as "this is what ran". Storing the literal
-- string 'backfill' cannot be misread: it is not a hash, it does not look like
-- one, and the drift gate treats any checksum that is not 64 lowercase hex
-- characters as UNVERIFIABLE and declines to compare it, rather than reporting
-- 382 false mismatches on its first run.
--
--
-- WRITE BOUNDARY
-- ==============
-- Service-role writes only. RLS is ENABLED with NO POLICIES, so PostgREST
-- returns nothing to anon or authenticated even if a grant were ever
-- reintroduced by ALTER DEFAULT PRIVILEGES; and anon/authenticated are REVOKEd
-- outright. service_role bypasses RLS, which is the intended and only writer:
-- the applier, running with the service key or through the Management API.
-- A ledger a client can write is not a ledger.
--
--
-- CONTRACT (fixed — the applier is built against this exact shape)
-- ================================================================
--   filename    text PRIMARY KEY   e.g. '2224_route_hop_signal.sql'
--   checksum    text NOT NULL      sha256 of the file's bytes at apply time,
--                                  or the literal 'backfill' (see above)
--   applied_at  timestamptz NOT NULL DEFAULT now()
--   applied_by  text NOT NULL      'ci' | 'manual' | 'backfill'
--   notes       text
--
-- applied_by carries a CHECK constraint pinning it to those three values. The
-- three-value vocabulary is the contract; a CHECK is what makes it one rather
-- than a comment. Widening it later is a one-line migration, and it should be a
-- deliberate one.
--
--
-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.schema_migration_ledger;

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
--
-- Deliberately minimal. This table references nothing and depends on nothing;
-- the only precondition that could fail is a name already taken by something
-- that is not our table, which would make every statement below mean something
-- other than what it says.
DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'schema_migration_ledger'
         AND c.relkind = 'r'
     ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.schema_migration_ledger exists but is not an ordinary table.';
  END IF;
END $$;

-- ── The ledger ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.schema_migration_ledger (
  filename    TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by  TEXT NOT NULL,
  notes       TEXT
);

-- applied_by vocabulary. Named so a failure says which constraint refused.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.schema_migration_ledger'::regclass
      AND conname = 'schema_migration_ledger_applied_by_check'
  ) THEN
    ALTER TABLE public.schema_migration_ledger
      ADD CONSTRAINT schema_migration_ledger_applied_by_check
      CHECK (applied_by IN ('ci', 'manual', 'backfill'));
  END IF;
END $$;

-- Newest-first reads ("what did the last apply run do?") are the only query
-- shape besides the full scan the gate performs.
CREATE INDEX IF NOT EXISTS schema_migration_ledger_applied_at_idx
  ON public.schema_migration_ledger (applied_at DESC);

ALTER TABLE public.schema_migration_ledger ENABLE ROW LEVEL SECURITY;

-- No policies, deliberately. RLS with an empty policy set denies every row to
-- every non-bypassing role; service_role bypasses it. The absence below is the
-- boundary, so anything that adds a policy here is changing the boundary.

REVOKE ALL ON TABLE public.schema_migration_ledger FROM anon;
REVOKE ALL ON TABLE public.schema_migration_ledger FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.schema_migration_ledger TO service_role;

COMMENT ON TABLE public.schema_migration_ledger IS
  'Which migration files have been applied to THIS database. One row per file in '
  'artifacts/api-server/src/migrations/. Read by check:migration-ledger '
  '(src/scripts/checkMigrationLedger.ts), which fails when a file on disk has no row here. '
  'AUTHORITATIVE ONLY FROM 2254 ONWARDS. Rows with applied_by = ''backfill'' were seeded by '
  '2254_schema_migration_ledger.sql and assert ONLY that the filename existed in src/migrations/ '
  'when 2254 ran; they are NOT evidence that the file was applied, and nothing verified that it '
  'was — no ledger existed before this table, and which of the pre-2254 files ran cannot be '
  'reconstructed. Their checksum is the literal ''backfill'' rather than a real sha256, because a '
  'hash of today''s bytes would be read as a record of what ran. Rows written by the applier carry '
  'applied_by ''ci'' or ''manual'' and a real sha256 of the file at apply time; those rows do mean '
  'the file ran. Service-role writes only: RLS is on with no policies and anon/authenticated hold '
  'no grants.';

COMMENT ON COLUMN public.schema_migration_ledger.checksum IS
  'sha256 (64 lowercase hex chars) of the migration file''s bytes at apply time, or the literal '
  '''backfill'' for rows seeded by 2254. The drift gate compares only well-formed hashes and '
  'reports anything else as unverifiable rather than as a mismatch.';

COMMENT ON COLUMN public.schema_migration_ledger.applied_by IS
  '''ci'' (applied by the CI applier), ''manual'' (applied by an operator), or ''backfill'' '
  '(seeded by 2254; asserts file existence only, never that the file was applied).';

-- ── Backfill ─────────────────────────────────────────────────────────────────
--
-- Every .sql file present in src/migrations/ when this migration was authored,
-- including this file itself. Postgres cannot list a directory, so the list is
-- literal — which is the honest form anyway: the file states exactly what it
-- claims to have seen.
--
-- This file's own row is 'backfill' like the rest. It is tempting to record it
-- as 'manual' since it demonstrably ran, but a migration cannot hash its own
-- bytes, and the value of 'backfill' is that it means ONE thing everywhere it
-- appears. The first row that genuinely means "this file was applied" will be
-- written by the applier, for the next migration after this one.
--
-- ON CONFLICT DO NOTHING: re-applying this file must never overwrite a real row
-- the applier wrote later. A replay is a no-op by construction, asserted in the
-- postcondition rather than assumed.
INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
SELECT
  f,
  'backfill',
  'backfill',
  'Seeded by 2254_schema_migration_ledger.sql. Asserts only that this filename existed in src/migrations/ when 2254 ran. NOT evidence that it was applied to this database; nothing verified that it was.'
FROM unnest(ARRAY[
  '0010_trip_plan.sql',
  '0011_message_type.sql',
  '0012_daily_briefs.sql',
  '0013_daily_briefs_cleanup.sql',
  '0014_profile_about_me.sql',
  '0015_blocks.sql',
  '0016_thread_reads.sql',
  '0017_job_health.sql',
  '0018_preferred_language.sql',
  '0019_proposed_time.sql',
  '0020_notifications_inbox_viewed.sql',
  '0021_plan_edit_permission.sql',
  '0022_availability_nudges.sql',
  '0023_push_tokens.sql',
  '0024_post_engagement.sql',
  '0025_location_system.sql',
  '0026_highlights.sql',
  '0028_highlights_last_viewed.sql',
  '0029_discovery_places.sql',
  '0032_location_preferences.sql',
  '0033_location_sessions.sql',
  '0034_geo_zones.sql',
  '0035_plan_geofences.sql',
  '0036_pulse_geo_tags.sql',
  '0037_feature_flags.sql',
  '0039_plan_geofence_full.sql',
  '0041_trip_crew_location.sql',
  '0042_passport_stamps.sql',
  '0043_hidden_gems.sql',
  '0044_tags_hashtags.sql',
  '0045_dob_profiles.sql',
  '0046_meetup_age_limits.sql',
  '0047_circle_age_settings.sql',
  '0048_age_audit_log.sql',
  '0049_discovery_places_age.sql',
  '0050_rent_a_buddy.sql',
  '0051_compass_foundation.sql',
  '0052_compass_pipeline_logs.sql',
  '0053_compass_feed_intelligence.sql',
  '0054_compass_cache.sql',
  '0055_compass_ux.sql',
  '0056_compass_user_prefs_v2.sql',
  '0057_reply_to_messages.sql',
  '0058_trip_flow.sql',
  '0059_route_plan_members.sql',
  '0060_discovery_places_coords.sql',
  '0061_discovery_place_reports.sql',
  '0062_notifications_schema.sql',
  '0063_interaction_foundation.sql',
  '0064_tags_approval.sql',
  '0065_phase7_safety.sql',
  '0066_post_interaction_layer.sql',
  '0067_reviews.sql',
  '0068_stories.sql',
  '0069_collections.sql',
  '0070_appeals.sql',
  '0071_protect_default_collection.sql',
  '0072_block_collections_truncate.sql',
  '0073_block_collection_items_truncate.sql',
  '0074_protect_saved_places.sql',
  '0075_seed_discovery_places.sql',
  '0077_trips_expansion.sql',
  '0078_trip_members_expansion.sql',
  '0079_trip_sub_tables.sql',
  '0080_events_extension.sql',
  '0081_stamp_system_v2.sql',
  '0082_stamp_definitions_v2.sql',
  '0083_place_category_columns.sql',
  '0084_reviews_place_entity.sql',
  '0085_enable_passport_flags.sql',
  '0086_discovery_places_osm_id.sql',
  '0087_profiles_cover_photo_url.sql',
  '0088_wishlist_places.sql',
  '0089_decrement_discovery_place_saved_count.sql',
  '0090_rent_buddy_rollout_tables.sql',
  '0091_activate_stamp_definitions.sql',
  '0092_seed_rent_buddy_launch_cities.sql',
  '0093_activate_stamp_definitions.sql',
  '0095_post_category.sql',
  '0097_post_saves.sql',
  '0098_profile_translation_prefs.sql',
  '0099_missing_indexes.sql',
  '0101_feed_save_indexes.sql',
  '0102_safe_return_single_session.sql',
  '0103_post_media.sql',
  '0104_compass_new_tables.sql',
  '0105_compass_performance_indexes.sql',
  '0106_engagement_indexes.sql',
  '0107_compass_analytics_onboarding.sql',
  '0108_circle_schema_tracked.sql',
  '0109_claim_invite_link_slot.sql',
  '0110_invite_link_idempotency.sql',
  '0111_reconcile_invite_slots.sql',
  '0112_trip_members_invite_link_id.sql',
  '0113_cleanup_stale_invite_attempts.sql',
  '0114_add_max_members_to_trips.sql',
  '0115_max_members_atomic_guard.sql',
  '0116_post_hides.sql',
  '0117_beta_feature_flags.sql',
  '0118_feature_flag_audit_log.sql',
  '0119_toggle_flag_atomic.sql',
  '0120_passport_section_order.sql',
  '0121_universal_stamp_catalog.sql',
  '0124_stamp_definitions_universal_artwork.sql',
  '0125_canonical_locations.sql',
  '0126_canonical_locations_unique.sql',
  '0127_layover_system.sql',
  '0128_posts_canonical_location.sql',
  '0129_post_media_stamp_overlay.sql',
  '0130_user_account_states_updated_at.sql',
  '0131_location_mode_check_update.sql',
  '0132_passport_visibility_prefs_columns.sql',
  '0133_rent_buddy_availability_alignment.sql',
  '0135_rent_buddy_meetup_base_coords.sql',
  '0136_stamp_queue_requeue_cap.sql',
  '0137_notification_prefs_timezone.sql',
  '0138_trips_reminder_sent_at.sql',
  '0139_trips_reminder_delivered_at.sql',
  '0140_trips_reminder_retry_count.sql',
  '0141_geocode_cache_deleted_at.sql',
  '0142_stamp_queue_cleanup_error.sql',
  '0143_passport_tab_order.sql',
  '0144_universal_stamp_catalog_country_code_nullable.sql',
  '0145_event_first_stamp_definitions.sql',
  '0146_append_cleanup_error_paths_fn.sql',
  '0147_buddy_bookings_compat_view.sql',
  '0148_memories_location.sql',
  '0149_memories_photo_url.sql',
  '0150_trips_cover_media_type.sql',
  '0151_event_cover_media_type.sql',
  '0152_messages_media.sql',
  '0153_add_rank_events.sql',
  '0154_rank_events_compass_surface.sql',
  '0155_calling_system.sql',
  '0156_event_voice_rooms.sql',
  '0157_memories_media_type.sql',
  '0160_beta_field_passthrough.sql',
  '0161_friend_requests_responded_at.sql',
  '0162_rent_buddy_availability_blocks.sql',
  '0163_write_path_drift_columns.sql',
  '0164_write_path_drift_columns_2.sql',
  '0165_city_timezones.sql',
  '0166_feature_flags_reconcile.sql',
  '0167_safety_ddl_reconcile.sql',
  '0168_discovery_cache_ddl.sql',
  '0169_traveler_passports_entry_requirements.sql',
  '0170_trip_readiness.sql',
  '0171_price_baselines.sql',
  '0172_trip_reservations.sql',
  '0173_neighborhood_areas.sql',
  '0174_reference_data.sql',
  '0175_trip_readiness_snapshots.sql',
  '0176_moderation_reports.sql',
  '0177_stamp_premium_foundation.sql',
  '0178_stamp_showcase_admire.sql',
  '0179_stamp_criteria_engine.sql',
  '0180_activate_event_category_stamps.sql',
  '0181_stamp_unified_view.sql',
  '0182_country_essentials.sql',
  '0183_budget_fx_conversion.sql',
  '0184_fsq_places.sql',
  '0185_seed_price_baselines.sql',
  '0186_geo_indexes.sql',
  '0187_upsert_city_stamp_reconcile.sql',
  '0188_map_search_flags.sql',
  '0189_globe_trotter_stamp_definitions.sql',
  '0191_media_assets.sql',
  '0192_globe_trotter_criteria.sql',
  '0193_retire_globe_trotter_legacy.sql',
  '0194_generated_visuals.sql',
  '0195_rls_privacy_baseline.sql',
  '0196_reviews_photos_column.sql',
  '0197_rank_events_analytics_columns.sql',
  '0198_place_contributor_stamps.sql',
  '0199_rank_events_live_pulse_surface.sql',
  '0200_backfill_unrecorded_live_objects.sql',
  '0201_pin_search_path_authz_functions.sql',
  '0202_rank_events_living_page_watch_feed_surfaces.sql',
  '0203_backfill_counter_and_purge_functions.sql',
  '0204_pin_search_path_writer_functions.sql',
  '0205_drop_enforce_is_official_service_role.sql',
  '0206_delete_seed_pollution_on_real_accounts.sql',
  '0207_delete_21_seed_posts_on_92602b6c.sql',
  '0208_post_media_feed_variant.sql',
  '0209_retire_freeze_flags.sql',
  '20260720_compass_preference_columns.sql',
  '20260721_verify_class_columns.sql',
  '20260722_events_featured.sql',
  '20260723_compass_conversations.sql',
  '20260724_compass_memories.sql',
  '20260725_passport_hidden_sections.sql',
  '20260726_compass_sense.sql',
  '20260727_compass_live.sql',
  '20260728_compass_autopilot.sql',
  '20260729_compass_outcome_learning.sql',
  '20260730_compass_intelligence_graph.sql',
  '20260731_post_event_links.sql',
  '20260801_e2ee_devices.sql',
  '20260802_e2ee_key_packages.sql',
  '20260803_messages_ciphertext.sql',
  '20260804_hidden_gems_image_url.sql',
  '20260805_events_core_flags.sql',
  '20260806_media_private_buckets.sql',
  '20260807_fix_show_header_publicly_default.sql',
  '20260808_header_image_privacy.sql',
  '20260809_real_place_image_provenance.sql',
  '20260810_place_image_reports.sql',
  '20260811_media_rls.sql',
  '20260812_posts_publish_at.sql',
  '20260813_posts_restrictions.sql',
  '20260814_media_stamp_reactions.sql',
  '20260815_close_memories_stories_grant.sql',
  '2027_media_private_buckets_prep.sql',
  '2028_canonical_places.sql',
  '2029_moderation_reports_place.sql',
  '2030_postgis_spatial.sql',
  '2031_community_place_photos.sql',
  '2032_moderation_report_image_url.sql',
  '2033_rls_hardening.sql',
  '2034_generated_visuals_retry_cols.sql',
  '2035_admin_access_log.sql',
  '2036_events_cover_source.sql',
  '2037_media_tab_flags.sql',
  '2038_media_admin_flags.sql',
  '2039_media_events.sql',
  '2040_media_ranking_boost_flags.sql',
  '2041_media_ranking_snapshots.sql',
  '2042_stamp_auto_approve_artwork_flag.sql',
  '2043_event_agenda_items.sql',
  '2044_hidden_gems_canonical_place_id.sql',
  '2045_posts_canonical_place_id.sql',
  '2046_phash_dedup.sql',
  '2047_place_living_cache.sql',
  '2048_place_coverage_buckets.sql',
  '2049_content_stamps.sql',
  '2050_place_cache_queue_worker_cols.sql',
  '2051_stamp_milestones.sql',
  '2052_content_stamps_memory_type.sql',
  '2053_discovery_places_canonical_location_id.sql',
  '2054_backfill_stamp_country_from_city.sql',
  '2055_content_stamps_migrated_from.sql',
  '2056_places_header_image_generated_id.sql',
  '2057_hidden_gems_add_a_gem_cols.sql',
  '2058_viewer_creator_fatigue_expires_at.sql',
  '2059_content_distribution_stats.sql',
  '2059_stamp_artwork_generation_source_placeholder.sql',
  '2060_ranking_debug_samples.sql',
  '2061_ranking_config_audit_log.sql',
  '2062_place_votes.sql',
  '2063_place_days_foundation.sql',
  '2064_shared_moments_foundation.sql',
  '2065_live_places_recaps.sql',
  '2066_live_place_recap_lifecycle_rpc.sql',
  '2067_live_place_recap_integrity_hardening.sql',
  '2068_live_places_rollout_flags.sql',
  '2069_circle_invites.sql',
  '2070_rls_hardening.sql',
  '2071_feature_flags_deny_anon.sql',
  '2072_track_profiles_full_name.sql',
  '2073_account_deletion_worker_flag.sql',
  '2074_rent_buddy_kyc_gate_flag.sql',
  '2075_stamp_progress_atomic.sql',
  '2076_user_stamps_unique.sql',
  '2077_enable_media_gem_uploads.sql',
  '2078_profiles_role_not_self_writable.sql',
  '2079_is_official_privileged_both_directions.sql',
  '2080_retire_inert_seeded_flags.sql',
  '2081_canonicalize_absolute_storage_urls.sql',
  '2082_canonicalize_remaining_storage_urls.sql',
  '2083_backfill_storage_backed_post_media.sql',
  '2084_codify_live_read_flags.sql',
  '2085_converge_absent_seeded_flags.sql',
  '2086_retire_unread_flags.sql',
  '2087_retire_city_launch_mode.sql',
  '2088_post_media_ready_requires_dimensions.sql',
  '2089_media_assets_ready_requires_dimensions.sql',
  '2089_revoke_post_media_public_read.sql',
  '2090_discovery_serve_log_flag.sql',
  '2091_discovery_engine_mode_flags.sql',
  '2092_discovery_shadow_serves.sql',
  '2093_discovery_shadow_serves_grants.sql',
  '2094_discovery_shadow_serves_cohort.sql',
  '2095_discovery_place_photos.sql',
  '2120_canonical_events.sql',
  '2121_source_registry.sql',
  '2122_freshness_policies.sql',
  '2123_canonical_event_families.sql',
  '2128_intel_contracts_seed.sql',
  '2129_location_snapshot_purge_flag.sql',
  '2130_intel_storage.sql',
  '2131_intel_live_label_flag.sql',
  '2132_intel_projection_flag.sql',
  '2133_intel_retention.sql',
  '2135_deletion_blocking_fks.sql',
  '2136_profiles_auth_users_convergence.sql',
  '2137_intel_stmt_trigger_removal.sql',
  '2138_profiles_fk_convergence_prep.sql',
  '2139_shared_content_tombstones.sql',
  '2140_deletion_receipt.sql',
  '2141_post_tombstones.sql',
  '2142_phone_verification.sql',
  '2143_plan_geofences_policy_convergence.sql',
  '2144_local_guide_profiles_write_boundary.sql',
  '2145_rent_buddy_profiles_write_boundary.sql',
  '2146_rent_buddy_applications_write_boundary.sql',
  '2147_hidden_gems_write_boundary.sql',
  '2148_posts_write_boundary.sql',
  '2149_passport_stamps_write_boundary.sql',
  '2150_passport_memories_write_boundary.sql',
  '2151_passport_postcards_write_boundary.sql',
  '2152_passport_postcards_status_boundary.sql',
  '2153_discovery_places_write_boundary.sql',
  '2154_hidden_gem_visits_write_boundary.sql',
  '2155_buddy_services_write_boundary.sql',
  '2156_rent_buddy_addons_write_boundary.sql',
  '2157_rent_buddy_packages_write_boundary.sql',
  '2158_post_media_write_boundary.sql',
  '2159_geo_zones_write_boundary.sql',
  '2160_portava_featured_write_boundary.sql',
  '2161_compass_memories_client_revoke.sql',
  '2162_public_profile_verification_view_boundary.sql',
  '2163_profiles_verification_privileged.sql',
  '2164_deleteuser_unblock_fk_actions.sql',
  '2165_intel_capture_quick_signal_flag.sql',
  '2166_intel_trail_followup_flag.sql',
  '2167_intel_mission_candidates.sql',
  '2168_intel_limited_live_flags.sql',
  '2169_intel_compass_rhythm_actor_gate_flag.sql',
  '2170_intel_reward_ledger.sql',
  '2171_intel_observations_independent_group.sql',
  '2172_intel_contribution_consent.sql',
  '2173_intel_contribution_retention.sql',
  '2174_intel_system_claim_promotion.sql',
  '2175_security_lint_hygiene.sql',
  '2176_intel_snapshot_conflict_target.sql',
  '2177_consume_key_package_atomic.sql',
  '2178_deletion_status_check_converge.sql',
  '2179_intel_live_promoted_scopes.sql',
  '2180_intel_reward_ledger_idempotency.sql',
  '2181_intel_coverage_snapshots.sql',
  '2182_close_authz_rpc_oracle.sql',
  '2183_memory_projection_contract.sql',
  '2184_memory_projector.sql',
  '2185_memory_retrieval_retention.sql',
  '2186_memory_projector_taxonomy.sql',
  '2187_memory_deletion_cascade.sql',
  '2188_memory_rediscovery.sql',
  '2189_memory_intent.sql',
  '2190_memory_lifecycle_fixes.sql',
  '2191_memory_projector_content_and_support.sql',
  '2192_memory_provenance_policy.sql',
  '2193_memory_projector_provenance.sql',
  '2194_memory_reset_export.sql',
  '2195_memory_inferred_preferences.sql',
  '2196_memory_feedback_completeness.sql',
  '2197_memory_reset_category_scope.sql',
  '2198_feature_flag_metadata_audit.sql',
  '2199_call_participants_rls_recursion.sql',
  '2200_memory_projection_exclude_deleted_profiles.sql',
  '2201_map_projection_flag.sql',
  '2202_map_telemetry.sql',
  '2203_intel_consent_erasure_grant.sql',
  '2204_intel_reward_ledger_erasure_grant.sql',
  '2205_memory_new_to_me_batch.sql',
  '2210_rent_buddy_default_off.sql',
  '2211_intel_mission_candidates_accepted_by_erasure_grant.sql',
  '2212_rent_buddy_country_snapshot.sql',
  '2213_memory_passport_controls.sql',
  '2214_memory_recaps.sql',
  '2216_map_observations.sql',
  '2217_protected_locations.sql',
  '2218_crowd_flow.sql',
  '2219_locate_friends_sessions.sql',
  '2220_canonical_locations_search_key.sql',
  '2222_map_telemetry_refusal_event.sql',
  '2223_map_media_evidence.sql',
  '2224_route_hop_signal.sql',
  '2250_media_asset_canonical_model.sql',
  '2251_hidden_gem_place_protection_index.sql',
  '2252_hidden_gem_contributions.sql',
  '2253_map_contribution_claim_types.sql',
  '2254_schema_migration_ledger.sql'
]::text[]) AS f
ON CONFLICT (filename) DO NOTHING;

-- ── Postcondition — prove the table, the constraint, the write boundary and
--    the backfill posture. Every RAISE below is inside an IF, so this block
--    aborts only on a real failure (src/test/migrationDeployability.test.ts).
DO $$
DECLARE
  anon_privs  text;
  auth_privs  text;
  rls_on      boolean;
  n_backfill  bigint;
  n_bad_ck    bigint;
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: schema_migration_ledger was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.schema_migration_ledger'::regclass
      AND conname = 'schema_migration_ledger_applied_by_check'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: applied_by CHECK constraint missing';
  END IF;

  SELECT c.relrowsecurity INTO rls_on
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'schema_migration_ledger';
  IF rls_on IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: row level security is not enabled on schema_migration_ledger';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'schema_migration_ledger'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: schema_migration_ledger has an RLS policy. The empty policy set IS the write boundary; a policy here grants a non-service role access to the record of what has been applied.';
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'schema_migration_ledger' AND grantee = 'anon';
  IF anon_privs <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected no grants', anon_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'schema_migration_ledger' AND grantee = 'authenticated';
  IF auth_privs <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected no grants', auth_privs;
  END IF;

  -- The backfill either ran now or ran on a previous apply. Either way the
  -- files this migration enumerated must be present. A count below the
  -- enumerated size means rows were deleted, which the gate would then report
  -- as disk-ahead-of-ledger against files nobody skipped.
  SELECT count(*) INTO n_backfill FROM public.schema_migration_ledger;
  IF n_backfill < 382 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: ledger holds % row(s), fewer than the 382 files this migration enumerated', n_backfill;
  END IF;

  -- A row that is neither a well-formed sha256 nor the 'backfill' sentinel
  -- would be silently skipped by the gate's checksum comparison forever.
  SELECT count(*) INTO n_bad_ck FROM public.schema_migration_ledger
   WHERE checksum <> 'backfill' AND checksum !~ '^[0-9a-f]{64}$';
  IF n_bad_ck > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % ledger row(s) hold a checksum that is neither a sha256 nor the ''backfill'' sentinel', n_bad_ck;
  END IF;
END $$;

COMMIT;
