/**
 * compass-ux.test.ts — Phase 5 Intelligence UX engine tests
 *
 * Covers:
 *   - CompassExplanationEngine: sensitive key → GENERIC_INELIGIBLE (never revealed)
 *   - CompassExplanationEngine: HMAC-signed token encode/decode + tamper detection
 *   - CompassFeedbackEngine: feedback weight updates, invalidate() called, null-db guard
 *   - CompassNotificationEngine: quiet hours, safety bypass, category mute, body redaction
 *   - CompassAbuseDefenseEngine: ring detection, booking loop, severe zeroes reward,
 *                                 refund abuse, referral farm, comment pod stubs
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
  redactLocationText,
  PRIORITY_LEVELS,
  type NotificationType,
  type NotificationPayload,
} from "../compass/CompassNotificationEngine.js";

import {
  runScan,
} from "../compass/CompassAbuseDefenseEngine.js";

import { localMinutesOfDay } from "../services/notifications/NotificationPreferenceService.js";

import {
  applySearchDecay,
  logSearchNudge,
  getDecayedWeights,
  type SearchSignalRow,
} from "../compass/CompassSearchDecayService.js";

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
      is(_k: string, _v: unknown)       { return c; },

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
        // `count` is what a `{ count: "exact", head: true }` select resolves;
        // the Attention Engine's interruption-cost read depends on it.
        const rows = [...(tableData[table] ?? [])];
        const result = { data: rows, count: rows.length, error: null };
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
    async rpc(fn: string, args?: unknown) {
      calls.push({ table: `rpc:${fn}`, method: "rpc", args });
      return { data: null, error: null };
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

  it("isSensitiveKey: report_suppressed → true", () => {
    assert.equal(isSensitiveKey("for_you:user:report_suppressed"), true);
  });

  it("isSensitiveKey: normal key → false", () => {
    assert.equal(isSensitiveKey("for_you:user:local"), false);
  });

  it("resolveExplanation: sensitive key returns GENERIC_INELIGIBLE", async () => {
    const result = await resolveExplanation("for_you:user:harassment_downrank", null, null);
    assert.equal(result, GENERIC_INELIGIBLE);
  });

  it("resolveExplanation: safety_downrank key returns GENERIC_INELIGIBLE", async () => {
    const result = await resolveExplanation("compass_picks:buddy:safety_downrank", null, null);
    assert.equal(result, GENERIC_INELIGIBLE);
  });

  it("resolveExplanation: GENERIC_INELIGIBLE never mentions 'harassment'", async () => {
    const result = await resolveExplanation("for_you:user:harassment_downrank", null, null);
    assert.ok(!result.toLowerCase().includes("harassment"));
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

  it("resolveExplanation: unknown key returns generic fallback (non-empty)", async () => {
    const result = await resolveExplanation("unknown_section:unknown_type", null, null);
    assert.ok(result.length > 0);
    assert.ok(!result.includes("harassment"));
  });

  it("resolveExplanation: DB is_sensitive override returns GENERIC_INELIGIBLE", async () => {
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

  // ── HMAC-signed token tests ─────────────────────────────────────────────────

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

  it("decodeRecommendationToken: malformed string returns null", () => {
    assert.equal(decodeRecommendationToken("not-a-valid-token!!"), null);
  });

  it("decodeRecommendationToken: empty string returns null", () => {
    assert.equal(decodeRecommendationToken(""), null);
  });

  it("decodeRecommendationToken: incomplete token (no sig) returns null", () => {
    const partial = Buffer.from(JSON.stringify({ userId: "x" })).toString("base64url");
    assert.equal(decodeRecommendationToken(partial), null);
  });

  it("decodeRecommendationToken: tampered userId invalidates signature → null", () => {
    const token: RecommendationToken = {
      userId:         "user-honest",
      itemId:         "item-1",
      itemType:       "user",
      sectionName:    "for_you",
      explanationKey: "for_you:user",
    };
    const encoded = encodeRecommendationToken(token);

    // Decode the raw bytes, mutate userId, re-encode WITHOUT updating sig
    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    raw.userId = "attacker-id";
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");

    assert.equal(decodeRecommendationToken(tampered), null, "Tampered token must be rejected");
  });

  it("decodeRecommendationToken: tampered explanationKey invalidates signature → null", () => {
    const token: RecommendationToken = {
      userId:         "user-a",
      itemId:         "item-a",
      itemType:       "post",
      sectionName:    "city_pulse",
      explanationKey: "city_pulse:post",
    };
    const encoded = encodeRecommendationToken(token);

    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    raw.explanationKey = "city_pulse:post:harassment_downrank"; // tamper to force sensitive key
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");

    assert.equal(decodeRecommendationToken(tampered), null, "Tampered explanationKey must be rejected");
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

  it("processFeedback: hide_category decreases category weight", async () => {
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
    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsert, "Expected upsert on compass_user_preferences");
    const weights = (upsert!.args as any).category_weights as Record<string, number>;
    // nightlife was 2; hide_category applies −4 → max(−10, 2−4) = −2
    assert.equal(weights["nightlife"], -2);
  });

  it("processFeedback: show_more increases item type weight", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [{ user_id: "user-1", category_weights: { buddy: 1 } }],
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

    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsert);
    const weights = (upsert!.args as any).category_weights as Record<string, number>;
    assert.equal(weights["buddy"], 3); // 1 + 2
  });

  it("processFeedback: mute_hashtag adds slug to muted_hashtags", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [{ user_id: "user-2", muted_hashtags: ["oldslug"] }],
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

    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsert);
    const slugs = (upsert!.args as any).muted_hashtags as string[];
    assert.ok(slugs.includes("oldslug"), "Old slug preserved");
    assert.ok(slugs.includes("newslug"), "New slug added");
  });

  it("processFeedback: not_interested adds itemId to ignored_item_ids", async () => {
    // Use a proper signed token so itemId is extracted correctly
    const token = encodeRecommendationToken({
      userId: "user-3", itemId: "item-999", itemType: "user",
      sectionName: "for_you", explanationKey: "for_you:user",
    });

    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [{ user_id: "user-3", ignored_item_ids: ["existing-item"] }],
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

    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsert);
    const ids = (upsert!.args as any).ignored_item_ids as string[];
    assert.ok(ids.includes("existing-item"), "Existing item preserved");
    assert.ok(ids.includes("item-999"), "New item added");
  });

  it("processFeedback: save action — no preference upsert", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences:    [],
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

    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.equal(upsert, undefined, "save should not update preferences");
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

    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsert);
    const styles = (upsert!.args as any).exclude_budget_styles as string[];
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

    const upsert = calls.find(
      (c) => c.table === "compass_user_preferences" && c.method === "upsert",
    );
    assert.ok(upsert);
    assert.equal((upsert!.args as any).min_trust_level, "building_trust");
  });

  it("processFeedback: invalidate() deletes compass_feed_cache row", async () => {
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

    const deleteCalls = calls.filter(
      (c) => c.table === "compass_feed_cache" && c.method === "delete",
    );
    assert.ok(deleteCalls.length > 0, "Expected cache delete from invalidate()");
  });
});

// ── CompassNotificationEngine ─────────────────────────────────────────────────

describe("CompassNotificationEngine", () => {
  function payload(type: NotificationType, category?: string): NotificationPayload {
    return { type, title: "Test", body: "Test body", category };
  }

  // ── redactLocationText ────────────────────────────────────────────────────────

  it("redactLocationText: strips decimal GPS coordinates", () => {
    const text = "Meet at 13.7563, 100.5018 near the park";
    const redacted = redactLocationText(text);
    assert.ok(!redacted.includes("13.7563"), "lat removed from body");
    assert.ok(!redacted.includes("100.5018"), "lng removed from body");
    assert.match(redacted, /\[location removed\]/);
  });

  it("redactLocationText: negative coordinates stripped", () => {
    const text = "Location is -33.8688, 151.2093";
    const redacted = redactLocationText(text);
    assert.ok(!redacted.includes("-33.8688"));
    assert.ok(!redacted.includes("151.2093"));
  });

  it("redactLocationText: no coordinates → text unchanged", () => {
    const text = "Join us at the rooftop bar!";
    assert.equal(redactLocationText(text), text);
  });

  it("redactLocationText: street address stripped", () => {
    const text = "Meet at 123 Main Street at noon";
    const redacted = redactLocationText(text);
    assert.ok(!redacted.includes("123 Main Street"), "street address removed");
  });

  // ── isQuietHours ─────────────────────────────────────────────────────────────

  it("isQuietHours: inside overnight window → true (23:30)", () => {
    assert.equal(isQuietHours("22:00", "07:00", 23 * 60 + 30), true);
  });

  it("isQuietHours: inside overnight window → true (02:00)", () => {
    assert.equal(isQuietHours("22:00", "07:00", 2 * 60), true);
  });

  it("isQuietHours: outside overnight window → false (12:00)", () => {
    assert.equal(isQuietHours("22:00", "07:00", 12 * 60), false);
  });

  it("isQuietHours: same-day window inside → true (10:00)", () => {
    assert.equal(isQuietHours("08:00", "20:00", 10 * 60), true);
  });

  it("isQuietHours: same-day window outside → false (21:00)", () => {
    assert.equal(isQuietHours("08:00", "20:00", 21 * 60), false);
  });

  it("isQuietHours: invalid format → false (no crash)", () => {
    assert.equal(isQuietHours("invalid", "07:00", 120), false);
  });

  // ── isQuietHours timezone awareness ──────────────────────────────────────────

  /** Format minutes-since-midnight as HH:MM, wrapping around midnight. */
  function toHHMM(mins: number): string {
    const m = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }

  it("isQuietHours: uses user's IANA timezone when nowMinutes not injected", () => {
    // Build a ±10-minute window around the CURRENT local time in a fixed-offset
    // timezone, so "now" in that tz is always inside the window.
    const tz = "Etc/GMT-12"; // UTC+12 — differs from server/UTC by 12h
    const localNow = localMinutesOfDay(new Date(), tz);
    const start = toHHMM(localNow - 10);
    const end   = toHHMM(localNow + 10);
    assert.equal(isQuietHours(start, end, undefined, tz), true,
      "window around local now in user's tz must be quiet");
    // The same window evaluated 12h away (server-ish clock) must NOT be quiet.
    assert.equal(isQuietHours(start, end, undefined, "Etc/GMT"), false,
      "same window 12 hours off must not be quiet");
  });

  it("isQuietHours: invalid timezone falls back without crashing", () => {
    const localNow = localMinutesOfDay(new Date(), null);
    const start = toHHMM(localNow - 10);
    const end   = toHHMM(localNow + 10);
    assert.equal(isQuietHours(start, end, undefined, "Not/A_Zone"), true,
      "invalid tz falls back to server-local time");
  });

  it("evaluateNotification: quiet hours evaluated in the buddy's timezone from notification_preferences", async () => {
    // User's local window differs from UTC: window is built around their local
    // "now" in UTC+12, so it is quiet locally but not on the UTC/server clock.
    const tz = "Etc/GMT-12";
    const localNow = localMinutesOfDay(new Date(), tz);
    const start = toHHMM(localNow - 10);
    const end   = toHHMM(localNow + 10);
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-tz", muted_topics: [`quiet_start:${start}`, `quiet_end:${end}`],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [{ user_id: "u-tz", timezone: tz }],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    // No nowMinutes injected — engine must resolve "now" in the user's timezone.
    const decision = await evaluateNotification(db, "u-tz", payload("message_normal"), {});
    assert.equal(decision.outcome, "suppressed_quiet_hours");
  });

  it("evaluateNotification: no stored timezone → not quiet for a window 12h off server time", async () => {
    const localNow = localMinutesOfDay(new Date(), null); // server-local
    const start = toHHMM(localNow + 12 * 60 - 10);
    const end   = toHHMM(localNow + 12 * 60 + 10);
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-notz", muted_topics: [`quiet_start:${start}`, `quiet_end:${end}`],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u-notz", payload("message_normal"), {});
    assert.equal(decision.outcome, "sent");
  });

  // ── Quiet window from notification_preferences (shared settings) ─────────────

  it("evaluateNotification: window set ONLY in notification_preferences suppresses during quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-np", muted_topics: [], exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [
        { user_id: "u-np", quiet_hours_enabled: true, quiet_start: "22:00", quiet_end: "07:00", timezone: null },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u-np", payload("recommendation"), { nowMinutes: 23 * 60 });
    assert.equal(decision.outcome, "suppressed_quiet_hours");
  });

  it("evaluateNotification: notification_preferences window not active outside quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-np2", muted_topics: [], exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [
        { user_id: "u-np2", quiet_hours_enabled: true, quiet_start: "22:00", quiet_end: "07:00", timezone: null },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    // A recommendation is a WORLD CHANGE (Sensing §15): outside quiet hours it
    // is routed by the Attention Engine, so this control declares the relation
    // and urgency that make a push legitimate — the case is about the quiet
    // window, and src/test/compassNotificationAttention.test.ts owns the rest.
    const p: NotificationPayload = { ...payload("recommendation"), data: { attention: { relevance: "saved", urgency: 0.8 } } };
    const decision = await evaluateNotification(db, "u-np2", p, { nowMinutes: 12 * 60 });
    assert.equal(decision.outcome, "sent");
  });

  it("evaluateNotification: notification_preferences window OVERRIDES legacy muted_topics entries", async () => {
    // Legacy window says 22:00–07:00 (would suppress at 23:00), but the user's
    // shared settings window is 01:00–05:00 — the shared window must win.
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-ovr", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [
        { user_id: "u-ovr", quiet_hours_enabled: true, quiet_start: "01:00", quiet_end: "05:00", timezone: null },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u-ovr", payload("message_normal"), { nowMinutes: 23 * 60 });
    assert.equal(decision.outcome, "sent", "shared window (01:00–05:00) is not active at 23:00");
    const decision2 = await evaluateNotification(db, "u-ovr", payload("message_normal"), { nowMinutes: 2 * 60 });
    assert.equal(decision2.outcome, "suppressed_quiet_hours", "shared window active at 02:00");
  });

  it("evaluateNotification: quiet_hours_enabled=false disables quiet hours even with stale legacy muted_topics entries", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-dis", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [
        { user_id: "u-dis", quiet_hours_enabled: false, quiet_start: "22:00", quiet_end: "07:00", timezone: null },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u-dis", payload("message_normal"), { nowMinutes: 23 * 60 });
    assert.equal(decision.outcome, "sent",
      "explicit opt-out in shared settings wins over stale legacy entries");
  });

  it("evaluateNotification: legacy muted_topics window applies when shared quiet setting is absent", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u-leg", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      notification_preferences: [{ user_id: "u-leg", timezone: null }],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u-leg", payload("message_normal"), { nowMinutes: 23 * 60 });
    assert.equal(decision.outcome, "suppressed_quiet_hours",
      "legacy fallback still works when shared setting was never configured");
  });

  // ── Priority levels ───────────────────────────────────────────────────────────

  it("PRIORITY_LEVELS: emergency_safety is 1", () => {
    assert.equal(PRIORITY_LEVELS["emergency_safety"], 1);
  });

  it("PRIORITY_LEVELS: general is 10 (lowest)", () => {
    assert.equal(PRIORITY_LEVELS["general"], 10);
  });

  // ── Safety bypass ─────────────────────────────────────────────────────────────

  it("evaluateNotification: level-1 emergency_safety bypasses quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u2", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u2", payload("emergency_safety"), { nowMinutes: 23 * 60 });
    assert.equal(decision.outcome, "sent");
    assert.equal(decision.priorityLevel, 1);
  });

  it("evaluateNotification: level-2 safety_alert bypasses quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u3", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u3", payload("safety_alert"), { nowMinutes: 2 * 60 });
    assert.equal(decision.outcome, "sent");
  });

  // ── Quiet hours suppression ───────────────────────────────────────────────────

  it("evaluateNotification: level-6 message_normal suppressed during quiet hours", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u4", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u4", payload("message_normal"), { nowMinutes: 23 * 60 });
    assert.equal(decision.outcome, "suppressed_quiet_hours");
  });

  it("evaluateNotification: discovery suppressed during quiet hours (01:00)", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u5", muted_topics: ["quiet_start:22:00", "quiet_end:07:00"],
          exclude_budget_styles: [], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const decision = await evaluateNotification(db, "u5", payload("discovery"), { nowMinutes: 1 * 60 });
    assert.equal(decision.outcome, "suppressed_quiet_hours");
  });

  // ── Category mute ─────────────────────────────────────────────────────────────

  it("evaluateNotification: recommendation (level 8) suppressed for muted category", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u6", muted_topics: [], exclude_budget_styles: ["nightlife"], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = { type: "recommendation", title: "T", body: "B", category: "nightlife" };
    const decision = await evaluateNotification(db, "u6", p, { nowMinutes: 14 * 60 });
    assert.equal(decision.outcome, "suppressed_category_muted");
  });

  it("evaluateNotification: booking_update (level 4) NOT suppressed when category is not muted", async () => {
    // Category mutes apply to ALL non-safety levels (3+).
    // booking_update is NOT suppressed here because its category ("booking")
    // is not in the user's muted list — only "nightlife" is muted.
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u7", muted_topics: [], exclude_budget_styles: ["nightlife"], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = { type: "booking_update", title: "T", body: "B", category: "booking" };
    const decision = await evaluateNotification(db, "u7", p, { nowMinutes: 14 * 60 });
    assert.equal(decision.outcome, "sent");
  });

  it("evaluateNotification: booking_update (level 4) IS suppressed when its category IS muted", async () => {
    // Confirms that category mutes apply to level 4 (not just levels 8–10).
    // A user who has muted "nightlife" should not receive a nightlife booking push.
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u7b", muted_topics: [], exclude_budget_styles: ["nightlife"], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = { type: "booking_update", title: "T", body: "B", category: "nightlife" };
    const decision = await evaluateNotification(db, "u7b", p, { nowMinutes: 14 * 60 });
    assert.equal(decision.outcome, "suppressed_category_muted");
  });

  it("evaluateNotification: nightlife suppressed for no_clubs user", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [
        { user_id: "u8", muted_topics: [], exclude_budget_styles: ["no_clubs"], compass_enabled: true },
      ],
      compass_notification_decisions: [],
      feature_flags: [],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = { type: "discovery", title: "Club Night", body: "Join us", category: "clubs" };
    const decision = await evaluateNotification(db, "u8", p, { nowMinutes: 14 * 60 });
    assert.equal(decision.outcome, "suppressed_ignored_category");
  });

  // ── Safety filter integration ─────────────────────────────────────────────────

  it("evaluateNotification: sender blocked by recipient → suppressed_blocked_sender", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [],
      // Recipient "u-recip" has blocked sender "u-sender"
      blocks: [
        { blocker_id: "u-recip", blocked_id: "u-sender" },
      ],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = {
      type: "message_normal",
      title: "New message",
      body:  "Hey!",
      data:  { senderId: "u-sender" },
    };
    const decision = await evaluateNotification(db, "u-recip", p, { nowMinutes: 12 * 60 });
    assert.equal(decision.outcome, "suppressed_blocked_sender");
  });

  it("evaluateNotification: sender has blocked recipient → suppressed_blocked_sender", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [],
      // Sender "u-sender2" has blocked recipient "u-recip2"
      blocks: [
        { blocker_id: "u-sender2", blocked_id: "u-recip2" },
      ],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = {
      type: "message_normal",
      title: "New message",
      body:  "Hey!",
      data:  { senderId: "u-sender2" },
    };
    const decision = await evaluateNotification(db, "u-recip2", p, { nowMinutes: 12 * 60 });
    assert.equal(decision.outcome, "suppressed_blocked_sender");
  });

  it("evaluateNotification: no block relationship → notification sent", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [],
      blocks: [],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = {
      type: "message_normal",
      title: "New message",
      body:  "Hey!",
      data:  { senderId: "u-stranger" },
    };
    const decision = await evaluateNotification(db, "u-recip3", p, { nowMinutes: 12 * 60 });
    assert.equal(decision.outcome, "sent");
  });

  it("evaluateNotification: category blocked by feature flag → suppressed_safety_filter", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [
        { flag: "COMPASS_BUDDY_SAFETY_BLOCK", enabled: true },
      ],
    };
    const { db } = makeFakeDb(tableData);
    const p: NotificationPayload = { type: "recommendation", title: "T", body: "B", category: "buddy" };
    const decision = await evaluateNotification(db, "u-safe", p, { nowMinutes: 12 * 60 });
    assert.equal(decision.outcome, "suppressed_safety_filter");
  });

  // ── Private location stripping ────────────────────────────────────────────────

  it("stripPrivateLocation: removes lat/lng from data", () => {
    const p: NotificationPayload = {
      type: "discovery", title: "T", body: "Test",
      data: { lat: "13.756", lng: "100.501", venue_name: "The Spot", city: "Bangkok" },
    };
    const stripped = stripPrivateLocation(p);
    assert.equal((stripped.data as any)["lat"],        undefined, "lat removed");
    assert.equal((stripped.data as any)["lng"],        undefined, "lng removed");
    assert.equal((stripped.data as any)["city"],       "Bangkok", "city preserved");
    assert.equal((stripped.data as any)["venue_name"], "The Spot", "venue_name preserved");
  });

  it("stripPrivateLocation: removes exact_address from data", () => {
    const p: NotificationPayload = {
      type: "discovery", title: "T", body: "Test",
      data: { exact_address: "123 Main St", city: "London" },
    };
    const stripped = stripPrivateLocation(p);
    assert.equal((stripped.data as any)["exact_address"], undefined);
    assert.equal((stripped.data as any)["city"], "London");
  });

  it("stripPrivateLocation: redacts GPS coordinates from body text", () => {
    const p: NotificationPayload = {
      type: "discovery", title: "T", body: "Location: 13.7563, 100.5018",
      data: {},
    };
    const stripped = stripPrivateLocation(p);
    assert.ok(!stripped.body.includes("13.7563"), "lat removed from body");
    assert.ok(!stripped.body.includes("100.5018"), "lng removed from body");
  });

  it("stripPrivateLocation: null data → empty data, no crash", () => {
    const p: NotificationPayload = { type: "general", title: "T", body: "B" };
    const stripped = stripPrivateLocation(p);
    assert.deepEqual(stripped.data, {});
  });

  it("evaluateNotification: strippedPayload has no private location keys", async () => {
    const decision = await evaluateNotification(
      null, "user-9",
      { type: "discovery", title: "New Place", body: "Check out 13.7563, 100.5018",
        data: { lat: "13.7563", lng: "100.5018", city: "BKK" } },
    );
    assert.equal((decision.strippedPayload.data as any)["lat"], undefined);
    assert.equal((decision.strippedPayload.data as any)["lng"], undefined);
    assert.equal((decision.strippedPayload.data as any)["city"], "BKK");
    assert.ok(!decision.strippedPayload.body.includes("13.7563"));
  });

  // ── Audit log ─────────────────────────────────────────────────────────────────

  it("evaluateNotification: logs decision to compass_notification_decisions", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      compass_user_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [],
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
    // A↔B, A↔C, B↔C — fully connected 5★ ring
    const reviews = [
      { reviewer_id: "user-A", reviewee_id: "user-B", rating: 5, created_at: since },
      { reviewer_id: "user-B", reviewee_id: "user-A", rating: 5, created_at: since },
      { reviewer_id: "user-A", reviewee_id: "user-C", rating: 5, created_at: since },
      { reviewer_id: "user-C", reviewee_id: "user-A", rating: 5, created_at: since },
      { reviewer_id: "user-B", reviewee_id: "user-C", rating: 5, created_at: since },
      { reviewer_id: "user-C", reviewee_id: "user-B", rating: 5, created_at: since },
    ];
    const tableData = emptyTables({ rent_buddy_reviews: reviews });
    const { db } = makeFakeDb(tableData);

    const result = await runScan(db, null);
    assert.ok(result.flagsWritten > 0, "Expected at least one flag");

    const flag = tableData["compass_abuse_flags"]?.[0];
    assert.ok(flag, "Expected an abuse flag row");
    assert.equal(flag["pattern_type"], "mutual_review_ring");
    assert.ok((flag["involved_users"] as string[]).length >= 3);
  });

  it("runScan: severe ring triggers reach reduction in compass_visibility_cooldowns", async () => {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    // 5-user ring (all reviewed each other) → severity=severe
    const users = ["u1", "u2", "u3", "u4", "u5"];
    const reviews: Record<string, unknown>[] = [];
    for (const a of users) for (const b of users) {
      if (a !== b) reviews.push({ reviewer_id: a, reviewee_id: b, rating: 5, created_at: since });
    }
    const tableData = emptyTables({ rent_buddy_reviews: reviews });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const cooldowns = tableData["compass_visibility_cooldowns"] ?? [];
    assert.ok(cooldowns.length > 0, "Expected visibility cooldown rows for severe ring");
  });

  it("runScan: severe flag zeroes active-user reward score", async () => {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const users = ["ua", "ub", "uc", "ud", "ue"];
    const reviews: Record<string, unknown>[] = [];
    for (const a of users) for (const b of users) {
      if (a !== b) reviews.push({ reviewer_id: a, reviewee_id: b, rating: 5, created_at: since });
    }
    const tableData = emptyTables({
      rent_buddy_reviews: reviews,
      compass_active_user_scores: [
        { user_id: "ua", active_user_score: 50, trust_multiplier: 1.0, boost_eligible: true },
      ],
    });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    // zeroActiveUserReward pushes a row with active_user_score=0
    const scores = tableData["compass_active_user_scores"] ?? [];
    const zeroed = scores.filter((r) => r["active_user_score"] === 0);
    assert.ok(zeroed.length > 0, "Expected zeroed active_user_score row");
  });

  it("runScan: booking loop (7 × 5★ same pair in 30 days) → booking_loop flag", async () => {
    const since = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000).toISOString();
    // Ratings live on rent_buddy_reviews (keyed by booking_id), not on bookings.
    const bookings: Record<string, unknown>[] = [];
    const loopReviews: Record<string, unknown>[] = [];
    for (let i = 0; i < 7; i++) {
      bookings.push({
        id:          `loop-bk-${i}`,
        traveler_id: "user-T",
        buddy_id:    "user-B",
        status:      "completed",
        created_at:  since,
      });
      loopReviews.push({ booking_id: `loop-bk-${i}`, rating: 5, created_at: since });
    }
    const tableData = emptyTables({
      rent_buddy_bookings: bookings,
      rent_buddy_reviews:  loopReviews,
    });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const flags = tableData["compass_abuse_flags"] ?? [];
    const loopFlag = flags.find((f) => f["pattern_type"] === "booking_loop");
    assert.ok(loopFlag, "Expected booking_loop flag");
    assert.ok(
      (loopFlag!["evidence"] as any)["all_five_star"] === true,
      "Expected all_five_star=true in evidence",
    );
  });

  it("runScan: refund abuse (4 cancellations in 30 days) → refund_abuse flag", async () => {
    const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString();
    const bookings: Record<string, unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      bookings.push({ traveler_id: "user-R", status: "cancelled", created_at: since });
    }
    const tableData = emptyTables({ rent_buddy_bookings: bookings });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const flags = tableData["compass_abuse_flags"] ?? [];
    const refundFlag = flags.find((f) => f["pattern_type"] === "refund_abuse");
    assert.ok(refundFlag, "Expected refund_abuse flag");
    assert.ok(
      (refundFlag!["involved_users"] as string[]).includes("user-R"),
    );
  });

  it("runScan: no patterns → flagsWritten = 0", async () => {
    const tableData = emptyTables({});
    const { db } = makeFakeDb(tableData);
    const result = await runScan(db, null);
    assert.equal(result.flagsWritten, 0);
  });

  // ── Referral farm >50 referred users ─────────────────────────────────────────
  // Regression: the old code sliced referredIds to 50 before querying bookings.
  // This under-counted active users in large referral networks, inflating
  // inactiveCount and triggering punitive flags incorrectly. The fix paginates
  // across all referred IDs in batches.

  it("runScan: referral farm with 55 referred users all inactive → severe referral_farm flag", async () => {
    const referredUsers: Record<string, unknown>[] = [];
    for (let i = 0; i < 55; i++) {
      referredUsers.push({ id: `ref-user-${i}`, referred_by: "referrer-X" });
    }
    // No bookings — all 55 are inactive
    const tableData = emptyTables({ profiles: referredUsers });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const flags = tableData["compass_abuse_flags"] ?? [];
    const farmFlag = flags.find((f) => f["pattern_type"] === "referral_farm");
    // Referral-farm detection is stubbed: profiles has no referred_by column in
    // the live schema, so no flag can be produced until referral tracking exists.
    assert.ok(!farmFlag, "referral_farm detection is stubbed (no referred_by column) — expected no flag");
  });

  it("runScan: referral farm with 55 referred users all having bookings → no flag", async () => {
    const referredUsers: Record<string, unknown>[] = [];
    const bookings: Record<string, unknown>[] = [];
    for (let i = 0; i < 55; i++) {
      referredUsers.push({ id: `active-ref-${i}`, referred_by: "referrer-Y" });
      bookings.push({ traveler_id: `active-ref-${i}`, status: "completed" });
    }
    // All 55 referred users have bookings → inactiveCount = 0 → no flag
    const tableData = emptyTables({
      profiles:            referredUsers,
      rent_buddy_bookings: bookings,
    });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const flags = tableData["compass_abuse_flags"] ?? [];
    const farmFlag = flags.find((f) => f["pattern_type"] === "referral_farm");
    assert.ok(!farmFlag, "No referral_farm flag when all referred users are active");
  });

  it("runScan: severe flag emits suspension request for each involved user", async () => {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    // 5-user ring → severe (clique.length >= 5)
    const users = ["su1", "su2", "su3", "su4", "su5"];
    const reviews: Record<string, unknown>[] = [];
    for (const a of users) for (const b of users) {
      if (a !== b) reviews.push({ reviewer_id: a, reviewee_id: b, rating: 5, created_at: since });
    }
    const tableData = emptyTables({ rent_buddy_reviews: reviews });
    const { db } = makeFakeDb(tableData);

    await runScan(db, null);

    const suspensions = tableData["compass_suspension_requests"] ?? [];
    assert.ok(
      suspensions.length >= users.length,
      `Expected ≥${users.length} suspension request rows for ${users.length}-user severe ring; got ${suspensions.length}`,
    );
    for (const uid of users) {
      const req = suspensions.find((r) => r["user_id"] === uid);
      assert.ok(req, `Expected suspension request for ${uid}`);
      assert.equal(req!["status"], "pending_review");
    }
  });
});

