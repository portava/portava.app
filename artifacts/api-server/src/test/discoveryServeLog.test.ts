/**
 * discoveryServeLog — Stage 0 serve-point instrumentation
 *
 * The property that matters most here is the FIRST one: with the
 * `discovery_serve_log_enabled` flag absent — which is its state in production
 * the moment this code lands — the module must perform NO write whatsoever.
 * That is what makes introducing Stage 0 behaviour-preserving.
 *
 * Tests:
 *  A. Flag absent (no row)            → zero inserts
 *  B. Flag present but false          → zero inserts
 *  C. Flag true                       → exactly one row per served item
 *  D. position mirrors served order
 *  E. servePoint is recorded on every row
 *  F. rankedInRequest is false for serve points 1-4, true for 5 and 6
 *  G. item_kind maps db/ → gem and OSM ids → place (matches discovery.ts:1329)
 *  H. surface is always 'discovery' (a value the CHECK already permits)
 *  I. Empty item list                  → zero inserts
 *  J. An insert ERROR is reported, not swallowed  (the 0202 lesson)
 *  K. An insert THROWING never propagates to the caller
 *  L. The flag read is cached — a second call inside the TTL re-reads nothing
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryServeLog.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  logDiscoveryServe,
  invalidateServeLogFlagCache,
  searchTypeToItemKind,
  DiscoveryServePoint,
  DISCOVERY_SERVE_LOG_FLAG,
} from "../lib/discoveryServeLog.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";

interface Captured { table: string; rows: any[]; }

/**
 * Minimal Supabase stub: answers the feature_flags lookup isFlagEnabled makes,
 * and captures rank_events inserts.
 */
function makeClient(opts: {
  flagRow?:     { enabled: boolean } | null;
  flagError?:   unknown;
  insertError?: unknown;
  insertThrows?: boolean;
}) {
  const captured: Captured[] = [];
  let flagReads = 0;

  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select() { return this; },
          eq()     { return this; },
          maybeSingle() {
            flagReads += 1;
            return Promise.resolve({
              data:  opts.flagRow ?? null,
              error: opts.flagError ?? null,
            });
          },
        };
      }
      return {
        insert(rows: any[]) {
          if (opts.insertThrows) throw new Error("insert exploded");
          captured.push({ table, rows });
          return Promise.resolve({ error: opts.insertError ?? null });
        },
      };
    },
  };

  return { client, captured, flagReads: () => flagReads };
}

const ITEMS = [
  { id: "node/1001" },
  { id: "db/22222222-2222-2222-2222-222222222222" },
  { id: "way/3003" },
];

describe("discoveryServeLog — inert until the flag is seeded", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("A. writes nothing when the flag row is absent", async () => {
    const { client, captured } = makeClient({ flagRow: null });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0, "a missing flag row must produce no write");
  });

  it("B. writes nothing when the flag is explicitly false", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: false } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });

  it("B2. writes nothing when the flag read errors (fail-closed)", async () => {
    const { client, captured } = makeClient({ flagError: { message: "boom" } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });
});

