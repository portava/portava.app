/**
 * Stamp trigger audit + StampAwardEngine smoke-test.
 *
 * AUDIT: all 17 slugs activated by 0093_activate_stamp_definitions.sql are
 * confirmed wired in the route files below. No slug needs is_active rollback.
 *
 * ┌─────────────────────┬───────────────────────────────────────────────────────┐
 * │ Slug                │ Trigger location & condition                          │
 * ├─────────────────────┼───────────────────────────────────────────────────────┤
 * │ first_post          │ posts.ts fire-and-forget: totalPosts ≥ 1              │
 * │ storyteller         │ posts.ts fire-and-forget: totalPosts ≥ 10             │
 * │ photographer        │ posts.ts fire-and-forget: hasPhoto && photoPosts ≥ 25 │
 * │ city_explorer       │ posts.ts fire-and-forget: distinctCities ≥ 1          │
 * │ globe_trotter       │ posts.ts fire-and-forget: distinctCountries ≥ 5       │
 * │ world_citizen       │ posts.ts fire-and-forget: distinctCountries ≥ 20      │
 * │ community_connector │ follows.ts: callerFollowingCount ≥ 10                 │
 * │ popular_traveler    │ follows.ts: targetFollowerCount ≥ 50                  │
 * │ travel_influencer   │ follows.ts: targetFollowerCount ≥ 500                 │
 * │ trip_planner        │ trips.ts POST /trips: non-draft trip created          │
 * │ good_host           │ trips.ts awardTripCompletionStamps: memberCount ≥ 2   │
 * │ buddy_veteran       │ rentABuddy.ts: completedCount + 1 ≥ 5                 │
 * │ nightlife_guide     │ rentABuddy.ts: bookingCategory === "nightlife"         │
 * │ food_guide          │ rentABuddy.ts: category === "food" | "food_dining"    │
 * │ top_rated_buddy     │ rentABuddy.ts: avgRating ≥ 4.8 && reviewCount ≥ 3    │
 * │ event_host          │ events.ts POST /events/:id/complete: host_id          │
 * │ event_participant   │ events.ts POST /events/:id/complete: checked-in users │
 * └─────────────────────┴───────────────────────────────────────────────────────┘
 *
 * SMOKE-TEST: awardStamp engine called directly with a controlled fake client.
 * Confirms the end-to-end award path (feature-flag → definition lookup →
 * source validation → idempotency → insert → awarded:true) works for first_post.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { awardStamp } from "../services/passport/StampAwardEngine.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const USER_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const POST_ID  = "bbbbbbbb-0000-0000-0000-000000000001";
const DEF_ID   = "cccccccc-0000-0000-0000-000000000001";
const STAMP_ID = "dddddddd-0000-0000-0000-000000000001";

// ── Fake client factory ────────────────────────────────────────────────────────

type FakeFlags = {
  v2Enabled?: boolean;
  stampsEnabled?: boolean;
  definitionActive?: boolean;
  postStatus?: string;
  existingEvent?: boolean;
  existingStamp?: boolean;
};

function makeClient(flags: FakeFlags = {}) {
  const {
    v2Enabled       = true,
    stampsEnabled   = true,
    definitionActive = true,
    postStatus      = "published",
    existingEvent   = false,
    existingStamp   = false,
  } = flags;

  const inserted: { table: string; row: Record<string, unknown> }[] = [];

  function makeBuilder(table: string) {
    let _hasInsert = false;
    let _insertData: Record<string, unknown> = {};
    const _eq: Record<string, unknown> = {};

    const b: any = {
      select(_cols?: string, _opts?: unknown) { return b; },
      eq(col: string, val: unknown)           { _eq[col] = val; return b; },
      not()                                   { return b; },
      is()                                    { return b; },
      in()                                    { return b; },
      upsert()                                { return b; },
      update()                                { return b; },
      insert(row: Record<string, unknown>) {
        _hasInsert = true;
        _insertData = row;
        return b;
      },

      maybeSingle(): Promise<{ data: unknown; error: null }> {
        if (table === "feature_flags") {
          const f = _eq["flag"];
          if (f === "stamp_system_v2_enabled")
            return Promise.resolve({ data: { enabled: v2Enabled }, error: null });
          if (f === "passport_stamps_enabled")
            return Promise.resolve({ data: { enabled: stampsEnabled }, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        if (table === "stamp_definitions") {
          return Promise.resolve({
            data: {
              id: DEF_ID,
              slug: "first_post",
              is_active: definitionActive,
              is_repeatable: false,
              max_awards_per_user: null,
              visibility_default: "public",
              criteria_type: "count",
            },
            error: null,
          });
        }
        if (table === "posts") {
          return Promise.resolve({ data: { status: postStatus }, error: null });
        }
        if (table === "stamp_award_events") {
          return Promise.resolve({
            data: existingEvent ? { id: "evt-1", status: "awarded" } : null,
            error: null,
          });
        }
        if (table === "user_stamps") {
          return Promise.resolve({
            data: existingStamp ? { id: "stmp-existing" } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },

      single(): Promise<{ data: unknown; error: null }> {
        if (table === "user_stamps" && _hasInsert) {
          inserted.push({ table, row: { ..._insertData } });
          return Promise.resolve({ data: { id: STAMP_ID }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },

      then(
        onFulfilled: (v: { data: unknown; error: null; count?: number }) => unknown,
        onRejected: ((e: unknown) => unknown) | undefined,
      ): Promise<unknown> {
        if (table === "stamp_award_events" && _hasInsert) {
          inserted.push({ table, row: { ..._insertData } });
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        }
        return Promise.resolve({ data: null, error: null, count: 0 }).then(onFulfilled, onRejected);
      },

      catch() { return b; },
    };
    return b;
  }

  return { client: { from: makeBuilder } as any, inserted };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("StampAwardEngine — first_post smoke-test", () => {

  it("awards first_post on a user's first post (happy path)", async () => {
    const { client, inserted } = makeClient();

    const result = await awardStamp(client, {
      userId:         USER_ID,
      definitionSlug: "first_post",
      sourceType:     "posts",
      sourceId:       POST_ID,
    });

    assert.equal(result.awarded, true, `expected awarded:true but got reason="${result.reason}"`);
    assert.equal(result.reason, "awarded");
    assert.equal(result.userStampId, STAMP_ID, "userStampId must match the inserted row's id");

    const events = inserted.filter((r) => r.table === "stamp_award_events");
    const stamps  = inserted.filter((r) => r.table === "user_stamps");

    assert.equal(events.length, 1, "one stamp_award_event row must be inserted");
    assert.equal(stamps.length,  1, "one user_stamp row must be inserted");

    assert.equal(events[0].row.status,      "awarded",  "event status must be 'awarded'");
    assert.equal(stamps[0].row.source_type, "posts",    "stamp source_type must be 'posts'");
    assert.equal(stamps[0].row.source_id,   POST_ID,    "stamp source_id must be the post id");
    assert.equal(stamps[0].row.user_id,     USER_ID,    "stamp user_id must match");
    assert.equal(stamps[0].row.is_revoked,  false,      "new stamp must not be revoked");
    assert.equal(stamps[0].row.display_on_passport, true);
  });

  it("is blocked when stamp_system_v2_enabled is false (fail-closed guard)", async () => {
    const { client } = makeClient({ v2Enabled: false });

    const result = await awardStamp(client, {
      userId:         USER_ID,
      definitionSlug: "first_post",
      sourceType:     "posts",
      sourceId:       POST_ID,
    });

    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "feature_disabled",
      "must return feature_disabled when stamp_system_v2_enabled is false");
  });

  it("is blocked when definition.is_active is false", async () => {
    const { client } = makeClient({ definitionActive: false });

    const result = await awardStamp(client, {
      userId:         USER_ID,
      definitionSlug: "first_post",
      sourceType:     "posts",
      sourceId:       POST_ID,
    });

    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "definition_inactive");
  });

  it("is blocked when the source post has status 'deleted' (source validation)", async () => {
    const { client } = makeClient({ postStatus: "deleted" });

    const result = await awardStamp(client, {
      userId:         USER_ID,
      definitionSlug: "first_post",
      sourceType:     "posts",
      sourceId:       POST_ID,
    });

    assert.equal(result.awarded, false);
    assert.ok(
      result.reason.startsWith("source_invalid_status"),
      `expected source_invalid_status:… but got "${result.reason}"`,
    );
  });

  it("is blocked when the stamp is already earned (already_earned guard)", async () => {
    const { client, inserted } = makeClient({ existingStamp: true });

    const result = await awardStamp(client, {
      userId:         USER_ID,
      definitionSlug: "first_post",
      sourceType:     "posts",
      sourceId:       POST_ID,
    });

    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "already_earned");
    assert.equal(inserted.length, 0, "no rows must be inserted when stamp is already earned");
  });

  it("is blocked when the idempotency event already exists (already_awarded guard)", async () => {
    // existingEvent=true + existingStamp=true so the engine does not fall into the
    // skipToStampInsert healing path (that path fires when the stamp row is MISSING).
    const { client, inserted } = makeClient({ existingEvent: true, existingStamp: true });

    const result = await awardStamp(client, {
      userId:         USER_ID,
      definitionSlug: "first_post",
      sourceType:     "posts",
      sourceId:       POST_ID,
    });

    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "already_awarded");
    assert.equal(inserted.length, 0, "no rows must be inserted on a duplicate call");
  });

});
