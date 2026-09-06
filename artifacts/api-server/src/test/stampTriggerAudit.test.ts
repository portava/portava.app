/**
 * Stamp trigger audit — three independent test suites.
 *
 * SUITE 1 — Static slug audit (executable trace of all 17 slugs from
 *   0093_activate_stamp_definitions.sql).
 *   Reads the real route source files, strips comments, and asserts that
 *   every activated slug appears as a string literal in an awardStamp call
 *   context.  If any slug is missing, the test fails and prints the exact
 *   UPDATE statement needed to roll it back to is_active=false.
 *
 * SUITE 2 — Route-trigger tests for the post-creation stamp path.
 *   Calls awardSocialPostStamps() — the function extracted directly from the
 *   POST /posts fire-and-forget block — with a controlled fake Supabase client.
 *   This exercises the same code that runs in the route without needing a live
 *   database or HTTP server.
 *
 * SUITE 3 — StampAwardEngine unit tests.
 *   Direct calls to awardStamp() exercising the engine's guard conditions
 *   (fail-closed flag, inactive definition, source validation, idempotency).
 *
 * Run: node --import tsx/esm --test src/test/stampTriggerAudit.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { awardSocialPostStamps } from "../routes/posts.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const USER_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const POST_ID  = "bbbbbbbb-0000-0000-0000-000000000001";
const DEF_ID   = "cccccccc-0000-0000-0000-000000000001";
const STAMP_ID = "dddddddd-0000-0000-0000-000000000001";

// ── SUITE 1: Static slug audit ─────────────────────────────────────────────────

describe("Stamp trigger audit — all 16 active slugs from 0093", () => {

  const ROUTE_FILES = [
    resolve("src/routes/posts.ts"),
    resolve("src/routes/follows.ts"),
    resolve("src/routes/trips.ts"),
    resolve("src/routes/rentABuddy.ts"),
    resolve("src/routes/events.ts"),
  ];

  const ACTIVATED_SLUGS = [
    // Post & social stamps (posts.ts)
    "first_post", "storyteller", "photographer",
    // Location milestone stamps (posts.ts — globe_trotter retired; globe_trotter_5/10 via criteria-engine)
    "city_explorer", "world_citizen",
    // Social follow-count stamps (follows.ts)
    "community_connector", "popular_traveler", "travel_influencer",
    // Trip outcome stamps (trips.ts)
    "trip_planner", "good_host",
    // Rent-a-Buddy progression stamps (rentABuddy.ts)
    "buddy_veteran", "nightlife_guide", "food_guide", "top_rated_buddy",
    // Event stamps (events.ts)
    "event_host", "event_participant",
  ] as const;

  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
  }

  const codeSource = ROUTE_FILES.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");

  function computeRollbackList(): string[] {
    return ACTIVATED_SLUGS.filter((slug) => !codeSource.includes(`"${slug}"`));
  }

  it("all 16 active slugs appear as string literals in the route files", () => {
    const unwired = computeRollbackList();
    assert.deepEqual(
      unwired, [],
      `The following slugs have NO awardStamp trigger and must be deactivated:\n` +
      `  UPDATE stamp_definitions SET is_active=false, updated_at=now()\n` +
      `  WHERE slug IN (${unwired.map((s) => `'${s}'`).join(", ")});\n` +
      `Add the trigger in the appropriate route file or run the UPDATE above.`,
    );
  });

  it("rollback list is empty — zero active slugs need is_active=false", () => {
    const needsRollback = computeRollbackList();
    assert.equal(
      needsRollback.length, 0,
      `${needsRollback.length} slug(s) unwired: ${needsRollback.join(", ")}`,
    );
  });

  it("each slug string appears in its expected route file", () => {
    const byFile: Record<string, string[]> = {
      // globe_trotter retired from direct trigger; globe_trotter_5/10 now via criteria-engine
      "posts.ts":       ["first_post", "storyteller", "photographer", "city_explorer", "world_citizen"],
      "follows.ts":     ["community_connector", "popular_traveler", "travel_influencer"],
      "trips.ts":       ["trip_planner", "good_host"],
      "rentABuddy.ts":  ["buddy_veteran", "nightlife_guide", "food_guide", "top_rated_buddy"],
      "events.ts":      ["event_host", "event_participant"],
    };

    for (const [fileName, slugs] of Object.entries(byFile)) {
      const filePath = ROUTE_FILES.find((f) => f.endsWith(fileName))!;
      const src = stripComments(readFileSync(filePath, "utf8"));
      for (const slug of slugs) {
        assert.ok(
          src.includes(`"${slug}"`),
          `"${slug}" not found in ${fileName} — either the trigger was removed ` +
          `or the slug was renamed. Fix the trigger or roll back is_active.`,
        );
      }
    }
  });
});

// ── SUITE 2: Route-trigger tests via awardSocialPostStamps ────────────────────

describe("Route trigger — awardSocialPostStamps (post-creation stamp path)", () => {

  function makeRouteClient(opts: {
    totalPosts?: number;
    photoPosts?: number;
    defId?: string;
    v2FlagEnabled?: boolean;
  } = {}) {
    const { totalPosts = 0, photoPosts = 0, defId = DEF_ID, v2FlagEnabled = true } = opts;
    const inserted: { table: string; row: Record<string, unknown> }[] = [];

    function makeBuilder(table: string) {
      let _countMode = false;
      let _hasNot    = false;
      let _hasInsert = false;
      let _insertData: Record<string, unknown> = {};
      const _eq: Record<string, unknown> = {};

      const b: any = {
        select(_cols?: string, o?: { count?: string; head?: boolean }) {
          if (o?.count === "exact" && o?.head === true) _countMode = true;
          return b;
        },
        eq(col: string, val: unknown)  { _eq[col] = val; return b; },
        not()                          { _hasNot = true; return b; },
        is()                           { return b; },
        in()                           { return b; },
        upsert()                       { return b; },
        update()                       { return b; },
        insert(row: Record<string, unknown>) {
          _hasInsert = true;
          _insertData = row;
          return b;
        },

        maybeSingle(): Promise<any> {
          if (table === "feature_flags") {
            const f = _eq["flag"];
            if (f === "stamp_system_v2_enabled")
              return v2FlagEnabled
                ? Promise.resolve({ data: { enabled: true }, error: null })
                : Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: { enabled: true }, error: null });
          }
          if (table === "stamp_definitions") {
            const slug = _eq["slug"] as string;
            return Promise.resolve({
              data: {
                id: defId,
                slug,
                is_active: true,
                is_repeatable: false,
                max_awards_per_user: null,
                visibility_default: "public",
                criteria_type: "count",
              },
              error: null,
            });
          }
          if (table === "posts") {
            // "active" — the real live label of the post_status enum. This
            // fixture said "published", which no row can hold.
            return Promise.resolve({ data: { status: "active" }, error: null });
          }
          if (table === "stamp_award_events") {
            return Promise.resolve({ data: null, error: null });
          }
          if (table === "user_stamps") {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },

        single(): Promise<any> {
          if (table === "user_stamps" && _hasInsert) {
            inserted.push({ table, row: { ..._insertData } });
            return Promise.resolve({ data: { id: STAMP_ID }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },

        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown): Promise<unknown> {
          if (_countMode && table === "posts") {
            const count = _hasNot ? photoPosts : totalPosts;
            return Promise.resolve({ data: null, error: null, count }).then(onF, onR);
          }
          if (_hasInsert && table === "stamp_award_events") {
            inserted.push({ table, row: { ..._insertData } });
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: null, error: null, count: 0 }).then(onF, onR);
        },

        catch() { return b; },
      };
      return b;
    }

    return { client: { from: makeBuilder } as any, inserted };
  }

  it("awards first_post when the user has published their first post", async () => {
    const { client, inserted } = makeRouteClient({ totalPosts: 1, photoPosts: 0 });

    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, false);

    assert.deepEqual(awarded, ["first_post"], "only first_post should be awarded at count=1");

    const events = inserted.filter((r) => r.table === "stamp_award_events");
    const stamps  = inserted.filter((r) => r.table === "user_stamps");
    assert.equal(events.length, 1, "one stamp_award_event row must be inserted");
    assert.equal(stamps.length,  1, "one user_stamp row must be inserted");
    assert.equal(events[0].row.status,      "awarded", "event status must be 'awarded'");
    assert.equal(stamps[0].row.source_type, "posts",   "stamp source_type must be 'posts'");
    assert.equal(stamps[0].row.source_id,   POST_ID,   "stamp source_id must be the post id");
    assert.equal(stamps[0].row.user_id,     USER_ID);
    assert.equal(stamps[0].row.is_revoked,  false);
  });

  it("does NOT award storyteller at 9 posts", async () => {
    const { client } = makeRouteClient({ totalPosts: 9 });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, false);
    assert.ok(!awarded.includes("storyteller"), "storyteller must NOT be awarded at 9 posts");
  });

  it("awards storyteller at exactly 10 posts", async () => {
    const { client } = makeRouteClient({ totalPosts: 10 });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, false);
    assert.ok(awarded.includes("storyteller"), "storyteller must be awarded at 10 posts");
    assert.ok(awarded.includes("first_post"),  "first_post also awarded at 10 posts");
  });

  it("does NOT award photographer when hasPhoto is false (even if photo count qualifies)", async () => {
    const { client } = makeRouteClient({ totalPosts: 25, photoPosts: 25 });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, false);
    assert.ok(!awarded.includes("photographer"), "photographer requires hasPhoto=true");
  });

  it("does NOT award photographer when photo post count is below 25", async () => {
    const { client } = makeRouteClient({ totalPosts: 30, photoPosts: 24 });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, true);
    assert.ok(!awarded.includes("photographer"), "photographer requires 25 photo posts");
  });

  it("awards photographer when hasPhoto=true and photo post count reaches 25", async () => {
    const { client } = makeRouteClient({ totalPosts: 30, photoPosts: 25 });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, true);
    assert.ok(awarded.includes("photographer"), "photographer must be awarded at 25 photo posts");
  });

  it("awards all three slugs simultaneously at 10 posts and 25 photo posts", async () => {
    const { client, inserted } = makeRouteClient({ totalPosts: 10, photoPosts: 25 });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, true);
    assert.deepEqual(
      [...awarded].sort(),
      ["first_post", "photographer", "storyteller"],
      "all three stamps must be awarded when thresholds are all met",
    );
    assert.equal(
      inserted.filter((r) => r.table === "stamp_award_events").length, 3,
      "three stamp_award_event rows inserted",
    );
    assert.equal(
      inserted.filter((r) => r.table === "user_stamps").length, 3,
      "three user_stamp rows inserted",
    );
  });

  it("returns empty list when stamp_system_v2_enabled is absent (fail-closed)", async () => {
    const { client } = makeRouteClient({ totalPosts: 5, v2FlagEnabled: false });
    const awarded = await awardSocialPostStamps(client, USER_ID, POST_ID, false);
    assert.deepEqual(awarded, [], "no stamps if feature flag row is absent (fail-closed)");
  });
});

// ── SUITE 3: StampAwardEngine unit tests ──────────────────────────────────────

describe("StampAwardEngine — first_post engine guard conditions", () => {

  function makeEngineClient(flags: {
    v2Enabled?: boolean;
    definitionActive?: boolean;
    postStatus?: string;
    existingEvent?: boolean;
    existingStamp?: boolean;
  } = {}) {
    const {
      v2Enabled        = true,
      definitionActive = true,
      // `post_status` is active | hidden | reported | deleted (baseline enum).
      // The default here used to be "published", which no row can ever hold —
      // the happy path passed for the wrong reason. "active" is the live label.
      postStatus       = "active",
      existingEvent    = false,
      existingStamp    = false,
    } = flags;

    const inserted: { table: string; row: Record<string, unknown> }[] = [];

    function makeBuilder(table: string) {
      let _hasInsert = false;
      let _insertData: Record<string, unknown> = {};
      const _eq: Record<string, unknown> = {};

      const b: any = {
        select()                       { return b; },
        eq(col: string, val: unknown)  { _eq[col] = val; return b; },
        not()                          { return b; },
        is()                           { return b; },
        in()                           { return b; },
        upsert()                       { return b; },
        update()                       { return b; },
        insert(row: Record<string, unknown>) {
          _hasInsert = true;
          _insertData = row;
          return b;
        },

        maybeSingle(): Promise<any> {
          if (table === "feature_flags") {
            const f = _eq["flag"];
            if (f === "stamp_system_v2_enabled")
              return Promise.resolve({ data: { enabled: v2Enabled }, error: null });
            return Promise.resolve({ data: { enabled: true }, error: null });
          }
          if (table === "stamp_definitions")
            return Promise.resolve({
              data: {
                id: DEF_ID, slug: "first_post",
                is_active: definitionActive,
                is_repeatable: false, max_awards_per_user: null,
                visibility_default: "public", criteria_type: "count",
              },
              error: null,
            });
          if (table === "posts")
            return Promise.resolve({ data: { status: postStatus }, error: null });
          if (table === "stamp_award_events")
            return Promise.resolve({
              data: existingEvent ? { id: "evt-1", status: "awarded" } : null,
              error: null,
            });
          if (table === "user_stamps")
            return Promise.resolve({
              data: existingStamp ? { id: "stmp-existing" } : null,
              error: null,
            });
          return Promise.resolve({ data: null, error: null });
        },

        single(): Promise<any> {
          if (table === "user_stamps" && _hasInsert) {
            inserted.push({ table, row: { ..._insertData } });
            return Promise.resolve({ data: { id: STAMP_ID }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },

        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown): Promise<unknown> {
          if (_hasInsert && table === "stamp_award_events") {
            inserted.push({ table, row: { ..._insertData } });
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: null, error: null, count: 0 }).then(onF, onR);
        },

        catch() { return b; },
      };
      return b;
    }

    return { client: { from: makeBuilder } as any, inserted };
  }

  it("awards first_post on the happy path", async () => {
    const { client, inserted } = makeEngineClient();
    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: "first_post",
      sourceType: "posts", sourceId: POST_ID,
    });

    assert.equal(result.awarded,     true,     `expected awarded:true but got "${result.reason}"`);
    assert.equal(result.reason,      "awarded");
    assert.equal(result.userStampId, STAMP_ID);
    assert.equal(inserted.filter((r) => r.table === "stamp_award_events").length, 1);
    assert.equal(inserted.filter((r) => r.table === "user_stamps").length,        1);
  });

  it("is blocked when stamp_system_v2_enabled is false (fail-closed guard)", async () => {
    const { client } = makeEngineClient({ v2Enabled: false });
    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: "first_post",
      sourceType: "posts", sourceId: POST_ID,
    });
    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "feature_disabled");
  });

  it("is blocked when definition.is_active is false", async () => {
    const { client } = makeEngineClient({ definitionActive: false });
    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: "first_post",
      sourceType: "posts", sourceId: POST_ID,
    });
    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "definition_inactive");
  });

  it("is blocked when the source post has a deleted status", async () => {
    const { client } = makeEngineClient({ postStatus: "deleted" });
    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: "first_post",
      sourceType: "posts", sourceId: POST_ID,
    });
    assert.equal(result.awarded, false);
    assert.ok(result.reason.startsWith("source_invalid_status"));
  });

  it("is blocked when the stamp is already earned (already_earned guard)", async () => {
    const { client, inserted } = makeEngineClient({ existingStamp: true });
    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: "first_post",
      sourceType: "posts", sourceId: POST_ID,
    });
    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "already_earned");
    assert.equal(inserted.length, 0, "no rows inserted when already earned");
  });

  it("is blocked on duplicate call via idempotency key (already_awarded guard)", async () => {
    const { client, inserted } = makeEngineClient({ existingEvent: true, existingStamp: true });
    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: "first_post",
      sourceType: "posts", sourceId: POST_ID,
    });
    assert.equal(result.awarded, false);
    assert.equal(result.reason,  "already_awarded");
    assert.equal(inserted.length, 0, "no rows inserted on duplicate call");
  });
});