describe("discoveryServeLog — row shape once enabled", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("C/D/E/H. one row per item, positioned, marked, on surface 'discovery'", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L2_FRESH, items: ITEMS,
      context: { destination: "lisbon", category: "for_you" },
    });

    assert.equal(captured.length, 1, "exactly one insert call");
    const rows = captured[0]!.rows;
    assert.equal(captured[0]!.table, "rank_events");
    assert.equal(rows.length, ITEMS.length, "one row per served item");

    rows.forEach((r: any, idx: number) => {
      assert.equal(r.position, idx, "position mirrors served order");
      assert.equal(r.surface, "discovery");
      assert.equal(r.outcome, "impression");
      assert.equal(r.user_id, USER_ID);
      assert.equal(r.features.servePoint, DiscoveryServePoint.CACHE_A_L2_FRESH);
      assert.equal(r.features.route, "GET /discovery");
      assert.equal(r.features.destination, "lisbon");
    });

    // One session id for the whole batch — "single open" semantics.
    const sessions = new Set(rows.map((r: any) => r.session_id));
    assert.equal(sessions.size, 1, "one session_id per batch");
  });

  it("F. rankedInRequest is false for cache serves and true for the ranking serves", async () => {
    const unranked = [
      DiscoveryServePoint.CACHE_A_L1,
      DiscoveryServePoint.CACHE_A_L2_FRESH,
      DiscoveryServePoint.CACHE_A_L2_STALE,
      DiscoveryServePoint.CACHE_B_HIT,
    ];
    for (const sp of unranked) {
      invalidateServeLogFlagCache();
      const { client, captured } = makeClient({ flagRow: { enabled: true } });
      await logDiscoveryServe(client, { userId: USER_ID, servePoint: sp, items: ITEMS });
      assert.equal(
        captured[0]!.rows[0].features.rankedInRequest, false,
        `serve point ${sp} runs no ranker in-request`,
      );
    }

    // Serve point 4 replays a Compass order but invokes no ranker in THIS
    // request — the distinction the Phase -1 proof corrected from three to four.
    invalidateServeLogFlagCache();
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COMPASS_FRESH_RANK, items: ITEMS,
    });
    assert.equal(captured[0]!.rows[0].features.rankedInRequest, true);
  });

  it("G. item_kind maps db/ to gem and OSM ids to place", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const kinds = captured[0]!.rows.map((r: any) => r.item_kind);
    assert.deepEqual(kinds, ["place", "gem", "place"]);
    // Every value must satisfy the CHECK at 0153_add_rank_events.sql:18.
    const allowed = new Set(["post", "event", "plan", "buddy", "place", "gem"]);
    for (const k of kinds) assert.ok(allowed.has(k), `${k} violates the item_kind CHECK`);
  });

  it("I. writes nothing for an empty served list", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: [],
    });
    assert.equal(captured.length, 0);
  });

  it("I2. writes nothing without a user id (rank_events.user_id is NOT NULL)", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: "", servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });
});

describe("discoveryServeLog — failure handling", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("J. a rejected insert does not throw (and is reported, not swallowed)", async () => {
    const { client } = makeClient({
      flagRow: { enabled: true },
      insertError: { message: "new row violates check constraint" },
    });
    await assert.doesNotReject(() =>
      logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });

  it("K. a throwing insert never propagates to the caller", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertThrows: true });
    await assert.doesNotReject(() =>
      logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });

  it("K2. a null client is a no-op", async () => {
    await assert.doesNotReject(() =>
      logDiscoveryServe(null, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });
});

describe("discoveryServeLog — Stage 0b, the rest of the discovery surface", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("M. serve points 7-9 are never marked as having run a ranker", async () => {
    for (const sp of [
      DiscoveryServePoint.FEED,
      DiscoveryServePoint.SEARCH,
      DiscoveryServePoint.SUGGEST,
    ]) {
      invalidateServeLogFlagCache();
      const { client, captured } = makeClient({ flagRow: { enabled: true } });
      await logDiscoveryServe(client, {
        userId: USER_ID, servePoint: sp, items: ITEMS, route: "GET /discovery/x",
      });
      assert.equal(
        captured[0]!.rows[0].features.rankedInRequest, false,
        `serve point ${sp} has no ranker call at all`,
      );
      assert.equal(captured[0]!.rows[0].features.route, "GET /discovery/x");
    }
  });

  it("N. an explicit kind overrides the id-based inference", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.SEARCH,
      items: [
        { id: "node/1", kind: "buddy" },
        { id: "db/2",   kind: "post"  },
        // null is a real, intended value — "served, kind not applicable".
        { id: "city/3", kind: null    },
      ],
    });
    const kinds = captured[0]!.rows.map((r: any) => r.item_kind);
    assert.deepEqual(kinds, ["buddy", "post", null]);
  });

  it("O. search types map only onto kinds the CHECK constraint accepts", () => {
    const allowed = new Set(["post", "event", "plan", "buddy", "place", "gem"]);
    const expected: Record<string, string | null> = {
      travelers: "buddy", buddies: "buddy", events: "event",
      trips: "plan", plans: "plan", places: "place",
      hidden_gems: "gem", posts: "post",
    };
    for (const [type, kind] of Object.entries(expected)) {
      assert.equal(searchTypeToItemKind(type), kind, `${type} maps to ${kind}`);
    }
    // Taxonomic result types have no valid kind and must map to null rather
    // than to an invented one, which would corrupt any item_kind grouping.
    for (const type of [
      "hashtags", "circles", "stamps", "activities",
      "cities", "countries", "languages", "interests", "vibes",
    ]) {
      assert.equal(searchTypeToItemKind(type), null, `${type} has no valid item_kind`);
    }
    // Nothing may escape the constraint's vocabulary.
    for (const type of [...Object.keys(expected), "cities", "unknown_future_type"]) {
      const k = searchTypeToItemKind(type);
      assert.ok(k === null || allowed.has(k), `${type} -> ${k} violates the CHECK`);
    }
  });
});