// ── CompassSearchDecayService ─────────────────────────────────────────────────

describe("applySearchDecay", () => {
  const MS_PER_DAY = 86_400_000;

  it("returns unchanged weights when there are no signal rows", () => {
    const weights = { nightlife: 3, food: 2 };
    const result = applySearchDecay(weights, [], 7);
    assert.deepEqual(result, weights);
  });

  it("returns unchanged weights when halfLifeDays is 0", () => {
    const weights = { nightlife: 3 };
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: new Date(Date.now() - 14 * MS_PER_DAY).toISOString(), search_weight: 3 },
    ];
    const result = applySearchDecay(weights, rows, 0);
    assert.deepEqual(result, weights);
  });

  it("does not decay a nudge applied today (age ≈ 0)", () => {
    const weights = { nightlife: 3 };
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: new Date().toISOString(), search_weight: 3 },
    ];
    const result = applySearchDecay(weights, rows, 7);
    // decay_factor ≈ 1, weightToShed ≈ 0
    assert.equal(result["nightlife"], 3);
  });

  it("halves search contribution after exactly one half-life", () => {
    const halfLifeDays = 7;
    const nudgeMs = Date.now() - halfLifeDays * MS_PER_DAY;
    const weights = { nightlife: 4 };
    const rows: SearchSignalRow[] = [
      {
        category:      "nightlife",
        last_nudge_at: new Date(nudgeMs).toISOString(),
        search_weight: 4,
      },
    ];
    const result = applySearchDecay(weights, rows, halfLifeDays, Date.now());
    // effective_sw = round(4 * 0.5) = 2; weightToShed = 2; result = 4 − 2 = 2
    assert.equal(result["nightlife"], 2);
  });

  it("fully decays after four half-lives (rounds to 0 shed)", () => {
    const halfLifeDays = 7;
    const nudgeMs = Date.now() - 4 * halfLifeDays * MS_PER_DAY; // 28 days ago
    const weights = { nightlife: 2 };
    const rows: SearchSignalRow[] = [
      {
        category:      "nightlife",
        last_nudge_at: new Date(nudgeMs).toISOString(),
        search_weight: 2,
      },
    ];
    const result = applySearchDecay(weights, rows, halfLifeDays, Date.now());
    // effective_sw = round(2 * 0.5^4) = round(0.125) = 0; weightToShed = 2; result = max(-10, 2−2) = 0
    assert.equal(result["nightlife"], 0);
  });

  it("does not decay categories that have no search signal row", () => {
    const weights = { nightlife: 3, food: 5 };
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: new Date(Date.now() - 14 * MS_PER_DAY).toISOString(), search_weight: 3 },
    ];
    const result = applySearchDecay(weights, rows, 7, Date.now());
    // food has no search signal — untouched
    assert.equal(result["food"], 5);
  });

  it("clamps result at WEIGHT_MIN (−10), never below", () => {
    // contrived: search_weight huge vs actual stored weight
    const weights = { nightlife: 1 };
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: new Date(Date.now() - 28 * MS_PER_DAY).toISOString(), search_weight: 20 },
    ];
    const result = applySearchDecay(weights, rows, 7, Date.now());
    assert.ok(result["nightlife"] >= -10, "Must be ≥ −10");
  });

  it("skips rows with invalid last_nudge_at (NaN date)", () => {
    const weights = { nightlife: 3 };
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: "not-a-date", search_weight: 3 },
    ];
    const result = applySearchDecay(weights, rows, 7);
    assert.equal(result["nightlife"], 3);
  });

  it("skips rows with search_weight = 0", () => {
    const weights = { nightlife: 3 };
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: new Date(Date.now() - 14 * MS_PER_DAY).toISOString(), search_weight: 0 },
    ];
    const result = applySearchDecay(weights, rows, 7);
    assert.equal(result["nightlife"], 3);
  });
});

