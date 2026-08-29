/**
 * ranking-explanation-analytics.test.ts
 *
 * Covers:
 *   A. New explanation keys resolve to the correct user-friendly strings.
 *   B. HMAC token round-trips correctly for new explanation keys.
 *   C. No sensitive key suffix leaks through the new keys.
 *   D. rankingAnalytics constants are well-typed and have the expected values.
 *   E. fire-and-forget analytics errors are caught and do not propagate.
 *   F. No private fields leak into analytics writes.
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankItems } from "../services/ranking/DiscoveryRankingService.js";

import {
  resolveExplanation,
  isSensitiveKey,
  encodeRecommendationToken,
  decodeRecommendationToken,
  GENERIC_INELIGIBLE,
  EXPLANATION_KEY_NEW_CREATOR_NEARBY,
  EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE,
  EXPLANATION_KEY_GAINING_INTEREST,
  EXPLANATION_KEY_HELPFUL_TO_TRAVELERS,
  EXPLANATION_KEY_RECENTLY_UPDATED,
} from "../compass/CompassExplanationEngine.js";

import {
  RankingEvent,
  OUTCOME_TO_ANALYTICS_EVENT,
  type RankingEventType,
} from "../services/ranking/rankingAnalytics.js";

// ── A. New explanation key resolution ────────────────────────────────────────

describe("A. New explanation keys resolve correctly", () => {
  it("new_creator_nearby → 'A new creator you may like'", async () => {
    const result = await resolveExplanation(EXPLANATION_KEY_NEW_CREATOR_NEARBY, null);
    assert.equal(result, "A new creator you may like");
  });

  it("returning_creator_active → uses {city} placeholder with provided city", async () => {
    const result = await resolveExplanation(
      EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE, null, "Lisbon",
    );
    assert.equal(result, "Recently active again in Lisbon");
  });

  it("returning_creator_active → falls back to 'your city' when no city provided", async () => {
    const result = await resolveExplanation(
      EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE, null, null,
    );
    assert.equal(result, "Recently active again in your city");
  });

  it("gaining_interest → 'Gaining interest in your area'", async () => {
    const result = await resolveExplanation(EXPLANATION_KEY_GAINING_INTEREST, null);
    assert.equal(result, "Gaining interest in your area");
  });

  it("helpful_to_travelers → 'Helpful to travelers with similar plans'", async () => {
    const result = await resolveExplanation(EXPLANATION_KEY_HELPFUL_TO_TRAVELERS, null);
    assert.equal(result, "Helpful to travelers with similar plans");
  });

  it("recently_updated → 'Recently updated'", async () => {
    const result = await resolveExplanation(EXPLANATION_KEY_RECENTLY_UPDATED, null);
    assert.equal(result, "Recently updated");
  });

  it("exported key constants match the strings used in template resolution", () => {
    assert.equal(EXPLANATION_KEY_NEW_CREATOR_NEARBY,       "new_creator_nearby");
    assert.equal(EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE, "returning_creator_active");
    assert.equal(EXPLANATION_KEY_GAINING_INTEREST,         "gaining_interest");
    assert.equal(EXPLANATION_KEY_HELPFUL_TO_TRAVELERS,     "helpful_to_travelers");
    assert.equal(EXPLANATION_KEY_RECENTLY_UPDATED,         "recently_updated");
  });
});

// ── B. HMAC token round-trip for new keys ────────────────────────────────────

describe("B. HMAC token round-trip for new explanation keys", () => {
  const baseToken = {
    userId:      "aaaa0000-0000-0000-0000-000000000001",
    itemId:      "bbbb0000-0000-0000-0000-000000000002",
    itemType:    "post",
    sectionName: "compass_picks",
  };

  const NEW_KEYS = [
    EXPLANATION_KEY_NEW_CREATOR_NEARBY,
    EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE,
    EXPLANATION_KEY_GAINING_INTEREST,
    EXPLANATION_KEY_HELPFUL_TO_TRAVELERS,
    EXPLANATION_KEY_RECENTLY_UPDATED,
  ];

  for (const key of NEW_KEYS) {
    it(`round-trips correctly for key: ${key}`, () => {
      const token = { ...baseToken, explanationKey: key };
      const encoded = encodeRecommendationToken(token);
      const decoded = decodeRecommendationToken(encoded);
      assert.ok(decoded !== null, `Token for key '${key}' should decode successfully`);
      assert.equal(decoded!.explanationKey, key);
      assert.equal(decoded!.userId,         token.userId);
      assert.equal(decoded!.itemId,         token.itemId);
    });
  }

  it("tampered token (modified explanationKey) is rejected", () => {
    const token = {
      ...baseToken,
      explanationKey: EXPLANATION_KEY_NEW_CREATOR_NEARBY,
    };
    const encoded = encodeRecommendationToken(token);

    // Decode raw JSON, mutate the key, re-encode without re-signing
    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    raw.explanationKey = EXPLANATION_KEY_GAINING_INTEREST;
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");

    const decoded = decodeRecommendationToken(tampered);
    assert.equal(decoded, null, "Tampered token must be rejected");
  });
});

// ── C. Sensitive key guard for new keys ──────────────────────────────────────

describe("C. New keys are not sensitive — they produce readable strings", () => {
  const NEW_KEYS = [
    EXPLANATION_KEY_NEW_CREATOR_NEARBY,
    EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE,
    EXPLANATION_KEY_GAINING_INTEREST,
    EXPLANATION_KEY_HELPFUL_TO_TRAVELERS,
    EXPLANATION_KEY_RECENTLY_UPDATED,
  ];

  for (const key of NEW_KEYS) {
    it(`${key} is not flagged as sensitive`, () => {
      assert.equal(
        isSensitiveKey(key),
        false,
        `Key '${key}' must not be treated as sensitive`,
      );
    });

    it(`${key} does not return GENERIC_INELIGIBLE`, async () => {
      const result = await resolveExplanation(key, null);
      assert.notEqual(
        result,
        GENERIC_INELIGIBLE,
        `Key '${key}' must not resolve to the generic ineligible string`,
      );
    });
  }

  it("a key with a sensitive suffix is still blocked", async () => {
    const sensitiveKey = "new_creator_nearby:harassment_downrank";
    const result = await resolveExplanation(sensitiveKey, null);
    assert.equal(result, GENERIC_INELIGIBLE);
  });
});

// ── D. RankingEvent constants are well-formed ────────────────────────────────

describe("D. RankingEvent constants have correct values", () => {
  it("scoring pipeline events are present and correctly named", () => {
    assert.equal(RankingEvent.ITEM_ELIGIBLE,  "ranking_item_eligible");
    assert.equal(RankingEvent.ITEM_SCORED,    "ranking_item_scored");
  });

  it("assembly / selection events are present", () => {
    assert.equal(RankingEvent.ITEM_SELECTED,             "ranking_item_selected");
    assert.equal(RankingEvent.ITEM_EXPLORATION_SELECTED,  "ranking_item_exploration_selected");
    assert.equal(RankingEvent.ITEM_UNDEREXPOSED_SELECTED, "ranking_item_underexposed_selected");
    assert.equal(RankingEvent.NEW_CREATOR_SELECTED,       "ranking_new_creator_selected");
    assert.equal(RankingEvent.RETURNING_CREATOR_SELECTED, "ranking_returning_creator_selected");
  });

  it("boost / penalty events are present", () => {
    assert.equal(RankingEvent.ACTIVITY_BOOST_APPLIED,  "ranking_activity_boost_applied");
    assert.equal(RankingEvent.ACTIVITY_BOOST_CAPPED,   "ranking_activity_boost_capped");
    assert.equal(RankingEvent.FATIGUE_PENALTY_APPLIED, "ranking_fatigue_penalty_applied");
    assert.equal(RankingEvent.DIVERSITY_REORDERED,     "ranking_diversity_reordered");
  });

  it("outcome events are present", () => {
    assert.equal(RankingEvent.ITEM_IMPRESSION, "ranking_item_impression");
    assert.equal(RankingEvent.ITEM_OPENED,     "ranking_item_opened");
    assert.equal(RankingEvent.ITEM_SAVED,      "ranking_item_saved");
    assert.equal(RankingEvent.ITEM_HIDDEN,     "ranking_item_hidden");
    assert.equal(RankingEvent.ITEM_REPORTED,   "ranking_item_reported");
  });

  it("all event strings are unique (no duplicate values)", () => {
    const values = Object.values(RankingEvent);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "Every RankingEvent value must be unique");
  });

  it("all event strings start with 'ranking_'", () => {
    for (const [key, value] of Object.entries(RankingEvent)) {
      assert.ok(
        value.startsWith("ranking_"),
        `RankingEvent.${key} value '${value}' must start with 'ranking_'`,
      );
    }
  });
});

// ── E. OUTCOME_TO_ANALYTICS_EVENT mapping ────────────────────────────────────

describe("E. OUTCOME_TO_ANALYTICS_EVENT maps legacy outcomes correctly", () => {
  it("maps 'tap' to ITEM_OPENED", () => {
    assert.equal(OUTCOME_TO_ANALYTICS_EVENT["tap"], RankingEvent.ITEM_OPENED);
  });

  it("maps 'save' to ITEM_SAVED", () => {
    assert.equal(OUTCOME_TO_ANALYTICS_EVENT["save"], RankingEvent.ITEM_SAVED);
  });

  it("maps 'hide' to ITEM_HIDDEN", () => {
    assert.equal(OUTCOME_TO_ANALYTICS_EVENT["hide"], RankingEvent.ITEM_HIDDEN);
  });

  it("maps 'report' to ITEM_REPORTED", () => {
    assert.equal(OUTCOME_TO_ANALYTICS_EVENT["report"], RankingEvent.ITEM_REPORTED);
  });
});

// ── F. Analytics write safety — no private fields leak ───────────────────────

describe("F. Analytics write payloads contain only safe fields", () => {
  /**
   * Safe analytics fields that may be written to rank_events.
   * This set is the explicit allowlist — any field outside it would be a leak.
   */
  const SAFE_ANALYTICS_FIELDS = new Set([
    "event_type",
    "item_id",
    "content_type",
    "surface",
    "user_id",
    "session_id",
    "served_at",
    // The writer emits EIGHT keys, not seven. `outcome` was missing from this
    // allowlist while writeRankAnalyticAsync has always set it to 'analytics'
    // (it is what keeps these rows out of the impression queries). The omission
    // went unnoticed because the assertions below used to walk a hand-built
    // literal instead of the real payload — a test that could only ever agree
    // with itself. They now capture the actual insert.
    "outcome",
  ]);

  /**
   * Fields that must NEVER appear in an analytics write.
   * These represent private data, scoring internals, or fraud signals.
   */
  const FORBIDDEN_FIELDS = [
    "score",
    "final_score",
    "components",
    "viewer_lat",
    "viewer_lng",
    "viewer_age",
    "travelStyles",
    "preferredLanguages",
    "ranking_feature_vector",
    "spam_penalty",
    "harassment_signal",
    "fraud_score",
    "email",
    "phone",
    "private_location",
  ];

  it("safe analytics fields are a known, bounded set", () => {
    // Verify we have not grown the allowed set accidentally
    assert.ok(SAFE_ANALYTICS_FIELDS.size <= 10,
      "Analytics field allowlist should remain small; review any additions");
  });

  it("no forbidden field name matches any safe field", () => {
    for (const field of FORBIDDEN_FIELDS) {
      assert.ok(
        !SAFE_ANALYTICS_FIELDS.has(field),
        `Forbidden field '${field}' must not be in the analytics safe set`,
      );
    }
  });

  /**
   * Capture the payload writeRankAnalyticAsync ACTUALLY inserts, by driving
   * rankItems with a recording stub. Asserting a hand-written literal proves
   * only that the literal matches the allowlist — it cannot notice the writer
   * growing a field, which is the entire risk this test exists to cover.
   */
  async function captureRealAnalyticsPayloads(): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    const db = {
      from(table: string) {
        return {
          insert(row: any) { if (table === "rank_events") rows.push(row); return Promise.resolve({ error: null, data: null }); },
          select() { return this; },
          eq() { return this; },
          in() { return Promise.resolve({ data: [], error: null }); },
          gte() { return Promise.resolve({ data: [], error: null }); },
        };
      },
    } as any;

    await rankItems(
      [{
        itemId: "item-123", itemType: "post", creatorId: null,
        createdAt: new Date().toISOString(), city: "paris", country: "FR",
        tags: ["adventure"], category: "adventure", languageCode: "en",
        hasMedia: true, distanceKm: 2,
      } as any],
      "compass",
      {
        viewerId: "viewer-456", travelStyles: ["adventure"], preferredLanguages: ["en"],
        preferredCities: ["paris"], currentCity: "paris", currentCountry: "FR",
        lat: 48.85, lng: 2.35, viewerAge: null,
        followedCreatorIds: new Set(), mutedCreatorIds: new Set(), sessionId: null,
      } as any,
      db,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: {
        rankingEnabled: true, explorationEnabled: false, activityBoostEnabled: false,
        experimentEnabled: false, shadowMode: false,
      } } as any,
    );
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget writes
    return rows;
  }

  it("the REAL analytics payload contains only allowed fields", async () => {
    const payloads = await captureRealAnalyticsPayloads();
    assert.ok(payloads.length > 0, "expected the writer to have inserted at least one row");

    for (const payload of payloads) {
      for (const field of Object.keys(payload)) {
        assert.ok(
          SAFE_ANALYTICS_FIELDS.has(field),
          `Analytics payload contains unexpected field: '${field}'`,
        );
      }
    }
  });

  it("the REAL analytics payload carries no forbidden field", async () => {
    const payloads = await captureRealAnalyticsPayloads();
    for (const payload of payloads) {
      for (const forbidden of FORBIDDEN_FIELDS) {
        assert.ok(!(forbidden in payload), `Analytics payload leaked '${forbidden}'`);
      }
    }
  });

  it("the allowlist matches the writer EXACTLY — no unused entries", async () => {
    // The other direction. An allowlist that drifts ahead of the writer stops
    // being a bound on what may be written and becomes decoration.
    const payloads = await captureRealAnalyticsPayloads();
    const emitted = new Set(payloads.flatMap((p) => Object.keys(p)));
    const unused = [...SAFE_ANALYTICS_FIELDS].filter((f) => !emitted.has(f));
    assert.deepEqual(unused, [], `allowlist entries the writer never emits: ${unused.join(", ")}`);
  });

  it("simulated payload has no forbidden fields", () => {
    const payload: Record<string, unknown> = {
      event_type:   RankingEvent.ITEM_ELIGIBLE,
      item_id:      "item-abc",
      content_type: "event",
      surface:      "discovery",
      user_id:      "viewer-xyz",
      session_id:   "sess-001",
      served_at:    new Date().toISOString(),
    };

    for (const forbidden of FORBIDDEN_FIELDS) {
      assert.ok(
        !(forbidden in payload),
        `Analytics payload must not contain forbidden field '${forbidden}'`,
      );
    }
  });
});
