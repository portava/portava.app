/**
 * Single source of truth for the frozen repo-root migrations directory.
 *
 * Every .sql file that existed in migrations/ (repo root) on 2026-08-08,
 * when that directory was formally archived. The root migrations dir is a
 * historical artefact — its files were applied to the very early schema
 * (pre-0010 canonical chain) and some were later superseded. It is NOT
 * the canonical source of truth for any table. All new database changes
 * must go into artifacts/api-server/src/migrations/ instead.
 *
 * The root dir diverges from the canonical (src/migrations/) chain in
 * several places; the column that exists live may come from either tree
 * (e.g. tags.created_at is from root 0043, while canonical 0043 created
 * tags.tagged_at which never existed live). When two trees disagree, the
 * live schema is authoritative — see docs/migrations.md.
 *
 * Imported by:
 *   - src/scripts/checkFrozenDir.ts           (CI guard, no DB credentials)
 *   - src/scripts/auditMigrationsVsLive.ts    (full schema audit startup guard)
 *
 * If a file is ever legitimately added to the frozen set, update this file
 * — never add an inline copy elsewhere.
 */

/** Every .sql filename (bare, no path separator) that is permitted in the root migrations dir. */
export const FROZEN_ROOT_FILES = new Set([
  "0001_spine.sql",
  "0002_map_privacy.sql",
  "0008_messaging.sql",
  "0009_translation.sql",
  "0010_group_chat.sql",
  "0011_telegraph_chat.sql",
  "0012_intelligence.sql",
  "0013_availability_meetups.sql",
  "0016_thread_reads.sql",
  "0017_job_health.sql",
  "0018_preferred_language.sql",
  "0028_highlights_last_viewed.sql",
  "0029_discovery_places.sql",
  "0032_location_preferences.sql",
  "0033_location_sessions.sql",
  "0034_geo_zones.sql",
  "0035_plan_geofences.sql",
  "0036_pulse_geo_tags.sql",
  "0037_feature_flags.sql",
  "0039_plan_geofence_full.sql",
  "0041_trip_crew_location.sql",
  "0042_passport_stamps.sql",
  "0043_tags_hashtags.sql",
  "0044_hashtag_reports.sql",
  "0044_tags_hashtags_supplement.sql",
  "0046_tag_suppression.sql",
  "0047_rent_buddy.sql",
  "0048_booking_stay_connected.sql",
  "0050_suggestion_seen.sql",
  "0051_trip_members_user_role_idx.sql",
  "0069_reviews.sql",
  "0070_appeals.sql",
  "0124_trip_crew_location_sessions_drift.sql",
  // Non-.sql files in the dir (apply script + notes). These are not checked
  // by the .sql-only filter but listed here for completeness.
  // "APPLY_THESE_IN_ORDER.sql", -- this is also a .sql extension
  "APPLY_THESE_IN_ORDER.sql",
]);