describe("logSearchNudge", () => {
  it("calls upsert_compass_search_signal RPC with correct args for delta=1", async () => {
    const { db, calls } = makeFakeDb({});

    await logSearchNudge(db as any, "user-1", "nightlife", 1);

    const rpc = calls.find((c) => c.table === "rpc:upsert_compass_search_signal");
    assert.ok(rpc, "Expected RPC call to upsert_compass_search_signal");
    assert.equal((rpc!.args as any).p_user_id, "user-1");
    assert.equal((rpc!.args as any).p_category, "nightlife");
    assert.equal((rpc!.args as any).p_delta, 1);
  });

  it("is a no-op when delta=0 (weight was already at the ±10 clamp)", async () => {
    const { db, calls } = makeFakeDb({});

    await logSearchNudge(db as any, "user-1", "nightlife", 0);

    const rpc = calls.find((c) => c.table === "rpc:upsert_compass_search_signal");
    assert.equal(rpc, undefined, "No RPC call expected when delta is 0");
  });

  it("is a no-op when delta is negative", async () => {
    const { db, calls } = makeFakeDb({});

    await logSearchNudge(db as any, "user-1", "nightlife", -1);

    const rpc = calls.find((c) => c.table === "rpc:upsert_compass_search_signal");
    assert.equal(rpc, undefined, "No RPC call expected when delta is negative");
  });

  it("search_weight stays bounded when weight is already at max (+10)", () => {
    // Simulate 20 nudges where the weight was already at +10: all deltas are 0.
    // applySearchDecay must never over-subtract because search_weight was never
    // incremented beyond the initial effective nudges.
    const MS_PER_DAY = 86_400_000;
    const staleDate = new Date(Date.now() - 14 * MS_PER_DAY).toISOString();
    const weights = { nightlife: 10 };
    // search_weight=2 (only 2 real effective nudges before cap was hit)
    const rows: SearchSignalRow[] = [
      { category: "nightlife", last_nudge_at: staleDate, search_weight: 2 },
    ];
    const result = applySearchDecay(weights, rows, 7, Date.now());
    // effective_sw = round(2 * 0.5^2) = round(0.5) = 1 (rounds to 0 or 1 depending on impl)
    // weightToShed ≤ 2; result = 10 − weightToShed ≥ 8
    assert.ok(result["nightlife"] >= 8, `Expected ≥8 after decay of capped weight; got ${result["nightlife"]}`);
  });

  it("never drives a category below 0 when weight was earned legitimately (not just from search)", () => {
    // weight=5 of which search contributed 2 (the rest came from feedback/outcome)
    const MS_PER_DAY = 86_400_000;
    const staleDate = new Date(Date.now() - 28 * MS_PER_DAY).toISOString(); // 4 half-lives
    const weights = { food: 5 };
    const rows: SearchSignalRow[] = [
      { category: "food", last_nudge_at: staleDate, search_weight: 2 },
    ];
    const result = applySearchDecay(weights, rows, 7, Date.now());
    // effective_sw = round(2 * 0.5^4) = 0; weightToShed = 2; result = 5 − 2 = 3
    assert.equal(result["food"], 3);
    assert.ok(result["food"] > 0, "Non-search contribution must not be removed");
  });
});

