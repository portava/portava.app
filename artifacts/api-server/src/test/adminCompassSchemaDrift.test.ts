/**
 * Schema-drift guard for adminCompass.ts posts/events queries.
 *
 * Task background: adminCompass.ts once queried posts with dead columns
 * (post_type / is_verified / event_starts_at). PostgREST fails the whole
 * query on an unknown column, and Promise.allSettled + the "?? 0" defaults
 * silently zeroed the dashboard counts in production.
 *
 * This test statically extracts every column name referenced in query
 * chains rooted at `sc.from("posts")` / `sc.from("events")` inside
 * src/routes/adminCompass.ts — .select() lists and filter/order method
 * first arguments — and asserts each exists in the known LIVE schema
 * column list.
 *
 * Live column lists verified 2026-07-20 via the Supabase Management API
 * (information_schema.columns, table_schema='public').
 *
 * Run: node --import tsx/esm --test src/test/adminCompassSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractColumnRefs, lineOf } from "./helpers/schemaColumnExtractor.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dir, "..", "routes", "adminCompass.ts");

// ── Live schema (verified 2026-07-20 via Supabase Management API) ────────────

const LIVE_POSTS_COLUMNS = new Set([
  "add_to_passport", "author_id", "canonical_location_id", "category",
  "comment_count", "comments_setting", "content", "created_at", "created_by",
  "delayed_location_reason", "deleted_at", "exited_geofence_at",
  "geofence_radius_meters", "geotag_credit_awarded", "geotag_verified",
  "has_video", "id", "like_count", "likes_hidden", "location_city",
  "location_country", "location_distance_meters", "location_lat",
  "location_lng", "location_name", "location_place_id",
  "location_privacy_mode", "location_sensitivity_level", "location_source",
  "location_verified", "location_verified_at", "media_count",
  "media_thumbnail_url", "media_type", "media_urls", "original_lat",
  "original_lng", "post_status", "primary_media_type", "public_lat",
  "public_lng", "public_location_label", "publish_after_exit",
  "publish_after_time", "publish_eligible_at", "published_at",
  "reposting_disabled", "save_count", "share_count", "sharing_disabled",
  "source", "status", "trip_id", "updated_at", "updated_by", "user_gps_lat",
  "user_gps_lng", "venue_id", "venue_name", "visibility",
]);

const LIVE_EVENTS_COLUMNS = new Set([
  "age_max", "age_min", "attendee_comments_enabled", "avg_rating", "category",
  "chat_enabled", "chat_thread_id", "circle_id", "city", "country",
  "cover_media_type", "cover_url", "created_at", "description", "ends_at",
  "featured", "going_count", "host_id", "id", "is_recurring", "location_lat",
  "location_lng", "location_name", "max_attendees", "price_type", "price_url",
  "recurring_config", "review_count", "rsvp_closed", "rsvp_options",
  "safety_notes", "show_exact_location", "starts_at", "state", "tags",
  "ticket_url", "title", "trip_id", "trust_score_min", "updated_at",
  "verified_only", "visibility", "waitlist_count", "waitlist_enabled",
]);

const source = readFileSync(SOURCE_PATH, "utf8");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("adminCompass.ts schema drift — posts/events columns must exist live", () => {
  it("finds posts and events query chains (parser sanity check)", () => {
    const postsRefs = extractColumnRefs(source, "posts");
    const eventsRefs = extractColumnRefs(source, "events");
    assert.ok(
      postsRefs.length >= 3,
      `expected to extract column refs from posts queries — parser may be broken (got ${postsRefs.length})`,
    );
    assert.ok(
      eventsRefs.length >= 2,
      `expected to extract column refs from events queries — parser may be broken (got ${eventsRefs.length})`,
    );
  });

  it("every posts column referenced in adminCompass.ts exists in the live posts table", () => {
    const bad = extractColumnRefs(source, "posts")
      .filter((r) => !LIVE_POSTS_COLUMNS.has(r.column));
    assert.deepEqual(
      bad,
      [],
      `adminCompass.ts references posts columns missing from the live schema — ` +
      `PostgREST will fail these queries and the dashboard will silently zero out: ` +
      bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
    );
  });

  it("every events column referenced in adminCompass.ts exists in the live events table", () => {
    const bad = extractColumnRefs(source, "events")
      .filter((r) => !LIVE_EVENTS_COLUMNS.has(r.column));
    assert.deepEqual(
      bad,
      [],
      `adminCompass.ts references events columns missing from the live schema — ` +
      `PostgREST will fail these queries and the dashboard will silently zero out: ` +
      bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
    );
  });

  it("catches the historical regression class (dead columns like post_type/is_verified/event_starts_at)", () => {
    // Guard the guard: the exact columns from the original bug must not be in
    // the live lists — if they ever appear here, this test's premise changed.
    for (const dead of ["post_type", "is_verified", "event_starts_at"]) {
      assert.ok(!LIVE_POSTS_COLUMNS.has(dead), `'${dead}' should not be a live posts column`);
    }
    // And the extractor would flag them: simulate a drifted query.
    const simulated = `sc.from("posts").select("id", { count: "exact", head: true }).eq("post_type", "event").eq("is_verified", true).lte("event_starts_at", now)`;
    const refs = extractColumnRefs(simulated, "posts");
    const flagged = refs.filter((r) => !LIVE_POSTS_COLUMNS.has(r.column)).map((r) => r.column);
    assert.deepEqual(
      flagged.sort(),
      ["event_starts_at", "is_verified", "post_type"],
      "extractor must flag the historical dead columns when present",
    );
  });
});
