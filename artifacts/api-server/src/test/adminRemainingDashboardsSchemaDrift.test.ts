/**
 * Schema-drift guard for the remaining admin dashboard routes:
 * adminStamps.ts, adminRankingMetrics.ts, trust-admin.ts, adminGeocode.ts.
 *
 * Same bug class as adminCompassSchemaDrift.test.ts and
 * adminGeoModerationSchemaDrift.test.ts: PostgREST fails the WHOLE query on
 * an unknown column, and admin dashboards using Promise.all/allSettled +
 * "?? 0" defaults silently zero their counts in production when a queried
 * column drifts from the live schema.
 *
 * This test statically extracts every column name referenced in query
 * chains rooted at `.from("<table>")` in each route file and asserts each
 * exists in the known LIVE schema column list.
 *
 * Live column lists verified 2026-07-21 via the Supabase Management API
 * (information_schema.columns, table_schema='public').
 *
 * Run: node --import tsx/esm --test src/test/adminRemainingDashboardsSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractColumnRefs, lineOf } from "./helpers/schemaColumnExtractor.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const routePath = (name: string) => join(__dir, "..", "routes", name);

// ── Live schema (verified 2026-07-21 via Supabase Management API) ────────────

const LIVE_COLUMNS: Record<string, Set<string>> = {
  profiles: new Set([
    "account_status", "auto_translate_messages", "availability_tags",
    "avatar_url", "bio", "buddy_verified_at", "budget_style", "city",
    "comfort_level", "country", "country_code", "cover_photo_url",
    "created_at", "current_city", "date_of_birth", "default_language",
    "display_name", "dob_verified", "expo_push_token", "flag_emoji",
    "full_name", "handle", "highlights_last_viewed_at", "home_city",
    "home_country", "home_country_verified_at", "host_verified_at", "id",
    "id_verified_at", "interests", "is_private", "location_city",
    "location_country", "location_verified", "looking_for", "name",
    "notifications_inbox_viewed_at", "open_to_meet",
    "passport_section_order", "passport_tab_order", "passport_visibility",
    "planning_style", "preferred_language", "preferred_message_language",
    "public_social_links", "role", "safety_flags_count",
    "selfie_verified_at", "show_original_messages", "show_telegraph_circle",
    "show_telegraph_dm", "show_telegraph_trip", "spoken_languages",
    "tag_permission", "tagline", "translation_updated_at",
    "travel_group_style", "travel_pace", "travel_style", "travel_styles",
    "trust_label", "trust_score", "updated_at", "username",
    "username_updated_at", "verification_expires_at", "verification_level",
    "verification_method", "verification_status", "verified", "verified_at",
    "verified_since",
  ]),
  stamp_award_events: new Set([
    "admin_id", "award_reason", "created_at", "criteria_snapshot", "id",
    "idempotency_key", "source_id", "source_type", "stamp_definition_id",
    "status", "updated_at", "user_id",
  ]),
  stamp_campaigns: new Set([
    "created_at", "description", "ends_at", "id", "is_active", "metadata",
    "name", "slug", "stamp_definition_id", "starts_at", "updated_at",
  ]),
  stamp_definitions: new Set([
    "category", "city", "country", "created_at", "criteria", "criteria_type",
    "description", "ends_at", "icon_url", "id", "is_active", "is_repeatable",
    "level_config", "max_awards_per_user", "name", "rarity", "slug",
    "source_system", "stamp_type", "starts_at", "universal_artwork_url",
    "updated_at", "visibility_default",
  ]),
  rank_events: new Set([
    "features", "id", "item_id", "item_kind", "outcome", "outcome_at",
    "position", "served_at", "session_id", "surface", "user_id",
  ]),
  trust_events: new Set([
    "category", "created_at", "delta", "event_type", "id", "metadata",
    "reviewed_at", "reviewed_by", "severity", "source_id", "source_type",
    "status", "user_id",
  ]),
  trust_profiles: new Set([
    "communication", "community_value", "content_quality", "created_at",
    "guide_accuracy", "host_quality", "last_recalculated_at",
    "location_honesty", "on_probation", "overall_score",
    "passport_authenticity", "plan_attendance", "probation_ends_at",
    "public_level", "respect_safety", "updated_at", "user_id",
  ]),
  trust_restrictions: new Set([
    "created_at", "expires_at", "id", "lifted_at", "lifted_by", "reason",
    "restriction_type", "source_event_id", "user_id",
  ]),
  trust_reviews: new Set([
    "assigned_to", "created_at", "id", "metadata", "notes", "resolved_at",
    "resolved_by", "review_type", "source_event_id", "status", "user_id",
  ]),
  trust_settings: new Set([
    "daily_cap_gem_save", "daily_cap_guide_verify", "daily_cap_plan_attend",
    "decay_half_life_days", "gaming_checkin_cluster_limit",
    "gaming_mutual_rate_threshold", "gaming_rapid_jump_points", "id",
    "level_building_trust", "level_city_trusted", "level_highly_trusted",
    "level_reliable", "level_trusted", "updated_at", "weekly_cap_gem_save",
    "weekly_cap_guide_verify", "weekly_cap_plan_attend",
    "weight_communication", "weight_community_value",
    "weight_content_quality", "weight_guide_accuracy", "weight_host_quality",
    "weight_location_honesty", "weight_passport_auth",
    "weight_plan_attendance", "weight_respect_safety",
  ]),
};

// Route file → tables it queries (from `.from("<table>")` call sites).
const ROUTE_TABLES: Record<string, string[]> = {
  "adminStamps.ts": [
    "profiles", "stamp_award_events", "stamp_campaigns", "stamp_definitions",
  ],
  "adminRankingMetrics.ts": ["profiles", "rank_events"],
  "trust-admin.ts": [
    // trust_admin_actions is insert-only in this route (no select/filter
    // chains), so the read-path extractor has nothing to guard there.
    "profiles", "trust_events", "trust_profiles",
    "trust_restrictions", "trust_reviews", "trust_settings",
  ],
  "adminGeocode.ts": ["profiles"],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

for (const [file, tables] of Object.entries(ROUTE_TABLES)) {
  const source = readFileSync(routePath(file), "utf8");

  describe(`${file} schema drift — queried columns must exist live`, () => {
    it("finds query chains for every guarded table (parser sanity check)", () => {
      for (const table of tables) {
        const refs = extractColumnRefs(source, table);
        assert.ok(
          refs.length >= 1,
          `expected to extract column refs from ${table} queries in ${file} — ` +
          `parser may be broken or the route no longer queries this table (got ${refs.length})`,
        );
      }
    });

    for (const table of tables) {
      const live = LIVE_COLUMNS[table]!;
      it(`every ${table} column referenced in ${file} exists in the live ${table} table`, () => {
        const bad = extractColumnRefs(source, table).filter((r) => !live.has(r.column));
        assert.deepEqual(
          bad,
          [],
          `${file} references ${table} columns missing from the live schema — ` +
          `PostgREST will fail these queries and the dashboard will silently zero out: ` +
          bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
        );
      });
    }
  });
}

describe("extractor guard-the-guard", () => {
  it("flags a simulated dead column in a trust query", () => {
    const simulated =
      `sc.from("trust_reviews").select("id", { count: "exact", head: true })` +
      `.eq("reviewer_id", userId).eq("status", "pending")`;
    const flagged = extractColumnRefs(simulated, "trust_reviews")
      .filter((r) => !LIVE_COLUMNS.trust_reviews!.has(r.column))
      .map((r) => r.column);
    assert.deepEqual(flagged, ["reviewer_id"],
      "extractor must flag a dead column referenced in a count query");
  });
});