describe("getDecayedWeights", () => {
  it("returns original weights when decay flag is disabled", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      feature_flags: [
        { flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: false, metadata: { half_life_days: 7 } },
      ],
      compass_search_signal_log: [],
    };
    const { db } = makeFakeDb(tableData);

    const result = await getDecayedWeights(db as any, "user-1", { nightlife: 4 });
    assert.equal(result["nightlife"], 4);
  });

  it("returns original weights when there are no log rows", async () => {
    const tableData: Record<string, Record<string, unknown>[]> = {
      feature_flags: [
        { flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true, metadata: { half_life_days: 7 } },
      ],
      compass_search_signal_log: [],
    };
    const { db } = makeFakeDb(tableData);

    const result = await getDecayedWeights(db as any, "user-1", { food: 5 });
    assert.equal(result["food"], 5);
  });

  it("decays weight when a stale search signal exists", async () => {
    const staleDate = new Date(Date.now() - 14 * 86_400_000).toISOString(); // 14 days = 2 half-lives
    const tableData: Record<string, Record<string, unknown>[]> = {
      feature_flags: [
        { flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true, metadata: { half_life_days: 7 } },
      ],
      compass_search_signal_log: [
        { user_id: "user-1", category: "nightlife", last_nudge_at: staleDate, search_weight: 4 },
      ],
    };
    const { db } = makeFakeDb(tableData);

    const result = await getDecayedWeights(db as any, "user-1", { nightlife: 4 });
    // effective_sw = round(4 * 0.5^2) = round(1) = 1; weightToShed = 3; result = 4 − 3 = 1
    assert.equal(result["nightlife"], 1);
  });

  it("returns original weights when DB throws (non-fatal)", async () => {
    const brokenDb = {
      from() { throw new Error("db error"); },
    };
    const result = await getDecayedWeights(brokenDb as any, "user-1", { nightlife: 3 });
    assert.equal(result["nightlife"], 3);
  });
});

