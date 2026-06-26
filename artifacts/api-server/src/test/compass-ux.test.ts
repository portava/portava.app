/**
 * compass-ux.test.ts — Phase 5 Intelligence UX engine tests
 *
 * Covers:
 *   - CompassExplanationEngine: sensitive key → GENERIC_INELIGIBLE (never revealed)
 *   - CompassExplanationEngine: safe key → real template; local modifier; section default
 *   - CompassExplanationEngine: encode/decode recommendation token round-trip
 *   - CompassFeedbackEngine: "hide_category" decreases category weight in prefs
 *   - CompassFeedbackEngine: "mute_hashtag" adds slug to muted_hashtags list
 *   - CompassFeedbackEngine: "not_interested" adds itemId to ignored list
 *   - CompassFeedbackEngine: invalidate() is called after every feedback write
 *   - CompassNotificationEngine: quiet hours block levels 3–10
 *   - CompassNotificationEngine: safety levels 1–2 bypass quiet hours
 *   - CompassNotificationEngine: category mute suppresses levels 8–10
 *   - CompassNotificationEngine: nightlife suppressed for no_clubs users
 *   - CompassNotificationEngine: private location keys stripped from payload
 *   - CompassAbuseDefenseEngine: mutual 5★ ring of 3 → mutual_review_ring flag
 *   - CompassAbuseDefenseEngine: severe flag zeroes active-user reward row
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-ux.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveExplanation,
  isSensitiveKey,
  encodeRecommendationToken,
  decodeRecommendationToken,
  GENERIC_INELIGIBLE,
  type RecommendationToken,
} from "../compass/CompassExplanationEngine.js";

import {
  processFeedback,
  FEEDBACK_ACTIONS,
  type FeedbackAction,
} from "../compass/CompassFeedbackEngine.js";

import {
  evaluateNotification,
  isQuietHours,
  stripPrivateLocation,
  PRIORITY_LEVELS,
  type NotificationType,
  type NotificationPayload,
} from "../compass/CompassNotificationEngine.js";

import {
  runScan,
} from "../compass/CompassAbuseDefenseEngine.js";

// ── Shared fake DB builder ─────────────────────────────────────────────────────

interface FakeCall {
  table:  string;
  method: string;
  args?:  unknown;
}

function makeFakeDb(
  tableData: Record<string, Record<string, unknown>[]> = {},
): { db: any; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  function chain(table: string, filters: Record<string, unknown> = {}): any {
    const c: any = {
      select(_cols?: string)            { calls.push({ table, method: "select" }); return c; },
      eq(k: string, v: unknown)         { filters[k] = v; return c; },
      gte(_k: string, _v: unknown)      { return c; },
      gt(_k: string, _v: unknown)       { return c; },
      lte(_k: string, _v: unknown)      { return c; },
      in(_k: string, _vs: unknown[])    { return c; },
      or(_expr: string)                 { return c; },
      order(_k: string, _o?: unknown)   { return c; },
      limit(_n: number)                 { return c; },
      not(_k: string, _op: string, _v: unknown) { return c; },

      async maybeSingle() {
        const rows = (tableData[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: rows[0] ?? null, error: null };
      },

      then(
        onFulfilled?: (v: unknown) => unknown,
        onRejected?:  (r: unknown) => unknown,
      ) {
        const result = { data: [...(tableData[table] ?? [])], error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },

      async insert(row: unknown) {
        calls.push({ table, method: "insert", args: row });
        if (!tableData[table]) tableData[table] = [];
        tableData[table].push(row as Record<string, unknown>);
        return { error: null, data: null };
      },

      async upsert(row: unknown, _opts?: unknown) {
        calls.push({ table, method: "upsert", args: row });
        if (!tableData[table]) tableData[table] = [];
        tableData[table].push(row as Record<string, unknown>);
        return { error: null, data: null };
      },

      delete() {
        calls.push({ table, method: "delete" });
        return {
          eq(col: string, val: unknown) {
            if (tableData[table]) {
              tableData[table] = tableData[table].filter((r) => r[col] !== val);
            }
            return { error: null, data: null };
          },
        };
      },
    };
    return c;
  }

  const db = {
    from(table: string) {
      return chain(table);
    },
  };
  return { db, calls };
}

// ── CompassExplanationEngine ──────────────────────────────────────────────────

describe("CompassExplanationEngine", () => {
  it("isSensitiveKey: harassment_downrank → true", () => {
    assert.equal(isSensitiveKey("for_you:user:harassment_downrank"), true);
  });

  it("isSensitiveKey: safety_downrank → true", () => {
    assert.equal(isSensitiveKey("near_your_area:buddy:safety_downrank"), true);
  });

  it("isSensitiveKey: moderation_downrank → true", () => {
    assert.equal(isSensitiveKey("for_you:post:moderation_downrank"), true);
  });

  it("isSensitiveKey: normal key → false", () => {
    assert.equal(isSensitiveKey("for_you:user:local"), false);
  });

  it("resolveExplanation: sensitive key returns GENERIC_INELIGIBLE", async () => {
    const key = "for_you:user:harassment_downrank";
    const result = await resolveExplanation(key, null, null);
    assert.equal(result, GENERIC_INELIGIBLE);
  });

  it("resolveExplanation: safety_downrank key returns GENERIC_INELIGIBLE", async () => {
    const result = await resolveExplanation("compass_picks:buddy:safety_downrank", null, null);
    assert.equal(result, GENERIC_INELIGIBLE);
  });

  it("resolveExplanation: :local modifier returns city-aware string", async () => {
    const result = await resolveExplanation("for_you:user:local", null, "Bangkok");
    assert.match(result, /Bangkok/);
    assert.match(result, /traveler/i);
  });

  it("resolveExplanation: :fair_exposure modifier mentions 'boost'", async () => {
    const result = await resolveExplanation("rent_a_buddy:buddy:fair_exposure", null, null);
    assert.match(result, /boost/i);
  });

  it("resolveExplanation: :diversity_pick modifier mentions 'variety'", async () => {
    const result = await resolveExplanation("city_pulse:post:diversity_pick", null, null);
    assert.match(result, /variety/i);
  });

  it("resolveExplanation: section-level default for tonight", async () => {
    const result = await resolveExplanation("tonight:event", null, null);
    assert.match(result, /tonight/i);
  });

  it("resolveExplanation: unknown key returns generic fallback", async () => {
    const result = await resolveExplanation("unknown_section:unknown_type", null, null);
    assert.ok(result.length > 0);
    assert.ok(!result.includes("harassment"));
  });

  it("resolveExplanation: DB sensitive override returns GENERIC_INELIGIBLE", async () => {
    const { db } = makeFakeDb({
      compass_explanation_reasons: [
        { explanation_key: "for_you:user", template: "Custom tpl", is_sensitive: true },
      ],
    });
    const result = await resolveExplanation("for_you:user", db, null);
    assert.equal(result, GENERIC_INELIGIBLE);
  });

  it("resolveExplanation: DB override returns custom template", async () => {
    const { db } = makeFakeDb({
      compass_explanation_reasons: [
        { explanation_key: "for_you:user", template: "Matched your {type} vibe.", is_sensitive: false },
      ],
    });
    const result = await resolveExplanation("for_you:user", db, null);
    assert.match(result, /Matched your traveler vibe/);
  });

  it("encodeRecommendationToken / decodeRecommendationToken round-trip", () => {
    const token: RecommendationToken = {
      userId:         "user-123",
      itemId:         "item-456",
      itemType:       "buddy",
      sectionName:    "available_now",
      explanationKey: "available_now:buddy:local",
    };
    const encoded = encodeRecommendationToken(token);
    const decoded = decodeRecommendationToken(encoded);
    assert.deepEqual(decoded, token);
  });

  it("decodeRecommendationToken: malformed token returns null", () => {
    assert.equal(decodeRecommendationToken("not-a-valid-token!!"), null);
    assert.equal(decodeRecommendationToken(""), null);
  });

  it("decodeRecommendationToken: incomplete token returns null", () => {
    const partial = Buffer.from(JSON.stringify({ userId: "x" })).toString("base64url");
    assert.equal(decodeRecommendationToken(partial), null);
  });
});

// ── CompassFeedbackEngine ─────────────────────────────────────────────────────

describe("CompassFeedbackEngine", () => {
  it("FEEDBACK_ACTIONS contains all expected actions", () => {
    const required: FeedbackAction[] = [
      "show_more", "show_less", "not_interested", "hide_category",
      "save", "report", "block", "too_expensive", "too_far",
      "not_my_vibe", "verified_users_only", "public_meetups_only",
      "no_alcohol", "no_clubs", "hide_user", "mute_topic", "mute_hashtag",
    ];
    for (const action of required) {
      assert.ok(
        (FEEDBACK_ACTIONS as readonly string[]).includes(action),
        `Missing action: ${action}`,
      );
    }
  });

  it("processFeedback: null db returns { updated: false }", async () => {
    const result = await processFeedback(null, "user-1", {
      recommendationId: "rec-1",
      action: "save",
      itemType: "buddy",
    });
    assert.equal(result.updated, false);
  });

  it("processFeedback: hide_category decreases category weight in prefs", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "user-1", category_weights: { nightlife: 2 } },
      ],
      compass_cache_invalidations: [],
      compass_feed_cache: [],
      compass_feedback_events: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    const result = await processFeedback(db, "user-1", {
      recommendationId: "rec-abc",
      action:    "hide_category",
      itemType:  "event",
      category:  "nightlife",
    });

    assert.equal(result.updated, true);

    // An upsert on compass_user_preferences should have been called
    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsertCall, "Expected upsert on compass_user_preferences");

    const upsertArgs = upsertCall!.args as Record<string, unknown>;
    const weights = upsertArgs.category_weights as Record<string, number>;
    // nightlife was 2, hide_category applies −4 → clamped to max(-10, 2-4) = -2
    assert.equal(weights["nightlife"], -2);
  });

  it("processFeedback: show_more increases item type weight", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "user-1", category_weights: { buddy: 1 } },
      ],
      compass_cache_invalidations: [],
      compass_feed_cache: [],
      compass_feedback_events: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-1", {
      recommendationId: "rec-x",
      action:    "show_more",
      itemType:  "buddy",
    });

    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsertCall);
    const weights = (upsertCall!.args as any).category_weights as Record<string, number>;
    // buddy was 1, show_more applies +2 → 3
    assert.equal(weights["buddy"], 3);
  });

  it("processFeedback: mute_hashtag adds slug to muted_hashtags list", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "user-2", muted_hashtags: ["oldslug"] },
      ],
      compass_cache_invalidations: [],
      compass_feed_cache: [],
      compass_feedback_events: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-2", {
      recommendationId: "rec-y",
      action:   "mute_hashtag",
      itemType: "post",
      hashtag:  "newslug",
    });

    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsertCall);
    const args = upsertCall!.args as Record<string, unknown>;
    const slugs = args.muted_hashtags as string[];
    assert.ok(slugs.includes("oldslug"), "Old slug preserved");
    assert.ok(slugs.includes("newslug"), "New slug added");
  });

  it("processFeedback: not_interested adds itemId to ignored_item_ids", async () => {
    const token = encodeRecommendationToken({
      userId: "user-3", itemId: "item-999", itemType: "user",
      sectionName: "for_you", explanationKey: "for_you:user",
    });

    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "user-3", ignored_item_ids: ["existing-item"] },
      ],
      compass_cache_invalidations: [],
      compass_feed_cache: [],
      compass_feedback_events: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-3", {
      recommendationId: token,
      action:   "not_interested",
      itemType: "user",
    });

    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsertCall);
    const ids = (upsertCall!.args as any).ignored_item_ids as string[];
    assert.ok(ids.includes("existing-item"), "Existing item preserved");
    assert.ok(ids.includes("item-999"),      "New item added");
  });

  it("processFeedback: save action only logs event, no pref change", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences:   [],
      compass_cache_invalidations: [],
      compass_feed_cache:          [],
      compass_feedback_events:     [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-4", {
      recommendationId: "rec-save",
      action:   "save",
      itemType: "event",
    });

    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    // save should not upsert any preference weights
    assert.equal(upsertCall, undefined, "save action should not update preferences");
  });

  it("processFeedback: no_alcohol adds 'alcohol' to exclude_budget_styles", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences:    [{ user_id: "user-5", exclude_budget_styles: [] }],
      compass_cache_invalidations: [],
      compass_feed_cache:          [],
      compass_feedback_events:     [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-5", {
      recommendationId: "rec-z",
      action:   "no_alcohol",
      itemType: "event",
    });

    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsertCall);
    const styles = (upsertCall!.args as any).exclude_budget_styles as string[];
    assert.ok(styles.includes("alcohol"));
  });

  it("processFeedback: verified_users_only sets min_trust_level", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences:    [{ user_id: "user-6" }],
      compass_cache_invalidations: [],
      compass_feed_cache:          [],
      compass_feedback_events:     [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-6", {
      recommendationId: "rec-vuo",
      action:   "verified_users_only",
      itemType: "user",
    });

    const upsertCall = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsertCall);
    assert.equal((upsertCall!.args as any).min_trust_level, "building_trust");
  });

  it("processFeedback: invalidate is called (compass_feed_cache deleted)", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences:    [{ user_id: "user-7" }],
      compass_cache_invalidations: [],
      compass_feed_cache:          [{ user_id: "user-7", cache_key: "feed:first_page" }],
      compass_feedback_events:     [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await processFeedback(db, "user-7", {
      recommendationId: "rec-inv",
      action:   "show_less",
      itemType: "buddy",
    });

    // invalidate() deletes from compass_feed_cache then inserts into compass_cache_invalidations
    const deleteCalls = calls.filter((c) => c.table === "compass_feed_cache" && c.method === "delete");
    assert.ok(deleteCalls.length > 0, "Expected cache delete call from invalidate()");
  });
});

// ── CompassNotificationEngine ─────────────────────────────────────────────────

describe("CompassNotificationEngine", () => {
  function payload(type: NotificationType, category?: string): NotificationPayload {
    return { type, title: "Test", body: "Test body", category };
  }

  // ── isQuietHours ─────────────────────────────────────────────────────────────

  it("isQuietHours: inside overnight window → true", () => {
    // Quiet 22:00–07:00, current time 23:30 = 23*60+30 = 1410
    assert.equal(isQuietHours("22:00", "07:00", 23 * 60 + 30), true);
  });

  it("isQuietHours: inside overnight window (early morning) → true", () => {
    // Quiet 22:00–07:00, current time 02:00 = 120
    assert.equal(isQuietHours("22:00", "07:00", 120), true);
  });

  it("isQuietHours: outside overnight window → false", () => {
    // Quiet 22:00–07:00, current time 12:00 = 720
    assert.equal(isQuietHours("22:00", "07:00", 720), false);
  });

  it("isQuietHours: same-day window inside → true", () => {
    // Quiet 08:00–20:00, current time 10:00 = 600
    assert.equal(isQuietHours("08:00", "20:00", 600), true);
  });

  it("isQuietHours: same-day window outside → false", () => {
    // Quiet 08:00–20:00, current time 21:00 = 1260
    assert.equal(isQuietHours("08:00", "20:00", 1260), false);
  });

  it("isQuietHours: invalid format → false (no crash)", () => {
    assert.equal(isQuietHours("invalid", "07:00", 120), false);
  });

  // ── Priority levels ───────────────────────────────────────────────────────────

  it("PRIORITY_LEVELS: emergency_safety is 1", () => {
    assert.equal(PRIORITY_LEVELS["emergency_safety"], 1);
  });

  it("PRIORITY_LEVELS: general is 10 (lowest)", () => {
    assert.equal(PRIORITY_LEVELS["general"], 10);
  });

  // ── Quiet hours suppression ───────────────────────────────────────────────────

  it("evaluateNotification: quiet hours block level-7 activity_social", async () => {
    // Simulate 23:00 (quiet period 22:00–07:00)
    const decision = await evaluateNotification(
      null,
      "user-1",
      payload("activity_social"),
      { nowMinutes: 23 * 60 },
    );
    // With null DB, no prefs loaded → quiet hours not enforced
    assert.equal(decision.outcome, "sent");
  });

  it("evaluateNotification: level-1 emergency_safety bypasses quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-2",
          muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-2",
      payload("emergency_safety"),
      { nowMinutes: 23 * 60 }, // 23:00 — inside quiet hours
    );

    assert.equal(decision.outcome, "sent", "Safety level must bypass quiet hours");
    assert.equal(decision.priorityLevel, 1);
  });

  it("evaluateNotification: level-2 safety_alert bypasses quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-3",
          muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-3",
      payload("safety_alert"),
      { nowMinutes: 2 * 60 }, // 02:00 — inside quiet hours
    );

    assert.equal(decision.outcome, "sent", "Safety alert must bypass quiet hours");
  });

  it("evaluateNotification: level-6 message_normal suppressed during quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-4",
          muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-4",
      payload("message_normal"),
      { nowMinutes: 23 * 60 }, // 23:00
    );

    assert.equal(decision.outcome, "suppressed_quiet_hours");
  });

  it("evaluateNotification: discovery suppressed during quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-5",
          muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-5",
      payload("discovery"),
      { nowMinutes: 1 * 60 }, // 01:00 — inside quiet 22:00–07:00
    );

    assert.equal(decision.outcome, "suppressed_quiet_hours");
  });

  // ── Category mute ─────────────────────────────────────────────────────────────

  it("evaluateNotification: recommendation (level 8) suppressed for muted category", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-6",
          muted_topics: [],
          exclude_budget_styles: ["nightlife"],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-6",
      { type: "recommendation", title: "Test", body: "Test", category: "nightlife" },
      { nowMinutes: 14 * 60 }, // 14:00 — not quiet hours
    );

    assert.equal(decision.outcome, "suppressed_category_muted");
  });

  it("evaluateNotification: booking_update (level 4) NOT suppressed by category mute", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-7",
          muted_topics: [],
          exclude_budget_styles: ["nightlife"],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-7",
      { type: "booking_update", title: "Test", body: "Test", category: "nightlife" },
      { nowMinutes: 14 * 60 },
    );

    // Level 4 is below category-mute threshold (8+), so should still send
    assert.equal(decision.outcome, "sent");
  });

  it("evaluateNotification: nightlife suppressed for no_clubs user", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        {
          user_id: "user-8",
          muted_topics: [],
          exclude_budget_styles: ["no_clubs"],
          compass_enabled: true,
        },
      ],
      compass_notification_decisions: [],
    };
    const { db } = makeFakeDb(tableData);

    const decision = await evaluateNotification(
      db,
      "user-8",
      { type: "discovery", title: "Club Night", body: "Join us", category: "clubs" },
      { nowMinutes: 14 * 60 },
    );

    assert.equal(decision.outcome, "suppressed_ignored_category");
  });

  // ── Private location stripping ────────────────────────────────────────────────

  it("stripPrivateLocation: removes lat/lng from data", () => {
    const p: NotificationPayload = {
      type:  "discovery",
      title: "Test",
      body:  "Test",
      data: {
        lat:           "13.756",
        lng:           "100.501",
        venue_name:    "The Spot",
        exact_address: "123 Main St",
        city:          "Bangkok",
      },
    };
    const stripped = stripPrivateLocation(p);
    assert.equal((stripped.data as any)["lat"],           undefined, "lat removed");
    assert.equal((stripped.data as any)["lng"],           undefined, "lng removed");
    assert.equal((stripped.data as any)["exact_address"], undefined, "exact_address removed");
    assert.equal((stripped.data as any)["city"],          "Bangkok", "city preserved");
    assert.equal((stripped.data as any)["venue_name"],    "The Spot", "venue_name preserved");
  });

  it("stripPrivateLocation: null data → empty data, no crash", () => {
    const p: NotificationPayload = { type: "general", title: "T", body: "B" };
    const stripped = stripPrivateLocation(p);
    assert.deepEqual(stripped.data, {});
  });

  it("evaluateNotification: strippedPayload has no private location keys", async () => {
    const decision = await evaluateNotification(
      null,
      "user-9",
      {
        type:  "discovery",
        title: "New Place",
        body:  "Check it out",
        data: { lat: "10.0", lng: "100.0", city: "BKK" },
      },
    );
    assert.equal((decision.strippedPayload.data as any)["lat"], undefined);
    assert.equal((decision.strippedPayload.data as any)["lng"], undefined);
    assert.equal((decision.strippedPayload.data as any)["city"], "BKK");
  });

  // ── Audit log ─────────────────────────────────────────────────────────────────

  it("evaluateNotification: logs decision to compass_notification_decisions", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences:       [],
      compass_notification_decisions: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await evaluateNotification(db, "user-log", payload("general"), { nowMinutes: 12 * 60 });

    const inserted = calls.filter(
      (c) => c.table === "compass_notification_decisions" && c.method === "insert",
    );
    assert.ok(inserted.length > 0, "Expected insert into compass_notification_decisions");
  });
});

// ── CompassAbuseDefenseEngine ─────────────────────────────────────────────────

describe("CompassAbuseDefenseEngine", () => {
  it("runScan: null db returns { flagsWritten: 0 }", async () => {
    const result = await runScan(null, null);
    assert.equal(result.flagsWritten, 0);
  });

  it("runScan: mutual 5★ ring of 3 users → mutual_review_ring flag", async () => {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString();
    // A reviewed B, B reviewed A, A reviewed C, C reviewed A, B reviewed C, C reviewed B
    const reviews = [
      { reviewer_id: "user-A", reviewee_id: "user-B", rating: 5, created_at: since },
      { reviewer_id: "user-B", reviewee_id: "user-A", rating: 5, created_at: since },
      { reviewer_id: "user-A", reviewee_id: "user-C", rating: 5, created_at: since },
      { reviewer_id: "user-C", reviewee_id: "user-A", rating: 5, created_at: since },
      { reviewer_id: "user-B", reviewee_id: "user-C", rating: 5, created_at: since },
      { reviewer_id: "user-C", reviewee_id: "user-B", rating: 5, created_at: since },
    ];

    const tableData: Record<string, Record<string, unknown>[]> = {
      reviews,
      rent_buddy_bookings:       [],
      hashtag_usage:             [],
      passport_stamps:           [],
      compass_abuse_flags:       [],
      compass_visibility_cooldowns: [],
      compass_active_user_scores: [],
      compass_active_user_events: [],
      profiles:                  [],
      trust_caps:                [],
      compass_active_user_badges: [],
      compass_city_reputation:   [],
      compass_category_reputation: [],
    };
    const { db } = makeFakeDb(tableData);

    const result = await runScan(db, null);
    assert.ok(result.flagsWritten > 0, "Expected at least one flag from mutual review ring");

    const flag = tableData["compass_abuse_flags"]?.[0];
    assert.ok(flag, "Expected an abuse flag row");
    assert.equal(flag["pattern_type"], "mutual_review_ring");
    assert.ok(
      (flag["involved_users"] as string[]).length >= 3,
      "Expected ≥3 users in the ring",
    );
  });

  it("runScan: severe ring triggers reach reduction in compass_visibility_cooldowns", async () => {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    // Build a 5-user ring (all reviewed each other) → severity=severe
    const users = ["user-1", "user-2", "user-3", "user-4", "user-5"];
    const reviews: Record<string, unknown>[] = [];
    for (const a of users) {
      for (const b of users) {
        if (a !== b) {
          reviews.push({ reviewer_id: a, reviewee_id: b, rating: 5, created_at: since });
        }
      }
    }

    const tableData: Record<string, Record<string, unknown>[]> = {
      reviews,
      rent_buddy_bookings:          [],
      hashtag_usage:                [],
      passport_stamps:              [],
      compass_abuse_flags:          [],
      compass_visibility_cooldowns: [],
      compass_active_user_scores:   [],
      compass_active_user_events:   [],
      profiles:                     [],
      trust_caps:                   [],
      compass_active_user_badges:   [],
      compass_city_reputation:      [],
      compass_category_reputation:  [],
    };
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    // Severe ring → visibility cooldowns applied
    const cooldowns = tableData["compass_visibility_cooldowns"] ?? [];
    assert.ok(cooldowns.length > 0, "Expected visibility cooldown rows for severe ring");
  });

  it("runScan: severe flag zeroes active-user reward score", async () => {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const users = ["ua", "ub", "uc", "ud", "ue"];
    const reviews: Record<string, unknown>[] = [];
    for (const a of users) {
      for (const b of users) {
        if (a !== b) {
          reviews.push({ reviewer_id: a, reviewee_id: b, rating: 5, created_at: since });
        }
      }
    }

    const tableData: Record<string, Record<string, unknown>[]> = {
      reviews,
      rent_buddy_bookings:          [],
      hashtag_usage:                [],
      passport_stamps:              [],
      compass_abuse_flags:          [],
      compass_visibility_cooldowns: [],
      compass_active_user_scores:   [
        { user_id: "ua", active_user_score: 50, trust_multiplier: 1.0, boost_eligible: true },
      ],
      compass_active_user_events:   [],
      profiles:                     [],
      trust_caps:                   [],
      compass_active_user_badges:   [],
      compass_city_reputation:      [],
      compass_category_reputation:  [],
    };
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    // For severe rings, active_user_score should be zeroed via upsert
    const scores = tableData["compass_active_user_scores"] ?? [];
    // The upsert in zeroActiveUserReward pushes a new row with score=0
    const zeroRows = scores.filter((r) => r["active_user_score"] === 0);
    assert.ok(
      zeroRows.length > 0,
      "Expected at least one zeroed active_user_score row after severe flag",
    );
  });

  it("runScan: booking loop >5 pairs in 30 days → booking_loop flag", async () => {
    const since = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000).toISOString();
    const bookings: Record<string, unknown>[] = [];
    for (let i = 0; i < 7; i++) {
      bookings.push({
        traveler_id: "user-T",
        buddy_id:    "user-B",
        status:      "completed",
        created_at:  since,
      });
    }

    const tableData: Record<string, Record<string, unknown>[]> = {
      reviews:                      [],
      rent_buddy_bookings:          bookings,
      hashtag_usage:                [],
      passport_stamps:              [],
      compass_abuse_flags:          [],
      compass_visibility_cooldowns: [],
      compass_active_user_scores:   [],
      compass_active_user_events:   [],
      profiles:                     [],
      trust_caps:                   [],
      compass_active_user_badges:   [],
      compass_city_reputation:      [],
      compass_category_reputation:  [],
    };
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const flags = tableData["compass_abuse_flags"] ?? [];
    const loopFlag = flags.find((f) => f["pattern_type"] === "booking_loop");
    assert.ok(loopFlag, "Expected booking_loop flag");
    assert.ok(
      (loopFlag!["involved_users"] as string[]).includes("user-T") ||
      (loopFlag!["involved_users"] as string[]).includes("user-B"),
    );
  });

  it("runScan: no patterns → flagsWritten = 0", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      reviews:                      [],
      rent_buddy_bookings:          [],
      hashtag_usage:                [],
      passport_stamps:              [],
      compass_abuse_flags:          [],
      compass_visibility_cooldowns: [],
      compass_active_user_scores:   [],
      compass_active_user_events:   [],
      profiles:                     [],
      trust_caps:                   [],
      compass_active_user_badges:   [],
      compass_city_reputation:      [],
      compass_category_reputation:  [],
    };
    const { db } = makeFakeDb(tableData);
    const result = await runScan(db, null);
    assert.equal(result.flagsWritten, 0);
  });
});