describe("discoveryServeLog — flag read caching", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("L. reads the flag once across repeated serves inside the TTL", async () => {
    const { client, captured, flagReads } = makeClient({ flagRow: { enabled: true } });
    for (let i = 0; i < 4; i++) {
      await logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      });
    }
    assert.equal(captured.length, 4, "every serve still logs");
    assert.equal(flagReads(), 1, "the flag is read once, not once per serve");
  });

  it("L2. the flag name is the one this module documents", () => {
    assert.equal(DISCOVERY_SERVE_LOG_FLAG, "discovery_serve_log_enabled");
  });
});

// ── `12` stop-condition evidence (census DV-82) ───────────────────────────────
//
// This writer is the only instrument that knows whether a Discovery event
// actually landed, so it is the only thing that can feed `12`'s first two stop
// conditions. The Phase 9 lesson applies: with the evaluator fully covered by
// its own tests, deleting the CALL that feeds it left everything green. A stop
// condition with no evidence never trips, which is indistinguishable from one
// that is working.
import {
  evaluateStopConditions,
  _resetStopConditionsForTest,
} from "../lib/discoveryStopConditions.js";

describe("discoveryServeLog — feeds the 12 stop conditions", () => {
  beforeEach(() => {
    invalidateServeLogFlagCache();
    _resetStopConditionsForTest();
  });

  it("M. a REJECTED insert is recorded as evidence, not only logged", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertError: { message: "check violation" } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const v = evaluateStopConditions();
    assert.equal(v.attempts, 1, "the attempt must reach the stop-condition window");
    assert.equal(v.eventRejectionRate, 1, "a rejected batch is a rejection");
    assert.equal(v.loggingGapRate, 1, "and every served item failed to become a row");
  });

  it("M2. a LANDED insert is recorded as healthy evidence", async () => {
    const { client } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const v = evaluateStopConditions();
    assert.equal(v.attempts, 1);
    assert.equal(v.eventRejectionRate, 0);
    assert.equal(v.loggingGapRate, 0);
  });

  it("M3. a THROWN insert is recorded — the failure most likely to be invisible", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertThrows: true });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const v = evaluateStopConditions();
    assert.equal(v.attempts, 1, "a throw leaves no error object and no rejected row; if it is not recorded here it is recorded nowhere");
    assert.equal(v.eventRejectionRate, 1);
  });

  it("M4. the FLAG BEING OFF is not evidence of anything — no attempt, no gap", async () => {
    const { client } = makeClient({ flagRow: { enabled: false } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(
      evaluateStopConditions().attempts, 0,
      "counting a disabled writer as a logging gap would make the stop trip hardest precisely while the feature is off",
    );
  });

  it("M5. a serve with NO items records nothing — an empty page is not a dropped page", async () => {
    const { client } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: [],
    });
    assert.equal(evaluateStopConditions().attempts, 0);
  });
});