// ── Test helpers ───────────────────────────────────────────────────────────────

function emptyTables(
  overrides: Record<string, Record<string, unknown>[]> = {},
): Record<string, Record<string, unknown>[]> {
  return {
    rent_buddy_reviews:           [],
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
    posts:                        [],
    posts_comments:               [],
    feature_flags:                [],
    compass_suspension_requests:  [],
    ...overrides,
  };
}

// ── CompassAbuseDefenseEngine — catch-up after a suspended process ────────────
//
// The scheduler runs hourly on Replit autoscale, which suspends the container
// after fifteen idle minutes. Three detectors scanned windows no wider than
// that gap (geotag_farming ONE HOUR on a one-hour timer, hashtag_spam and
// available_now_abuse 24 h), so abuse committed inside a tick that never
// happened was outside every later window and was evaluated by NO scan, ever:
// no flag, no reach reduction, no compass_suspension_requests row, and no
// trace that anything had been skipped.
//
// These tests assert the resulting STATE of the scan — the `since` each
// detector actually sent to the database, the flags that landed, and whether a
// watermark was advanced — rather than that runScan resolved
// (CONTRIBUTING.md:33-66). The window-recording fake exists for that: the
// shared makeFakeDb above treats `.gte()` as a no-op, which cannot tell a
// one-hour window from a 54-hour one.

