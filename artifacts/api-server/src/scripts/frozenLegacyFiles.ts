/**
 * Single source of truth for the frozen legacy migrations directory.
 *
 * Every .sql file that existed in artifacts/api-server/migrations/ on
 * 2026-07-17.  The legacy directory is frozen as of that date; all new
 * database changes must go into artifacts/api-server/src/migrations/ instead.
 *
 * Imported by:
 *   - src/scripts/checkFrozenDir.ts  (standalone CI guard, no DB credentials)
 *   - src/scripts/auditMigrationsVsLive.ts  (full schema audit)
 *
 * If a file is ever added to the frozen set, update this file — never add an
 * inline copy elsewhere.
 */

/**
 * Rogue-file predicate for the frozen legacy dir. A frozen file is stored as a
 * bare filename (no path separator); anything nested ("/") or not in `frozenSet`
 * is rogue. Pure (no I/O) and side-effect-free, so guard tests bind to this
 * exact filter instead of a hand-copied mirror. Both checkFrozenDir.ts and
 * auditMigrationsVsLive.ts's inline guard call it.
 */
export function findRogueFrozenFiles(
  entries: string[],
  frozenSet: Set<string> = FROZEN_LEGACY_FILES,
): string[] {
  return entries.filter((f) => !frozenSet.has(f));
}

/** Every .sql filename (bare, no path separator) that is permitted in the legacy dir. */
export const FROZEN_LEGACY_FILES = new Set([
  "0011_trip_plan_coords.sql",
  "0012_group_chat.sql",
  "0013_availability_meetups.sql",
  "0019_proposed_time.sql",
  "0020_notifications_inbox_viewed.sql",
  "0022_availability_nudges.sql",
  "0023_push_tokens.sql",
  "0024_post_engagement.sql",
  "0025_location_system.sql",
  "0026_highlights.sql",
  "0027_verification_status.sql",
  "0028_highlights_last_viewed.sql",
  "0029_discovery_places.sql",
  "0030_message_reports.sql",
  "0031_thread_reports.sql",
  "0032_location_preferences.sql",
  "0033_location_sessions.sql",
  "0034_geo_zones.sql",
  "0035_plan_geofences.sql",
  "0036_pulse_geo_tags.sql",
  "0037_feature_flags.sql",
  "0038_plan_geofences_rls_fix.sql",
  "0039_plan_geofence_full.sql",
  "0040_safe_return.sql",
  "0041_notifications.sql",
  "0041_trip_crew_location.sql",
  "0042_passport_stamps.sql",
  "0043_trust_engine.sql",
  "0044_airport_layover.sql",
  "0044_hashtag_reports.sql",
  "0046_tag_suppression.sql",
  "0047_rent_buddy.sql",
  "0048_rent_buddy_marketplace.sql",
  "0048_rent_buddy_rollout.sql",
  "0051_rent_buddy_compliance.sql",
  "0055_compass_admin.sql",
  "0062_discovery_place_saves.sql",
  "0063_push_retry_queue.sql",
  "0075_stamp_artwork.sql",
  "0076_profile_emergency_contacts.sql",
  "0089_decrement_discovery_place_saved_count.sql",
  "0093_activate_stamp_definitions.sql",
  "0094_profile_account_status_and_privacy.sql",
  "0095_post_category.sql",
  "0100_backfill_display_name.sql",
  "0102_show_real_name.sql",
  "0107_rent_buddy_admin_actions.sql",
  "0108_rent_buddy_spec_tables.sql",
  "0109_rent_buddy_missing_enums.sql",
  "0110_rent_buddy_payouts.sql",
  "0111_rent_buddy_onboarding_ack.sql",
  "0112_rent_buddy_lifecycle.sql",
  "0113_rent_buddy_lifecycle_fixes.sql",
  "0114_review_moderation.sql",
  "0115_circle_visibility_settings.sql",
  "0116_circle_context_settings.sql",
  "0117_circle_presence.sql",
  "0118_circle_checkins.sql",
  "0119_circle_member_visibility_overrides.sql",
  "0120_circle_meeting_points.sql",
  "0121_circle_audit_events.sql",
  "0122_circle_global_pause_and_defaults.sql",
  "0123_engagement_user_indexes.sql",
  "0130_rent_buddy_place_coords.sql",
  "0134_rent_buddy_schema_rebuild.sql",
  "0135_rent_buddy_reliability_counter_functions.sql",
  "0138_city_country_geocode_cache.sql",
  "0139_geocode_cache_corrected_at.sql",
  "20260620_telegraph_intelligence.sql",
  "20260621_weather_cache.sql",
  "20260702_crew_location_flags_reseed.sql",
]);