// ── `04` §5 — the recommendation denominator (DV-40) ─────────────────────────
//
// "Every served item must have a `recommendation_id`", plus a nine-field
// minimum record: recommendation_id, user_id, session_id, candidate_type/id,
// surface, rank_position, model_version, reason codes, served_at.
//
// The census recorded DV-40 as N on the evidence that `recommendation_id` has
// "zero occurrences in Discovery" and that the `10` §3 recommendation tables are
// absent. The second half is true. The first half was false even when written:
// Compass mints an HMAC-signed `recommendation_id` per served item and
// registers it in the production table `compass_served_recommendations`
// (migration 0055_compass_admin.sql:22). What was absent is a denominator on
// DISCOVERY's serves — and seven of the nine fields were already on the row.
//
// So this does not build a recommendation subsystem. It completes the record
// Discovery already writes, on the table Discovery already writes to, with no
// migration: the three missing fields go into the `features` jsonb that every
// serve-log row already carries.
//
// WHY NOT REUSE THE COMPASS TOKEN. `encodeRecommendationToken`
// (src/compass/CompassExplanationEngine.ts:283) is deterministic over
// (userId, itemId, itemType, sectionName, explanationKey) — deliberately, since
// Compass dedupes on it (`dedupeByRecommendationId`) and hands it to the client
// as a `/why` lookup handle. A DENOMINATOR has the opposite requirement: two
// serves of the same item to the same user are TWO exposures, and an id that
// collapses them under-counts exactly the quantity `04` §5 exists to measure.
// The id below therefore binds the serve, not the item.
import {
  recommendationIdFor,
  RECOMMENDATION_RECORD_FIELDS,
} from "../lib/discoveryRecommendationId.js";
import { DISCOVERY_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";

describe("discoveryServeLog — 04 §5 the recommendation denominator (DV-40)", () => {
  beforeEach(() => {
    invalidateServeLogFlagCache();
  });

  it("R1. every served item carries a recommendation_id — none is blank, and a REPEATED item still gets two", async () => {
    // The repeat is the whole point of this fixture. A page of three DISTINCT
    // items cannot tell whether the id binds the exposure or merely the item —
    // both hypotheses predict three different ids — so the one arrangement that
    // separates them is the same item served twice at two rank positions.
    // (Found by mutation: pinning `position` to 0 in the derivation left an
    // all-distinct fixture entirely green.)
    const REPEATED = [
      { id: "node/1001" },
      { id: "db/22222222-2222-2222-2222-222222222222" },
      { id: "node/1001" },
    ];
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: REPEATED,
    });
    const rows = captured[0]?.rows ?? [];
    assert.equal(rows.length, REPEATED.length, "precondition: one row per served item");

    const ids = rows.map((r: any) => r.features?.recommendationId);
    for (const id of ids) {
      assert.equal(typeof id, "string", "04 §5: every served item must have a recommendation_id");
      assert.ok((id as string).length > 0, "a blank id is an absent id wearing a field name");
    }
    assert.equal(
      new Set(ids).size, ids.length,
      "the same item at two rank positions is TWO exposures; one id for both under-counts the denominator",
    );
  });

  it("R2. all nine 04 §5 fields are recoverable from the row the writer produces", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
      context: { destination: "miami" },
    });
    const row = (captured[0]?.rows ?? [])[1];
    assert.ok(row, "precondition: a row was written");

    // The six the columns already carried.
    assert.equal(row.user_id, USER_ID, "04 §5 user_id");
    assert.equal(typeof row.session_id, "string", "04 §5 session_id");
    assert.ok(row.item_id && row.item_kind, "04 §5 candidate type/id");
    assert.equal(row.surface, "discovery", "04 §5 surface");
    assert.equal(row.position, 1, "04 §5 rank_position");
    assert.ok(row.served_at, "04 §5 served_at");
    // The three this adds, in the jsonb the row already writes.
    assert.equal(typeof row.features.recommendationId, "string", "04 §5 recommendation_id");
    assert.equal(row.features.modelVersion, DISCOVERY_MODEL_VERSION, "04 §5 model_version");
    assert.ok(Array.isArray(row.features.reasonCodes), "04 §5 reason codes");

    // And the list itself is exported, so a reader can check the record against
    // the specification rather than against this test's own memory of it.
    assert.equal(RECOMMENDATION_RECORD_FIELDS.length, 9, "04 §5 names nine fields");
  });

  it("R3. the id binds the SERVE, not the item — the same item served twice is two exposures", async () => {
    const a = recommendationIdFor({
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    });
    const b = recommendationIdFor({
      userId: USER_ID, sessionId: "s2", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    });
    assert.notEqual(a, b, "a second session is a second exposure; collapsing them under-counts the denominator");

    const c = recommendationIdFor({
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 1, itemId: "node/1001",
    });
    assert.notEqual(a, c, "the same item at a different rank position is a different exposure");

    const d = recommendationIdFor({
      userId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000002", sessionId: "s1",
      servedAt: "2026-09-14T00:00:00.000Z", surface: "discovery", position: 0, itemId: "node/1001",
    });
    assert.notEqual(a, d, "another viewer's exposure is not this viewer's");
  });

  it("R4. the id is DETERMINISTIC — the identical batch replayed yields the identical ids", async () => {
    const args = {
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    } as const;
    assert.equal(
      recommendationIdFor(args), recommendationIdFor(args),
      "DV-37: a retried batch must not manufacture a second exposure for the same serve — a random id would",
    );
  });

  it("R5. the id is opaque and leaks no identifier — a user id must not be readable out of it", async () => {
    const id = recommendationIdFor({
      userId: USER_ID, sessionId: "s1", servedAt: "2026-09-14T00:00:00.000Z",
      surface: "discovery", position: 0, itemId: "node/1001",
    });
    assert.ok(!id.includes(USER_ID), "the viewer's id must not be recoverable from the recommendation id");
    assert.ok(!id.includes("node/1001"), "nor the item id");
    // base64/hex-safe: it goes into jsonb and may later become a URL segment.
    assert.match(id, /^[A-Za-z0-9_-]+$/, "an opaque id must be transport-safe wherever it is later carried");
  });

  it("R6. reason codes on the row are the GROUNDED ones, and a serve with no ranker claims none", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const rows = captured[0]?.rows ?? [];
    for (const r of rows) {
      assert.deepEqual(
        r.features.reasonCodes, [],
        "serve point 1 replays a cache and ran no ranker; inventing reason codes there would be a claim nothing backs",
      );
    }
  });

  it("R8. a caller's free-form context cannot overwrite the record — the denominator is not decoration", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
      // A caller that happens to use these names — or a malicious one — must not
      // be able to decide what the exposure record says about itself.
      context: { recommendationId: "forged", modelVersion: "v0-forged" } as any,
    });
    const row = (captured[0]?.rows ?? [])[0];
    assert.notEqual(row.features.recommendationId, "forged", "04 §5: the id is derived from the serve, never taken from the caller");
    assert.equal(row.features.modelVersion, DISCOVERY_MODEL_VERSION, "nor may the caller restate which model ranked the page");
  });

  it("R7. per-item reason codes are carried when the ranker DID supply them", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client as any, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, items: ITEMS,
      reasonCodesById: { "way/3003": ["nearby_now", "saved_similar"] },
    });
    const rows = captured[0]?.rows ?? [];
    const third = rows.find((r: any) => r.item_id === "way/3003");
    assert.deepEqual(third.features.reasonCodes, ["nearby_now", "saved_similar"], "the ranker's own codes reach the row");
    const first = rows.find((r: any) => r.item_id === "node/1001");
    assert.deepEqual(first.features.reasonCodes, [], "an item the ranker gave no codes for claims none");
  });
});