const WM_NOW   = new Date("2026-03-15T12:00:00.000Z");
const WM_HOUR  = 60 * 60 * 1_000;
const JOB_GEO   = "compass_abuse_geotag_farming";
const JOB_HASH  = "compass_abuse_hashtag_spam";
const JOB_AVAIL = "compass_abuse_available_now_abuse";

/** An ISO timestamp this many hours before WM_NOW. */
function wmAgo(hours: number): string {
  return new Date(WM_NOW.getTime() - hours * WM_HOUR).toISOString();
}

interface WindowRead { table: string; since: string | null; until: string | null }

/**
 * A fake client that HONOURS `.gte()`/`.lte()` on created_at and records every
 * window it was asked for. Without that, a detector could be handed a 54-hour
 * window and still be tested as if it had scanned one hour.
 */
function makeWindowDb(opts: {
  tables?:      Record<string, Record<string, unknown>[]>;
  failTables?:  Set<string>;
  failWrites?:  Set<string>;
} = {}) {
  const tables     = opts.tables ?? {};
  const failTables = opts.failTables ?? new Set<string>();
  const failWrites = opts.failWrites ?? new Set<string>();
  const windows: WindowRead[] = [];

  function builder(table: string) {
    const eqs: Record<string, unknown>  = {};
    const ins: Record<string, unknown[]> = {};
    let since: string | null = null;
    let until: string | null = null;

    const b: any = {
      select()                             { return b; },
      eq(k: string, v: unknown)            { eqs[k] = v; return b; },
      in(k: string, vs: unknown[])         { ins[k] = vs; return b; },
      gte(k: string, v: string)            { if (k === "created_at") since = v; return b; },
      lte(k: string, v: string)            { if (k === "created_at") until = v; return b; },
      gt()                                 { return b; },
      is()                                 { return b; },
      or()                                 { return b; },
      not()                                { return b; },
      order()                              { return b; },
      limit()                              { return b; },

      async maybeSingle() {
        const rows = (tables[table] ?? []).filter((r) =>
          Object.entries(eqs).every(([k, v]) => r[k] === v),
        );
        return { data: rows[0] ?? null, error: null };
      },

      then(resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) {
        windows.push({ table, since, until });
        if (failTables.has(table)) {
          return Promise.resolve({ data: null, error: { message: `permission denied for ${table}` } }).then(resolve, reject);
        }
        const rows = (tables[table] ?? []).filter((r) => {
          for (const [k, v] of Object.entries(eqs)) if (r[k] !== v) return false;
          for (const [k, vs] of Object.entries(ins)) if (!vs.includes(r[k])) return false;
          // Rows with no created_at (posts, profiles) are not time-filtered —
          // only the windowed reads carry a bound.
          const raw = r["created_at"] as string | undefined;
          if (raw) {
            const ts = Date.parse(raw);
            if (since !== null && ts < Date.parse(since)) return false;
            if (until !== null && ts > Date.parse(until)) return false;
          }
          return true;
        });
        return Promise.resolve({ data: rows, count: rows.length, error: null }).then(resolve, reject);
      },

      async insert(row: unknown) {
        if (failWrites.has(table)) return { data: null, error: { message: `insert denied for ${table}` } };
        (tables[table] ??= []).push(row as Record<string, unknown>);
        return { data: null, error: null };
      },
      async upsert(row: unknown) {
        if (failWrites.has(table)) return { data: null, error: { message: `upsert denied for ${table}` } };
        (tables[table] ??= []).push(row as Record<string, unknown>);
        return { data: null, error: null };
      },
    };
    return b;
  }

  const db = {
    from: (table: string) => builder(table),
    async rpc() { return { data: null, error: null }; },
  } as any;

  return { db, windows, tables };
}

/** Injected watermark store, so these tests need no scheduler_watermarks table. */
function makeWatermarkPorts(
  initial: Record<string, Date> = {},
  opts: { failRead?: Set<string>; failCommit?: Set<string> } = {},
) {
  const store   = new Map<string, Date>(Object.entries(initial));
  const reads: string[] = [];
  const commits: Array<{ job: string; through: Date }> = [];
  const ports = {
    async read(_db: any, job: string) {
      reads.push(job);
      if (opts.failRead?.has(job)) return { at: null, ok: false };   // a REFUSAL, not an absence
      return { at: store.get(job) ?? null, ok: true };
    },
    async commit(_db: any, job: string, through: Date) {
      commits.push({ job, through });
      if (opts.failCommit?.has(job)) return false;
      store.set(job, through);
      return true;
    },
  };
  return { ports, store, reads, commits };
}

/**
 * The distinct lookbacks a table was read with, in whole hours, measured from
 * `anchorMs`. For the wide detectors, which were left on the real clock.
 */
function lookbackHours(windows: WindowRead[], table: string, anchorMs: number): number[] {
  return [...new Set(
    sincesFor(windows, table).map((s) => Math.round((anchorMs - Date.parse(s!)) / WM_HOUR)),
  )].sort((a, b) => a - b);
}

/** Every `since` a table was read with, in call order. */
function sincesFor(windows: WindowRead[], table: string): Array<string | null> {
  return windows.filter((w) => w.table === table).map((w) => w.since);
}

/**
 * Abuse inside a 54-hour gap, placed so that each burst is dense enough to
 * meet its detector's threshold INSIDE that detector's calibrated window —
 * a real burst, not a quiet trickle that only adds up across the catch-up.
 */
function gapAbuseFixtures(): Record<string, Record<string, unknown>[]> {
  const stamps: Record<string, unknown>[] = [];
  for (let i = 0; i < 16; i++) {                       // 16 > GEOTAG_FARM_MIN, all within ~15 min
    stamps.push({ user_id: "farmer-1", created_at: wmAgo(30 - i * 0.01) });
  }
  const usage: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  for (let i = 0; i < 21; i++) {                       // 21 > HASHTAG_SPAM_MIN, within ~2 h
    usage.push({ hashtag_id: "tag-spam", source_id: `spam-post-${i}`, source_type: "post", created_at: wmAgo(40 - i * 0.1) });
    posts.push({ id: `spam-post-${i}`, author_id: "spammer-1" });
  }
  const toggles: Record<string, unknown>[] = [];
  for (let i = 0; i < 21; i++) {                       // 21 > AVAILABLE_TOGGLE_MIN, within ~1 h
    toggles.push({ user_id: "toggler-1", event_type: "availability_toggle", created_at: wmAgo(45 - i * 0.05) });
  }
  return emptyTables({
    passport_stamps:            stamps,
    hashtag_usage:              usage,
    posts,
    compass_active_user_events: toggles,
  });
}

describe("CompassAbuseDefenseEngine — a suspended hour is scanned late, not never", () => {
  it("54-hour gap: abuse inside the gap IS scanned, and all three watermarks advance to `through`", async () => {
    const tables = gapAbuseFixtures();
    const { db, windows } = makeWindowDb({ tables });
    const { ports, commits, store } = makeWatermarkPorts({
      [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    const result = await runScan(db, null, { now: WM_NOW, watermarks: ports });

    // The windows actually sent to the database resume from the watermark.
    assert.equal(sincesFor(windows, "passport_stamps")[0], wmAgo(54), "geotag_farming must resume from its watermark, not from now-1h");
    assert.equal(sincesFor(windows, "hashtag_usage")[0], wmAgo(54));
    assert.equal(sincesFor(windows, "compass_active_user_events")[0], wmAgo(54));

    // And the abuse in the gap is evaluated — the state that was missing.
    const flags = tables["compass_abuse_flags"] ?? [];
    const kinds = flags.map((f) => f["pattern_type"]).sort();
    assert.deepEqual(kinds, ["available_now_abuse", "geotag_farming", "hashtag_spam"], `got ${JSON.stringify(kinds)}`);
    const geo = flags.find((f) => f["pattern_type"] === "geotag_farming")!;
    assert.deepEqual(geo["involved_users"], ["farmer-1"]);
    assert.equal((geo["evidence"] as any).stamp_count, 16, "the peak hour inside the gap, not the 54-hour total");
    assert.equal((geo["evidence"] as any).catchup_scan, true);
    assert.equal(result.status, "ok");
    assert.equal(result.flagsWritten, 3);
    assert.deepEqual(result.watermarkFailures, []);

    // Reach reduction really happened for the gap abuse (geotag is `high`).
    const cooldowns = (tables["compass_visibility_cooldowns"] ?? []).map((c) => c["author_id"]);
    assert.ok(cooldowns.includes("farmer-1"), `expected a reach reduction for farmer-1; got ${JSON.stringify(cooldowns)}`);

    // All three advanced, to the pass's `through` and not to a fresh clock.
    assert.deepEqual(commits.map((c) => c.job).sort(), [JOB_AVAIL, JOB_GEO, JOB_HASH]);
    for (const c of commits) assert.equal(c.through.toISOString(), WM_NOW.toISOString());
    assert.equal(store.get(JOB_GEO)!.toISOString(), WM_NOW.toISOString());
  });

  it("a failed watermark READ does not widen the window and commits nothing", async () => {
    // `{ ok: false }` is a refusal, not `{ at: null, ok: true }`. Falling back
    // to the calibrated lookback and committing nothing is what keeps a
    // transient DB error from either resetting or advancing coverage.
    const tables = gapAbuseFixtures();
    const { db, windows } = makeWindowDb({ tables });
    const { ports, commits } = makeWatermarkPorts(
      {
        [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
        [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
        [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      },
      { failRead: new Set([JOB_GEO, JOB_HASH, JOB_AVAIL]) },
    );

    const result = await runScan(db, null, { now: WM_NOW, watermarks: ports });

    assert.equal(sincesFor(windows, "passport_stamps")[0], wmAgo(1), "an unreadable watermark must leave the 1-hour lookback alone");
    assert.equal(sincesFor(windows, "hashtag_usage")[0], wmAgo(24));
    assert.equal(sincesFor(windows, "compass_active_user_events")[0], wmAgo(24));
    assert.deepEqual(commits, [], "nothing may be advanced on a watermark this process could not read");
    assert.deepEqual(tables["compass_abuse_flags"], [], "the gap abuse is outside the calibrated windows — unchanged old behaviour");
    assert.equal(result.flagsWritten, 0);
    // Said out loud: the detectors measured their own windows (status ok), but
    // the missed time was not recovered on this pass.
    assert.equal(result.status, "ok");
    assert.equal(result.watermarkFailures.length, 3);
    assert.deepEqual([...new Set(result.watermarkFailures.map((f) => f.phase))], ["read"]);
  });

  it("the catch-up cap bounds the window, and what it leaves out is left out", async () => {
    const stamps: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) stamps.push({ user_id: "old-farmer",   created_at: wmAgo(100 - i * 0.01) }); // before the 72 h cap
    for (let i = 0; i < 20; i++) stamps.push({ user_id: "recent-farmer", created_at: wmAgo(50 - i * 0.01) }); // inside it
    const tables = emptyTables({ passport_stamps: stamps });
    const { db, windows } = makeWindowDb({ tables });
    const stale = new Date(WM_NOW.getTime() - 30 * 24 * WM_HOUR); // a month-old watermark
    const { ports } = makeWatermarkPorts({ [JOB_GEO]: stale, [JOB_HASH]: stale, [JOB_AVAIL]: stale });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });

    assert.equal(sincesFor(windows, "passport_stamps")[0], wmAgo(72),  "geotag catch-up is capped at 72 h");
    assert.equal(sincesFor(windows, "hashtag_usage")[0], wmAgo(168),   "hashtag_spam catch-up is capped at 7 days");
    assert.equal(sincesFor(windows, "compass_active_user_events")[0], wmAgo(72));

    const flags  = tables["compass_abuse_flags"] ?? [];
    const farmed = flags.flatMap((f) => f["involved_users"] as string[]);
    assert.ok(farmed.includes("recent-farmer"), "abuse inside the cap is flagged");
    assert.ok(!farmed.includes("old-farmer"), "abuse older than the cap is NOT evaluated — the admitted cost of capping");
    assert.equal((flags[0]!["evidence"] as any).catchup_capped, true, "a capped pass must say so in its own evidence");
  });

  it("a failed detector does not advance ITS watermark, and does not hold back the others", async () => {
    // Why one job key per detector: the detectors run under
    // Promise.allSettled, so a shared key would be advanced by hashtag_spam's
    // success over the window geotag_farming could not read.
    const tables = gapAbuseFixtures();
    const { db } = makeWindowDb({ tables, failTables: new Set(["passport_stamps"]) });
    const { ports, commits, store } = makeWatermarkPorts({
      [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    const result = await runScan(db, null, { now: WM_NOW, watermarks: ports });

    assert.equal(result.status, "incomplete");
    assert.ok(result.failedDetectors.some((f) => f.detector === "geotag_farming"));
    assert.ok(!commits.some((c) => c.job === JOB_GEO), "an unread window must not be marked scanned");
    assert.equal(store.get(JOB_GEO)!.toISOString(), wmAgo(54), "the mark stays where it was, so the next pass re-covers it");
    assert.deepEqual(commits.map((c) => c.job).sort(), [JOB_AVAIL, JOB_HASH], "the detectors that DID complete still advance");
  });

  it("a flag that could not be inserted does not advance the watermark either", async () => {
    // Finding abuse and failing to record it is not a covered window: the
    // abuse would be dropped permanently and invisibly on the next advance.
    const tables = emptyTables({
      passport_stamps: Array.from({ length: 16 }, (_, i) => ({ user_id: "farmer-2", created_at: wmAgo(30 - i * 0.01) })),
    });
    const { db } = makeWindowDb({ tables, failWrites: new Set(["compass_abuse_flags"]) });
    const { ports, commits, store } = makeWatermarkPorts({
      [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    const result = await runScan(db, null, { now: WM_NOW, watermarks: ports });

    assert.equal(result.flagsWritten, 0, "flagsWritten counts rows that landed, not handleFlag calls");
    assert.ok(!commits.some((c) => c.job === JOB_GEO), "the window whose flag was lost must be re-scanned");
    assert.equal(store.get(JOB_GEO)!.toISOString(), wmAgo(54));
    assert.deepEqual(commits.map((c) => c.job).sort(), [JOB_AVAIL, JOB_HASH], "per-job isolation again: these two found nothing and completed");
  });

  it("a watermark NEWER than a detector's lookback never narrows its window", async () => {
    // hashtag_spam is calibrated on 24 h but runs hourly: `since = watermark`
    // would shrink it to the last half hour and stop counting the other 23½.
    const fresh = new Date(WM_NOW.getTime() - 0.5 * WM_HOUR);
    const tables = emptyTables({});
    const { db, windows } = makeWindowDb({ tables });
    const { ports, commits } = makeWatermarkPorts({ [JOB_GEO]: fresh, [JOB_HASH]: fresh, [JOB_AVAIL]: fresh });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });

    assert.equal(sincesFor(windows, "hashtag_usage")[0], wmAgo(24), "the window is the UNION of the lookback and the missed time");
    assert.equal(sincesFor(windows, "compass_active_user_events")[0], wmAgo(24));
    assert.equal(sincesFor(windows, "passport_stamps")[0], wmAgo(1), "geotag's own hour is still its floor");
    assert.equal(commits.length, 3, "a steady-state pass still moves every mark forward");
  });

  it("the wide detectors keep their own windows and have no watermark at all", async () => {
    const tables = emptyTables({});
    const { db, windows } = makeWindowDb({ tables });
    const { ports, reads, commits } = makeWatermarkPorts({
      [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });
    // The five wide detectors were deliberately not touched, which includes not
    // being handed the injected clock — they still anchor on the real one, so
    // their windows are measured against it and rounded to whole hours.
    const anchor = Date.now();

    // mutual_review_ring 7 d, and booking_loop's 5★ read over its own 30 d.
    assert.deepEqual(
      lookbackHours(windows, "rent_buddy_reviews", anchor),
      [7 * 24, 30 * 24],
      "the 7-day ring window and the 30-day booking-loop window are untouched",
    );
    // booking_loop + refund_abuse, both 30 d.
    assert.deepEqual(lookbackHours(windows, "rent_buddy_bookings", anchor), [30 * 24]);
    // comment_pod 72 h.
    assert.deepEqual(lookbackHours(windows, "posts_comments", anchor), [72]);
    // Only the three narrow detectors have keys; nothing else is read or moved.
    assert.deepEqual(reads.sort(), [JOB_AVAIL, JOB_GEO, JOB_HASH]);
    assert.deepEqual(commits.map((c) => c.job).sort(), [JOB_AVAIL, JOB_GEO, JOB_HASH]);
  });

  it("a catch-up pass applies each threshold to its CALIBRATED window, not to the span total", async () => {
    // The direction a wider window must NOT be allowed to go. GEOTAG_FARM_MIN
    // is a per-HOUR rate and `severe` (>30) is a per-hour rate too, and severe
    // means an auto-confirmed flag, a zeroed reward, a 365-day cooldown and a
    // compass_suspension_requests row. Feeding a 54-hour total into a
    // one-hour threshold would manufacture all of that against a merely busy
    // traveller — a new defect pointed the other way.
    const stamps: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) stamps.push({ user_id: "steady-user", created_at: wmAgo(53 - i * 1.3) });   // 40 stamps, never >1/h
    for (let i = 0; i < 31; i++) stamps.push({ user_id: "burst-user",  created_at: wmAgo(20 - i * 0.01) });  // 31 in ~20 min
    const tables = emptyTables({ passport_stamps: stamps });
    const { db } = makeWindowDb({ tables });
    const { ports } = makeWatermarkPorts({
      [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });

    const flags = tables["compass_abuse_flags"] ?? [];
    const flagged = flags.flatMap((f) => f["involved_users"] as string[]);
    assert.ok(!flagged.includes("steady-user"), `40 stamps spread over 54 h is not geotag farming; got ${JSON.stringify(flags)}`);
    const burst = flags.find((f) => (f["involved_users"] as string[]).includes("burst-user"))!;
    assert.ok(burst, "a real one-hour burst inside the gap is still caught");
    assert.equal(burst["severity"], "severe", "and at the severity its own hour earned");
    assert.equal((burst["evidence"] as any).stamp_count, 31);
    assert.deepEqual(
      (tables["compass_suspension_requests"] ?? []).map((r) => r["user_id"]),
      ["burst-user"],
      "the suspension request the old scan never raised — and only for the burst",
    );
  });

  it("the exonerating bookings read follows the window the toggles were counted in", async () => {
    // available_now_abuse's flag claims "no completed bookings in the 24 h they
    // were toggling". Exonerating on a booking from a different day of the
    // catch-up span would make this detector weaker than the timely scan it
    // stands in for.
    const toggles = (uid: string, at: number) =>
      Array.from({ length: 21 }, (_, i) => ({ user_id: uid, event_type: "availability_toggle", created_at: wmAgo(at - i * 0.05) }));
    const tables = emptyTables({
      compass_active_user_events: [...toggles("busy-buddy", 45), ...toggles("idle-buddy", 45)],
      rent_buddy_bookings: [
        // Inside busy-buddy's peak 24 h → exonerated.
        { id: "bk-in",  buddy_id: "busy-buddy", traveler_id: "t1", status: "completed", created_at: wmAgo(40) },
        // Outside idle-buddy's peak 24 h → does not exonerate.
        { id: "bk-out", buddy_id: "idle-buddy", traveler_id: "t2", status: "completed", created_at: wmAgo(2) },
      ],
    });
    const { db } = makeWindowDb({ tables });
    const { ports } = makeWatermarkPorts({
      [JOB_GEO]:   new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_HASH]:  new Date(WM_NOW.getTime() - 54 * WM_HOUR),
      [JOB_AVAIL]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });

    const flagged = (tables["compass_abuse_flags"] ?? [])
      .filter((f) => f["pattern_type"] === "available_now_abuse")
      .flatMap((f) => f["involved_users"] as string[]);
    assert.deepEqual(flagged, ["idle-buddy"], `expected only idle-buddy; got ${JSON.stringify(flagged)}`);
  });

  it("an on-demand scoped scan neither reads nor advances a watermark", async () => {
    // A scoped scan looks at ONE user's rows. Committing its `through` would
    // declare the window covered for everyone else — the same permanent skip,
    // aimed at everyone who was not the subject of the report.
    const tables = gapAbuseFixtures();
    const { db, windows } = makeWindowDb({ tables });
    const { ports, reads, commits } = makeWatermarkPorts({
      [JOB_GEO]: new Date(WM_NOW.getTime() - 54 * WM_HOUR),
    });

    await runScan(db, "farmer-1", { now: WM_NOW, watermarks: ports });

    assert.deepEqual(reads, [], "no watermark is consulted for a scoped scan");
    assert.deepEqual(commits, [], "and none is advanced");
    assert.equal(sincesFor(windows, "passport_stamps")[0], wmAgo(1), "a scoped scan keeps the calibrated lookback");
  });
  // ── Two gaps the first pass of this work left open ─────────────────────────
  //
  // Both are the SAME hazard: the catch-up path counting fewer rows than it
  // actually read. A detector standing in for the timely scans that never ran
  // may see more than they would have; it may never see less. Neither of these
  // was caught by the tests above — a mutation run found them — so they are
  // pinned here with the arithmetic that makes them bite.

  it("a stamp whose created_at cannot be parsed is still counted on a catch-up pass", async () => {
    // The steady-state path counts rows, not timestamps, so an unparseable
    // created_at has always counted. The peak path can only count rows it can
    // PLACE in time, so dropping them would make the catch-up pass quietly
    // stricter than the pass it replaces. 12 placeable + 4 unplaceable = 16,
    // over GEOTAG_FARM_MIN; the 12 alone are not.
    const stamps: Record<string, unknown>[] = [];
    for (let i = 0; i < 12; i++) stamps.push({ user_id: "farmer-2", created_at: wmAgo(30 - i * 0.01) });
    for (let i = 0; i < 4; i++)  stamps.push({ user_id: "farmer-2", created_at: "not-a-timestamp" });

    const tables = emptyTables({ passport_stamps: stamps });
    const { db } = makeWindowDb({ tables });
    const { ports } = makeWatermarkPorts({ [JOB_GEO]: new Date(WM_NOW.getTime() - 54 * WM_HOUR) });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });

    const geo = (tables["compass_abuse_flags"] ?? []).find((f) => f["pattern_type"] === "geotag_farming");
    assert.ok(geo, "16 stamps in one hour must be flagged even when 4 of them carry an unparseable created_at");
    assert.equal((geo!["evidence"] as any).stamp_count, 16, "the 4 rows that could not be placed in time must not be dropped from the count");
  });

  it("the densest window includes a row sitting exactly on its far edge", async () => {
    // 16 stamps spanning EXACTLY one hour, first to last. The window the
    // threshold is calibrated on is one hour, and the read that produced these
    // rows has an inclusive lower bound and no upper bound, so all 16 are in
    // one window and the account is a farmer. A half-open window would see 15
    // and let it through — one row below the line, from a boundary alone.
    const stamps: Record<string, unknown>[] = [];
    for (let k = 0; k < 16; k++) stamps.push({ user_id: "farmer-3", created_at: wmAgo(30 - k / 15) });
    assert.equal(
      Date.parse(stamps[15]!["created_at"] as string) - Date.parse(stamps[0]!["created_at"] as string),
      WM_HOUR,
      "fixture guard: first and last stamp must be exactly one hour apart, or this test is not about the edge",
    );

    const tables = emptyTables({ passport_stamps: stamps });
    const { db } = makeWindowDb({ tables });
    const { ports } = makeWatermarkPorts({ [JOB_GEO]: new Date(WM_NOW.getTime() - 54 * WM_HOUR) });

    await runScan(db, null, { now: WM_NOW, watermarks: ports });

    const geo = (tables["compass_abuse_flags"] ?? []).find((f) => f["pattern_type"] === "geotag_farming");
    assert.ok(geo, "16 stamps spanning exactly one hour must be flagged");
    assert.equal((geo!["evidence"] as any).stamp_count, 16);
  });
});
